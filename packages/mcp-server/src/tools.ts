import * as z from 'zod'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { toFramePoint, type InterfaceTurn } from '@tapflowio/protocol/screen'
import { EnvironmentStepError, isEligible, parseFlow, refusedFlow, runFlow, unavailableButton, unavailableButtonMessage, type FlowDriver, type FlowResult } from '@tapflowio/flow-runner'
import { SessionEndedError, SessionLeftError, type TapflowClient } from './client.js'
import { TESTING_GUIDE } from './guide.js'
import { compactLaunchOptions, launchOptionsProblem, type LaunchApplied } from '@tapflowio/protocol/launch'

// Input refusal reasons that name the environment rather than the product,
// mirroring flow-runner's ENVIRONMENTAL_INPUT_REASONS. `unsupported`,
// `malformed` and `no-gesture` stay product: the first two name the test's own
// request, and no-gesture cannot tell a clean refusal from a partially applied
// gesture, so retry safety and failure classification stay separate concerns.
const ENVIRONMENTAL_REASONS = new Set([
  'not-booted',
  'channel-unavailable',
  'channel-starting',
  'dispatch-failed',
  'not-session-owner',
])

// Session lifecycle notes TapflowClient.failed() appends when the relay has
// told us the session is gone or unbound. A failure carrying one is
// environmental even when the prose names the request, not the session.
const SESSION_NOTE_MARKERS = [
  'the relay ended this session',
  "the agent's connection to the relay went away",
  'the agent reconnected and cleared its device binding',
]

// TapflowClient rebuilds timeout/disconnect input failures as prose instead of
// a typed error, so they carry no class to branch on — but the prefix is the
// contract this package's own tests hold (see client.test.ts), not free prose.
const UNCONFIRMED_INPUT_PREFIX = 'Could not confirm the input reached the device'

function toEnvironmentError(e: unknown): unknown {
  if (e instanceof EnvironmentStepError) return e
  // Session lifecycle failures the client rethrows as their own class: the CLI
  // maps both to exit 2 via RelayDriver, so run_flow must do the same before
  // falling back to message matching (their prose carries no session marker).
  if (e instanceof SessionEndedError || e instanceof SessionLeftError) {
    return new EnvironmentStepError(e.message, { cause: e })
  }
  const message = e instanceof Error ? e.message : String(e)
  // The client's unconfirmed-input error mirrors flow-runner's
  // InputUnconfirmedError, which RelayDriver also maps to exit 2.
  if (message.startsWith(UNCONFIRMED_INPUT_PREFIX)) {
    return new EnvironmentStepError(message, { cause: e })
  }
  const reason = /\((not-booted|channel-unavailable|channel-starting|dispatch-failed|not-session-owner|unsupported|malformed|no-gesture)\)/.exec(message)?.[1]
  if (reason !== undefined) {
    // Environmental reasons retype without changing a word the operator reads;
    // product reasons (unsupported, malformed, no-gesture) pass through.
    if (ENVIRONMENTAL_REASONS.has(reason)) {
      return new EnvironmentStepError(message, { cause: e })
    }
    return e
  }
  if (SESSION_NOTE_MARKERS.some((marker) => message.includes(marker))) {
    return new EnvironmentStepError(message, { cause: e })
  }
  return e
}

