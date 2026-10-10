import { describe, it, expect, vi } from 'vitest'
import { RunRecorder } from '../../lib/runRecorder.js'
import { ciContext } from '../../lib/ci.js'

function recorder(fetchImpl: (url: string, init: RequestInit) => Promise<Response>, callTimeoutMs?: number) {
  const warn = vi.fn()
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => fetchImpl(String(url), init ?? {}))
  const r = new RunRecorder('http://relay.test', 'tflw_pat_x', { fetch: fetchMock as typeof fetch, warn, ...(callTimeoutMs ? { callTimeoutMs } : {}) })
  return { r, warn, fetchMock }
}

const ok = (url: string) => Promise.resolve(url.endsWith('/api/v1/runs') ? Response.json({ id: 'run-1' }, { status: 201 }) : Response.json({ ok: true }))
const flow = { status: 'passed' as const, durationMs: 1, steps: [] }
const planned = { client: 'c', flows: [{ name: 'a' }], ci: null }

describe('RunRecorder', () => {
  it('sends in order, with the token, and only one finish', async () => {
    const { r, fetchMock } = recorder(ok)
    r.create(planned)
    r.reportFlow(0, flow)
    r.finish({ status: 'passed', exitCode: 0 })
    r.finish({ status: 'failed', exitCode: 1 })
    r.reportFlow(1, flow)
    expect(await r.drain(1000)).toBe('run-1')
    expect(fetchMock.mock.calls.map(([u]) => String(u))).toEqual([
      'http://relay.test/api/v1/runs', 'http://relay.test/api/v1/runs/run-1/flows/0', 'http://relay.test/api/v1/runs/run-1/finish',
    ])
    expect((fetchMock.mock.calls[0]![1]!.headers as Record<string, string>).Authorization).toBe('Bearer tflw_pat_x')
  })

  it('gives up on a call that does not answer within its deadline, and warns once', async () => {
    const { r, warn, fetchMock } = recorder((_u, init) => new Promise((_res, rej) => {
      // Settles only through the deadline: with no signal it never answers.
      init.signal?.addEventListener('abort', () => rej(init.signal!.reason as Error))
    }), 30)
    r.create(planned)
    r.reportFlow(0, flow)
    r.finish({ status: 'passed', exitCode: 0 })
    expect(await r.drain(2000)).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toMatch(/^run not recorded: could not reach the relay/)
  })

  it('stops waiting at the drain cap even when a call never settles', async () => {
    const { r, warn } = recorder(() => new Promise(() => {}), 60_000)
    r.create(planned)
    const started = Date.now()
    expect(await r.drain(50)).toBeNull()
    expect(Date.now() - started).toBeLessThan(1000)
    expect(warn).toHaveBeenCalledWith('run record incomplete: the relay did not answer within 0s')
  })

  it('says the record is incomplete when a later call fails, and sends nothing after it', async () => {
    const { r, warn, fetchMock } = recorder((u) => u.endsWith('/flows/0') ? Promise.resolve(Response.json({ error: 'Run already finished' }, { status: 409 })) : ok(u))
    r.create(planned)
    r.reportFlow(0, flow)
    r.finish({ status: 'passed', exitCode: 0 })
    expect(await r.drain(1000)).toBe('run-1')
    expect(warn).toHaveBeenCalledWith('run record incomplete: the relay answered 409 (Run already finished)')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls.map(([u]) => String(u)).some((u) => u.endsWith('/finish'))).toBe(false)
  })
})

describe('ciContext', () => {
  it('is null outside CI', () => {
    expect(ciContext({})).toBeNull()
    expect(ciContext({ CI: 'false' })).toBeNull()
  })

  it.each([
    [{ CI: 'true', GITLAB_CI: 'true', CI_JOB_URL: 'https://gitlab.test/j/1', CI_COMMIT_SHA: 'a', CI_COMMIT_REF_NAME: 'main' },
      { provider: 'gitlab', branch: 'main', commit: 'a', jobUrl: 'https://gitlab.test/j/1' }],
    [{ CI: 'true', CIRCLECI: 'true', CIRCLE_BUILD_URL: 'https://circle.test/1', CIRCLE_SHA1: 'b', CIRCLE_BRANCH: 'dev' },
      { provider: 'circleci', branch: 'dev', commit: 'b', jobUrl: 'https://circle.test/1' }],
    [{ CI: 'true', BUILDKITE: 'true', BUILDKITE_BUILD_URL: 'https://bk.test/1', BUILDKITE_COMMIT: 'c', BUILDKITE_BRANCH: 'x' },
      { provider: 'buildkite', branch: 'x', commit: 'c', jobUrl: 'https://bk.test/1' }],
    [{ JENKINS_URL: 'https://j.test/', BUILD_URL: 'https://j.test/job/1/', GIT_COMMIT: 'd', GIT_BRANCH: 'origin/main' },
      { provider: 'jenkins', branch: 'origin/main', commit: 'd', jobUrl: 'https://j.test/job/1/' }],
    [{ TF_BUILD: 'True', SYSTEM_COLLECTIONURI: 'https://dev.azure.com/org/', SYSTEM_TEAMPROJECT: 'My Project', BUILD_BUILDID: '9', BUILD_SOURCEVERSION: 'e', BUILD_SOURCEBRANCHNAME: 'main' },
      { provider: 'azure', branch: 'main', commit: 'e', jobUrl: 'https://dev.azure.com/org/My%20Project/_build/results?buildId=9' }],
    [{ CI: 'true', GITHUB_ACTIONS: 'true', GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'o/r', GITHUB_RUN_ID: '1', GITHUB_SHA: 'f', GITHUB_HEAD_REF: 'feature', GITHUB_REF_NAME: '12/merge' },
      { provider: 'github', branch: 'feature', commit: 'f', jobUrl: 'https://github.com/o/r/actions/runs/1' }],
    [{ CI: 'true' }, { provider: 'ci' }],
  ])('reads %o', (env, expected) => {
    expect(ciContext(env)).toEqual(expected)
  })

  it('leaves out a job link it cannot build whole', () => {
    expect(ciContext({ CI: 'true', GITHUB_ACTIONS: 'true', GITHUB_SERVER_URL: 'https://github.com', GITHUB_SHA: 'f' }))
      .toEqual({ provider: 'github', commit: 'f' })
  })
})
