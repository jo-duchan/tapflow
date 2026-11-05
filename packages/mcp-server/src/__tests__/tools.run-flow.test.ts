import { describe, it, expect, vi } from 'vitest'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { makeFlowDriver, registerTools } from '../tools.js'
import { SessionEndedError, SessionLeftError, type TapflowClient } from '../client.js'
import { EnvironmentStepError, isEnvironmentStepFailure, parseFlow, runFlow, TransientQueryError } from '@tapflowio/flow-runner'

type ToolResult = { content: unknown[]; isError?: boolean }
type Handler = (args: Record<string, unknown>) => Promise<ToolResult>

// Capture the tool handlers registered by registerTools so we can invoke run_flow directly.
function captureTools(client: TapflowClient): Map<string, Handler> {
  const handlers = new Map<string, Handler>()
  const server = {
    registerTool: (name: string, _config: unknown, handler: Handler) => { handlers.set(name, handler) },
  }
  registerTools(server as unknown as McpServer, client)
  return handlers
}

function fakeClient(calls: string[]): TapflowClient {
  return {
    installApp: vi.fn(async () => { calls.push('install') }),
    launchApp: vi.fn(async () => { calls.push('launch') }),
    clearState: vi.fn(async () => { calls.push('clearState') }),
    queryUITree: vi.fn(async () => []),
    queryUITreeWithTurn: vi.fn(async function (this: TapflowClient, ...args: Parameters<TapflowClient['queryUITree']>) {
      return { elements: await (this as unknown as { queryUITree: TapflowClient['queryUITree'] }).queryUITree(...args) }
    }),
    screenshot: vi.fn(async () => Buffer.from('')),
    tap: vi.fn(),
    swipe: vi.fn(async () => {}),
    typeText: vi.fn(async () => {}),
    pressKey: vi.fn(),
    openUrl: vi.fn(async () => {}),
    reconnectIfRotated: vi.fn(async () => {}),
    releasedByReconnect: vi.fn(() => undefined),
    activity: vi.fn(),
    lookupBuild: vi.fn(async () => ({ kind: 'unknown', reason: 'no token' })),
  } as unknown as TapflowClient
}

describe('run_flow — runs only a flow for the build\'s app', () => {
  const runFlowHandler = (client: TapflowClient) => captureTools(client).get('run_flow') as Handler
  const text = (res: ToolResult) => (res.content[0] as { text: string }).text
  const flow = 'appId: com.a\nsteps:\n  - clearState\n'

  it('refuses a flow for another app without installing or touching the device', async () => {
    const calls: string[] = []
    const client = fakeClient(calls)
    vi.mocked(client.lookupBuild).mockResolvedValue({ kind: 'found', bundleId: 'com.a.debug', platform: 'ios' })
    const res = await runFlowHandler(client)({ sessionId: 's1', flow, buildId: 5 })
    expect(res.isError).toBe(true)
    expect(text(res)).toContain('flow is for com.a, build 5 is com.a.debug')
    expect(calls).toEqual([])
  })

  it('runs a flow whose appId matches the build', async () => {
    const calls: string[] = []
    const client = fakeClient(calls)
    vi.mocked(client.lookupBuild).mockResolvedValue({ kind: 'found', bundleId: 'com.a', platform: 'ios' })
    const res = await runFlowHandler(client)({ sessionId: 's1', flow, buildId: 5 })
    expect(res.isError).toBeFalsy()
    expect(calls).toEqual(['install', 'clearState'])
  })

  it('says a build the relay does not have is not found', async () => {
    const calls: string[] = []
    const client = fakeClient(calls)
    vi.mocked(client.lookupBuild).mockResolvedValue({ kind: 'not-found' })
    const res = await runFlowHandler(client)({ sessionId: 's1', flow, buildId: 5 })
    expect(res.isError).toBe(true)
    expect(text(res)).toContain('build 5 not found')
    expect(calls).toEqual([])
  })

  // MCP reaches the device on loopback with no token; the build route needs one. That must not stop a run.
  it('runs the flow and says the app check was left out when the build cannot be looked up', async () => {
    const calls: string[] = []
    const client = fakeClient(calls)
    const res = await runFlowHandler(client)({ sessionId: 's1', flow, buildId: 5 })
    expect(res.isError).toBeFalsy()
    expect(calls).toEqual(['install', 'clearState'])
    expect(JSON.parse(text(res))).toMatchObject({ status: 'passed', appCheckSkipped: 'no token' })
  })

  it('does not look the build up without a buildId', async () => {
    const client = fakeClient([])
    await runFlowHandler(client)({ sessionId: 's1', flow })
    expect(client.lookupBuild).not.toHaveBeenCalled()
  })
})

