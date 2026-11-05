import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// `flow run --parallel` (S5-b2): devices the relay leases, one socket each under the run's client id, sharing one
// queue of flows. The relay is faked at the client: each lease hands out the next device on the list.

interface FakeDevice { sessionId: string; deviceId: string; deviceName: string; source?: 'pool' | 'boot'; boot?: { cold?: boolean } }

const mocks = vi.hoisted(() => ({
  parseFlow: vi.fn((_text: string, file?: string): { name: string; file?: string; steps: unknown[] } => ({ name: path.basename(file ?? 'flow', '.yaml'), steps: [] })),
  runFlow: vi.fn(),
  canLease: vi.fn(async () => true),
  lease: vi.fn(),
  installApp: vi.fn(async (_sessionId: string, _build: number) => {}),
  leaveSession: vi.fn((_sessionId: string) => {}),
  clients: [] as { clientId: string }[],
}))

vi.mock('@tapflowio/flow-runner', async (importOriginal) => {
  const real = await importOriginal<typeof import('@tapflowio/flow-runner')>()
  return {
    ...real,
    parseFlow: mocks.parseFlow,
    runFlow: mocks.runFlow,
    // The fake lease marks a boot failure with the session it chose, as the real one does.
    leasedSessionOf: (e: unknown) => (e as { leasedSession?: string }).leasedSession,
    RelayClient: class {
      readonly clientId: string
      constructor(_url: string, _tokens: unknown, opts: { clientId?: string } = {}) {
        this.clientId = opts.clientId ?? 'client-1'
        mocks.clients.push(this)
      }
      connect = async () => {}
      canLease = mocks.canLease
      lease = (req: unknown) => mocks.lease(req)
      installApp = mocks.installApp
      leaveSession = mocks.leaveSession
      disconnect = () => {}
      setStreamListener = () => {}
      activity = () => {}
      listDevices = async () => []
    },
    // The session it drives, so the fake engine knows which device ran a flow.
    RelayDriver: class {
      constructor(readonly client: unknown, readonly sessionId: string) {}
    },
  }
})

import { cmdFlowRun } from '../../commands/flow-run.js'
import { AdmissionRefusedError, LeaseRefusedError, type FlowResult } from '@tapflowio/flow-runner'

const A: FakeDevice = { sessionId: 'sa', deviceId: 'da', deviceName: 'iPhone A' }
const B: FakeDevice = { sessionId: 'sb', deviceId: 'db', deviceName: 'iPhone B' }

/** Each lease takes the next answer: a device, or an error to throw. */
function leases(...answers: (FakeDevice | Error)[]): void {
  mocks.lease.mockImplementation(async () => {
    const next = answers.shift()
    if (next === undefined) throw new AdmissionRefusedError('lease refused (all-held): every device in use', 'all-held')
    if (next instanceof Error) throw next
    return { platform: 'ios', source: 'boot', watchUrl: `http://localhost:4000/automation/sessions/${next.sessionId}`, boot: {}, ...next }
  })
}

/** Which session ran which flow, in the order they finished. */
let ranOn: [string, string][]
/** A flow's result by name; passed unless named here. */
let outcomes: Record<string, FlowResult['status'] | 'environment'>

function result(name: string, outcome: FlowResult['status'] | 'environment' = 'passed'): FlowResult {
  if (outcome === 'passed') return { name, status: 'passed', steps: [], durationMs: 1 }
  return { name, status: 'failed', steps: [], durationMs: 1, failureMessage: 'step: failed', failureKind: outcome === 'environment' ? 'environment' : 'product' }
}

