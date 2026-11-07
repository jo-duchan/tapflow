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
  bootDevice: vi.fn(async () => ({})),
  installApp: vi.fn(async () => {}),
  leaveSession: vi.fn(() => {}),
  disconnect: vi.fn(() => {}),
  setStreamListener: vi.fn(),
  activity: vi.fn(),
}))

vi.mock('@tapflowio/flow-runner', async (importOriginal) => ({
  // The real tap and token resolution: these tests feed it frames and tokens and check what reaches the relay.
  ...(({ VideoTap, resolveToken, tokenRefusal, fetchWithToken, fixedToken, isEligible, lookupBuild, parseTagList, retryAdmission, admissionRefusalOf, AdmissionRefusedError, parseServiceTier, refusedFlow, unavailableButton, unavailableButtonMessage, missingSecret, missingSecretMessage }) => ({
    VideoTap, resolveToken, tokenRefusal, fetchWithToken, fixedToken, isEligible, lookupBuild, parseTagList, retryAdmission, admissionRefusalOf, AdmissionRefusedError, parseServiceTier, refusedFlow, unavailableButton, unavailableButtonMessage, missingSecret, missingSecretMessage,
  }))(
    await importOriginal<typeof import('@tapflowio/flow-runner')>(),
  ),
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
    setStreamListener = mocks.setStreamListener
    activity = mocks.activity
  },
  RelayDriver: class {
    constructor(..._args: unknown[]) {}
  },
}))

import { cmdFlowRun, secretArg, tagsArg } from '../../commands/flow-run.js'

// A developer's own credentials file must never reach these runs: every test starts with none.
beforeEach(() => { vi.stubEnv('TAPFLOW_TOKEN_FILE', path.join(os.tmpdir(), 'tapflow-no-such-credentials.json')) })
import type { FlowResult, StreamListener } from '@tapflowio/flow-runner'
import { AdmissionRefusedError } from '@tapflowio/flow-runner'
import { CODEC_H264, writeEnvelopeHeader } from '@tapflowio/agent-core/utils'

const IDR = writeEnvelopeHeader(Buffer.from([0, 0, 0, 1, 0x67, 1, 0, 0, 0, 1, 0x68, 1, 0, 0, 0, 1, 0x65, 9]), 1, { codec: CODEC_H264, keyframe: true })
const PFRAME = writeEnvelopeHeader(Buffer.from([0, 0, 0, 1, 0x41, 9]), 2, { codec: CODEC_H264, keyframe: false })