// A2: whoever watches the session sees each step as it starts, named without anything it types.
describe('run_flow — tells watchers each step', () => {
  it('sends one activity per step start, with what is typed left out', async () => {
    const client = fakeClient([])
    await (captureTools(client).get('run_flow') as Handler)({ sessionId: 's1', flow: 'steps:\n  - pressKey: Enter\n  - inputText: "hunter2"\n' })
    expect(vi.mocked(client.activity).mock.calls).toEqual([['s1', 'step 1: pressKey(Enter)'], ['s1', 'step 2: inputText (7 chars)']])
  })
})

describe('run_flow — install before replay', () => {
  const runFlowHandler = (client: TapflowClient) => captureTools(client).get('run_flow') as Handler

  it('installs buildId before running the flow (default)', async () => {
    const calls: string[] = []
    const client = fakeClient(calls)
    // `launchApp` ends once the app shows a screen, so the fake has one.
    vi.mocked(client.queryUITree).mockResolvedValue([{ role: 'button', label: 'OK', frame: { x: 0, y: 0, width: 1, height: 1 }, enabled: true }])
    const res = await runFlowHandler(client)({ sessionId: 's1', flow: 'steps:\n  - launchApp\n', buildId: 5 })
    expect(res.isError).toBeFalsy()
    expect(client.installApp).toHaveBeenCalledWith('s1', 5)
    expect(calls).toEqual(['install', 'launch']) // install strictly before the launchApp step
  })

  // #1047. The driver's `launchApp` once took no parameter, which still satisfies the interface: a flow's launch
  // arguments would have run as a plain launch with nothing failing.
  it('passes a launchApp step\'s options to the client', async () => {
    const calls: string[] = []
    const client = fakeClient(calls)
    vi.mocked(client.queryUITree).mockResolvedValue([{ role: 'button', label: 'OK', frame: { x: 0, y: 0, width: 1, height: 1 }, enabled: true }])
    const res = await runFlowHandler(client)({ sessionId: 's1', flow: 'steps:\n  - launchApp: { arguments: { flag: true }, env: { A: x } }\n', buildId: 5, install: false })
    expect(res.isError).toBeFalsy()
    expect(client.launchApp).toHaveBeenCalledWith('s1', 5, { arguments: { flag: true }, env: { A: 'x' } })
  })

  it('install:false skips the install but still launches', async () => {
    const calls: string[] = []
    const client = fakeClient(calls)
    // `launchApp` ends once the app shows a screen, so the fake has one.
    vi.mocked(client.queryUITree).mockResolvedValue([{ role: 'button', label: 'OK', frame: { x: 0, y: 0, width: 1, height: 1 }, enabled: true }])
    await runFlowHandler(client)({ sessionId: 's1', flow: 'steps:\n  - launchApp\n', buildId: 5, install: false })
    expect(client.installApp).not.toHaveBeenCalled()
    expect(calls).toEqual(['launch'])
  })

  it('no buildId → nothing to install', async () => {
    const calls: string[] = []
    const client = fakeClient(calls)
    await runFlowHandler(client)({ sessionId: 's1', flow: 'steps:\n  - clearState: com.example.app\n' })
    expect(client.installApp).not.toHaveBeenCalled()
    expect(calls).toEqual(['clearState'])
  })

  it('missing buildId on launchApp is an environment failure', async () => {
    const calls: string[] = []
    const client = fakeClient(calls)
    const driver = makeFlowDriver(client, 's1', undefined)
    await expect(driver.launchApp()).rejects.toBeInstanceOf(EnvironmentStepError)
    await expect(driver.launchApp()).rejects.toThrow('pass buildId')
    const err = await driver.launchApp().catch((e: unknown) => e as Error)
    expect(isEnvironmentStepFailure(err)).toBe(true)

    // Also verify runFlow classifies it as environment when flowing through the engine
    const flow = parseFlow('steps:\n  - launchApp\n', 'f.yaml')
    const result = await runFlow(flow, driver)
    expect(result.status).toBe('failed')
    expect(result.failureKind).toBe('environment')
    expect(result.failureMessage).toContain('buildId')
  })

  it('passes the engine selector deadline signal to the client', async () => {
    const calls: string[] = []
    const client = fakeClient(calls)
    vi.mocked(client.queryUITree).mockImplementation(async (_sessionId, signal) => {
      expect(signal).toBeInstanceOf(AbortSignal)
      return [{
        role: 'button',
        label: 'OK',
        frame: { x: 0, y: 0, width: 1, height: 1 },
        enabled: true,
      }]
    })
    const res = await runFlowHandler(client)({ sessionId: 's1', flow: 'steps:\n  - assertVisible: "OK"\n' })
    expect(res.isError).toBeFalsy()
  })

  it('retries a transient ui-tree response until the selector resolves', async () => {
    const calls: string[] = []
    const client = fakeClient(calls)
    let attempts = 0
    vi.mocked(client.queryUITree).mockImplementation(async () => {
      if (attempts++ === 0) throw new TransientQueryError('temporary relay failure')
      return [{
        role: 'button',
        label: 'OK',
        frame: { x: 0, y: 0, width: 1, height: 1 },
        enabled: true,
      }]
    })
    const res = await runFlowHandler(client)({ sessionId: 's1', flow: 'steps:\n  - assertVisible: "OK"\n' })
    expect(res.isError).toBeFalsy()
    expect(client.queryUITree).toHaveBeenCalledTimes(2)
  })

  it('surfaces an install failure as a run_flow error and never runs the flow', async () => {
    const calls: string[] = []
    const client = fakeClient(calls)
    vi.mocked(client.installApp).mockRejectedValueOnce(new Error('device offline'))
    const res = await runFlowHandler(client)({ sessionId: 's1', flow: 'steps:\n  - launchApp\n', buildId: 5 })
    expect(res.isError).toBe(true)
    expect(JSON.stringify(res.content)).toContain('device offline')
    expect(calls).toEqual([]) // install rejected → launchApp step never reached
  })

  it('returns failureKind so callers never branch on prose', async () => {
    const calls: string[] = []
    const client = fakeClient(calls)
    // Immediate permanent failure (no polling): fails fast with product kind.
    vi.mocked(client.queryUITree).mockRejectedValueOnce(new Error('Session not found'))
    const res = await runFlowHandler(client)({ sessionId: 's1', flow: 'steps:\n  - assertVisible: "OK"\n' })
    expect(res.isError).toBeFalsy()
    const payload = JSON.parse((res.content[0] as { text: string }).text)
    expect(payload.status).toBe('failed')
    expect(payload.failureKind).toBe('product')
  })

  it('classifies environmental input refusals like the CLI RelayDriver', async () => {
    const calls: string[] = []
    const client = fakeClient(calls)
    const driver = makeFlowDriver(client, 's1', 5)
    // Same wire shape TapflowClient.failed() builds for an environmental reason.
    vi.mocked(client.tap).mockRejectedValueOnce(new Error('tap was refused by the device (channel-unavailable): x — the input channel is gone'))
    const flow = parseFlow('steps:\n  - tapOn: "OK"\n', 'f.yaml')
    vi.mocked(client.queryUITree).mockResolvedValue([{ role: 'button', label: 'OK', frame: { x: 0, y: 0, width: 1, height: 1 }, enabled: true }])
    const result = await runFlow(flow, driver)
    expect(result.status).toBe('failed')
    expect(result.failureKind).toBe('environment')
  })

  it('keeps product input refusals (no-gesture) as product', async () => {
    const calls: string[] = []
    const client = fakeClient(calls)
    const driver = makeFlowDriver(client, 's1', 5)
    vi.mocked(client.tap).mockRejectedValueOnce(new Error('tap was refused by the device (no-gesture): unsure — part of it may already have been applied'))
    const flow = parseFlow('steps:\n  - tapOn: "OK"\n', 'f.yaml')
    vi.mocked(client.queryUITree).mockResolvedValue([{ role: 'button', label: 'OK', frame: { x: 0, y: 0, width: 1, height: 1 }, enabled: true }])
    const result = await runFlow(flow, driver)
    expect(result.status).toBe('failed')
    expect(result.failureKind).toBe('product')
  })

  it('maps ended and left sessions to environment like the CLI RelayDriver', async () => {
    // TapflowClient rethrows these as their own class with prose that carries
    // no session-note marker, so message matching alone would call them product.
    const cases = [
      new SessionEndedError('tap failed: the relay ended session s1 (agent-disconnected) while it was in flight', 'agent-disconnected'),
      new SessionLeftError('tap failed: this client left session s1 while the request was in flight'),
    ]
    for (const original of cases) {
      const calls: string[] = []
      const client = fakeClient(calls)
      const driver = makeFlowDriver(client, 's1', 5)
      vi.mocked(client.tap).mockRejectedValueOnce(original)
      const flow = parseFlow('steps:\n  - tapOn: "OK"\n', 'f.yaml')
      vi.mocked(client.queryUITree).mockResolvedValue([{ role: 'button', label: 'OK', frame: { x: 0, y: 0, width: 1, height: 1 }, enabled: true }])
      const result = await runFlow(flow, driver)
      expect(result.status).toBe('failed')
      expect(result.failureKind).toBe('environment')
      expect(result.failureMessage).toBe(`tapOn("OK"): ${original.message}`)
    }
  })

  it('maps unconfirmed input to environment like InputUnconfirmedError', async () => {
    const calls: string[] = []
    const client = fakeClient(calls)
    const driver = makeFlowDriver(client, 's1', 5)
    vi.mocked(client.tap).mockRejectedValueOnce(new Error('Could not confirm the input reached the device: this session has acknowledged input before, and this one went unanswered. Do not repeat the input.'))
    const flow = parseFlow('steps:\n  - tapOn: "OK"\n', 'f.yaml')
    vi.mocked(client.queryUITree).mockResolvedValue([{ role: 'button', label: 'OK', frame: { x: 0, y: 0, width: 1, height: 1 }, enabled: true }])
    const result = await runFlow(flow, driver)
    expect(result.status).toBe('failed')
    expect(result.failureKind).toBe('environment')
  })
})

