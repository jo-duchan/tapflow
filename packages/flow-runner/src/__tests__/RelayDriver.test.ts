import { describe, it, expect, vi } from 'vitest'
import { PlatformError } from '@tapflowio/agent-core'
import { RelayDriver } from '../RelayDriver.js'
import { runFlow } from '../engine.js'
import { parseFlow } from '../schema.js'
import { EnvironmentStepError, isEnvironmentStepFailure, TransientQueryError } from '../errors.js'
import {
  InputRefusedError,
  InputUnconfirmedError,
  type RelayClient,
  RelayClosedError,
  RelayHttpError,
  RequestTimeoutError,
  RelayUnavailableError,
  SessionEndedError,
  SessionUnavailableError,
} from '../RelayClient.js'

// RelayDriver takes the concrete client; the fake below satisfies the methods
// the driver calls, cast once at construction rather than per test.
// A chrome with a frame is an iOS one, which is what tells the settle loop a turn is expected.
const IOS_CHROME = { framePng: '', buttons: [] }
const ANDROID_CHROME = { buttons: [], streamType: 'h264', bodyRotation: 90 }

function driverWith(client: Record<string, (...args: never[]) => Promise<unknown>>) {
  // A fake that answers only `queryUITree` reads as a tree with no turn: the driver asks `queryUITreeWithTurn`.
  const { queryUITree } = client
  if (queryUITree && !client.queryUITreeWithTurn) {
    client.queryUITreeWithTurn = (async (...args: never[]) => ({ elements: await queryUITree(...args) })) as never
  }
  return new RelayDriver(client as unknown as RelayClient, 's1', 7)
}

