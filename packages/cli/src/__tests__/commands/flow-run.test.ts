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
      devices: [{ sessionId: 's1', name: 'dev', status: 'booted', busy: false, id: 'dev1' }],
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
    mocks.listDevices.mockResolvedValue([
      {
        devices: [{ sessionId: 's1', name: 'dev', status: 'booted', busy: false, id: 'dev1' }],
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
    mocks.runFlow.mockResolvedValue(resultOf('passed'))
    await run([flowFile('a.yaml')])
    expect(console.log).toHaveBeenCalledWith('watch this run: http://localhost:4000/automation/sessions/s1')
    const log = vi.mocked(console.log).mock
    const printedAt = log.invocationCallOrder[log.calls.findIndex(([line]) => String(line).startsWith('watch this run:'))]!
    expect(printedAt).toBeLessThan(mocks.bootDevice.mock.invocationCallOrder[0]!)
  })

  // The link is the relay's address rewritten, which a secret holding the relay URL does not mask — so a
  // public repository's CI log would show the host. Mutation: print regardless.
  it('prints no link in CI', async () => {
    vi.stubEnv('CI', 'true')
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