describe('launch_app — launch options', () => {
  const launchHandler = (client: TapflowClient) => captureTools(client).get('launch_app') as Handler

  it('passes arguments and env, with empty maps dropped', async () => {
    const client = fakeClient([])
    await launchHandler(client)({ sessionId: 's1', buildId: 5, arguments: { flag: true }, env: {} })
    expect(client.launchApp).toHaveBeenCalledWith('s1', 5, { arguments: { flag: true } })
    await launchHandler(client)({ sessionId: 's1', buildId: 5 })
    expect(client.launchApp).toHaveBeenLastCalledWith('s1', 5, undefined)
  })

  // #1047, PR 2: the relay's per-app defaults reach the app without the agent naming them, so the result does.
  it('reports the applied keys, defaults included', async () => {
    const client = fakeClient([])
    vi.mocked(client.launchApp).mockResolvedValue({ arguments: ['a'], env: ['LOG_LEVEL'] })
    const res = await launchHandler(client)({ sessionId: 's1', buildId: 5 })
    expect(JSON.parse((res.content as { text: string }[])[0]!.text)).toEqual({ launched: true, buildId: 5, applied: { arguments: ['a'], env: ['LOG_LEVEL'] } })
  })

  // The interface allows `void`, so a driver that dropped the value would compile and lose the run record's names.
  it('passes the applied keys through the run_flow driver', async () => {
    const client = fakeClient([])
    vi.mocked(client.launchApp).mockResolvedValue({ arguments: ['a'], env: [] })
    expect(await makeFlowDriver(client, 's1', 5).launchApp()).toEqual({ arguments: ['a'], env: [] })
  })

  it('refuses what the shared check refuses, before calling the relay', async () => {
    const client = fakeClient([])
    const res = await launchHandler(client)({ sessionId: 's1', buildId: 5, env: { DYLD_INSERT_LIBRARIES: 'x' } })
    expect(res.isError).toBe(true)
    expect((res.content as { text: string }[])[0]!.text).toMatch(/reserved/)
    expect(client.launchApp).not.toHaveBeenCalled()
  })
})

