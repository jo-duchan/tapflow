import * as z from 'zod'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { EnvironmentStepError, parseFlow, runFlow, type FlowDriver } from '@tapflowio/flow-runner'
import { SessionEndedError, SessionLeftError, type TapflowClient } from './client.js'

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
  return {
    queryUITree: (signal) => guard(() => client.queryUITree(sessionId, signal)),
    tap: async (x, y) => guard(() => client.tap(sessionId, x, y)),
    swipe: (from, to, durationMs) => guard(() => client.swipe(sessionId, from[0], from[1], to[0], to[1], durationMs)),
    inputText: async (text) => guard(() => client.typeText(sessionId, text)),
    pressKey: async (code) => guard(() => client.pressKey(sessionId, code)),
    openUrl: (url) => guard(() => client.openUrl(sessionId, url)),
    launchApp: async () => {
      if (buildId === undefined) {
        throw new EnvironmentStepError('this flow uses launchApp — pass buildId (see list_builds)')
      }
      await guard(() => client.launchApp(sessionId, buildId))
    },
    clearState: (appId) => guard(() => client.clearState(sessionId, appId)),
    screenshot: (signal) => guard(() => client.screenshot(sessionId, 'png', signal)),
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

function ok(text: string): ToolResult {
  return { content: [{ type: 'text', text }] }
}

function err(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true }
}

export function registerTools(server: McpServer, client: TapflowClient): void {
  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
    'connect_device',
    {
      description: 'Join a device session so you can control it. Required before boot_device, install_app, and launch_app. ' +
        'The result carries watchUrl, a dashboard page where the person you are working for can watch the device ' +
        'live while you drive it — give them that link when you start testing.',
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

  server.registerTool(
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

  server.registerTool(
    'boot_device',
    {
      description: 'Boot a simulator/emulator. Requires connect_device first. Waits up to 30 seconds for the device to be ready.',
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

  server.registerTool(
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

  server.registerTool(
    'query_ui_tree',
    {
      description:
        'Query the accessibility tree of the current screen: interactive and text-bearing elements as ' +
        '{ role, label, identifier, frame, enabled, rawRole }. Frames are normalized 0-1 relative to the screen. ' +
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

  server.registerTool(
    'run_flow',
    {
      description:
        'Replay a tapflow flow (YAML) deterministically — no LLM in the loop. Use this for verified scenarios instead of ' +
        'tapping step by step: author the flow once, then replay it idempotently. Pass the YAML inline via "flow", or a ' +
        'file path via "path" (resolved from the MCP server process cwd). Steps: clearState / launchApp / tapOn / ' +
        'inputText / pressKey / swipe / scroll / openUrl / assertVisible / assertNotVisible. launchApp launches the ' +
        'buildId argument. When buildId is set, the build is installed before replaying (like `tapflow flow run --build`) ' +
        'so clearState/launchApp have the app present — pass install:false to skip. Returns per-step results; on failure ' +
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
        // Install the build before replaying (mirrors `flow run --build`) so clearState/launchApp find the app present; skip with install:false.
        if (buildId !== undefined && install !== false) {
          await client.installApp(sessionId, buildId)
        }
        const driver = makeFlowDriver(client, sessionId, buildId)
        const result = await runFlow(parsed, driver)

        let screenshotPath: string | undefined
        if (result.failureScreenshot) {
          screenshotPath = path.join(os.tmpdir(), `tapflow-flow-failure-${Date.now()}.png`)
          fs.writeFileSync(screenshotPath, result.failureScreenshot)
        }
        return ok(JSON.stringify({
          name: result.name,
          status: result.status,
          durationMs: result.durationMs,
          steps: result.steps,
          ...(result.failureMessage ? { failureMessage: result.failureMessage } : {}),
          ...(result.failureKind ? { failureKind: result.failureKind } : {}),
          ...(screenshotPath ? { failureScreenshotPath: screenshotPath } : {}),
        }, null, 2))
      } catch (e) {
        return err(`run_flow failed: ${(e as Error).message}`)
      }
    },
  )

  server.registerTool(
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

  server.registerTool(
    'tap',
    {
      description: 'Tap at a pixel coordinate matching the screenshot. Use the width and height from the screenshot tool response.',
      inputSchema: {
        sessionId: z.string().describe('Session ID from list_devices'),
        x: z.number().describe('X pixel coordinate (from screenshot)'),
        y: z.number().describe('Y pixel coordinate (from screenshot, 0 = top)'),
        screenshotWidth: z.number().int().describe('Screenshot width in pixels (from screenshot tool)'),
        screenshotHeight: z.number().int().describe('Screenshot height in pixels (from screenshot tool)'),
      },
    },
    async ({ sessionId, x, y, screenshotWidth, screenshotHeight }) => {
      try {
        await client.tap(sessionId, x / screenshotWidth, y / screenshotHeight)
        return ok(JSON.stringify({ tapped: true, x, y }))
      } catch (e) {
        return err(`tap failed: ${(e as Error).message}`)
      }
    },
  )

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
    'install_app',
    {
      description: 'Install an app on the device. Requires connect_device first. Waits up to 60 seconds.',
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

  server.registerTool(
    'launch_app',
    {
      description: 'Launch an installed app on the device. Requires connect_device first. Waits up to 15 seconds.',
      inputSchema: {
        sessionId: z.string().describe('Session ID from list_devices'),
        buildId: z.number().int().describe('Build ID from the tapflow relay builds API'),
      },
    },
    async ({ sessionId, buildId }) => {
      try {
        await client.launchApp(sessionId, buildId)
        return ok(JSON.stringify({ launched: true, buildId }))
      } catch (e) {
        return err(`launch_app failed: ${(e as Error).message}`)
      }
    },
  )
}