describe('RelayDriver failure-kind mapping (#543)', () => {
  it('retypes relay/agent/session failures as EnvironmentStepError, message and cause preserved', async () => {
    const cases: Array<() => Error> = [
      () => new SessionEndedError('app install failed: gone (agent-disconnected)', 'agent-disconnected'),
      () => new SessionUnavailableError('ui-tree query failed - the relay ended this session (gone)'),
      () => new InputRefusedError('not-booted', new PlatformError('tap was refused by the device (not-booted): down')),
      () => new InputRefusedError('channel-unavailable', new PlatformError('tap was refused (channel-unavailable): x')),
      () => new InputRefusedError('channel-starting', new PlatformError('tap was refused (channel-starting): x')),
      () => new InputRefusedError('dispatch-failed', new PlatformError('tap was refused (dispatch-failed): x')),
      () => new InputRefusedError('not-session-owner', new PlatformError('tap was refused (not-session-owner): x')),
      () => new InputUnconfirmedError('tap was not confirmed'),
      () => new RelayClosedError('relay connection closed'),
      () => new RequestTimeoutError('tap timed out'),
      () => new RelayUnavailableError('not connected to relay'),
      () => new RelayHttpError('session not found', 404),
      () => new SessionUnavailableError('device boot failed — the relay ended this session (gone)'),
    ]
    for (const make of cases) {
      const original = make()
      const driver = driverWith({ tap: vi.fn(async () => { throw original }) })
      const err = await driver.tap(0.5, 0.5).catch((e: unknown) => e)
      expect(err).toBe(original)
      expect(isEnvironmentStepFailure(err)).toBe(true)
      expect(err).toBeInstanceOf(PlatformError)
      expect((err as Error).message).toBe(original.message)
    }
  })

  it('rethrows product failures untouched, same instance', async () => {
    const cases: Array<() => Error> = [
      () => new InputRefusedError('malformed', new PlatformError('tap was refused (malformed): bad frame')),
      () => new InputRefusedError('unsupported', new PlatformError('tap was refused (unsupported): no')),
      () => new InputRefusedError('no-gesture', new PlatformError('tap was refused (no-gesture): unsure')),
      () => new Error('launchApp needs a build under test'),
      // A launch failure on a healthy session is a broken build, not infra:
      // failed() returns a plain PlatformError when no session note applies.
      () => new PlatformError('launch failed'),
    ]
    for (const make of cases) {
      const original = make()
      const driver = driverWith({ tap: vi.fn(async () => { throw original }) })
      const err = await driver.tap(0.5, 0.5).catch((e: unknown) => e)
      expect(err).toBe(original)
    }
  })

  it('lets TransientQueryError through unwrapped so the poll loop keeps retrying it', async () => {
    const original = new TransientQueryError('agent blip')
    const driver = driverWith({ queryUITree: vi.fn(async () => { throw original }) })
    const err = await driver.queryUITree().catch((e: unknown) => e)
    expect(err).toBe(original)
  })

  it('launchApp without a build is an environment configuration failure', async () => {
    const driver = new RelayDriver({} as unknown as RelayClient, 's1')
    const err = await driver.launchApp().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(EnvironmentStepError)
    expect(isEnvironmentStepFailure(err)).toBe(true)
    expect((err as Error).message).toContain('--build')
  })

  it('carries a marked relay failure through the engine as environmental', async () => {
    const client = {
      queryUITreeWithTurn: vi.fn(async () => { throw new RelayHttpError('relay unavailable', 503) }),
      screenshot: vi.fn(async () => Buffer.from('PNG')),
    } as unknown as RelayClient
    const result = await runFlow(parseFlow('steps:\n  - assertVisible: "OK"\n', 'test.yaml'), new RelayDriver(client, 's1'), {
      defaultTimeoutMs: 20,
      pollIntervalMs: 1,
    })
    expect(result.failureKind).toBe('environment')
  })

  // Regression pin for #825: no status split. Any RelayHttpError escaping the
  // query retry loop is environmental — the relay's ui-tree/screenshot
  // statuses (401/403 token, 404 session gone, 409 device not booted, 502/504
  // agent away or silent, 0 network) never come from the app under test.
  const ESCAPING_HTTP_CASES = [
    { label: 'network failure', status: 0, permanent: false },
    { label: 'unauthorized', status: 401, permanent: false },
    { label: 'forbidden', status: 403, permanent: false },
    { label: 'session not found', status: 404, permanent: false },
    { label: 'device not booted', status: 409, permanent: false },
    { label: 'agent away', status: 502, permanent: false },
    { label: 'agent silent', status: 504, permanent: false },
    { label: 'invalid response shape', status: 200, permanent: true },
    { label: 'invalid JSON', status: 200, permanent: true },
  ]

  it.each(ESCAPING_HTTP_CASES)('RelayHttpError escaping the query retry loop stays environmental ($label, status $status)', async ({ label, status, permanent }) => {
    const cause = new Error('underlying transport detail')
    const original = new RelayHttpError(`ui-tree query failed: ${label}`, status, { cause }, permanent)
    const driver = driverWith({ queryUITree: vi.fn(async (): Promise<never> => { throw original }) })
    const err = await driver.queryUITree().catch((e: unknown) => e)
    expect(err).toBe(original)
    expect(isEnvironmentStepFailure(err)).toBe(true)
    expect((err as RelayHttpError).status).toBe(status)
    expect((err as RelayHttpError).permanent).toBe(permanent)
    expect((err as RelayHttpError).cause).toBe(cause)
    expect((err as Error).message).toBe(original.message)
  })

  it.each(ESCAPING_HTTP_CASES)('a $label RelayHttpError (status $status) failing the step stays environmental end to end', async ({ label, status, permanent }) => {
    const original = new RelayHttpError(`ui-tree query failed: ${label}`, status, { cause: new Error(label) }, permanent)
    const queryUITree = vi.fn(async (): Promise<never> => { throw original })
    const client = {
      queryUITreeWithTurn: queryUITree,
      screenshot: vi.fn(async () => Buffer.from('PNG')),
    } as unknown as RelayClient
    const result = await runFlow(parseFlow('steps:\n  - assertVisible: "OK"\n', 'test.yaml'), new RelayDriver(client, 's1'), {
      defaultTimeoutMs: 20,
      pollIntervalMs: 1,
    })
    expect(result.status).toBe('failed')
    expect(result.failureKind).toBe('environment')
    expect(result.failureMessage).toContain(label)
    // A RelayHttpError fails the step at once, permanent or not: the engine only retries TransientQueryError.
    expect(queryUITree).toHaveBeenCalledTimes(1)
  })

  it('does not mark a transient query failure as environmental at the driver level', async () => {
    const original = new TransientQueryError('agent blip')
    const driver = driverWith({ queryUITree: vi.fn(async (): Promise<never> => { throw original }) })
    const err = await driver.queryUITree().catch((e: unknown) => e)
    expect(err).toBe(original)
    expect(isEnvironmentStepFailure(err)).toBe(false)
  })
})

