import { describe, it, expect, vi } from 'vitest'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { BrowserToRelay, CaptureObservation, UIElement } from '@tapflowio/protocol'
import { registerTools } from '../tools.js'
import type { TapflowClient } from '../client.js'
import { AgentCaptureRecorder, KEEP_AFTER_RELEASE_MS } from '../capture.js'

// MCP Flow Capture (L6a): the agent's actions recorded by this server, judged with capture_flow, verified from a reset.
type ToolResult = { content: Array<{ type: string; text?: string }>; isError?: boolean }
type Handler = (args: Record<string, unknown>) => Promise<ToolResult>

const LOGIN: UIElement = { role: 'button', label: 'Log in', identifier: 'login', enabled: true, frame: { x: 0.1, y: 0.8, width: 0.3, height: 0.05 } }
const FORMS: UIElement = { role: 'button', label: 'Forms', identifier: 'forms', enabled: true, frame: { x: 0.5, y: 0.8, width: 0.3, height: 0.05 } }
const WELCOME: UIElement = { role: 'text', label: 'Welcome back', enabled: true, frame: { x: 0.1, y: 0.3, width: 0.8, height: 0.05 } }
const field = (over: Partial<UIElement>): UIElement =>
  ({ role: 'input', label: 'Field', identifier: 'field', enabled: true, focused: true, frame: { x: 0.1, y: 0.4, width: 0.8, height: 0.05 }, ...over })

function harness(opts: { observe?: () => Promise<boolean>; platform?: string } = {}) {
  const sends = new Set<(m: BrowserToRelay) => void>()
  const observations = new Set<(m: CaptureObservation) => void>()
  let n = 0
  const touchIds: string[] = []
  let screen: UIElement[] = [LOGIN, FORMS]
  const touchEnd = (sessionId: string) => {
    const requestId = `t${++n}`
    touchIds.push(requestId)
    for (const l of sends) l({ type: 'input:touch:end', sessionId, requestId, payload: { x: 0, y: 0 } })
  }
  const client = {
    onSend: (l: (m: BrowserToRelay) => void) => { sends.add(l); return () => sends.delete(l) },
    onObservation: (l: (m: CaptureObservation) => void) => { observations.add(l); return () => observations.delete(l) },
    connectDevice: vi.fn(async () => ({ watchUrl: 'http://relay/watch' })),
    disconnectDevice: vi.fn(),
    observe: vi.fn(opts.observe ?? (async () => true)),
    listDevices: vi.fn(async () => [{ platform: opts.platform ?? 'ios', devices: [{ sessionId: 's1' }, { sessionId: 's2' }] }]),
    queryUITreeWithTurn: vi.fn(async () => ({ elements: screen })),
    queryUITree: vi.fn(async () => screen),
    reach: vi.fn(async (_s: string, targets: unknown[]) => targets.map(() => ({ state: 'unknown', reason: 'test' }))),
    tap: vi.fn(async (s: string) => { touchEnd(s) }),
    longPress: vi.fn(async (s: string) => { touchEnd(s) }),
    swipe: vi.fn(async (s: string) => { touchEnd(s) }),
    typeText: vi.fn(async (_s: string, _text: string) => {}),
    pressKey: vi.fn(async () => {}),
    pressButton: vi.fn(async () => {}),
    launchApp: vi.fn(async () => undefined),
    installApp: vi.fn(async () => {}),
    clearState: vi.fn(async () => {}),
    lookupBuild: vi.fn(async () => ({ kind: 'found', bundleId: 'com.app', platform: 'ios' })),
    chrome: vi.fn(async () => null),
    runReset: vi.fn(async () => ({ done: ['app-reinstall'], failed: [] })),
    screenshot: vi.fn(async () => Buffer.from('png')),
    reconnectIfClosed: vi.fn(async () => {}),
    releasedByReconnect: vi.fn(() => undefined),
    activity: vi.fn(),
  }
  const handlers = new Map<string, Handler>()
  const server = { registerTool: (name: string, _config: unknown, handler: Handler) => { handlers.set(name, handler) } }
  registerTools(server as unknown as McpServer, client as unknown as TapflowClient)
  const call = (name: string, args: Record<string, unknown> = {}) => handlers.get(name)!(args)
  const json = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await call(name, args)
    return { res, body: JSON.parse(res.content[0]!.text!) as Record<string, unknown> }
  }
  return {
    client, call, json, touchIds,
    show: (elements: UIElement[]) => { screen = elements },
    observe: (msg: Omit<CaptureObservation, 'type' | 'sessionId'>, sessionId = 's1') => {
      for (const l of observations) l({ type: 'capture:observation', sessionId, ...msg })
    },
  }
}