/** The stream listener the run installed, so a test can play the device's frames into it. */
const streamListener = (): StreamListener => mocks.setStreamListener.mock.calls.find(([l]) => l !== null)![0] as StreamListener

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
  // A2: watchers see each step as it starts, under the engine's redacted label; the video keeps its own marks.
  it('tells the session each step as it starts, by its watcher label', async () => {
    mocks.runFlow.mockImplementation(async (_flow: unknown, _driver: unknown, opts?: { onStep?: (m: Record<string, unknown>) => void }) => {
      opts?.onStep?.({ index: 1, name: 'inputText("hunter2")', phase: 'start', label: 'inputText (7 chars)' })
      opts?.onStep?.({ index: 1, name: 'inputText("hunter2")', phase: 'end', status: 'passed' })
      return resultOf('passed')
    })
    await run([flowFile('a.yaml')])
    expect(mocks.activity.mock.calls).toEqual([['s1', 'step 2: inputText (7 chars)']])
  })

  // Flow Capture: a flow types only the secrets the run names, and the run reads them before it touches a device.
  describe('--secret', () => {
    it('hands the engine exactly the named variables', async () => {
      vi.stubEnv('PASSWORD', 'hunter2')
      vi.stubEnv('OTHER', 'not-this')
      mocks.runFlow.mockResolvedValue(resultOf('passed'))
      await run([flowFile('a.yaml')], { secret: ['PASSWORD'] })
      expect(mocks.runFlow.mock.calls[0]![2]).toMatchObject({ secrets: { PASSWORD: 'hunter2' } })
      expect(JSON.stringify(mocks.runFlow.mock.calls[0]![2])).not.toContain('not-this')
    })

    it('hands it none without the flag, whatever the environment holds', async () => {
      vi.stubEnv('PASSWORD', 'hunter2')
      mocks.runFlow.mockResolvedValue(resultOf('passed'))
      await run([flowFile('a.yaml')])
      expect(mocks.runFlow.mock.calls[0]![2]).not.toHaveProperty('secrets')
    })

    it.each([
      [['MISSING'], /--secret MISSING: MISSING is not set in the environment/],
      [['NOT-A-NAME'], /--secret takes the name of an environment variable/],
    ])('stops with exit 2 before the device for %j', async (names, message) => {
      await run([flowFile('a.yaml')], { secret: names })
      expect(process.exitCode).toBe(2)
      expect(mocks.joinSession).not.toHaveBeenCalled()
      expect(console.error).toHaveBeenCalledWith(expect.stringMatching(message))
    })

    // What CI expands a missing secret to: typing nothing would fail later, as the app's fault.
    it('refuses an empty variable as it refuses a missing one', async () => {
      vi.stubEnv('PASSWORD', '')
      await run([flowFile('a.yaml')], { secret: ['PASSWORD'] })
      expect(process.exitCode).toBe(2)
      expect(mocks.joinSession).not.toHaveBeenCalled()
    })

    it('stops before choosing a device when a flow types a secret the run was not given', async () => {
      mocks.parseFlow.mockImplementationOnce(() => ({ name: 'login', steps: [{ type: 'inputSecret', name: 'PASSWORD' }] as never[] }))
      await run([flowFile('login.yaml')])
      expect(process.exitCode).toBe(2)
      expect(mocks.joinSession).not.toHaveBeenCalled()
      expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/login: the secret PASSWORD was not given to this run/))
    })

    it('keeps a repeated or numeric-looking name as typed', () => {
      expect(secretArg(undefined)).toBeUndefined()
      expect(secretArg('PASSWORD')).toEqual(['PASSWORD'])
      expect(secretArg(['A', 'B'])).toEqual(['A', 'B'])
    })
  })

  // L2: a Mac busy booting another device is waited out, and the run lets go of the session while it waits so a
  // person who wants this device is not told it is in use. Mutation: drop the leave, or retry any failure.
  describe('when the Mac is busy booting another device', () => {
    const busy = () => new AdmissionRefusedError('boot refused (host-booting): busy', 'host-booting')

    it('leaves the session, waits, and joins and boots again', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout'] })
      try {
        mocks.bootDevice.mockRejectedValueOnce(busy())
        mocks.runFlow.mockResolvedValue(resultOf('passed'))
        const done = run([flowFile('a.yaml')])
        await vi.advanceTimersByTimeAsync(10_000)
        await done
      } finally {
        vi.useRealTimers()
      }
      expect(mocks.joinSession).toHaveBeenCalledTimes(2)
      expect(mocks.bootDevice).toHaveBeenCalledTimes(2)
      const leaveAt = mocks.leaveSession.mock.invocationCallOrder[0]!
      expect(leaveAt).toBeGreaterThan(mocks.bootDevice.mock.invocationCallOrder[0]!)
      expect(leaveAt).toBeLessThan(mocks.joinSession.mock.invocationCallOrder[1]!)
      expect(console.log).toHaveBeenCalledWith(expect.stringMatching(/^waiting \d+s: another device is booting on this Mac$/))
      expect(process.exitCode ?? 0).toBe(0)
    })

    it('gives up with exit 2 once --admission-timeout has passed', async () => {
      mocks.bootDevice.mockRejectedValue(busy())
      try {
        await run([flowFile('a.yaml')], { admissionTimeout: 0 })
        expect(process.exitCode).toBe(2)
        expect(mocks.runFlow).not.toHaveBeenCalled()
      } finally {
        // The mock is shared by the whole file and `clearAllMocks` keeps implementations: restore it even on failure.
        mocks.bootDevice.mockReset()
        mocks.bootDevice.mockImplementation(async () => ({}))
      }
    })

    it('does not retry a boot that failed for another reason', async () => {
      mocks.bootDevice.mockRejectedValueOnce(new Error('Device not found: dev1'))
      await run([flowFile('a.yaml')])
      expect(mocks.joinSession).toHaveBeenCalledTimes(1)
      expect(process.exitCode).toBe(2)
    })
  })

  describe('--service-tier', () => {
    it('asks for the tier on the boot', async () => {
      mocks.runFlow.mockResolvedValue(resultOf('passed'))
      await run([flowFile('a.yaml')], { serviceTier: 'slim', keep: 'push,photos' })
      expect(mocks.bootDevice).toHaveBeenCalledWith('s1', 'dev1', expect.objectContaining({ serviceTier: { name: 'slim', keep: ['push', 'photos'] } }))
    })

    it('asks for none without the flag', async () => {
      mocks.runFlow.mockResolvedValue(resultOf('passed'))
      await run([flowFile('a.yaml')])
      expect((mocks.bootDevice.mock.calls[0] as unknown[])[2]).not.toHaveProperty('serviceTier')
    })

    it('stops with exit 2 on an unknown feature, before choosing a device', async () => {
      await run([flowFile('a.yaml')], { serviceTier: 'slim', keep: 'pushh' })
      expect(process.exitCode).toBe(2)
      expect(mocks.listDevices).not.toHaveBeenCalled()
    })

    it('refuses --keep without a tier', async () => {
      await run([flowFile('a.yaml')], { keep: 'push' })
      expect(process.exitCode).toBe(2)
    })
  })

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

  // B2: a tapOn's suggestions go to the console under the failure, and with the step to the record.
  it('prints a failed tapOn\'s suggestions and records them with the step', async () => {
    const relay = fakeRelay()
    const suggestion = { yaml: 'tapOn: "Sign in"', element: { role: 'button', label: 'Sign in' } }
    mocks.runFlow.mockResolvedValue({
      ...resultOf('failed', 'product'),
      steps: [{ index: 0, name: 'tapOn("Sign inn")', status: 'failed', durationMs: 5, message: 'no element', suggestions: [suggestion] }],
    })
    await cmdFlowRun([file], { token: 'tflw_pat_x' })
    expect(errLines()).toContain('  try: tapOn: "Sign in"')
    const report = relay.calls.find((c) => c.url.endsWith('/flows/0'))!.body as { steps: { suggestions?: unknown[] }[] }
    expect(report.steps[0]!.suggestions).toEqual([suggestion])
  })

  it('creates the run with the runner id and the planned flows, reports each flow, and finishes it', async () => {
    const relay = fakeRelay()
    mocks.runFlow.mockResolvedValue({ ...resultOf('failed', 'product'), failureScreenshot: Buffer.from('png') })
    await cmdFlowRun([file], { token: 'tflw_pat_x', relay: 'wss://relay.example.test', build: 7 })

    expect(relay.calls.map((c) => c.url)).toEqual([
      // The lookup is awaited at once; the create waits its turn on the recorder's queue.
      'https://relay.example.test/api/v1/builds/7',
      'https://relay.example.test/api/v1/runs',
      // What the boot said about the device, before anything that can fail after it.
      'https://relay.example.test/api/v1/runs/run-1/device',
      // Which device the flow is on as it starts, so the page shows it running there rather than guessing.
      'https://relay.example.test/api/v1/runs/run-1/flows/0/start',
      'https://relay.example.test/api/v1/runs/run-1/flows/0',
      'https://relay.example.test/api/v1/runs/run-1/flows/0/screenshot',
      'https://relay.example.test/api/v1/runs/run-1/finish',
    ])
    expect(relay.calls[1]!.body).toEqual({ client: 'client-1', buildId: 7, flows: [{ name: file, file }], resetRequested: true })
    expect(relay.calls[2]!.body).toMatchObject({ sessionId: 's1', deviceId: 'dev1', deviceName: 'dev' })
    expect(relay.calls[3]!.body).toEqual({ sessionId: 's1', deviceId: 'dev1', deviceName: 'dev' })
    expect(relay.calls[4]!.body).toMatchObject({
      status: 'failed', failureKind: 'product', deviceId: 'dev1', deviceName: 'dev', platform: 'ios',
    })
    expect(relay.calls[6]!.body).toEqual({ status: 'failed', exitCode: 1, failureKind: 'product' })
    // Outside CI, with the page's link on the watch link's origin.
    expect(console.log).toHaveBeenCalledWith('recorded as run run-1: http://localhost:4000/automation/runs/run-1')
    expect(process.exitCode).toBe(1)
  })

  it('asks a recorded run for each passed flow\'s last screen and sends it as the flow\'s screenshot', async () => {
    const relay = fakeRelay()
    mocks.runFlow.mockResolvedValue({ ...resultOf('passed'), lastScreenshot: Buffer.from('home') })
    await cmdFlowRun([file], { token: 'tflw_pat_x' })
    expect(mocks.runFlow.mock.calls[0]![2]).toMatchObject({ captureLastScreen: true })
    expect(relay.calls.map((c) => c.url)).toContain('http://localhost:4000/api/v1/runs/run-1/flows/0/screenshot')
  })

  it('takes no last screens when nothing records the run', async () => {
    fakeRelay()
    mocks.runFlow.mockResolvedValue(resultOf('passed'))
    await cmdFlowRun([file], { token: 'tflw_pat_x', record: false })
    expect(mocks.runFlow.mock.calls[0]![2]).not.toHaveProperty('captureLastScreen')
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
    // Set by GitHub Actions itself, so this suite's own CI run would add `/attempts/1` to the link.
    vi.stubEnv('GITHUB_RUN_ATTEMPT', '')
    mocks.runFlow.mockResolvedValue(resultOf('passed'))
    await cmdFlowRun([file], { token: 'tflw_pat_x' })
    expect(relay.calls[0]!.body).toMatchObject({
      ci: { provider: 'github', branch: 'main', commit: 'abc', jobUrl: 'https://github.com/o/r/actions/runs/42' },
    })
    // The id only: the link would put the relay's address in the CI log.
    expect(console.log).toHaveBeenCalledWith('recorded as run run-1')
  })

  it('records nothing with --no-record, and says nothing about it', async () => {
    const relay = fakeRelay()
    mocks.runFlow.mockResolvedValue(resultOf('passed'))
    await cmdFlowRun([file], { token: 'tflw_pat_x', record: false })
    expect(relay.fetchMock).not.toHaveBeenCalled()
    expect(errLines().some((l) => l.includes('not recorded'))).toBe(false)
  })

  it('records with the token from the credentials file when no flag or env gives one (T1)', async () => {
    const credentials = path.join(dir, 'credentials.json')
    fs.writeFileSync(credentials, JSON.stringify({ version: 1, relays: { 'http://localhost:4000': { token: 'tflw_pat_file' } } }), { mode: 0o600 })
    vi.stubEnv('TAPFLOW_TOKEN_FILE', credentials)
    fakeRelay()
    mocks.runFlow.mockResolvedValue(resultOf('passed'))
    await cmdFlowRun([file], {})
    const auths = vi.mocked(globalThis.fetch).mock.calls.map(([, init]) => (init?.headers as Record<string, string>).Authorization)
    expect(auths.length).toBeGreaterThan(0)
    expect(new Set(auths)).toEqual(new Set(['Bearer tflw_pat_file']))
  })

  it('says a --relay that is not a URL is not one, and exits 2', async () => {
    await cmdFlowRun([file], { token: 'tflw_pat_x', relay: '4000' })
    expect(process.exitCode).toBe(2)
    expect(errLines().some((l) => l.includes('--relay is not a relay URL ("4000")'))).toBe(true)
    expect(mocks.connect).not.toHaveBeenCalled()
  })

  it('names the relay, the token\'s source and the fix when the relay refuses it', async () => {
    fakeRelay(() => Response.json({ error: 'Unauthorized' }, { status: 401 }))
    mocks.runFlow.mockResolvedValue(resultOf('passed'))
    await cmdFlowRun([file], { token: 'tflw_pat_wrong', relay: 'wss://relay.example.test' })
    expect(errLines().find((l) => l.startsWith('run not recorded'))).toMatch(
      /^run not recorded: the relay at https:\/\/relay\.example\.test did not accept the token from --token .* under "https:\/\/relay\.example\.test"/,
    )
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
    expect(console.log).toHaveBeenCalledWith('recorded as run run-1 (incomplete): http://localhost:4000/automation/runs/run-1')
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

describe('cmdFlowRun runs only the flows that apply to this build and these tags (L1)', () => {
  let dir: string
  const flowsByFile = new Map<string, { appId?: string; tags?: string[] }>()

  const flowFile = (name: string, fields: { appId?: string; tags?: string[] } = {}): string => {
    const file = path.join(dir, name)
    fs.writeFileSync(file, 'steps: []\n')
    flowsByFile.set(file, fields)
    return file
  }

  /** The relay knows build 7 as `com.b`, and answers `/builds/<other>` with what `buildAnswer` says. */
  const relayWith = (buildAnswer: (url: string) => Response = () => Response.json({ id: 7, bundle_id: 'com.b' })) =>
    fakeRelay((url) => (url.includes('/api/v1/builds/') ? buildAnswer(url) : defaultAnswer(url)))

  const logLines = () => vi.mocked(console.log).mock.calls.map(([l]) => String(l))
  const errLines = () => vi.mocked(console.error).mock.calls.map(([l]) => String(l))

  beforeEach(() => {
    vi.clearAllMocks()
    flowsByFile.clear()
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-flow-eligible-'))
    mocks.parseFlow.mockImplementation((_text: string, file?: string) => ({ name: path.basename(file ?? 'flow'), steps: [], file, ...flowsByFile.get(file ?? '') }))
    mocks.runFlow.mockResolvedValue(resultOf('passed'))
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
    mocks.parseFlow.mockImplementation((_text: string, file?: string) => ({ name: file ?? 'flow', steps: [] }))
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    process.exitCode = undefined
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('skips a flow for another app, records why, and runs the rest', async () => {
    const relay = relayWith()
    const other = flowFile('other.yaml', { appId: 'com.a' })
    const mine = flowFile('mine.yaml', { appId: 'com.b' })
    await cmdFlowRun([other, mine], { token: 'tflw_pat_x', build: 7, junit: path.join(dir, 'junit.xml') })

    expect(mocks.runFlow).toHaveBeenCalledTimes(1)
    expect(mocks.runFlow.mock.calls[0]![0]).toMatchObject({ name: 'mine.yaml' })
    expect(logLines()).toContain('– other.yaml (skipped: flow is for com.a, build 7 is com.b)')
    expect(logLines()).toContain('\n1/1 flows passed, 1 skipped')
    expect(relay.calls.find((c) => c.url.endsWith('/flows/0'))!.body).toEqual({
      status: 'skipped', skipReason: 'app-mismatch', failureMessage: 'flow is for com.a, build 7 is com.b', durationMs: 0, steps: [],
    })
    expect(relay.calls.find((c) => c.url.endsWith('/flows/1'))!.body).toMatchObject({ status: 'passed' })
    expect(mocks.toJUnitXml).toHaveBeenCalledWith([expect.anything()], [{ name: 'other.yaml', file: other, message: 'flow is for com.a, build 7 is com.b' }])
    expect(process.exitCode).toBe(0)
  })

  it('exits 2 without touching a device when no flow applies, and records the run as an environment failure', async () => {
    const relay = relayWith()
    await cmdFlowRun([flowFile('other.yaml', { appId: 'com.a' })], { token: 'tflw_pat_x', build: 7 })

    expect(mocks.runFlow).not.toHaveBeenCalled()
    expect(mocks.listDevices).not.toHaveBeenCalled()
    expect(mocks.bootDevice).not.toHaveBeenCalled()
    expect(relay.calls.find((c) => c.url.endsWith('/finish'))!.body).toEqual({
      status: 'failed', exitCode: 2, failureKind: 'environment', errorMessage: 'no flow ran: 1 skipped (app-mismatch 1)',
    })
    expect(process.exitCode).toBe(2)
  })

  // D1: the build says the platform before a device is chosen, so a flow pressing a button that platform has none of
  // fails there, like a compile error, and the rest run.
  it('fails a flow pressing a button the build\'s platform lacks before choosing a device, records it, and runs the rest', async () => {
    const relay = relayWith(() => Response.json({ id: 7, bundle_id: 'com.b', platform: 'ios' }))
    const back = flowFile('back.yaml')
    flowsByFile.set(back, { steps: [{ type: 'pressButton', name: 'back' }] } as never)
    const fine = flowFile('fine.yaml')
    await cmdFlowRun([back, fine], { token: 'tflw_pat_x', build: 7 })

    expect(mocks.runFlow).toHaveBeenCalledTimes(1)
    expect(mocks.runFlow.mock.calls[0]![0]).toMatchObject({ name: 'fine.yaml' })
    // The engine is told the device's platform, for what only the device can answer.
    expect(mocks.runFlow.mock.calls[0]![2]).toMatchObject({ platform: 'ios' })
    expect(errLines().some((l) => l.includes('iOS has no "back" button'))).toBe(true)
    expect(relay.calls.find((c) => c.url.endsWith('/flows/0'))!.body).toMatchObject({ status: 'failed', failureKind: 'environment' })
    expect(relay.calls.find((c) => c.url.endsWith('/flows/0'))!.body).not.toHaveProperty('deviceId')
    expect(logLines()).toContain('\n1/2 flows passed')
    expect(process.exitCode).toBe(2)
  })

  it('exits 2 without touching a device when every flow presses a button the platform lacks', async () => {
    relayWith(() => Response.json({ id: 7, bundle_id: 'com.b', platform: 'ios' }))
    const back = flowFile('back.yaml')
    flowsByFile.set(back, { steps: [{ type: 'pressButton', name: 'recent_apps' }] } as never)
    await cmdFlowRun([back], { token: 'tflw_pat_x', build: 7 })
    expect(mocks.listDevices).not.toHaveBeenCalled()
    expect(errLines()).toContain('✗ no flow ran: 1 cannot run on ios')
    expect(process.exitCode).toBe(2)
  })

  it('exits 2 without touching a device when the build does not exist', async () => {
    relayWith(() => Response.json({ error: 'Build not found' }, { status: 404 }))
    await cmdFlowRun([flowFile('a.yaml')], { token: 'tflw_pat_x', build: 99 })
    expect(errLines()).toContain('✗ build 99 not found on the relay (see list_builds / the dashboard)')
    expect(mocks.bootDevice).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(2)
  })

  // `flow run` needs only a view token; the build route wants builds:write. A refusal is not a missing build.
  it('runs every flow, and says the app check was left out, when the relay will not say what the build is', async () => {
    relayWith(() => Response.json({ error: 'Insufficient scope' }, { status: 403 }))
    await cmdFlowRun([flowFile('other.yaml', { appId: 'com.a' })], { token: 'tflw_pat_x', build: 7 })
    expect(mocks.runFlow).toHaveBeenCalledTimes(1)
    expect(errLines()).toContain('app check skipped (the relay answered 403): flows run whatever their appId')
    expect(process.exitCode).toBe(0)
  })

  it('runs every flow without asking the relay when there is no token', async () => {
    const relay = fakeRelay()
    await cmdFlowRun([flowFile('other.yaml', { appId: 'com.a' })], { build: 7 })
    expect(relay.calls).toEqual([])
    expect(mocks.runFlow).toHaveBeenCalledTimes(1)
    expect(errLines()).toContain('app check skipped (no token): flows run whatever their appId')
  })

  it('says nothing about the app check when no flow names an app', async () => {
    relayWith(() => Response.json({}, { status: 403 }))
    await cmdFlowRun([flowFile('a.yaml')], { token: 'tflw_pat_x', build: 7 })
    expect(errLines().some((l) => l.startsWith('app check skipped'))).toBe(false)
  })

  it('runs only the flows the tag filters let through, exclude winning', async () => {
    fakeRelay()
    const smoke = flowFile('smoke.yaml', { tags: ['smoke'] })
    const flaky = flowFile('flaky.yaml', { tags: ['smoke', 'flaky'] })
    const slow = flowFile('slow.yaml', { tags: ['slow'] })
    await cmdFlowRun([smoke, flaky, slow], { includeTags: 'smoke', excludeTags: 'flaky' })
    expect(mocks.runFlow.mock.calls.map(([f]) => (f as { name: string }).name)).toEqual(['smoke.yaml'])
    expect(logLines()).toContain('– flaky.yaml (skipped: tagged flaky)')
    expect(logLines()).toContain('– slow.yaml (skipped: not tagged smoke)')
  })

  it('exits 2 when the tag filters leave nothing to run, and still writes the JUnit report saying why', async () => {
    fakeRelay()
    const junit = path.join(dir, 'out', 'junit.xml')
    const a = flowFile('a.yaml')
    await cmdFlowRun([a], { includeTags: 'smoke', junit })
    expect(errLines()).toContain('✗ no flow ran: 1 skipped (tag-filter 1)')
    expect(process.exitCode).toBe(2)
    expect(mocks.toJUnitXml).toHaveBeenCalledWith([], [{ name: 'a.yaml', file: a, message: 'not tagged smoke' }])
    expect(fs.readFileSync(junit, 'utf-8')).toBe('<xml/>')
  })

  // The argument parser hands `''` back as 0, a bare flag as true, and a repeated one as an array.
  it.each([
    ['an empty value', 0, ''],
    ['a flag with no value', true, ''],
    ['a value', 'smoke,login', 'smoke,login'],
    ['a numeric tag', 12, '12'],
    ['a repeated flag', ['smoke', 0, 'login'], 'smoke,,login'],
  ])('reads %s from the parser as a tag list', (_, value, list) => {
    expect(tagsArg(value)).toBe(list)
  })

  // A relay older than skipped flows answers 400. Stopping there would drop the finish too, and the relay would
  // then show the run as "runner disconnected". Mutation: let the 400 stop recording.
  it('still records the rest of the run when the relay refuses a skipped flow', async () => {
    const relay = fakeRelay((url) => {
      if (url.includes('/api/v1/builds/')) return Response.json({ id: 7, bundle_id: 'com.b' })
      if (url.endsWith('/flows/0')) return Response.json({ error: 'every flow needs a status of passed or failed' }, { status: 400 })
      return defaultAnswer(url)
    })
    await cmdFlowRun([flowFile('other.yaml', { appId: 'com.a' }), flowFile('mine.yaml')], { token: 'tflw_pat_x', build: 7 })
    expect(relay.calls.map((c) => c.url.replace(/^.*\/api\/v1/, ''))).toEqual(['/builds/7', '/runs', '/runs/run-1/flows/0', '/runs/run-1/device', '/runs/run-1/flows/1/start', '/runs/run-1/flows/1', '/runs/run-1/finish'])
    expect(errLines().filter((l) => l.startsWith('skipped flows not recorded'))).toHaveLength(1)
    expect(logLines().some((l) => l.startsWith('recorded as run run-1') && !l.includes('incomplete'))).toBe(true)
  })

  describe('the run reset (S4)', () => {
    const bootOpts = () => (mocks.bootDevice.mock.calls[0] as unknown[])[2] as Record<string, unknown>
    const REPORT = { done: ['app-uninstall', 'keychain'], failed: ['location'] }

    it('uninstalls the build it is about to install, and clears the apps it only runs', async () => {
      relayWith()
      await cmdFlowRun([flowFile('mine.yaml', { appId: 'com.b' }), flowFile('helper.yaml')], { token: 'tflw_pat_x', build: 7 })
      expect(bootOpts()['runReset']).toEqual({ uninstall: ['com.b'], clear: [] })
    })

    it('clears rather than uninstalls a build it will not install', async () => {
      relayWith()
      await cmdFlowRun([flowFile('mine.yaml', { appId: 'com.b' })], { token: 'tflw_pat_x', build: 7, install: false })
      expect(bootOpts()['runReset']).toEqual({ uninstall: [], clear: ['com.b'] })
    })

    // Without builds:write the build has no bundle id here; its flows' appId is all there is to clear.
    it('clears the flows\' apps when the relay will not say what the build is', async () => {
      relayWith(() => Response.json({}, { status: 403 }))
      await cmdFlowRun([flowFile('mine.yaml', { appId: 'com.b' })], { token: 'tflw_pat_x', build: 7 })
      expect(bootOpts()['runReset']).toEqual({ uninstall: [], clear: ['com.b'] })
    })

    it('names an appId the relay would drop the whole reset for, and resets the rest', async () => {
      relayWith()
      await cmdFlowRun([flowFile('mine.yaml', { appId: 'com.b' }), flowFile('odd.yaml', { appId: 'x;reboot' })], { token: 'tflw_pat_x' })
      expect(bootOpts()['runReset']).toEqual({ uninstall: [], clear: ['com.b'] })
      expect(errLines()).toContain('not reset, not an app id: "x;reboot"')
    })

    it('asks for no reset with --no-reset, and records that it did not', async () => {
      const relay = relayWith()
      await cmdFlowRun([flowFile('mine.yaml', { appId: 'com.b' })], { token: 'tflw_pat_x', build: 7, reset: false })
      expect(bootOpts()).not.toHaveProperty('runReset')
      expect(relay.calls.find((c) => c.url.endsWith('/api/v1/runs'))!.body).toMatchObject({ resetRequested: false })
      expect(errLines().some((l) => l.startsWith('device not reset'))).toBe(false)
    })

    it('records the request and what the boot answered, and says what was reset', async () => {
      const relay = relayWith()
      mocks.bootDevice.mockResolvedValueOnce({ cold: false, runReset: REPORT })
      await cmdFlowRun([flowFile('mine.yaml', { appId: 'com.b' })], { token: 'tflw_pat_x', build: 7 })
      expect(relay.calls.find((c) => c.url.endsWith('/api/v1/runs'))!.body).toMatchObject({ resetRequested: true })
      expect(relay.calls.find((c) => c.url.endsWith('/run-1/device'))!.body).toEqual({ sessionId: 's1', deviceId: 'dev1', deviceName: 'dev', cold: false, runReset: REPORT })
      expect(logLines()).toContain('reset on dev: app-uninstall, keychain')
      expect(errLines().some((l) => l.startsWith('reset failed: location'))).toBe(true)
      // Before the install: a run that fails to install still has its device recorded.
      const deviceAt = relay.calls.findIndex((c) => c.url.endsWith('/run-1/device'))
      expect(deviceAt).toBeGreaterThan(-1)
      expect(mocks.installApp.mock.invocationCallOrder[0]!).toBeGreaterThan(mocks.bootDevice.mock.invocationCallOrder[0]!)
    })

    it('warns when nothing says the device was reset, and runs anyway', async () => {
      relayWith()
      await cmdFlowRun([flowFile('mine.yaml', { appId: 'com.b' })], { token: 'tflw_pat_x', build: 7 })
      expect(errLines().some((l) => l.startsWith('device not reset: the agent or the relay predates run resets'))).toBe(true)
      expect(mocks.runFlow).toHaveBeenCalledTimes(1)
      expect(process.exitCode).toBe(0)
    })
  })
})

describe('cmdFlowRun keeps each flow\'s video beside the record (A4)', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    vi.clearAllMocks()
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-flow-video-'))
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

  const videoCalls = (calls: { url: string; body: unknown }[]) =>
    calls.filter((c) => c.url.includes('/video')).map((c) => c.url.replace('http://localhost:4000/api/v1/runs/run-1/flows/', ''))

  it('asks for H.264 and reads the stream only when the run is recorded', async () => {
    fakeRelay()
    mocks.runFlow.mockResolvedValue(resultOf('passed'))
    await cmdFlowRun([file], { token: 'tflw_pat_x' })
    expect(mocks.bootDevice).toHaveBeenLastCalledWith('s1', 'dev1', expect.objectContaining({ acceptH264: true }))
    expect(mocks.setStreamListener.mock.calls.map(([l]) => l === null)).toEqual([false, true])
    // Before the join: a join with no listener asks the relay for no stream, and the video would be empty.
    expect(mocks.setStreamListener.mock.invocationCallOrder[0]!).toBeLessThan(mocks.joinSession.mock.invocationCallOrder[0]!)

    vi.clearAllMocks()
    await cmdFlowRun([file], { token: 'tflw_pat_x', record: false })
    expect(mocks.bootDevice).toHaveBeenLastCalledWith('s1', 'dev1', expect.objectContaining({ acceptH264: false }))
    expect(mocks.setStreamListener.mock.calls.filter(([l]) => l !== null)).toEqual([])
  })

  it('sends each flow\'s frames as its video, with the step marks, and ends it', async () => {
    const relay = fakeRelay()
    mocks.runFlow.mockImplementation(async (_flow: unknown, _driver: unknown, opts: { onStep?: (m: unknown) => void }) => {
      const tap = streamListener()
      tap.frame(IDR)
      opts.onStep?.({ index: 0, name: 'tap', phase: 'start' })
      tap.frame(PFRAME)
      return { ...resultOf('failed', 'product'), failureScreenshot: Buffer.from('png') }
    })
    await cmdFlowRun([file, file], { token: 'tflw_pat_x' })

    // The second flow's video starts with the frames since the first one's last keyframe, so its own keyframe
    // opens a second chunk.
    expect(videoCalls(relay.calls)).toEqual([
      '0/video/open', '0/video/chunks/0', '0/video/end',
      '1/video/open', '1/video/chunks/0', '1/video/chunks/1', '1/video/end',
    ])
    const open = relay.calls.find((c) => c.url.endsWith('/0/video/open'))!.body as Record<string, unknown>
    expect(open).toMatchObject({ formatVersion: 1, codec: 'h264', platform: 'ios' })
    const chunk = relay.calls.find((c) => c.url.endsWith('/0/video/chunks/0'))!.body as Uint8Array
    expect(Buffer.from(chunk).includes(Buffer.from('"type":"step"'))).toBe(true)
    expect(relay.calls.find((c) => c.url.endsWith('/0/video/end'))!.body).toEqual({ lastSeq: 0, reason: 'done' })
    // The record is unchanged by its video.
    expect(relay.calls.filter((c) => !c.url.includes('/video')).map((c) => c.url.replace('http://localhost:4000', ''))).toEqual([
      '/api/v1/runs', '/api/v1/runs/run-1/device',
      '/api/v1/runs/run-1/flows/0/start', '/api/v1/runs/run-1/flows/0', '/api/v1/runs/run-1/flows/0/screenshot',
      '/api/v1/runs/run-1/flows/1/start', '/api/v1/runs/run-1/flows/1', '/api/v1/runs/run-1/flows/1/screenshot',
      '/api/v1/runs/run-1/finish',
    ])
    expect(process.exitCode).toBe(1)
  })

  it('retries a failed flow\'s last chunk, and says the video lost its end when the retry fails too', async () => {
    let tries = 0
    const relay = fakeRelay((url) => {
      if (url.endsWith('/video/chunks/0')) { tries++; return Response.json({}, { status: 503 }) }
      return defaultAnswer(url)
    })
    mocks.runFlow.mockImplementation(async () => {
      streamListener().frame(IDR)
      return resultOf('failed', 'product')
    })
    await cmdFlowRun([file], { token: 'tflw_pat_x' })
    expect(tries).toBe(2)
    expect(relay.calls.find((c) => c.url.endsWith('/0/video/end'))!.body).toEqual({ lastSeq: 0, reason: 'truncated' })
  })

  it('ends the video of a flow cut off by an error, so it is not left open', async () => {
    const relay = fakeRelay()
    mocks.runFlow.mockImplementation(async () => {
      streamListener().frame(IDR)
      throw new Error('relay connection closed')
    })
    await cmdFlowRun([file], { token: 'tflw_pat_x' })
    expect(process.exitCode).toBe(2)
    expect(relay.calls.find((c) => c.url.endsWith('/0/video/end'))!.body).toEqual({ lastSeq: 0, reason: 'done' })
  })

  it('never changes the result when the relay refuses video', async () => {
    const relay = fakeRelay((url) => (url.includes('/video') ? Response.json({ error: 'no' }, { status: 500 }) : defaultAnswer(url)))
    mocks.runFlow.mockImplementation(async () => {
      streamListener().frame(IDR)
      return resultOf('passed')
    })
    // No reset asked, so the one line on stderr is the video's.
    await cmdFlowRun([file], { token: 'tflw_pat_x', reset: false })
    expect(process.exitCode).toBe(0)
    expect(relay.calls.some((c) => c.url.endsWith('/finish'))).toBe(true)
    expect(vi.mocked(console.error).mock.calls.map(([l]) => String(l))).toEqual([expect.stringContaining('video stopped: the relay answered 500')])
  })

  it('on SIGINT ends the flow\'s video as cancelled, after finishing the record', async () => {
    const relay = fakeRelay()
    const before = { SIGINT: process.listeners('SIGINT'), SIGTERM: process.listeners('SIGTERM') }
    let exited: (code: number) => void = () => {}
    const exitCode = new Promise<number>((resolve) => { exited = resolve })
    vi.spyOn(process, 'exit').mockImplementation(((code: number) => { exited(code) }) as never)
    mocks.runFlow.mockImplementation(() => {
      streamListener().frame(IDR)
      process.emit('SIGINT', 'SIGINT')
      return new Promise(() => {})
    })
    void cmdFlowRun([file], { token: 'tflw_pat_x' })

    expect(await exitCode).toBe(130)
    expect(relay.calls.find((c) => c.url.endsWith('/0/video/end'))!.body).toEqual({ lastSeq: 0, reason: 'cancelled' })
    expect(relay.calls.some((c) => c.url.endsWith('/finish'))).toBe(true)
    for (const sig of ['SIGINT', 'SIGTERM'] as const) {
      for (const l of process.listeners(sig)) if (!before[sig].includes(l)) process.off(sig, l)
    }
  })
})