describe('RelayDriver — pinch refused as unsupported', () => {
  // Android's adb fallback has no pinch: the device's backend, not the app, so it must not read as a regression.
  it('is the environment\'s for a pinch, and stays the product\'s for anything else', async () => {
    const pinchRefused = new InputRefusedError('unsupported', new PlatformError('pinch was refused by the device (unsupported): no pinch on this path'))
    const driver = driverWith({ pinch: vi.fn(async () => { throw pinchRefused }) })
    const err = await driver.pinch([[0.4, 0.5], [0.6, 0.5]], [[0.2, 0.5], [0.8, 0.5]], 100).catch((e: unknown) => e)
    expect(err).toBe(pinchRefused)
    expect(isEnvironmentStepFailure(err)).toBe(true)

    const keyRefused = new InputRefusedError('unsupported', new PlatformError('pressButton x was refused by the device (unsupported): Unknown button'))
    const buttons = driverWith({ pressButton: vi.fn(async () => { throw keyRefused }) })
    expect(isEnvironmentStepFailure(await buttons.pressButton('x').catch((e: unknown) => e))).toBe(false)
  })

  it('reports a pinch the adb path refused as an environment failure of the flow', async () => {
    const driver = driverWith({
      queryUITree: vi.fn(async () => []),
      pinch: vi.fn(async () => { throw new InputRefusedError('unsupported', new PlatformError('pinch was refused by the device (unsupported): x')) }),
      screenshot: vi.fn(async () => Buffer.from('')),
    })
    const result = await runFlow(parseFlow('steps:\n  - pinch: { on: [0.5, 0.5], scale: 2 }\n', 'x.yaml'), driver, { pollIntervalMs: 1, defaultTimeoutMs: 20 })
    expect(result.failureKind).toBe('environment')
  })
})

