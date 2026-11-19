// What a host other than `RelayClient` builds on (Flow Capture's dashboard dialog, #1125): a channel it fills in late,
// the tree read and its failure judgement, the settle wait, the secret name rule, the clear-state a flow starts with,
// and a screenshot that is a `Uint8Array`.
import { describe, it, expect, vi, afterEach } from 'vitest'
import type { BrowserToRelay, ChromePayload, PosturesPayload, UIElement } from '@tapflowio/protocol'
import { SessionChannel, type RelayMsg } from '../sessionChannel.js'
import { parseUITreeResponse } from '../uiTreeRead.js'
import { RelayHttpError, SessionUnavailableError } from '../sessionErrors.js'
import { TransientQueryError } from '../errors.js'
import { runFlow, waitForStableScreen, type FlowDriver } from '../engine.js'
import { isSecretName, parseFlow } from '../schema.js'
import { flowSteps, flowToYaml, type CapturedFlow, type CapturedStep } from '../capture/index.js'

class LateChannel extends SessionChannel {
  readonly sent: BrowserToRelay[] = []
  protected send(msg: BrowserToRelay): void { this.sent.push(msg) }
  receive(msg: RelayMsg): void { this.dispatch(msg) }
  fill(sessionId: string, chrome: ChromePayload | null, postures: PosturesPayload | null): void { this.seed(sessionId, chrome, postures) }
  judge(sessionId: string, e: unknown): unknown { return this.treeQueryFailure(sessionId, e) }
}

const iosChrome = (streamRotation: 0 | 90 | 180 | 270): ChromePayload => ({
  framePng: '', bezelWidth: 1, bezelHeight: 1, compositeWidth: 1, compositeHeight: 1,
  padding: { left: 0, right: 0, top: 0, bottom: 0 }, screenRect: { x: 0, y: 0, width: 1, height: 1 },
  screenCornerRadius: 0, logicalWidth: 1, logicalHeight: 1, buttons: [], streamRotation,
})

const el = (label: string): UIElement => ({ role: 'button', label, enabled: true, frame: { x: 0, y: 0, width: 0.5, height: 0.1 } })

afterEach(() => { vi.useRealTimers() })

describe('a channel that starts listening after the join', () => {
  it('knows the chrome it was seeded with, so a turn already made sends nothing and waits for nothing', async () => {
    const ch = new LateChannel()
    ch.fill('s1', iosChrome(270), null)
    await ch.setOrientation('s1', 'landscape', 50)
    expect(ch.sent).toEqual([])
  })

  it('without the seed, waits out its deadline for a chrome the relay will not send again', async () => {
    const ch = new LateChannel()
    await expect(ch.setOrientation('s1', 'landscape', 50)).rejects.toThrow(/sent no chrome/)
  })

  it('picks a posture from the seeded list', async () => {
    const ch = new LateChannel()
    ch.fill('s1', null, { postures: [{ id: 'CLOSED', label: 'Folded' }, { id: 'OPENED', label: 'Open' }], currentId: 'OPENED' })
    const done = ch.setPosture('s1', 'folded', 500)
    expect(ch.sent).toEqual([{ type: 'input:posture', sessionId: 's1', payload: { postureId: 'CLOSED' } }])
    ch.receive({ type: 'device:postures', sessionId: 's1', payload: { postures: [{ id: 'CLOSED', label: 'Folded' }, { id: 'OPENED', label: 'Open' }], currentId: 'CLOSED' } })
    await done
  })

  it('does not let a seed overwrite what the relay has since said', async () => {
    const ch = new LateChannel()
    ch.receive({ type: 'session:chrome', sessionId: 's1', payload: iosChrome(0) })
    ch.fill('s1', iosChrome(270), null)
    await ch.setOrientation('s1', 'portrait', 50)
    expect(ch.sent).toEqual([])
  })
})

describe('a ui-tree read over any transport', () => {
  it('reads the elements and the interface turn, and refuses a body nothing can use', () => {
    expect(parseUITreeResponse({ elements: [el('OK')], interfaceTurn: 90 })).toEqual({ elements: [el('OK')], interfaceTurn: 90 })
    expect(parseUITreeResponse({ elements: [el('OK')], interfaceTurn: 45 })).toEqual({ elements: [el('OK')] })
    const bad = (() => { try { parseUITreeResponse({ elements: [{ role: 'button' }] }) } catch (e) { return e } })()
    expect(bad).toBeInstanceOf(RelayHttpError)
    expect((bad as RelayHttpError).permanent).toBe(true)
  })

  it('judges a failure by what the channel knows of the session before the status', () => {
    const ch = new LateChannel()
    const busy = new RelayHttpError('ui-tree query failed: 502', 502)
    expect(ch.judge('s1', busy)).toBeInstanceOf(TransientQueryError)
    expect(ch.judge('s1', new RelayHttpError('not found', 404))).toBeInstanceOf(RelayHttpError)
    ch.receive({ type: 'session:terminated', sessionId: 's1', reason: 'idle-shutdown' })
    const ended = ch.judge('s1', busy)
    expect(ended).toBeInstanceOf(SessionUnavailableError)
    expect((ended as Error).message).toMatch(/the relay ended this session/)
  })
})

