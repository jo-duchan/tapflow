import { describe, it, expect, vi } from 'vitest'
import { isEligible, lookupBuild, parseTagList } from '../eligibility.js'
import { fixedToken } from '../credentials.js'

const build = (bundleId: string | null) => ({ build: { id: 42, bundleId } })

describe('isEligible', () => {
  it('runs a flow with no appId against any build', () => {
    expect(isEligible({}, build('com.b'))).toEqual({ ok: true })
  })

  it('runs a flow whose appId matches the build', () => {
    expect(isEligible({ appId: 'com.a' }, build('com.a'))).toEqual({ ok: true })
  })

  it('skips a flow whose appId differs from the build, naming both ids', () => {
    expect(isEligible({ appId: 'com.a' }, build('com.a.debug'))).toEqual({
      ok: false, reason: 'app-mismatch', message: 'flow is for com.a, build 42 is com.a.debug',
    })
  })

  it('runs the flow when the build is unknown or its bundle id could not be read', () => {
    expect(isEligible({ appId: 'com.a' }, {})).toEqual({ ok: true })
    expect(isEligible({ appId: 'com.a' }, build(null))).toEqual({ ok: true })
  })

  it('runs only flows carrying one of the included tags', () => {
    const target = { includeTags: ['smoke', 'login'] }
    expect(isEligible({ tags: ['login'] }, target)).toEqual({ ok: true })
    expect(isEligible({ tags: ['slow'] }, target)).toEqual({ ok: false, reason: 'tag-filter', message: 'not tagged smoke or login' })
    expect(isEligible({}, target)).toEqual({ ok: false, reason: 'tag-filter', message: 'not tagged smoke or login' })
  })

  it('treats an empty include list as no filter', () => {
    expect(isEligible({}, { includeTags: [] })).toEqual({ ok: true })
  })

  it('lets an excluded tag win over an included one', () => {
    expect(isEligible({ tags: ['smoke', 'flaky'] }, { includeTags: ['smoke'], excludeTags: ['flaky'] }))
      .toEqual({ ok: false, reason: 'tag-filter', message: 'tagged flaky' })
  })

  it('reports the tag filter before the app check', () => {
    expect(isEligible({ appId: 'com.a', tags: ['flaky'] }, { ...build('com.b'), excludeTags: ['flaky'] }))
      .toMatchObject({ reason: 'tag-filter' })
  })
})

describe('parseTagList', () => {
  it('splits on commas and drops blanks', () => {
    expect(parseTagList(' smoke, ,login ')).toEqual(['smoke', 'login'])
    expect(parseTagList(undefined)).toEqual([])
  })
})

describe('lookupBuild', () => {
  const tokens = fixedToken('tfp_x', 'http://relay')
  const answer = (status: number, body: unknown) =>
    vi.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }))

  it('returns the bundle id and platform of a found build', async () => {
    const f = answer(200, { id: 42, bundle_id: 'com.a', platform: 'ios' })
    expect(await lookupBuild('http://relay', tokens, 42, f)).toEqual({ kind: 'found', bundleId: 'com.a', platform: 'ios' })
    expect(f).toHaveBeenCalledWith('http://relay/api/v1/builds/42', expect.anything())
  })

  it('returns a null bundle id when the relay has none', async () => {
    expect(await lookupBuild('http://relay', tokens, 42, answer(200, { id: 42, bundle_id: null }))).toEqual({ kind: 'found', bundleId: null, platform: null })
  })

  it('treats 404 as a build that does not exist', async () => {
    expect(await lookupBuild('http://relay', tokens, 42, answer(404, { error: 'Build not found' }))).toEqual({ kind: 'not-found' })
  })

  it.each([401, 403, 500])('treats %i as unknown, not as an error about the build', async (status) => {
    expect(await lookupBuild('http://relay', tokens, 42, answer(status, {}))).toMatchObject({ kind: 'unknown' })
  })

  it('treats an HTML answer from an older relay as unknown', async () => {
    expect(await lookupBuild('http://relay', tokens, 42, answer(200, '<!doctype html>'))).toMatchObject({ kind: 'unknown' })
  })

  it('treats a network error as unknown', async () => {
    const f = vi.fn(async () => { throw new Error('ECONNREFUSED') })
    expect(await lookupBuild('http://relay', tokens, 42, f)).toMatchObject({ kind: 'unknown', reason: expect.stringContaining('ECONNREFUSED') })
  })

  it('does not ask without a token', async () => {
    const f = answer(200, {})
    expect(await lookupBuild('http://relay', fixedToken('', 'http://relay'), 42, f)).toEqual({ kind: 'unknown', reason: 'no token' })
    expect(f).not.toHaveBeenCalled()
  })

  it('gives up after its deadline', async () => {
    const f = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('timed out')))
    }))
    expect(await lookupBuild('http://relay', tokens, 42, f as unknown as typeof fetch, 20)).toMatchObject({ kind: 'unknown' })
  })
})
