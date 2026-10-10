import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const mocks = vi.hoisted(() => ({
  parseFlow: vi.fn((text: string, file?: string) => ({ name: file ?? 'flow', steps: [] })),
  runFlow: vi.fn(),
  toJUnitXml: vi.fn(() => '<xml/>'),
  connect: vi.fn(async () => {}),
  // listDevices answers AgentSessions; the device under test lives in .devices.
  listDevices: vi.fn(async () => [
    {
      devices: [{ sessionId: 's1', name: 'dev', status: 'booted', busy: false, id: 'dev1', platform: 'ios' }],
    },
  ]),
  joinSession: vi.fn(async () => ({ watchUrl: 'http://localhost:4000/automation/sessions/s1' })),
  bootDevice: vi.fn(async () => {}),
  installApp: vi.fn(async () => {}),
  leaveSession: vi.fn(() => {}),
  disconnect: vi.fn(() => {}),
}))

vi.mock('@tapflowio/flow-runner', () => ({
  parseFlow: mocks.parseFlow,
  runFlow: mocks.runFlow,
  toJUnitXml: mocks.toJUnitXml,
  RelayClient: class {
    clientId = 'client-1'
    connect = mocks.connect
    listDevices = mocks.listDevices
    joinSession = mocks.joinSession
    bootDevice = mocks.bootDevice
    installApp = mocks.installApp
    leaveSession = mocks.leaveSession
    disconnect = mocks.disconnect
  },
  RelayDriver: class {
    constructor(..._args: unknown[]) {}
  },
}))

import { cmdFlowRun } from '../../commands/flow-run.js'
import type { FlowResult } from '@tapflowio/flow-runner'

function resultOf(status: 'passed' | 'failed', failureKind?: 'environment' | 'product'): FlowResult {
  return {
    name: 'flow',
    status,
    steps: [],
    durationMs: 1,
    ...(status === 'failed'
      ? { failureMessage: 'step: failed', ...(failureKind ? { failureKind } : {}) }
      : {}),
  }
}