// D1: a button the device lacks is refused before anything is installed or pressed, as `flow run` refuses it.
describe('run_flow — a button the device lacks', () => {
  const runFlowHandler = (client: TapflowClient) => captureTools(client).get('run_flow') as Handler
  const text = (res: ToolResult) => (res.content[0] as { text: string }).text
  const onPlatform = (client: TapflowClient, platform: string) => {
    ;(client as unknown as { listDevices: () => Promise<unknown> }).listDevices = vi.fn(async () => [
      { platform: 'android', devices: [{ sessionId: 'other' }] },
      { platform, devices: [{ sessionId: 's1' }] },
    ])
    ;(client as unknown as { pressButton: () => Promise<void> }).pressButton = vi.fn(async () => {})
  }

  it('refuses back on iOS without installing, as a result the run would have given', async () => {
    const calls: string[] = []
    const client = fakeClient(calls)
    onPlatform(client, 'ios')
    const res = await runFlowHandler(client)({ sessionId: 's1', flow: 'steps:\n  - pressButton: back\n', buildId: 5 })
    expect(res.isError).toBeFalsy()
    expect(JSON.parse(text(res))).toMatchObject({ status: 'failed', failureKind: 'environment', failureMessage: expect.stringMatching(/iOS has no "back" button/) })
    expect(calls).toEqual([])
    expect(client.installApp).not.toHaveBeenCalled()
  })

  it('presses it where the platform has it', async () => {
    const client = fakeClient([])
    onPlatform(client, 'android')
    const res = await runFlowHandler(client)({ sessionId: 's1', flow: 'steps:\n  - pressButton: back\n' })
    expect(JSON.parse(text(res))).toMatchObject({ status: 'passed' })
    expect((client as unknown as { pressButton: ReturnType<typeof vi.fn> }).pressButton).toHaveBeenCalledWith('s1', 'back')
  })

  // What only the device knows: iOS's lock exists when the device's chrome declares a power button it can press.
  it('checks an iOS button that depends on the device against its chrome before the first step', async () => {
    const client = fakeClient([])
    onPlatform(client, 'ios')
    ;(client as unknown as Record<string, unknown>).chrome = vi.fn(async () => ({
      framePng: '', bezelWidth: 1, bezelHeight: 1, compositeWidth: 1, compositeHeight: 1,
      padding: { left: 0, right: 0, top: 0, bottom: 0 }, screenRect: { x: 0, y: 0, width: 1, height: 1 },
      screenCornerRadius: 0, logicalWidth: 1, logicalHeight: 1,
      buttons: [{ name: 'power', accessibilityTitle: 'Power', anchor: 'right', onTop: false, normalOffset: { x: 0, y: 0 }, rolloverOffset: { x: 0, y: 0 }, buttonW: 1, buttonH: 1, usagePage: 12, usage: 0 }],
    }))
    const res = await runFlowHandler(client)({ sessionId: 's1', flow: 'steps:\n  - pressButton: lock\n' })
    expect(JSON.parse(text(res))).toMatchObject({ status: 'failed', failureKind: 'environment', failureMessage: expect.stringMatching(/this device has no "lock" button/) })
    expect((client as unknown as { pressButton: ReturnType<typeof vi.fn> }).pressButton).not.toHaveBeenCalled()
  })

  it('runs unchecked when the listing does not name the session\'s platform', async () => {
    const client = fakeClient([])
    ;(client as unknown as { pressButton: () => Promise<void> }).pressButton = vi.fn(async () => {})
    const res = await runFlowHandler(client)({ sessionId: 's1', flow: 'steps:\n  - pressButton: back\n' })
    expect(JSON.parse(text(res))).toMatchObject({ status: 'passed' })
  })
})