// Adapts TapflowClient (this process's single relay connection) to the
// flow-runner engine surface, so run_flow shares the session the agent
// already joined via connect_device instead of opening a second one.
// The guard gives run_flow the same failureKind as the CLI's RelayDriver:
// without it every input refusal reads as product here while the CLI reports
// the environmental ones as environment.
export function makeFlowDriver(client: TapflowClient, sessionId: string, buildId?: number): FlowDriver {
  const guard = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn()
    } catch (e) {
      throw toEnvironmentError(e)
    }
  }
  // The app's interface turn from the latest tree this driver read, held by this driver — one `run_flow` call — so a
  // value from another call or from `query_ui_tree` is never applied. Every point a flow sends is turned by it, the way
  // flow-runner's `RelayDriver` does; undefined (Android, an older agent) turns nothing.
  let turn: InterfaceTurn | undefined
  const at = (x: number, y: number) => toFramePoint(turn, [x, y])
  return {
    queryUITree: async (signal) => {
      const read = await guard(() => client.queryUITreeWithTurn(sessionId, signal))
      turn = read.interfaceTurn
      return read.elements
    },
    tap: async (x, y) => { const [fx, fy] = at(x, y); return guard(() => client.tap(sessionId, fx, fy)) },
    swipe: (from, to, durationMs) => {
      const [fx, fy] = at(...from), [tx, ty] = at(...to)
      return guard(() => client.swipe(sessionId, fx, fy, tx, ty, durationMs))
    },
    inputText: async (text) => guard(() => client.typeText(sessionId, text)),
    // Names the modifiers for the reason `launchApp` names its options below: a function that drops the second
    // parameter still satisfies `FlowDriver.pressKey`, and would press Cmd+A as a plain A with nothing failing.
    pressKey: async (code, modifiers) => guard(() => client.pressKey(sessionId, code, modifiers)),
    openUrl: (url) => guard(() => client.openUrl(sessionId, url)),
    // Takes the options explicitly: a function with no parameter still satisfies `FlowDriver.launchApp`, and would
    // have run a flow's launch arguments as a plain launch with nothing failing to compile. The return type is spelled
    // out for the same reason: the interface allows `void`, and a body that dropped `applied` would compile.
    launchApp: async (options): Promise<LaunchApplied | undefined> => {
      if (buildId === undefined) {
        throw new EnvironmentStepError('this flow uses launchApp — pass buildId (see list_builds)')
      }
      return guard(() => client.launchApp(sessionId, buildId, options))
    },
    clearState: (appId) => guard(() => client.clearState(sessionId, appId)),
    screenshot: (signal) => guard(() => client.screenshot(sessionId, 'png', signal)),
    pressButton: (name) => guard(() => client.pressButton(sessionId, name)),
    longPress: (x, y, durationMs) => { const [fx, fy] = at(x, y); return guard(() => client.longPress(sessionId, fx, fy, durationMs)) },
    // `unsupported` stays product for every other input (it names the request), but a pinch refused as unsupported
    // is Android's adb fallback — the device's backend, not the app. Same rule as flow-runner's `RelayDriver.pinch`.
    pinch: async (start, end, durationMs) => {
      try {
        const turned = (f: [[number, number], [number, number]]): [[number, number], [number, number]] => [at(...f[0]), at(...f[1])]
        await guard(() => client.pinch(sessionId, turned(start), turned(end), durationMs))
      } catch (e) {
        if (!(e instanceof EnvironmentStepError) && e instanceof Error && e.message.includes('(unsupported)')) {
          throw new EnvironmentStepError(e.message, { cause: e })
        }
        throw e
      }
    },
    chrome: (timeoutMs) => guard(() => client.chrome(sessionId, timeoutMs)),
    // After the device turns, read which way the app stands until two reads agree (at most 2 s), as `RelayDriver`
    // does: the chrome answers before the app has finished turning. Where a turn is expected (an iOS chrome, or one
    // already read), a read with none is a turn caught mid-way and is passed over; elsewhere (Android) it ends the loop.
    setOrientation: async (orientation, timeoutMs) => {
      await guard(() => client.setOrientation(sessionId, orientation, timeoutMs))
      const chrome = await client.chrome(sessionId, 1).catch(() => null)
      const expected = turn !== undefined || (chrome !== null && 'framePng' in chrome)
      // The turn from before the call is wrong now; a loop that never settles leaves none rather than that one.
      turn = undefined
      const until = Date.now() + 2_000
      let previous: InterfaceTurn | null = null
      while (Date.now() < until) {
        let read: InterfaceTurn | undefined
        try {
          read = (await client.queryUITreeWithTurn(sessionId, AbortSignal.timeout(Math.max(1, until - Date.now())))).interfaceTurn
        } catch {
          return
        }
        if (read === undefined) {
          if (!expected) {
            turn = undefined
            return
          }
        } else {
          turn = read
          if (read === previous) return
          previous = read
        }
        await new Promise((r) => setTimeout(r, 200))
      }
    },
    setPosture: (posture, timeoutMs) => guard(() => client.setPosture(sessionId, posture, timeoutMs)),
  }
}

/** The platform of the agent holding `sessionId`, or undefined when the listing does not say — then nothing is
 *  checked against the platform, as before. */
async function platformOf(client: TapflowClient, sessionId: string): Promise<string | undefined> {
  try {
    const agents = await client.listDevices()
    return agents.find((a) => a.devices.some((d) => d.sessionId === sessionId))?.platform
  } catch {
    return undefined
  }
}