// A tree point is in the app's upright interface and a touch in the portrait framebuffer: the driver turns every
// point by the turn of the latest tree it read, and nothing when that tree carried none.
describe('RelayDriver — points turned by the app\'s interface turn', () => {
  const tree = (interfaceTurn?: number) => vi.fn(async () => (interfaceTurn === undefined ? { elements: [] } : { elements: [], interfaceTurn }))

  it('turns tap, longPress, swipe and pinch points by 270 after a tree said so', async () => {
    const tap = vi.fn(async () => {}), longPress = vi.fn(async () => {}), swipe = vi.fn(async () => {}), pinch = vi.fn(async () => {})
    const driver = driverWith({ queryUITreeWithTurn: tree(270), tap, longPress, swipe, pinch })
    await driver.queryUITree()
    await driver.tap(0.25, 0.1)
    await driver.longPress(0.25, 0.1, 1000)
    await driver.swipe([0.25, 0.1], [0.5, 0.5], 300)
    await driver.pinch([[0.25, 0.1], [0.75, 0.1]], [[0.1, 0.1], [0.9, 0.1]], 500)
    expect(tap).toHaveBeenCalledWith('s1', 0.9, 0.25)
    expect(longPress).toHaveBeenCalledWith('s1', 0.9, 0.25, 1000)
    expect(swipe).toHaveBeenCalledWith('s1', [0.9, 0.25], [0.5, 0.5], 300)
    expect(pinch).toHaveBeenCalledWith('s1', [[0.9, 0.25], [0.9, 0.75]], [[0.9, 0.1], [0.9, 0.9]], 500)
  })

  it('sends points as they are when the tree carried no turn, or before any tree', async () => {
    const tap = vi.fn(async () => {})
    const driver = driverWith({ queryUITreeWithTurn: tree(), tap })
    await driver.tap(0.25, 0.1)
    await driver.queryUITree()
    await driver.tap(0.25, 0.1)
    expect(tap.mock.calls).toEqual([['s1', 0.25, 0.1], ['s1', 0.25, 0.1]])
  })

  // The chrome says the device turned before the app has; one read could keep the old turn for the next swipe.
  it('reads the app\'s turn again after setOrientation until two reads agree', async () => {
    const reads = [0, 270, 270, 90]
    const queryUITreeWithTurn = vi.fn(async () => ({ elements: [], interfaceTurn: reads.shift() }))
    const tap = vi.fn(async () => {})
    const driver = driverWith({ setOrientation: vi.fn(async () => {}), chrome: vi.fn(async () => IOS_CHROME), queryUITreeWithTurn, tap })
    await driver.setOrientation('landscape', 1000)
    await driver.tap(0.25, 0.1)
    expect(queryUITreeWithTurn).toHaveBeenCalledTimes(3)
    expect(tap).toHaveBeenCalledWith('s1', 0.9, 0.25)
  })

  // The runner answers 0 — no turn on the wire — when its two reads of the app disagree, which is most likely right
  // after the chrome said the device turned. Taking that as the answer left the next coordinate step untransformed.
  it('passes over a read with no turn on iOS, as a turn caught mid-way', async () => {
    const reads = [undefined, 270, 270]
    const queryUITreeWithTurn = vi.fn(async () => ({ elements: [], interfaceTurn: reads.shift() }))
    const tap = vi.fn(async () => {})
    const driver = driverWith({ setOrientation: vi.fn(async () => {}), chrome: vi.fn(async () => IOS_CHROME), queryUITreeWithTurn, tap })
    await driver.setOrientation('landscape', 1000)
    await driver.tap(0.25, 0.1)
    expect(queryUITreeWithTurn).toHaveBeenCalledTimes(3)
    expect(tap).toHaveBeenCalledWith('s1', 0.9, 0.25)
  })

  // The device has turned, so the turn read before it is wrong; a loop that never settles must not leave it in place.
  it('drops the turn from before the call when the settle never reads one', async () => {
    const reads: Array<() => { elements: never[]; interfaceTurn?: number }> = [
      () => ({ elements: [], interfaceTurn: 90 }), () => ({ elements: [] }), () => { throw new Error('tree read failed') },
    ]
    const queryUITreeWithTurn = vi.fn(async () => reads.shift()!())
    const tap = vi.fn(async () => {})
    const driver = driverWith({ setOrientation: vi.fn(async () => {}), chrome: vi.fn(async () => IOS_CHROME), queryUITreeWithTurn, tap })
    await driver.queryUITree()
    await driver.setOrientation('portrait', 1000)
    await driver.tap(0.25, 0.1)
    expect(tap).toHaveBeenCalledWith('s1', 0.25, 0.1)
  })

  it('stops after one read when the device reports no turn at all (Android)', async () => {
    const queryUITreeWithTurn = tree()
    const driver = driverWith({ setOrientation: vi.fn(async () => {}), chrome: vi.fn(async () => ANDROID_CHROME), queryUITreeWithTurn })
    await driver.setOrientation('landscape', 1000)
    expect(queryUITreeWithTurn).toHaveBeenCalledTimes(1)
  })
})
