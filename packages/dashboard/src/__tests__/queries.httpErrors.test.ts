import { describe, it, expect, vi, afterEach } from 'vitest'
import { getApps, getBuilds, updateBuildStatus, scheduleBuildDeletion, cancelBuildDeletion, RoleRefusedError } from '@/lib/queries'

/**
 * **An empty array is an answer, and a 500 is not one.**
 *
 * `getApps` and `getBuilds` used to `return []` on `!res.ok`, and `updateBuildStatus` did not look
 * at the status at all. So a server error, a 502 from a proxy, or a session that had expired all
 * resolved *successfully* with zero rows — and the App Center, whose whole failure state was added
 * to tell "the request failed" apart from "this app has no builds", rendered the second one.
 *
 * It was invisible to the page's own tests because every one of them drove failure with
 * `mockRejectedValue`, which is the shape a dead relay produces and the only one these helpers
 * already passed through. These exercise the helpers themselves, against a `fetch` that answers.
 */
afterEach(() => vi.unstubAllGlobals())

function respondWith(status: number, body: unknown = { items: [] }) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })))
}

describe('the fetch helpers the App Center reads through', () => {
  it.each([
    ['getApps', () => getApps()],
    ['getBuilds', () => getBuilds({ appId: 1, search: '', statusFilter: 'all' })],
    ['updateBuildStatus', () => updateBuildStatus(1, 'Done')],
  ])('%s rejects on a 500 rather than answering with nothing', async (_name, call) => {
    respondWith(500)
    await expect(call()).rejects.toThrow(/500/)
  })

  it.each([
    ['getApps', () => getApps()],
    ['getBuilds', () => getBuilds({ appId: 1, search: '', statusFilter: 'all' })],
  ])('%s rejects on a 401, which is a session to renew and not an empty account', async (_name, call) => {
    respondWith(401)
    await expect(call()).rejects.toThrow(/401/)
  })

  it('still answers with an empty list when the server really says there is nothing', async () => {
    // The point is to stop conflating the two, not to make emptiness an error.
    respondWith(200, { items: [] })
    await expect(getBuilds({ appId: 1, search: '', statusFilter: 'all' })).resolves.toEqual([])
  })
})

// A 403 on a build action is a role refusal (a Viewer, or someone demoted mid-session). It is thrown as
// its own type carrying the relay's sentence, which App Center says and answers by re-reading `/me`.
// Mutation: drop `throwIfRefused` from one helper → its row fails with the generic status error.
describe('build actions refused for the caller\'s role', () => {
  it.each([
    ['updateBuildStatus', () => updateBuildStatus(1, 'Done')],
    ['scheduleBuildDeletion', () => scheduleBuildDeletion(1)],
    ['cancelBuildDeletion', () => cancelBuildDeletion(1)],
  ])('%s rejects with RoleRefusedError and the server message on a 403', async (_name, call) => {
    respondWith(403, { error: 'Viewers have read-only access' })
    const err = await call().then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(RoleRefusedError)
    expect((err as Error).message).toBe('Viewers have read-only access')
  })

  it('a 500 is still a plain failure, not a role refusal', async () => {
    respondWith(500)
    const err = await updateBuildStatus(1, 'Done').then(() => null, (e: unknown) => e)
    expect(err).not.toBeInstanceOf(RoleRefusedError)
  })
})