/**
 * What a buffer actually is, from its magic bytes, or `null` for anything else.
 *
 * The request's `format` is a **preference** (see `ScreenshotRequest` in protocol) and the reply's is
 * a claim, so neither can decide how to parse these bytes. Android produces PNG whatever is asked —
 * `screencap -p` takes no format — and used to echo the request, so a JPEG request arrived as PNG
 * bytes that `getImageDimensions` then scanned for a JPEG SOF0 marker. In a few hundred KB of IDAT a
 * stray `ff c0` is close to certain, which yielded a **wrong** width and height, and those numbers go
 * into the response text the LLM reads and hands back as `tap`'s divisors. The tap lands somewhere
 * else on the screen (#508).
 *
 * Sniffing here rather than trusting the agent's fix is what makes this work against an agent that
 * has *not* been upgraded: agents are separate processes on separate release lines and this protocol
 * has no version handshake, so a self-hosted user running an older Mac agent is the ordinary case.
 *
 * Duplicated in the relay for the same reason its copy is duplicated here — see that one's note.
 */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function sniffImageFormat(buf: Buffer): 'png' | 'jpeg' | null {
  // All eight signature bytes, not the leading four. The trailing `0d 0a 1a 0a` is the part that
  // detects a mangled transfer — CRLF translation, a truncated read — and those produce exactly the
  // buffer this must not call a PNG, because `getImageDimensions` would then read a width and height
  // out of whatever sits at bytes 16-23.
  if (buf.length >= PNG_SIGNATURE.length && PNG_SIGNATURE.every((b, i) => buf[i] === b)) return 'png'
  // JPEG has no counterpart: SOI is two bytes and that is the whole marker.
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xd8) return 'jpeg'
  return null
}

function getImageDimensions(buf: Buffer, format: string): { width: number; height: number } | null {
  if (format === 'png' && buf.length >= 24) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
  }
  if (format === 'jpeg') {
    for (let i = 2; i < buf.length - 8; i++) {
      if (buf[i] === 0xff && buf[i + 1] === 0xc0) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) }
      }
    }
  }
  return null
}

type ToolResult = { content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>; isError?: boolean }

const RUNS_LIMIT = 50
const RUN_SCREENSHOTS_MAX = 4
/** Raw bytes across get_run's images, about 5.3 MB once base64'd. */
const RUN_SCREENSHOT_BYTES = 4 * 1024 * 1024

function ok(text: string): ToolResult {
  return { content: [{ type: 'text', text }] }
}

function err(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true }
}