describe('makeFlowDriver — a pinch refused as unsupported', () => {
  it('is the environment\'s, while any other unsupported refusal stays the product\'s', async () => {
    const client = fakeClient([])
    const refused = (what: string) => async () => { throw new Error(`${what} was refused (unsupported) — not available on this path`) }
    ;(client as unknown as Record<string, unknown>).pinch = vi.fn(refused('Input'))
    ;(client as unknown as Record<string, unknown>).pressButton = vi.fn(refused('Input'))
    const driver = makeFlowDriver(client, 's1', undefined)
    expect(isEnvironmentStepFailure(await driver.pinch([[0.4, 0.5], [0.6, 0.5]], [[0.2, 0.5], [0.8, 0.5]], 100).catch((e: unknown) => e))).toBe(true)
    expect(isEnvironmentStepFailure(await driver.pressButton('x').catch((e: unknown) => e))).toBe(false)
  })
})

describe('tap — holdMs is a long press', () => {
  it('holds when asked and taps when not', async () => {
    const client = fakeClient([])
    ;(client as unknown as Record<string, unknown>).longPress = vi.fn(async () => {})
    const tap = captureTools(client).get('tap') as Handler
    await tap({ sessionId: 's1', x: 50, y: 100, screenshotWidth: 100, screenshotHeight: 200, holdMs: 1200 })
    expect((client as unknown as { longPress: ReturnType<typeof vi.fn> }).longPress).toHaveBeenCalledWith('s1', 0.5, 0.5, 1200)
    expect(client.tap).not.toHaveBeenCalled()
    await tap({ sessionId: 's1', x: 50, y: 100, screenshotWidth: 100, screenshotHeight: 200 })
    expect(client.tap).toHaveBeenCalledWith('s1', 0.5, 0.5)
  })
})