type Listed = { steps: Array<{ n: number; step: Record<string, unknown>; origin: string; expect?: Array<{ candidate: number; selector: Record<string, unknown> }> }>; notes?: string[] }

describe('MCP Flow Capture', () => {
  it('records element taps as the agent named them, and returns the flow once it replays from a reset', async () => {
    const h = harness()
    // The app: Log in leads to Welcome, and a reset brings Log in back.
    const tap = h.client.tap.getMockImplementation()!
    h.client.tap.mockImplementation(async (s: string) => { await tap(s); h.show([WELCOME, FORMS]) })
    h.client.runReset.mockImplementation(async () => { h.show([LOGIN, FORMS]); return { done: ['app-reinstall'], failed: [] } })
    const { body: opened } = await h.json('connect_device', { sessionId: 's1', capture: true })
    expect(opened.capture).toMatchObject({ open: true, observing: true })
    expect(h.client.observe).toHaveBeenCalledWith('s1', true)
    await h.call('launch_app', { sessionId: 's1', buildId: 7 })
    await h.call('query_ui_tree', { sessionId: 's1' })
    await h.call('tap', { sessionId: 's1', element: { id: 'login' } })
    // A read in the same millisecond as the tap is not after it; a device takes longer than that.
    await new Promise((r) => setTimeout(r, 2))
    await h.call('query_ui_tree', { sessionId: 's1' })

    const { body: list } = await h.json('list_captured_steps')
    const steps = (list as unknown as Listed).steps
    expect(steps.map((s) => [s.n, s.step, s.origin])).toEqual([
      [1, { type: 'launchApp' }, 'agent'],
      // The wait the tool added to find the element is not written.
      [2, { type: 'tapOn', selector: { id: 'login' } }, 'agent'],
    ])
    const welcome = steps[1]!.expect!.find((c) => c.selector['label'] === 'Welcome back')!

    const { res, body } = await h.json('capture_flow', { sessionId: 's1', name: 'login', expect: [{ step: 2, candidate: welcome.candidate }] })
    expect(res.isError).toBeFalsy()
    expect(body).toMatchObject({ verified: true, attempt: 1 })
    expect(h.client.runReset).toHaveBeenCalledWith('s1', ['com.app'])
    expect(body['yaml']).toContain('appId: com.app')
    expect(body['yaml']).toContain('assertVisible')

    // The Verify's own taps are not the agent's: the list is what it was (test 18).
    const { body: again } = await h.json('list_captured_steps')
    expect((again as unknown as Listed).steps).toEqual(steps)
  })

  it('names a tap by coordinates by what the touch was seen to hit, carried in the app\'s space', async () => {
    const h = harness()
    await h.call('connect_device', { sessionId: 's1', capture: true })
    await h.call('query_ui_tree', { sessionId: 's1' })
    await h.call('tap', { sessionId: 's1', x: 65, y: 164, screenshotWidth: 100, screenshotHeight: 200 })
    h.observe({ requestId: h.touchIds.at(-1)!, touched: { point: { x: 0.65, y: 0.82 }, moving: false, element: { identifier: 'forms', traits: 1 } } })
    await h.call('tap', { sessionId: 's1', x: 90, y: 10, screenshotWidth: 100, screenshotHeight: 200 })
    const steps = ((await h.json('list_captured_steps')).body as unknown as Listed).steps
    expect(steps.map((s) => [s.step, s.origin])).toEqual([
      [{ type: 'tapOn', selector: { id: 'forms' } }, 'observed'],
      [{ type: 'tapPoint', at: [0.9, 0.05] }, 'coordinate'],
    ])
  })

  it('keeps typing into a field it could not read as plain a secret, echoes nothing, and types it only in Verify', async () => {
    const h = harness()
    await h.call('connect_device', { sessionId: 's1', capture: true })
    await h.call('launch_app', { sessionId: 's1', buildId: 7 })
    await h.call('tap', { sessionId: 's1', element: { id: 'login' } })
    h.show([LOGIN, field({ secure: undefined })])
    const { body: typed } = await h.json('type_text', { sessionId: 's1', text: 'hunter2' })
    expect(typed).toEqual({ typed: true, length: 7 })
    h.show([LOGIN, field({ identifier: 'name', secure: false })])
    await h.call('type_text', { sessionId: 's1', text: 'Duck' })

    const { res: listRes } = await h.json('list_captured_steps')
    expect(listRes.content[0]!.text).not.toContain('hunter2')
    const steps = ((await h.json('list_captured_steps')).body as unknown as Listed).steps
    expect(steps.map((s) => s.step['type'])).toEqual(['launchApp', 'tapOn', 'inputSecret', 'inputText'])
    expect(steps[3]!.step).toEqual({ type: 'inputText', text: 'Duck' })

    h.client.typeText.mockClear()
    const { res, body } = await h.json('capture_flow', { sessionId: 's1', name: 'l', secrets: [{ step: 3, name: 'APP_PASSWORD' }] })
    expect(body['verified']).toBe(true)
    expect(res.content[0]!.text).not.toContain('hunter2')
    expect(body['yaml']).toContain('secret: APP_PASSWORD')
    expect(h.client.typeText.mock.calls.map((c) => c[1])).toEqual(['hunter2', 'Duck'])
  })

  it('says which of the agent\'s steps a failed Verify stopped on, and notes it when that step is left out', async () => {
    const h = harness()
    await h.call('connect_device', { sessionId: 's1', capture: true })
    await h.call('launch_app', { sessionId: 's1', buildId: 7 })
    await h.call('tap', { sessionId: 's1', element: { id: 'login' } })
    await h.call('tap', { sessionId: 's1', element: { id: 'forms' } })
    // On the replay, the device refuses the second tap.
    h.client.tap.mockImplementationOnce(async () => {}).mockImplementationOnce(async () => { throw new Error('Input failed (malformed)') })
    const { body: failed } = await h.json('capture_flow', { sessionId: 's1', name: 'l' })
    expect(failed).toMatchObject({ verified: false, attempt: 1, failedStep: 3 })
    const { body: list } = await h.json('list_captured_steps')
    expect(list['notes']).toContain('Failed in an earlier Verify: #3')
    const { body: passed } = await h.json('capture_flow', { sessionId: 's1', name: 'l', drop: [3] })
    expect(passed).toMatchObject({ verified: true, attempt: 2 })
    expect(passed['yaml']).toContain('dropped-after-verify-failure): #3')
  })

  it('refuses a run_flow that types while capturing, and keeps one that passed as the agent\'s block', async () => {
    const h = harness()
    await h.call('connect_device', { sessionId: 's1', capture: true })
    const { body: refused } = await h.json('run_flow', { sessionId: 's1', flow: 'name: t\nsteps:\n  - inputText: hi\n' })
    expect(refused['status']).toBe('failed')
    expect(String(refused['failureMessage'])).toContain('type_text')
    expect(h.client.typeText).not.toHaveBeenCalled()
    await h.json('run_flow', { sessionId: 's1', flow: 'name: t\nsteps:\n  - tapOn: { id: login }\n' })
    const steps = ((await h.json('list_captured_steps')).body as unknown as Listed).steps
    expect(steps.map((s) => [s.step, s.origin])).toEqual([[{ type: 'tapOn', selector: { id: 'login' } }, 'agent-step']])
  })

  it('opens a capture without observation when the device cannot observe, and says so', async () => {
    const h = harness({ observe: async () => false })
    const { body } = await h.json('connect_device', { sessionId: 's1', capture: true })
    expect(body['capture']).toMatchObject({ open: true, observing: false })
    expect(String((body['capture'] as { note: string }).note)).toContain('cannot be observed')
  })

  it('verifies only on a session of the capture\'s platform, and refuses choices it did not offer', async () => {
    const h = harness()
    await h.call('connect_device', { sessionId: 's1', capture: true })
    await h.call('tap', { sessionId: 's1', element: { id: 'login' } })
    h.client.listDevices.mockResolvedValueOnce([{ platform: 'ios', devices: [{ sessionId: 's1' }] }, { platform: 'android', devices: [{ sessionId: 's2' }] }] as never)
    expect((await h.call('capture_flow', { sessionId: 's2', name: 'l' })).isError).toBe(true)
    const { res, body } = await h.json('capture_flow', { sessionId: 's1', name: 'l', expect: [{ step: 1, candidate: 99 }] })
    expect(res.isError).toBe(true)
    expect(body['refused']).toEqual([{ step: 1, reason: 'no-candidate' }])
    expect(h.client.runReset).not.toHaveBeenCalled()
  })

  it('keeps a capture whose device was taken back, past the hour after it was first let go', async () => {
    vi.useFakeTimers()
    try {
      const h = harness()
      await h.call('connect_device', { sessionId: 's1', capture: true })
      await h.call('disconnect_device', { sessionId: 's1' })
      await h.call('connect_device', { sessionId: 's1' })
      vi.advanceTimersByTime(KEEP_AFTER_RELEASE_MS + 60_000)
      expect((await h.call('list_captured_steps')).isError).toBeFalsy()
      await h.call('disconnect_device', { sessionId: 's1' })
      vi.advanceTimersByTime(KEEP_AFTER_RELEASE_MS + 60_000)
      expect((await h.call('list_captured_steps')).isError).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('verifies nothing it cannot reset or launch: no build launched, or a build whose app cannot be named', async () => {
    const h = harness()
    await h.call('connect_device', { sessionId: 's1', capture: true })
    await h.call('tap', { sessionId: 's1', element: { id: 'login' } })
    expect((await h.json('list_captured_steps')).body['notes']).toContainEqual(expect.stringContaining('No launch was captured'))
    // A flow always begins with a launch, and Verify would not know which build.
    const none = await h.call('capture_flow', { sessionId: 's1', name: 'l' })
    expect(none.isError).toBe(true)
    expect(none.content[0]!.text).toContain('launch_app')

    const unknown = harness()
    unknown.client.lookupBuild.mockResolvedValue({ kind: 'unknown', reason: 'relay unreachable' } as never)
    await unknown.call('connect_device', { sessionId: 's1', capture: true })
    await unknown.call('launch_app', { sessionId: 's1', buildId: 7 })
    await unknown.call('tap', { sessionId: 's1', element: { id: 'login' } })
    const res = await unknown.call('capture_flow', { sessionId: 's1', name: 'l' })
    expect(res.isError).toBe(true)
    expect(res.content[0]!.text).toContain('relay unreachable')
    for (const c of [h, unknown]) expect(c.client.runReset).not.toHaveBeenCalled()
  })

  it('lists a tap whose landing could not be confirmed, and says so', async () => {
    const h = harness()
    await h.call('connect_device', { sessionId: 's1', capture: true })
    const sent = h.client.tap.getMockImplementation()!
    h.client.tap.mockImplementationOnce(async (s: string) => {
      await sent(s)
      throw new Error('Could not confirm the input reached the device')
    })
    expect((await h.call('tap', { sessionId: 's1', x: 90, y: 10, screenshotWidth: 100, screenshotHeight: 200 })).isError).toBe(true)
    const { body } = await h.json('list_captured_steps')
    expect((body as unknown as Listed).steps.map((st) => st.step)).toEqual([{ type: 'tapPoint', at: [0.9, 0.05] }])
    expect(body['notes']).toContainEqual(expect.stringContaining('1 input was not confirmed'))
  })

  it('answers list_captured_steps and capture_flow with an error when no capture is open', async () => {
    const h = harness()
    expect((await h.call('list_captured_steps')).isError).toBe(true)
    expect((await h.call('capture_flow', { sessionId: 's1', name: 'l' })).isError).toBe(true)
  })
})

describe('AgentCaptureRecorder', () => {
  const touchEnd = (requestId: string, sessionId = 's1'): BrowserToRelay => ({ type: 'input:touch:end', sessionId, requestId, payload: { x: 0, y: 0 } })

  it('pairs a touch with what the agent saw of it, one that came before the touch was recorded too', () => {
    const rec = new AgentCaptureRecorder('s1', 'ios', true)
    rec.noteSent(touchEnd('a'))
    const element = { identifier: 'forms', traits: 1 }
    rec.noteObservation({ type: 'capture:observation', sessionId: 's1', requestId: 'a', touched: { point: { x: 0.6, y: 0.82 }, moving: false, element } })
    rec.add({ kind: 'tap', at: 1, point: [0.6, 0.82] }, rec.take())
    rec.noteObservation({ type: 'capture:observation', sessionId: 's1', requestId: 'a', landed: { on: 'app' } })
    expect(rec.actions[0]).toMatchObject({ observed: { element }, landed: { on: 'app' } })
  })

  it('drops what it saw of a touch it did not send, or one a Verify sent', () => {
    const rec = new AgentCaptureRecorder('s1', 'ios', true)
    rec.verifying = true
    rec.noteSent(touchEnd('v'))
    rec.verifying = false
    rec.noteSent(touchEnd('other', 's2'))
    expect(rec.take()).toEqual([])
    for (const requestId of ['v', 'other', 'dashboard']) {
      rec.noteObservation({ type: 'capture:observation', sessionId: 's1', requestId, landed: { on: 'home' } })
    }
    rec.add({ kind: 'tap', at: 1, point: [0.5, 0.5] }, ['v'])
    expect(rec.actions[0]).not.toHaveProperty('landed')
  })

  it('is kept for an hour after its device was let go, and again while held', () => {
    let now = 0
    const rec = new AgentCaptureRecorder('s1', 'ios', true, () => now)
    rec.release()
    now = KEEP_AFTER_RELEASE_MS - 60_000
    expect(rec.expired).toBe(false)
    now = KEEP_AFTER_RELEASE_MS + 60_000
    expect(rec.expired).toBe(true)
    rec.hold()
    expect(rec.expired).toBe(false)
  })
})