describe('cmdFlowRun exit codes (#543)', () => {
  let files: string[]
  let dir: string

  const flowFile = (name: string): string => {
    const file = path.join(dir, name)
    fs.writeFileSync(file, 'steps: []\n')
    files.push(file)
    return file
  }

  beforeEach(() => {
    // clear (not reset): the hoisted mock implementations above must survive per-test.
    vi.clearAllMocks()
    files = []
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-flow-run-'))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    process.exitCode = undefined
    // A token in the developer's own shell would turn on recording and send these runs to a real relay.
    vi.stubEnv('TAPFLOW_TOKEN', '')
    mocks.listDevices.mockResolvedValue([
      {
        devices: [{ sessionId: 's1', name: 'dev', status: 'booted', busy: false, id: 'dev1', platform: 'ios' }],
      },
    ])
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    process.exitCode = undefined
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const run = (args: string[], opts = {}) => cmdFlowRun(args, opts).catch((e: unknown) => e)

  // Printed before the device boots, so the person who started the run has the link while it is still worth
  // watching. `vi.stubEnv` because this suite itself may run under CI.
  it('prints where to watch the run', async () => {
    vi.stubEnv('CI', '')
    vi.stubEnv('JENKINS_URL', '')
    vi.stubEnv('TF_BUILD', '')
    mocks.runFlow.mockResolvedValue(resultOf('passed'))
    await run([flowFile('a.yaml')])
    expect(console.log).toHaveBeenCalledWith('watch this run: http://localhost:4000/automation/sessions/s1')
    const log = vi.mocked(console.log).mock
    const printedAt = log.invocationCallOrder[log.calls.findIndex(([line]) => String(line).startsWith('watch this run:'))]!
    expect(printedAt).toBeLessThan(mocks.bootDevice.mock.invocationCallOrder[0]!)
  })

  // The link is the relay's address rewritten, which a secret holding the relay URL does not mask — so a
  // public repository's CI log would show the host. Mutation: print regardless.
  it.each([
    ['CI', 'true'],
    // Jenkins and Azure Pipelines set no `CI`.
    ['JENKINS_URL', 'https://jenkins.example.test/'],
    ['TF_BUILD', 'True'],
  ])('prints no link in CI (%s)', async (name, value) => {
    vi.stubEnv('CI', '')
    vi.stubEnv('JENKINS_URL', '')
    vi.stubEnv('TF_BUILD', '')
    vi.stubEnv(name, value)
    mocks.runFlow.mockResolvedValue(resultOf('passed'))
    await run([flowFile('a.yaml')])
    expect(vi.mocked(console.log).mock.calls.some(([line]) => String(line).startsWith('watch this run:'))).toBe(false)
  })

  it('exits 0 when every flow passes', async () => {
    mocks.runFlow.mockResolvedValue(resultOf('passed'))
    await run([flowFile('a.yaml')])
    expect(process.exitCode).toBe(0)
  })

  it('exits 1 on a product failure', async () => {
    mocks.runFlow.mockResolvedValue(resultOf('failed', 'product'))
    await run([flowFile('a.yaml')])
    expect(process.exitCode).toBe(1)
  })

  it('exits 2 when every failure is environmental', async () => {
    mocks.runFlow.mockResolvedValue(resultOf('failed', 'environment'))
    await run([flowFile('a.yaml')])
    expect(process.exitCode).toBe(2)
  })

  it('exits 1 on mixed product and environment failures, so a regression is never masked', async () => {
    mocks.runFlow
      .mockResolvedValueOnce(resultOf('failed', 'environment'))
      .mockResolvedValueOnce(resultOf('failed', 'product'))
    await run([flowFile('a.yaml'), flowFile('b.yaml')])
    expect(process.exitCode).toBe(1)
  })

  it('does not replace a product failure with a cleanup environment error', async () => {
    mocks.runFlow.mockResolvedValue(resultOf('failed', 'product'))
    mocks.leaveSession.mockImplementationOnce(() => { throw new Error('relay closed') })
    await run([flowFile('a.yaml')])
    expect(process.exitCode).toBe(1)
  })

  it('keeps exit 1 when a product failure is followed by a runFlow rejection', async () => {
    // Guards the sawProductFailure ternary in the catch path: replacing it
    // with EXIT_ENV_ERROR leaves the other 8 tests green and would mask a
    // regression behind an infrastructure exit code.
    mocks.runFlow
      .mockResolvedValueOnce(resultOf('failed', 'product'))
      .mockRejectedValueOnce(new Error('relay closed mid-run'))
    await run([flowFile('a.yaml'), flowFile('b.yaml')])
    expect(process.exitCode).toBe(1)
  })

  it('leaves a joined session when device preparation fails', async () => {
    mocks.bootDevice.mockRejectedValueOnce(new Error('device boot failed'))
    await run([flowFile('a.yaml')])
    expect(mocks.leaveSession).toHaveBeenCalledWith('s1')
    expect(process.exitCode).toBe(2)
  })

  it('exits 2 when the flow file does not parse', async () => {
    mocks.parseFlow.mockImplementationOnce(() => { throw new Error('steps[0]: bad step') })
    await run([flowFile('a.yaml')])
    expect(process.exitCode).toBe(2)
    expect(mocks.runFlow).not.toHaveBeenCalled()
  })

  it('exits 2 for a timeout outside the timer range', async () => {
    await run([flowFile('a.yaml')], { timeout: Number.MAX_VALUE })
    expect(process.exitCode).toBe(2)
    expect(mocks.connect).not.toHaveBeenCalled()
  })
})

/** The relay as the recorder sees it: every POST, and an answer chosen per path. */
function fakeRelay(answer: (url: string) => Response | Promise<Response> = defaultAnswer) {
  const calls: { url: string; body: unknown }[] = []
  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url)
    const raw = init?.body
    calls.push({ url: u, body: typeof raw === 'string' ? JSON.parse(raw) : raw })
    return answer(u)
  })
  vi.stubGlobal('fetch', fetchMock)
  return { calls, fetchMock }
}

function defaultAnswer(url: string): Response {
  return url.endsWith('/api/v1/runs')
    ? Response.json({ id: 'run-1' }, { status: 201 })
    : Response.json({ ok: true })
}