describe('waitForStableScreen', () => {
  it('answers the read the screen settled on, polling past a transient failure', async () => {
    const reads = [
      () => Promise.reject(new TransientQueryError('not up yet')),
      () => Promise.resolve({ elements: [el('Splash')], interfaceTurn: 0 as const }),
      () => Promise.resolve({ elements: [el('Home')], interfaceTurn: 90 as const }),
    ]
    let i = 0
    const read = vi.fn((): Promise<{ elements: UIElement[]; interfaceTurn: 0 | 90 }> => reads[Math.min(i++, reads.length - 1)]!())
    const got = await waitForStableScreen(read, { timeoutMs: 5000, pollIntervalMs: 200 })
    expect(got).toEqual({ elements: [el('Home')], interfaceTurn: 90 })
  })

  it('throws what is not transient, and answers nothing when no read succeeded', async () => {
    await expect(waitForStableScreen(() => Promise.reject(new RelayHttpError('gone', 404)), { timeoutMs: 200, pollIntervalMs: 10 }))
      .rejects.toBeInstanceOf(RelayHttpError)
    await expect(waitForStableScreen(() => Promise.reject(new TransientQueryError('slow')), { timeoutMs: 100, pollIntervalMs: 10 }))
      .resolves.toBeUndefined()
  })
})

describe('the secret name a person may give', () => {
  it.each([['PASSWORD', true], ['_pin2', true], ['2FA', false], ['MY-PASS', false], ['', false]])('%s → %s', (name, ok) => {
    expect(isSecretName(name)).toBe(ok)
  })
})

describe('flowSteps', () => {
  const tap = { raw: {} as CapturedStep['raw'], step: { type: 'tapPoint' as const, at: [0.5, 0.5] as [number, number] } }
  const clear = { raw: {} as CapturedStep['raw'], step: { type: 'clearState' as const, appId: 'com.x' } }
  const captured = (steps: CapturedStep[], launchAdded: boolean): CapturedFlow => ({ steps, secrets: {}, launchAdded })

  it('starts from a cleared app when the bundle id is known, and the YAML reads it back with the flow\'s appId', () => {
    const steps = flowSteps(captured([tap], true), { appId: 'com.example.app' })
    expect(steps.map((s) => s.type)).toEqual(['clearState', 'launchApp', 'tapPoint'])
    // Round trip: the bare clear-state needs the flow's appId, which the host writes beside the steps.
    const yaml = flowToYaml({ name: 'x', appId: 'com.example.app', steps })
    expect(parseFlow(yaml, 'x.yaml')).toMatchObject({ appId: 'com.example.app', steps })
    // Without it the file would not load, and the writer refuses rather than hand it out.
    expect(() => flowToYaml({ name: 'x', steps })).toThrow(/requires a flow-level appId/)
  })

  it('adds no clear-state without a bundle id, and none twice', () => {
    expect(flowSteps(captured([tap], true)).map((s) => s.type)).toEqual(['launchApp', 'tapPoint'])
    expect(flowSteps(captured([clear, tap], true), { appId: 'com.x' }).map((s) => s.type)).toEqual(['clearState', 'launchApp', 'tapPoint'])
  })

  it('still clears this app when the captured clear-state names another one', () => {
    // A companion app the range reset is kept; it does not stand in for the app under test.
    expect(flowSteps(captured([clear, tap], true), { appId: 'com.example.app' }))
      .toEqual([{ type: 'clearState', appId: 'com.x' }, { type: 'clearState' }, { type: 'launchApp' }, tap.step])
  })
})

describe('a screenshot as Uint8Array', () => {
  it('is what a browser driver returns, and what a failed flow carries', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    const driver = {
      queryUITree: async () => [],
      screenshot: async () => png,
    } as unknown as FlowDriver
    const result = await runFlow(parseFlow('steps:\n  - tapOn: Missing\n', 'x.yaml'), driver, { defaultTimeoutMs: 20, pollIntervalMs: 1 })
    expect(result.failureScreenshot).toBe(png)
  })
})