// The same rule as flow-runner's RelayDriver: a point is turned by the app's turn from the latest tree this run read.
describe('makeFlowDriver — points turned by the app\'s interface turn', () => {
  it('turns a tap by 270 after a tree said so, and not before', async () => {
    const client = fakeClient([])
    ;(client as unknown as Record<string, unknown>).queryUITreeWithTurn = vi.fn(async () => ({ elements: [], interfaceTurn: 270 }))
    const driver = makeFlowDriver(client, 's1', undefined)
    await driver.tap(0.25, 0.1)
    await driver.queryUITree()
    await driver.tap(0.25, 0.1)
    expect(vi.mocked(client.tap).mock.calls).toEqual([['s1', 0.25, 0.1], ['s1', 0.9, 0.25]])
  })

  // The runner answers 0 — no turn on the wire — when its two reads of the app disagree, most likely right after the
  // chrome said the device turned. On iOS that read is passed over; on Android the first read ends the wait.
  it('passes over a read with no turn on iOS after setOrientation, and stops at once on Android', async () => {
    const ios = fakeClient([])
    const reads = [undefined, 270, 270]
    Object.assign(ios, {
      setOrientation: vi.fn(async () => {}),
      chrome: vi.fn(async () => ({ framePng: '', buttons: [] })),
      queryUITreeWithTurn: vi.fn(async () => ({ elements: [], interfaceTurn: reads.shift() })),
    })
    const driver = makeFlowDriver(ios, 's1', undefined)
    await driver.setOrientation!('landscape', 1000)
    await driver.tap(0.25, 0.1)
    expect(ios.tap).toHaveBeenCalledWith('s1', 0.9, 0.25)

    const android = fakeClient([])
    const read = vi.fn(async () => ({ elements: [] }))
    Object.assign(android, {
      setOrientation: vi.fn(async () => {}),
      chrome: vi.fn(async () => ({ buttons: [], streamType: 'h264', bodyRotation: 90 })),
      queryUITreeWithTurn: read,
    })
    await makeFlowDriver(android, 's1', undefined).setOrientation!('landscape', 1000)
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('drops the turn from before setOrientation when the settle never reads one', async () => {
    const client = fakeClient([])
    const reads: Array<() => { elements: never[]; interfaceTurn?: number }> = [
      () => ({ elements: [], interfaceTurn: 90 }), () => ({ elements: [] }), () => { throw new Error('tree read failed') },
    ]
    Object.assign(client, {
      setOrientation: vi.fn(async () => {}),
      chrome: vi.fn(async () => ({ framePng: '', buttons: [] })),
      queryUITreeWithTurn: vi.fn(async () => reads.shift()!()),
    })
    const driver = makeFlowDriver(client, 's1', undefined)
    await driver.queryUITree()
    await driver.setOrientation!('portrait', 1000)
    await driver.tap(0.25, 0.1)
    expect(client.tap).toHaveBeenCalledWith('s1', 0.25, 0.1)
  })

  it('does not carry a turn from one driver to the next', async () => {
    const client = fakeClient([])
    ;(client as unknown as Record<string, unknown>).queryUITreeWithTurn = vi.fn(async () => ({ elements: [], interfaceTurn: 90 }))
    await makeFlowDriver(client, 's1', undefined).queryUITree()
    await makeFlowDriver(client, 's1', undefined).tap(0.25, 0.1)
    expect(client.tap).toHaveBeenCalledWith('s1', 0.25, 0.1)
  })
})