describe('flow run --parallel', () => {
  let dir: string
  let files: string[]
  const flowFiles = (...names: string[]) => names.map((n) => {
    const file = path.join(dir, `${n}.yaml`)
    fs.writeFileSync(file, 'steps: []\n')
    files.push(file)
    return file
  })
  const errLines = () => (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]))
  const logLines = () => (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]))

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.clients.length = 0
    mocks.canLease.mockResolvedValue(true)
    files = []
    ranOn = []
    outcomes = {}
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-flow-parallel-'))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    vi.stubEnv('TAPFLOW_TOKEN', '')
    vi.stubEnv('TAPFLOW_TOKEN_FILE', path.join(os.tmpdir(), 'tapflow-no-such-credentials.json'))
    process.exitCode = undefined
    // A turn per flow, so two workers really interleave.
    mocks.runFlow.mockImplementation(async (flow: { name: string }, driver: { sessionId: string }) => {
      await new Promise((r) => setTimeout(r, 5))
      ranOn.push([flow.name, driver.sessionId])
      return result(flow.name, outcomes[flow.name])
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    process.exitCode = undefined
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it.each([
    [{ parallel: 0, platform: 'ios' }, '--parallel must be a whole number of devices from 1 to 16'],
    [{ parallel: 17, platform: 'ios' }, '--parallel must be a whole number of devices from 1 to 16'],
    [{ parallel: 1.5, platform: 'ios' }, '--parallel must be a whole number of devices from 1 to 16'],
    [{ parallel: 2, platform: 'ios', device: 'iPhone A' }, '--parallel chooses its devices; leave out --device and --session'],
    [{ parallel: 2 }, '--parallel without --build needs --platform ios or --platform android'],
    [{ parallel: 2, platform: 'web' }, '--platform must be ios or android, not "web"'],
    [{ parallel: 2, platform: 'ios', build: 7 }, '--platform is for a run without --build; with one, the relay reads the build\'s platform'],
    [{ platform: 'ios' }, '--platform is for --parallel; without it, pick the device with --device or --session'],
  ])('refuses %o before touching a device', async (opts, message) => {
    await cmdFlowRun(flowFiles('one'), opts)
    expect(process.exitCode).toBe(2)
    expect(errLines()).toContain(`✗ ${message}`)
    expect(mocks.lease).not.toHaveBeenCalled()
  })

  // An older relay drops a lease without a word: asked first, so the run says why instead of waiting forever.
  it('stops with exit 2 when the relay cannot lease', async () => {
    mocks.canLease.mockResolvedValue(false)
    await cmdFlowRun(flowFiles('one'), { parallel: 2, platform: 'ios' })
    expect(process.exitCode).toBe(2)
    expect(errLines()).toContain('✗ this relay cannot choose devices for --parallel — update it, or run without --parallel')
    expect(mocks.lease).not.toHaveBeenCalled()
  })

  it('shares the flows across the devices it leased, each run once, as one holder', async () => {
    leases(A, B)
    await cmdFlowRun(flowFiles('one', 'two', 'three', 'four'), { parallel: 2, platform: 'ios' })
    expect(process.exitCode).toBe(0)
    expect(ranOn.map(([f]) => f).sort()).toEqual(['four', 'one', 'three', 'two'])
    expect(new Set(ranOn.map(([, s]) => s))).toEqual(new Set(['sa', 'sb']))
    // Every worker's socket under the run's client id: the relay sees one run holding two devices.
    expect(new Set(mocks.clients.map((c) => c.clientId))).toEqual(new Set(['client-1']))
    expect(mocks.lease).toHaveBeenCalledWith(expect.objectContaining({ platform: 'ios', exclude: [] }))
    expect(mocks.leaveSession.mock.calls.map(([s]) => s).sort()).toEqual(['sa', 'sb'])
    expect(logLines()).toContain('\n4/4 flows passed on 2 devices')
  })

  it('leases no more devices than there are flows to run', async () => {
    leases(A, B)
    await cmdFlowRun(flowFiles('one'), { parallel: 4, platform: 'ios' })
    expect(mocks.lease).toHaveBeenCalledTimes(1)
    expect(process.exitCode).toBe(0)
  })

  it('reads the platform from the build, installing it on each device', async () => {
    leases(A, B)
    await cmdFlowRun(flowFiles('one', 'two'), { parallel: 2, build: 7, record: false })
    expect(mocks.lease).toHaveBeenCalledWith(expect.objectContaining({ buildId: 7 }))
    expect(mocks.lease.mock.calls[0]![0]).not.toHaveProperty('platform')
    expect(mocks.installApp.mock.calls.map(([s]) => s).sort()).toEqual(['sa', 'sb'])
  })

  it('writes a JUnit suite per device', async () => {
    leases(A, B)
    const junit = path.join(dir, 'report.xml')
    await cmdFlowRun(flowFiles('one', 'two', 'three'), { parallel: 2, platform: 'ios', junit })
    const xml = fs.readFileSync(junit, 'utf-8')
    expect(xml).toContain('<testsuite name="tapflow-flows (iPhone A)"')
    expect(xml).toContain('<testsuite name="tapflow-flows (iPhone B)"')
    expect(xml).toContain('<testsuites tests="3" failures="0"')
  })

  // Decision 4: a flow that lost its device is not run again; that device's worker leaves and the others go on.
  it('lets a device go after a flow fails outside the app, keeps the rest running, and exits 2', async () => {
    leases(A, B)
    outcomes = { one: 'environment' }
    await cmdFlowRun(flowFiles('one', 'two', 'three', 'four'), { parallel: 2, platform: 'ios' })
    const brokenOn = ranOn.find(([f]) => f === 'one')![1]
    expect(ranOn.filter(([, s]) => s === brokenOn).map(([f]) => f)).toEqual(['one'])
    expect(ranOn).toHaveLength(4)
    expect(process.exitCode).toBe(2)
  })

  // D1: a flow pressing a button the platform has none of is refused before a device is chosen, like a compile error.
  it('fails a flow that presses a button the platform lacks before leasing for it, and runs the rest', async () => {
    leases(A, B)
    mocks.parseFlow.mockImplementation((_text: string, file?: string) => {
      const name = path.basename(file ?? 'flow', '.yaml')
      return { name, file, steps: name === 'back' ? [{ type: 'pressButton', name: 'back' }] : [] }
    })
    const junit = path.join(dir, 'report.xml')
    await cmdFlowRun(flowFiles('back', 'two'), { parallel: 2, platform: 'ios', junit })
    expect(ranOn.map(([f]) => f)).toEqual(['two'])
    expect(mocks.lease).toHaveBeenCalledTimes(1)
    expect(errLines().some((l) => l.includes('iOS has no "back" button'))).toBe(true)
    expect(fs.readFileSync(junit, 'utf-8')).toContain('<testsuite name="tapflow-flows (cannot run on ios)"')
    expect(logLines()).toContain('\n1/2 flows passed on 1 device')
    expect(process.exitCode).toBe(2)
    mocks.parseFlow.mockImplementation((_text: string, file?: string) => ({ name: path.basename(file ?? 'flow', '.yaml'), steps: [] }))
  })

  // The engine's own check, for what only the device knows: the flow could never run there, which says nothing about
  // the device, so the worker keeps it.
  it('keeps a device after a flow it refused before running, and tells the engine the device\'s platform', async () => {
    leases(A)
    mocks.runFlow.mockImplementation(async (flow: { name: string }, driver: { sessionId: string }, opts: { platform?: string }) => {
      ranOn.push([flow.name, driver.sessionId])
      expect(opts.platform).toBe('ios')
      if (flow.name === 'one') return { ...result('one', 'environment'), failedBeforeRun: true as const }
      return result(flow.name)
    })
    await cmdFlowRun(flowFiles('one', 'two', 'three'), { parallel: 1, platform: 'ios' })
    expect(ranOn.map(([, s]) => s)).toEqual(['sa', 'sa', 'sa'])
    expect(errLines().some((l) => l.includes('leaving this device'))).toBe(false)
    expect(process.exitCode).toBe(2)
  })

  // A step the device cannot do — a posture on one that does not fold — says nothing about the device either.
  it('keeps a device after a flow asked it for something it lacks', async () => {
    leases(A)
    mocks.runFlow.mockImplementation(async (flow: { name: string }, driver: { sessionId: string }) => {
      ranOn.push([flow.name, driver.sessionId])
      if (flow.name === 'one') return { ...result('one', 'environment'), deviceLacks: true as const }
      return result(flow.name)
    })
    await cmdFlowRun(flowFiles('one', 'two'), { parallel: 1, platform: 'ios' })
    expect(ranOn.map(([f]) => f)).toEqual(['one', 'two'])
    expect(errLines().some((l) => l.includes('leaving this device'))).toBe(false)
  })

  // A device chosen and then failed to boot is the lease's to leave, and the run's to keep out of later leases.
  it('keeps a device that failed to boot out of the next lease another worker makes', async () => {
    const busy = new AdmissionRefusedError('lease refused (all-held): every device in use', 'all-held')
    leases(Object.assign(new Error('simulator failed to boot'), { leasedSession: 'sa' }), busy, B)
    await cmdFlowRun(flowFiles('one', 'two'), { parallel: 2, platform: 'ios', admissionTimeout: 1 })
    expect(mocks.lease.mock.calls.at(-1)![0]).toMatchObject({ exclude: ['sa'] })
    expect(ranOn.map(([, s]) => s)).toEqual(['sb', 'sb'])
    expect(process.exitCode).toBe(0)
  })

  // A busy Mac turned the boot away: the device is fine, and a later lease may have it.
  it('does not keep out a device whose boot the Mac was too busy for', async () => {
    const turnedAway = Object.assign(new AdmissionRefusedError('busy', 'host-booting'), { leasedSession: 'sa' })
    leases(turnedAway, A)
    await cmdFlowRun(flowFiles('one'), { parallel: 1, platform: 'ios', admissionTimeout: 1 })
    expect(mocks.lease.mock.calls.at(-1)![0]).toMatchObject({ exclude: [] })
    expect(ranOn).toEqual([['one', 'sa']])
  })

  it('numbers two devices that share a name, in the output and the JUnit suites', async () => {
    leases(A, { ...B, deviceName: 'iPhone A' })
    const junit = path.join(dir, 'report.xml')
    await cmdFlowRun(flowFiles('one', 'two', 'three', 'four'), { parallel: 2, platform: 'ios', junit })
    expect(logLines().filter((l) => l.startsWith('[iPhone A #2] ▶')).length).toBeGreaterThan(0)
    expect(fs.readFileSync(junit, 'utf-8')).toContain('<testsuite name="tapflow-flows (iPhone A #2)"')
  })

  // A pooled session whose device was shut down outside tapflow comes back cold; saying an earlier run left it up
  // would contradict the record, which keeps the agent's `cold`.
  it('says a pooled device booted when its boot was cold, and was left up otherwise', async () => {
    leases({ ...A, source: 'pool', boot: { cold: true } }, { ...B, source: 'pool' })
    await cmdFlowRun(flowFiles('one', 'two'), { parallel: 2, platform: 'ios' })
    expect(logLines()).toContain('[iPhone A] booted')
    expect(logLines()).toContain('[iPhone B] using a device an earlier run left up')
  })

  // D3: the run's devices left behind are excluded from every later lease of the run, not only the leaving worker's.
  it('keeps a device one worker left out of the next lease another worker makes', async () => {
    const busy = new AdmissionRefusedError('lease refused (all-held): every device in use', 'all-held')
    // Device 1 gets A; device 2 is refused once, and asks again within the 1 s the run waits.
    leases(A, busy, B)
    outcomes = { one: 'environment' }
    await cmdFlowRun(flowFiles('one', 'two', 'three'), { parallel: 2, platform: 'ios', admissionTimeout: 1 })
    expect(mocks.lease.mock.calls.at(-1)![0]).toMatchObject({ exclude: ['sa'] })
    expect(ranOn.filter(([, s]) => s === 'sb').map(([f]) => f)).toEqual(['two', 'three'])
  })

  it('exits 1 when a flow fails in the app, whatever else happened', async () => {
    leases(A, B)
    outcomes = { one: 'environment', two: 'failed' }
    await cmdFlowRun(flowFiles('one', 'two', 'three'), { parallel: 2, platform: 'ios' })
    expect(process.exitCode).toBe(1)
  })

  // C5: no device of the platform can never be waited out, and nothing tested anything — an environment failure.
  it('exits 2 and counts every flow as not run when the relay has no device of the platform', async () => {
    leases(new LeaseRefusedError('lease refused (no-device): no android device on this relay', 'no-device'))
    const junit = path.join(dir, 'report.xml')
    await cmdFlowRun(flowFiles('one', 'two'), { parallel: 1, platform: 'android', junit })
    expect(process.exitCode).toBe(2)
    expect(errLines()).toContain('✗ 2 flows not run: device 1: lease refused (no-device): no android device on this relay')
    expect(fs.readFileSync(junit, 'utf-8')).toContain('<testsuite name="tapflow-flows (not run)" tests="2" failures="0" errors="2" skipped="0"')
  })

  it('runs everything on the device that installed when the other could not, and exits 0', async () => {
    leases(A, B)
    mocks.installApp.mockImplementation(async (sessionId: string) => {
      if (sessionId === 'sb') throw new Error('install failed')
    })
    await cmdFlowRun(flowFiles('one', 'two', 'three'), { parallel: 2, build: 7, record: false })
    expect(ranOn.map(([, s]) => s)).toEqual(['sa', 'sa', 'sa'])
    expect(process.exitCode).toBe(0)
    expect(errLines()).toContain('✗ [iPhone B] install failed')
    mocks.installApp.mockImplementation(async () => {})
  })

  it('does not install on a device that booted after the others ran every flow', async () => {
    mocks.lease
      .mockImplementationOnce(async () => ({ ...A, platform: 'ios', source: 'boot', watchUrl: 'http://localhost:4000/automation/sessions/sa', boot: {} }))
      .mockImplementationOnce(async () => {
        await new Promise((r) => setTimeout(r, 100))
        return { ...B, platform: 'ios', source: 'boot', watchUrl: 'http://localhost:4000/automation/sessions/sb', boot: {} }
      })
    await cmdFlowRun(flowFiles('one', 'two'), { parallel: 2, build: 7, record: false })
    expect(ranOn.map(([, s]) => s)).toEqual(['sa', 'sa'])
    expect(mocks.installApp.mock.calls.map(([s]) => s)).toEqual(['sa'])
    expect(mocks.leaveSession).toHaveBeenCalledWith('sb')
    expect(process.exitCode).toBe(0)
  })

  // A worker waiting on a busy relay stops when the queue empties, instead of sleeping out its backoff first.
  it('stops waiting for a device once another device has run every flow', async () => {
    leases(A)
    const started = Date.now()
    await cmdFlowRun(flowFiles('one', 'two'), { parallel: 2, platform: 'ios' })
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(ranOn.map(([, s]) => s)).toEqual(['sa', 'sa'])
    expect(logLines().some((l) => l.startsWith('[device 2] waiting'))).toBe(true)
    expect(process.exitCode).toBe(0)
  })

  it('records each device and says which device each flow started on', async () => {
    const urls: [string, unknown][] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      urls.push([url.replace(/^.*\/api\/v1/, ''), init.body ? JSON.parse(init.body as string) : null])
      return url.endsWith('/api/v1/runs') ? Response.json({ id: 'run-1' }, { status: 201 }) : Response.json({ ok: true })
    }))
    leases(A, B)
    await cmdFlowRun(flowFiles('one', 'two'), { parallel: 2, platform: 'ios', token: 'tflw_pat_x' })
    const devices = urls.filter(([u]) => u === '/runs/run-1/device').map(([, b]) => (b as { sessionId: string }).sessionId)
    expect(devices.sort()).toEqual(['sa', 'sb'])
    const starts = urls.filter(([u]) => /\/flows\/\d\/start$/.test(u)).map(([u, b]) => [u.match(/flows\/(\d)/)![1], (b as { sessionId: string }).sessionId])
    expect(starts.sort()).toEqual(ranOn.map(([f, s]) => [f === 'one' ? '0' : '1', s]).sort())
    expect(urls.at(-1)).toEqual(['/runs/run-1/finish', { status: 'passed', exitCode: 0 }])
    vi.unstubAllGlobals()
  })
})