describe('cmdFlowRun records the run on the relay (A3)', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    vi.clearAllMocks()
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-flow-record-'))
    file = path.join(dir, 'login.yaml')
    fs.writeFileSync(file, 'steps: []\n')
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    process.exitCode = undefined
    vi.stubEnv('TAPFLOW_TOKEN', '')
    for (const name of ['CI', 'JENKINS_URL', 'TF_BUILD', 'GITHUB_ACTIONS']) vi.stubEnv(name, '')
    mocks.listDevices.mockResolvedValue([
      { devices: [{ sessionId: 's1', name: 'dev', status: 'booted', busy: false, id: 'dev1', platform: 'ios' }] },
    ])
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    process.exitCode = undefined
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const errLines = () => vi.mocked(console.error).mock.calls.map(([l]) => String(l))

  it('creates the run with the runner id and the planned flows, reports each flow, and finishes it', async () => {
    const relay = fakeRelay()
    mocks.runFlow.mockResolvedValue({ ...resultOf('failed', 'product'), failureScreenshot: Buffer.from('png') })
    await cmdFlowRun([file], { token: 'tflw_pat_x', relay: 'wss://relay.example.test', build: 7 })

    expect(relay.calls.map((c) => c.url)).toEqual([
      'https://relay.example.test/api/v1/runs',
      'https://relay.example.test/api/v1/runs/run-1/flows/0',
      'https://relay.example.test/api/v1/runs/run-1/flows/0/screenshot',
      'https://relay.example.test/api/v1/runs/run-1/finish',
    ])
    expect(relay.calls[0]!.body).toEqual({ client: 'client-1', buildId: 7, flows: [{ name: file, file }] })
    expect(relay.calls[1]!.body).toMatchObject({
      status: 'failed', failureKind: 'product', deviceId: 'dev1', deviceName: 'dev', platform: 'ios',
    })
    expect(relay.calls[3]!.body).toEqual({ status: 'failed', exitCode: 1, failureKind: 'product' })
    expect(console.log).toHaveBeenCalledWith('recorded as run run-1')
    expect(process.exitCode).toBe(1)
  })

  it('finishes before it lets go of the relay, so the record is the runner\'s and not the relay\'s guess', async () => {
    const relay = fakeRelay()
    mocks.runFlow.mockResolvedValue(resultOf('passed'))
    await cmdFlowRun([file], { token: 'tflw_pat_x' })
    const finishAt = relay.fetchMock.mock.invocationCallOrder[relay.calls.findIndex((c) => c.url.endsWith('/finish'))]!
    expect(finishAt).toBeLessThan(mocks.disconnect.mock.invocationCallOrder[0]!)
  })

  it('records an environment failure before any flow, with the reason', async () => {
    const relay = fakeRelay()
    mocks.listDevices.mockResolvedValue([{ devices: [] }])
    await cmdFlowRun([file], { token: 'tflw_pat_x' })
    expect(relay.calls.at(-1)!.body).toEqual({
      status: 'failed', exitCode: 2, failureKind: 'environment',
      errorMessage: 'no devices registered on the relay — is an agent running?',
    })
    expect(process.exitCode).toBe(2)
  })

  it('sends the CI context in CI', async () => {
    const relay = fakeRelay()
    vi.stubEnv('CI', 'true')
    vi.stubEnv('GITHUB_ACTIONS', 'true')
    vi.stubEnv('GITHUB_SERVER_URL', 'https://github.com')
    vi.stubEnv('GITHUB_REPOSITORY', 'o/r')
    vi.stubEnv('GITHUB_RUN_ID', '42')
    vi.stubEnv('GITHUB_SHA', 'abc')
    vi.stubEnv('GITHUB_HEAD_REF', '')
    vi.stubEnv('GITHUB_REF_NAME', 'main')
    mocks.runFlow.mockResolvedValue(resultOf('passed'))
    await cmdFlowRun([file], { token: 'tflw_pat_x' })
    expect(relay.calls[0]!.body).toMatchObject({
      ci: { provider: 'github', branch: 'main', commit: 'abc', jobUrl: 'https://github.com/o/r/actions/runs/42' },
    })
  })

  it('records nothing with --no-record, and says nothing about it', async () => {
    const relay = fakeRelay()
    mocks.runFlow.mockResolvedValue(resultOf('passed'))
    await cmdFlowRun([file], { token: 'tflw_pat_x', record: false })
    expect(relay.fetchMock).not.toHaveBeenCalled()
    expect(errLines().some((l) => l.includes('not recorded'))).toBe(false)
  })

  it('says once that a run without a token is not recorded', async () => {
    const relay = fakeRelay()
    mocks.runFlow.mockResolvedValue(resultOf('passed'))
    await cmdFlowRun([file], {})
    expect(relay.fetchMock).not.toHaveBeenCalled()
    expect(errLines().filter((l) => l.startsWith('run not recorded: no token'))).toHaveLength(1)
    expect(process.exitCode).toBe(0)
  })

  it.each([
    ['a relay that cannot be reached', () => Promise.reject(new Error('ECONNREFUSED')), 'could not reach the relay (ECONNREFUSED)'],
    ['an older relay answering the dashboard page', () => new Response('<!doctype html>', { status: 200, headers: { 'Content-Type': 'text/html' } }), 'this relay does not record runs yet'],
    ['a token that may not record', () => Response.json({ error: 'Insufficient scope' }, { status: 403 }), 'needs builds:write'],
  ])('never changes the result for %s, and warns once', async (_name, answer, says) => {
    const relay = fakeRelay(answer)
    mocks.runFlow.mockResolvedValue(resultOf('passed'))
    await cmdFlowRun([file, file], { token: 'tflw_pat_x' })
    expect(process.exitCode).toBe(0)
    expect(relay.fetchMock).toHaveBeenCalledTimes(1)
    expect(errLines().filter((l) => l.startsWith('run not recorded'))).toHaveLength(1)
    expect(errLines().find((l) => l.startsWith('run not recorded'))).toContain(says)
  })

  it('says the record is incomplete beside its id when a later call failed', async () => {
    fakeRelay((u) => u.endsWith('/finish') ? Response.json({ error: 'boom' }, { status: 500 }) : defaultAnswer(u))
    mocks.runFlow.mockResolvedValue(resultOf('passed'))
    await cmdFlowRun([file], { token: 'tflw_pat_x' })
    expect(console.log).toHaveBeenCalledWith('recorded as run run-1 (incomplete)')
    expect(process.exitCode).toBe(0)
  })

  it('prints no flow failure for the step the cancel interrupted', async () => {
    fakeRelay()
    // Waited for below: the exit comes after the record drains, and arriving after this test's mocks are
    // restored it would be a real `process.exit`.
    let exited: () => void = () => {}
    const exit = new Promise<void>((resolve) => { exited = resolve })
    vi.spyOn(process, 'exit').mockImplementation((() => { exited() }) as never)
    const before = { SIGINT: process.listeners('SIGINT'), SIGTERM: process.listeners('SIGTERM') }
    // The signal path leaves the session, which fails the step in flight — as `RelayClient` does.
    let failStep: (e: Error) => void = () => {}
    mocks.leaveSession.mockImplementation(() => failStep(new Error('this client left session s1')))
    mocks.runFlow.mockImplementation(() => new Promise((_res, rej) => {
      failStep = rej
      process.emit('SIGINT', 'SIGINT')
    }))
    await cmdFlowRun([file, file], { token: 'tflw_pat_x' })
    await exit
    expect(errLines().some((l) => l.includes('left session'))).toBe(false)
    expect(mocks.runFlow).toHaveBeenCalledTimes(1)
    for (const sig of ['SIGINT', 'SIGTERM'] as const) {
      for (const l of process.listeners(sig)) if (!before[sig].includes(l)) process.off(sig, l)
    }
  })

  it('on SIGINT finishes the record as aborted, leaves the session and exits 130', async () => {
    const relay = fakeRelay()
    const before = { SIGINT: process.listeners('SIGINT'), SIGTERM: process.listeners('SIGTERM') }
    let exited: (code: number) => void = () => {}
    const exitCode = new Promise<number>((resolve) => { exited = resolve })
    vi.spyOn(process, 'exit').mockImplementation(((code: number) => { exited(code) }) as never)
    // The flow is mid-step when the signal arrives, and never finishes on its own.
    mocks.runFlow.mockImplementation(() => { process.emit('SIGINT', 'SIGINT'); return new Promise(() => {}) })
    void cmdFlowRun([file], { token: 'tflw_pat_x' })

    expect(await exitCode).toBe(130)
    expect(relay.calls.at(-1)).toEqual({
      url: 'http://localhost:4000/api/v1/runs/run-1/finish',
      body: { status: 'aborted', exitCode: 130, errorMessage: 'cancelled (SIGINT)' },
    })
    expect(mocks.leaveSession).toHaveBeenCalledWith('s1')
    // Left before the record drains, so the device stops being driven; disconnected only after it.
    const finishAt = relay.fetchMock.mock.invocationCallOrder.at(-1)!
    expect(mocks.leaveSession.mock.invocationCallOrder[0]!).toBeLessThan(finishAt)
    expect(mocks.disconnect.mock.invocationCallOrder[0]!).toBeGreaterThan(finishAt)
    // The run never reaches its `finally`, so its handlers are still installed; remove only those.
    for (const sig of ['SIGINT', 'SIGTERM'] as const) {
      for (const l of process.listeners(sig)) if (!before[sig].includes(l)) process.off(sig, l)
    }
  })
})