export function registerTools(server: McpServer, client: TapflowClient): void {
  // Every tool first gives a rotated token its one reconnect (`reconnectIfRotated`), and a tool aimed at a session
  // the relay released because of it says so instead of failing for a reason it cannot name.
  const register = ((name: string, config: unknown, cb: (...args: unknown[]) => unknown) =>
    server.registerTool(name, config as never, (async (...args: unknown[]) => {
      await client.reconnectIfRotated().catch(() => { /* the tool reports the closed socket itself */ })
      // Only a tool whose schema has a sessionId gets its input as the first argument; a schema-less one gets the
      // SDK's request context there, whose own `sessionId` is a transport's, not a device's.
      const takesSession = (config as { inputSchema?: Record<string, unknown> }).inputSchema?.['sessionId'] !== undefined
      const sessionId = takesSession ? (args[0] as { sessionId?: unknown } | undefined)?.sessionId : undefined
      const note = name !== 'connect_device' && typeof sessionId === 'string' ? client.releasedByReconnect(sessionId) : undefined
      if (note) return err(`${name} failed: ${note}`)
      return cb(...args)
    }) as never)) as McpServer['registerTool']

  // The methodology is a tool rather than server instructions so that it costs nothing until it is asked for:
  // instructions ride along in every session, testing or not. See guide.ts.
  register(
    'get_testing_guide',
    { description: 'How to test a mobile feature with these tools: cases to cover, what cannot be tested here, how to avoid false bugs, how to save a verified flow, and the report format. Call once before testing.' },
    async () => ok(TESTING_GUIDE),
  )

  register(
    'list_builds',
    { description: 'List all apps and their builds available on the relay. Use this to find buildId before calling install_app or launch_app.' },
    async () => {
      try {
        const apps = await client.listBuilds()
        return ok(JSON.stringify(apps, null, 2))
      } catch (e) {
        return err(`list_builds failed: ${(e as Error).message}`)
      }
    },
  )

  register(
    'list_runs',
    {
      description:
        'List the flow runs `tapflow flow run` recorded on the relay (CI and local), newest first. Use it to find a failed ' +
        'run, then get_run to see why. When nextCursor is not null, pass it as "before" for the older runs. Read-only.',
      inputSchema: {
        status: z.enum(['running', 'passed', 'failed', 'aborted']).optional().describe('Only runs that ended this way ("aborted" is a cancelled run)'),
        buildId: z.number().int().optional().describe('Only runs of this build (from list_builds)'),
        flow: z.string().optional().describe('Only runs with a flow whose name contains this'),
        ci: z.boolean().optional().describe('true for CI runs only, false for local runs only'),
        limit: z.number().int().optional().describe(`How many (default 10, at most ${RUNS_LIMIT})`),
        before: z.string().optional().describe('nextCursor from an earlier list_runs, for the runs older than that page'),
      },
    },
    async ({ status, buildId, flow, ci, limit, before }) => {
      try {
        const page = await client.listRuns({ status, buildId, flow, ci, limit: limit ?? 10, before })
        return ok(JSON.stringify(page, null, 2))
      } catch (e) {
        return err(`list_runs failed: ${(e as Error).message}`)
      }
    },
  )

  register(
    'get_run',
    {
      description:
        'Read one recorded flow run: each failed flow\'s steps (a passed flow\'s step count, stepCount), failure message, ' +
        'whether the failure was the app ("product") or the environment, and the flow file\'s path. A failed tapOn step may ' +
        'carry "suggestions": lines that each tap one element on the screen it failed on. Screenshots of up to four failed flows come back as images (4 MB in all; one that is missing or over that is ' +
        'named in the text instead). A ' +
        'file path is as the runner was given it, relative to the directory it ran in (the CI job\'s, for a CI run), so ' +
        'find that file in your checkout before editing it; then replay it with run_flow. Read-only.',
      inputSchema: {
        runId: z.string().describe('Run id from list_runs'),
      },
    },
    async ({ runId }) => {
      try {
        const run = await client.getRun(runId)
        // A passed flow's steps are only counted: a suite of twenty flows with thirty steps each would otherwise be
        // tens of KB, and the failed flow an agent came for would sit at the end of it, where a client cuts. Compact
        // JSON for the same reason.
        const brief = {
          ...run,
          flows: run.flows.map(({ steps, ...f }) => (f.status === 'passed' ? { ...f, stepCount: steps?.length ?? 0 } : { ...f, ...(steps ? { steps } : {}) })),
        }
        const content: ToolResult['content'] = [{ type: 'text', text: JSON.stringify(brief) }]
        // Only failed flows: a passed flow's last screen is evidence for a person, and would only make the answer
        // larger here. Capped by count and by bytes, since each image is a screen's worth of tokens and a client may
        // refuse a whole answer over one large image.
        const failed = run.flows.filter((f) => f.status === 'failed' && f.hasScreenshot)
        let bytes = 0
        let attached = 0
        let tried = 0
        // Counted by images attached, not candidates: a screenshot that is gone does not use up a place.
        for (const f of failed) {
          if (attached === RUN_SCREENSHOTS_MAX) break
          tried++
          // One screenshot that cannot be read costs that screenshot, not the record already in hand.
          let shot: Awaited<ReturnType<typeof client.runScreenshot>>
          try {
            shot = await client.runScreenshot(run.id, f.idx)
          } catch (e) {
            content.push({ type: 'text', text: `Could not read the screenshot of ${f.name} (flow ${f.idx}): ${(e as Error).message}` })
            continue
          }
          if (shot && bytes + shot.data.length > RUN_SCREENSHOT_BYTES) {
            content.push({ type: 'text', text: `The screenshot of ${f.name} (flow ${f.idx}) is left out to keep this answer small; open the run's page (url) to see it.` })
            continue
          }
          if (shot) bytes += shot.data.length
          if (!shot) {
            content.push({ type: 'text', text: `There is no screenshot of ${f.name} (flow ${f.idx}) on the relay any more.` })
            continue
          }
          content.push({ type: 'text', text: `Screenshot of ${f.name} (flow ${f.idx}), where it failed:` })
          content.push({ type: 'image', data: shot.data.toString('base64'), mimeType: shot.mimeType })
          attached++
        }
        const left = failed.length - tried
        if (left > 0) content.push({ type: 'text', text: `${left} more failed flows have a screenshot; open the run's page (url) to see them.` })
        return { content }
      } catch (e) {
        return err(`get_run failed: ${(e as Error).message}`)
      }
    },
  )

  register(
    'list_devices',
    { description: 'List all available simulators and emulators registered on the tapflow relay.' },
    async () => {
      try {
        const sessions = await client.listDevices()
        return ok(JSON.stringify(sessions, null, 2))
      } catch (e) {
        return err(`list_devices failed: ${(e as Error).message}`)
      }
    },
  )

  register(
    'connect_device',
    {
      description: 'Join a device session so you can control it. Required before boot_device, install_app, and launch_app. ' +
        'The result carries watchUrl, a dashboard page where the person you are working for can watch the device ' +
        'live while you drive it — give them that link when you start testing. Before testing a feature, call ' +
        'get_testing_guide; when done, call disconnect_device so the device is free for others.',
      inputSchema: {
        sessionId: z.string().describe('Session ID from list_devices'),
      },
    },
    async ({ sessionId }) => {
      try {
        const { watchUrl } = await client.connectDevice(sessionId)
        return ok(JSON.stringify({ connected: true, sessionId, watchUrl }))
      } catch (e) {
        return err(`connect_device failed: ${(e as Error).message}`)
      }
    },
  )

  register(
    'disconnect_device',
    {
      description: 'End a device session and release the connection.',
      inputSchema: {
        sessionId: z.string().describe('Session ID to disconnect'),
      },
    },
    async ({ sessionId }) => {
      try {
        client.disconnectDevice(sessionId)
        return ok(JSON.stringify({ disconnected: true, sessionId }))
      } catch (e) {
        return err(`disconnect_device failed: ${(e as Error).message}`)
      }
    },
  )

  register(
    'boot_device',
    {
      description: 'Boot a simulator/emulator. Requires connect_device first. Waits up to 3 minutes for the device to be ready.',
      inputSchema: {
        sessionId: z.string().describe('Session ID from list_devices'),
        deviceId: z.string().describe('Device ID from list_devices'),
      },
    },
    async ({ sessionId, deviceId }) => {
      try {
        await client.bootDevice(sessionId, deviceId)
        return ok(JSON.stringify({ booted: true, sessionId, deviceId }))
      } catch (e) {
        return err(`boot_device failed: ${(e as Error).message}`)
      }
    },
  )

  register(
    'shutdown_device',
    {
      description:
        'Shut the session\'s booted simulator/emulator down — powers the device off to free resources or force a ' +
        'cold boot next time. Unlike disconnect_device (which only leaves the session, leaving the device running), ' +
        'this actually stops the device. Requires connect_device first. Waits up to 30 seconds.',
      inputSchema: {
        sessionId: z.string().describe('Session ID from list_devices'),
        deviceId: z.string().describe('Device ID from list_devices'),
      },
    },
    async ({ sessionId, deviceId }) => {
      try {
        await client.shutdownDevice(sessionId, deviceId)
        return ok(JSON.stringify({ shutdown: true, sessionId, deviceId }))
      } catch (e) {
        return err(`shutdown_device failed: ${(e as Error).message}`)
      }
    },
  )

  register(
    'query_ui_tree',
    {
      description:
        'Query the accessibility tree of the current screen: interactive, text-bearing or identified elements as ' +
        '{ role, label, identifier, placeholder, frame, enabled, rawRole }. placeholder is a text field\'s hint, present only ' +
        'when it has one; a bare-text selector falls back to it after label. Frames are normalized 0-1 relative to the screen. ' +
        'Prefer this over guessing coordinates from a screenshot: to tap an element, multiply the frame center by the ' +
        'screenshot pixel size — x = (frame.x + frame.width / 2) * screenshotWidth, y = (frame.y + frame.height / 2) * screenshotHeight — ' +
        'and pass those pixel coordinates to the tap tool.',
      inputSchema: {
        sessionId: z.string().describe('Session ID from list_devices'),
      },
    },
    async ({ sessionId }) => {
      try {
        const elements = await client.queryUITree(sessionId)
        return ok(JSON.stringify({ count: elements.length, elements }, null, 2))
      } catch (e) {
        return err(`query_ui_tree failed: ${(e as Error).message}`)
      }
    },
  )

  function flowResponse(result: FlowResult, appCheckSkipped?: string): Record<string, unknown> {
    let screenshotPath: string | undefined
    if (result.failureScreenshot) {
      screenshotPath = path.join(os.tmpdir(), `tapflow-flow-failure-${Date.now()}.png`)
      fs.writeFileSync(screenshotPath, result.failureScreenshot)
    }
    return {
      name: result.name,
      status: result.status,
      durationMs: result.durationMs,
      steps: result.steps,
      ...(result.failureMessage ? { failureMessage: result.failureMessage } : {}),
      ...(result.failureKind ? { failureKind: result.failureKind } : {}),
      ...(screenshotPath ? { failureScreenshotPath: screenshotPath } : {}),
      // The flow ran without its appId being compared with the build's, and why.
      ...(appCheckSkipped ? { appCheckSkipped } : {}),
    }
  }

  register(
    'run_flow',
    {
      description:
        'Replay a tapflow flow (YAML) deterministically — no LLM in the loop. Use this for verified scenarios instead of ' +
        'tapping step by step: author the flow once, then replay it idempotently. Pass the YAML inline via "flow", or a ' +
        'file path via "path" (resolved from the MCP server process cwd). Steps: clearState / launchApp / tapOn / ' +
        'inputText / pressKey / swipe / scroll / openUrl / assertVisible / assertNotVisible / pressButton / ' +
        'longPressOn / pinch / setOrientation / setPosture; scroll: { until: <selector> } scrolls to an element. launchApp launches the ' +
        'buildId argument. When buildId is set, the build is installed before replaying (like `tapflow flow run --build`) ' +
        'so clearState/launchApp have the app present — pass install:false to skip. A flow whose appId differs from ' +
        "the build's bundle id is not run and returns an error naming both. Returns per-step results; on failure " +
        'a screenshot is saved to a temp file.',
      inputSchema: {
        sessionId: z.string().describe('Session ID from list_devices (connect_device first)'),
        flow: z.string().optional().describe('Flow YAML content (inline)'),
        path: z.string().optional().describe('Path to a flow YAML file (alternative to "flow")'),
        buildId: z.number().int().optional().describe('Build under test — installed before replay and launched by the launchApp step (from list_builds)'),
        install: z.boolean().optional().describe('Install buildId before replaying (default: true when buildId is set)'),
      },
    },
    async ({ sessionId, flow, path: flowPath, buildId, install }) => {
      try {
        if ((flow === undefined) === (flowPath === undefined)) {
          return err('run_flow needs exactly one of "flow" (inline YAML) or "path"')
        }
        let yamlText: string
        if (flow !== undefined) {
          yamlText = flow
        } else {
          // Constrain file reads to the server cwd subtree — this tool loads
          // flow YAML, not arbitrary files. Anything else goes through "flow".
          const resolved = path.resolve(flowPath!)
          if (!resolved.startsWith(process.cwd() + path.sep)) {
            return err(`run_flow "path" must stay inside the MCP server working directory (${process.cwd()}) — pass the YAML inline via "flow" instead`)
          }
          yamlText = fs.readFileSync(resolved, 'utf-8')
        }
        const parsed = parseFlow(yamlText, flowPath ?? 'inline-flow.yaml')
        const platform = await platformOf(client, sessionId)
        // A button the platform has none of, refused before anything is installed — the same verdict `flow run`
        // reaches before it picks a device, and reported as the same result a run would give.
        if (platform !== undefined) {
          const missing = unavailableButton(parsed, platform)
          if (missing !== null && missing !== 'needs-chrome') {
            return ok(JSON.stringify(flowResponse(refusedFlow(parsed, missing.index, unavailableButtonMessage(missing, platform), { beforeRun: true })), null, 2))
          }
        }
        // The same check as `flow run --build`, before the device is touched. With one flow, "skipped" leaves nothing
        // run, which `flow run` also treats as an error rather than a pass.
        let appCheckSkipped: string | undefined
        if (buildId !== undefined) {
          const build = await client.lookupBuild(buildId)
          if (build.kind === 'not-found') return err(`run_flow: build ${buildId} not found (see list_builds)`)
          if (build.kind === 'found') {
            const verdict = isEligible(parsed, { build: { id: buildId, bundleId: build.bundleId } })
            if (!verdict.ok) return err(`run_flow did not run the flow: ${verdict.message} — set the flow's appId to the build's, remove it, or pick another build`)
          } else if (parsed.appId !== undefined) {
            appCheckSkipped = build.reason
          }
        }
        // Install the build before replaying (mirrors `flow run --build`) so clearState/launchApp find the app present; skip with install:false.
        if (buildId !== undefined && install !== false) {
          await client.installApp(sessionId, buildId)
        }
        const driver = makeFlowDriver(client, sessionId, buildId)
        // Each step as it starts, for whoever watches this session (A2); named without anything it types.
        const result = await runFlow(parsed, driver, {
          onStep: (mark) => { if (mark.phase === 'start' && mark.label) client.activity(sessionId, `step ${mark.index + 1}: ${mark.label}`) },
          ...(platform !== undefined ? { platform } : {}),
        })
        return ok(JSON.stringify(flowResponse(result, appCheckSkipped), null, 2))
      } catch (e) {
        return err(`run_flow failed: ${(e as Error).message}`)
      }
    },
  )

  register(
    'screenshot',
    {
      description: 'Capture the current screen of a device. Returns the image so you can analyze it.',
      inputSchema: {
        sessionId: z.string().describe('Session ID from list_devices'),
        format: z.enum(['png', 'jpeg']).optional().describe(
          'Preferred image format (default: png). Honoured on iOS; Android always returns PNG, and the ' +
          'response says so when it differs.',
        ),
      },
    },
    async ({ sessionId, format }) => {
      try {
        const requested = format ?? 'png'
        const buf = await client.screenshot(sessionId, requested)
        // The bytes decide, not what was asked for and not what the reply claims. Falling back to the
        // request when nothing matches keeps the old behaviour for a producer neither signature
        // covers, and says so rather than presenting a guess as a reading.
        const sniffed = sniffImageFormat(buf)
        const actual = sniffed ?? requested
        const mimeType = actual === 'jpeg' ? 'image/jpeg' : 'image/png'
        const ext = actual === 'jpeg' ? 'jpg' : 'png'
        const filename = `tapflow-${sessionId.slice(0, 8)}-${Date.now()}.${ext}`
        const filePath = path.join(os.tmpdir(), filename)
        fs.writeFileSync(filePath, buf)
        const dims = getImageDimensions(buf, actual)
        const dimText = dims ? ` (${dims.width}×${dims.height}px)` : ''
        // Named only when it differs, so the ordinary case stays quiet — and named at all because the
        // caller asked for something it did not get, and `tap` takes these dimensions as divisors.
        const formatNote = sniffed === null
          ? ` — the image is in an unrecognised format, read as ${requested}`
          : sniffed !== requested
            ? ` — ${requested} was requested but the device produced ${sniffed}`
            : ''
        return {
          content: [
            { type: 'image' as const, data: buf.toString('base64'), mimeType },
            { type: 'text' as const, text: `Screenshot saved: ${filePath}${dimText}${formatNote}` },
          ],
        }
      } catch (e) {
        return err(`screenshot failed: ${(e as Error).message}`)
      }
    },
  )

  register(
    'tap',
    {
      description: 'Tap at a pixel coordinate matching the screenshot. Use the width and height from the screenshot tool response.',
      inputSchema: {
        sessionId: z.string().describe('Session ID from list_devices'),
        x: z.number().describe('X pixel coordinate (from screenshot)'),
        y: z.number().describe('Y pixel coordinate (from screenshot, 0 = top)'),
        screenshotWidth: z.number().int().describe('Screenshot width in pixels (from screenshot tool)'),
        screenshotHeight: z.number().int().describe('Screenshot height in pixels (from screenshot tool)'),
        holdMs: z.number().optional().describe('Hold before releasing, ms: a long press (1000 typical)'),
      },
    },
    // A long press is a held tap rather than a tool of its own: every tool's schema rides in every session (the
    // budget in guide.test.ts), and a pinch is reachable through run_flow's `pinch` step.
    async ({ sessionId, x, y, screenshotWidth, screenshotHeight, holdMs }) => {
      try {
        if (holdMs !== undefined) await client.longPress(sessionId, x / screenshotWidth, y / screenshotHeight, holdMs)
        else await client.tap(sessionId, x / screenshotWidth, y / screenshotHeight)
        return ok(JSON.stringify({ tapped: true, x, y, ...(holdMs !== undefined ? { holdMs } : {}) }))
      } catch (e) {
        return err(`tap failed: ${(e as Error).message}`)
      }
    },
  )

  register(
    'swipe',
    {
      description: 'Swipe from one pixel coordinate to another. Use the width and height from the screenshot tool response.',
      inputSchema: {
        sessionId: z.string().describe('Session ID from list_devices'),
        startX: z.number().describe('Start X pixel coordinate (from screenshot)'),
        startY: z.number().describe('Start Y pixel coordinate (from screenshot, 0 = top)'),
        endX: z.number().describe('End X pixel coordinate (from screenshot)'),
        endY: z.number().describe('End Y pixel coordinate (from screenshot)'),
        screenshotWidth: z.number().int().describe('Screenshot width in pixels (from screenshot tool)'),
        screenshotHeight: z.number().int().describe('Screenshot height in pixels (from screenshot tool)'),
        durationMs: z.number().optional().describe('Swipe duration in milliseconds (default: 300)'),
      },
    },
    async ({ sessionId, startX, startY, endX, endY, screenshotWidth, screenshotHeight, durationMs }) => {
      try {
        await client.swipe(
          sessionId,
          startX / screenshotWidth,
          startY / screenshotHeight,
          endX / screenshotWidth,
          endY / screenshotHeight,
          durationMs,
        )
        return ok(JSON.stringify({ swiped: true, from: { x: startX, y: startY }, to: { x: endX, y: endY } }))
      } catch (e) {
        return err(`swipe failed: ${(e as Error).message}`)
      }
    },
  )

  register(
    'type_text',
    {
      description:
        'Type text into the currently focused input field (tap the field first). ' +
        'iOS supports arbitrary Unicode (pasted); Android supports ASCII only.',
      inputSchema: {
        sessionId: z.string().describe('Session ID from list_devices'),
        text: z.string().describe('Text to type into the focused field'),
      },
    },
    async ({ sessionId, text }) => {
      try {
        await client.typeText(sessionId, text)
        return ok(JSON.stringify({ typed: true, text }))
      } catch (e) {
        return err(`type_text failed: ${(e as Error).message}`)
      }
    },
  )

  register(
    'press_key',
    {
      description:
        'Press a keyboard key by its KeyboardEvent.code name: "Enter", "Backspace", "Escape", "Tab", ' +
        '"ArrowUp"/"ArrowDown"/"ArrowLeft"/"ArrowRight", letters as "KeyA".."KeyZ", digits as "Digit0".."Digit9". ' +
        '"Return" is accepted as an alias for "Enter". Use type_text for entering text.',
      inputSchema: {
        sessionId: z.string().describe('Session ID from list_devices'),
        key: z.string().describe('KeyboardEvent.code name (e.g. "Enter", "Backspace", "Escape")'),
      },
    },
    async ({ sessionId, key }) => {
      try {
        await client.pressKey(sessionId, key)
        return ok(JSON.stringify({ pressed: true, key }))
      } catch (e) {
        return err(`press_key failed: ${(e as Error).message}`)
      }
    },
  )

  register(
    'press_button',
    {
      description:
        'Press a hardware button by a cross-platform name: "home", "lock", "volume_up", "volume_down" work on both ' +
        'platforms. Android also has "back" and "recent_apps" (no-ops on iOS). Other names map to a device button ' +
        'only if that device exposes one.',
      inputSchema: {
        sessionId: z.string().describe('Session ID from list_devices'),
        button: z.string().describe('Button name (e.g. "home", "lock", "back")'),
      },
    },
    async ({ sessionId, button }) => {
      try {
        await client.pressButton(sessionId, button)
        return ok(JSON.stringify({ pressed: true, button }))
      } catch (e) {
        return err(`press_button failed: ${(e as Error).message}`)
      }
    },
  )

  register(
    'install_app',
    {
      description: 'Install an app on the device. Requires connect_device first. Waits up to 2 minutes.',
      inputSchema: {
        sessionId: z.string().describe('Session ID from list_devices'),
        buildId: z.number().int().describe('Build ID from the tapflow relay builds API'),
      },
    },
    async ({ sessionId, buildId }) => {
      try {
        await client.installApp(sessionId, buildId)
        return ok(JSON.stringify({ installed: true, buildId }))
      } catch (e) {
        return err(`install_app failed: ${(e as Error).message}`)
      }
    },
  )

  register(
    'launch_app',
    {
      description: 'Launch an installed app on the device. Requires connect_device first. Waits up to 15 seconds. ' +
        'Returning does not mean the app\'s first screen is up (iOS: the process started; Android: a first frame, which can be a splash): before a tap or ' +
        'swipe by coordinates, call query_ui_tree or screenshot until the screen you expect is there.',
      inputSchema: {
        sessionId: z.string().describe('Session ID from list_devices'),
        buildId: z.number().int().describe('Build ID from the tapflow relay builds API'),
        arguments: z.record(z.string(), z.union([z.string(), z.number().int(), z.boolean(), z.array(z.string())])).optional()
          .describe('Restarts a running app with these. iOS: -key value. Android: intent extras. env: iOS only'),
        env: z.record(z.string(), z.string()).optional(),
      },
    },
    async ({ sessionId, buildId, arguments: args, env }) => {
      // The same check the relay and the agents apply, answered before anything is sent.
      const problem = launchOptionsProblem({ arguments: args, env })
      if (problem) return err(`launch_app failed: ${problem}`)
      try {
        // `applied` names what reached the app, the relay's per-app defaults included.
        const applied = await client.launchApp(sessionId, buildId, compactLaunchOptions({ arguments: args, env }))
        return ok(JSON.stringify({ launched: true, buildId, ...(applied ? { applied } : {}) }))
      } catch (e) {
        return err(`launch_app failed: ${(e as Error).message}`)
      }
    },
  )
}
