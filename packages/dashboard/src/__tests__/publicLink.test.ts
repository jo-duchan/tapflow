import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  resolveTeammateBases,
  joinPath,
  loadTeammateBases,
  resetTeammateBasesForTests,
  LOOKUP_DEADLINE_MS,
  type RelayHostInfo,
} from '@/lib/publicLink'

const info = (over: Partial<RelayHostInfo> = {}): RelayHostInfo =>
  ({ lanHost: null, port: 4000, publicBaseUrl: null, agentRelayUrl: null, ...over })

const viewer = (url: string) => {
  const u = new URL(url)
  return { protocol: u.protocol, hostname: u.hostname, host: u.host, origin: u.origin }
}

function stubRelayHost(response: { ok: boolean; body?: unknown } | Error) {
  const fetchMock = vi.fn(() => response instanceof Error
    ? Promise.reject(response)
    : Promise.resolve({ ok: response.ok, json: () => Promise.resolve(response.body) }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('resolveTeammateBases', () => {
  const configured = info({ publicBaseUrl: 'http://192.168.219.113:4000', agentRelayUrl: 'ws://192.168.219.113:4000', lanHost: '10.0.0.2' })

  it('uses the configured addresses for a viewer on localhost', () => {
    expect(resolveTeammateBases(configured, viewer('http://localhost:3001')))
      .toEqual({ linkBase: 'http://192.168.219.113:4000', agentWsBase: 'ws://192.168.219.113:4000' })
  })

  it('uses the configured addresses for a viewer on the LAN too (row C)', () => {
    expect(resolveTeammateBases(configured, viewer('http://192.168.0.7:4000')))
      .toEqual({ linkBase: 'http://192.168.219.113:4000', agentWsBase: 'ws://192.168.219.113:4000' })
  })

  it('keeps the viewer origin for a viewer already on the LAN, whatever the relay guesses (row A)', () => {
    expect(resolveTeammateBases(info({ lanHost: '10.0.0.2' }), viewer('http://192.168.0.7:4000')))
      .toEqual({ linkBase: 'http://192.168.0.7:4000', agentWsBase: 'ws://192.168.0.7:4000' })
  })

  it.each(['http://localhost:3001', 'http://127.0.0.1:3001', 'http://[::1]:3001'])(
    'replaces a local viewer (%s) with the relay LAN address at the relay port (rows B, D)',
    (url) => {
      expect(resolveTeammateBases(info({ lanHost: '192.168.0.50' }), viewer(url)))
        .toEqual({ linkBase: 'http://192.168.0.50:4000', agentWsBase: 'ws://192.168.0.50:4000' })
    },
  )

  it('falls back to the viewer when the relay could not be asked', () => {
    expect(resolveTeammateBases(null, viewer('http://localhost:3000')))
      .toEqual({ linkBase: 'http://localhost:3000', agentWsBase: 'ws://localhost:3000' })
  })

  it('lets a link and the agent address differ: a tunnel is for browsers only (rows F, G)', () => {
    const tunnel = info({ publicBaseUrl: 'http://mac.tailnet.ts.net:4000', agentRelayUrl: null, lanHost: '192.168.0.50' })
    expect(resolveTeammateBases(tunnel, viewer('http://localhost:4000')))
      .toEqual({ linkBase: 'http://mac.tailnet.ts.net:4000', agentWsBase: 'ws://192.168.0.50:4000' })
  })

  it('keeps the recognized relay warning alongside the existing teammate addresses', () => {
    expect(resolveTeammateBases(info({
      publicBaseUrl: 'https://relay.example.com',
      publicUrlWarning: 'container-without-public-url',
    }), viewer('http://localhost:3000'))).toMatchObject({
      linkBase: 'https://relay.example.com',
      publicUrlWarning: 'container-without-public-url',
    })
  })

  it('follows an https viewer for the fallback schemes', () => {
    expect(resolveTeammateBases(info({ lanHost: '192.168.0.50' }), viewer('https://localhost:4000')))
      .toEqual({ linkBase: 'https://192.168.0.50:4000', agentWsBase: 'wss://192.168.0.50:4000' })
  })
})

describe('joinPath', () => {
  it('joins without doubling or dropping the slash', () => {
    expect(joinPath('https://x.example.com/tapflow', '/invite?token=t')).toBe('https://x.example.com/tapflow/invite?token=t')
    expect(joinPath('https://x.example.com/tapflow/', '/invite?token=t')).toBe('https://x.example.com/tapflow/invite?token=t')
    expect(joinPath('http://a:4000', '/x')).toBe('http://a:4000/x')
  })
})

describe('loadTeammateBases', () => {
  beforeEach(() => resetTeammateBasesForTests())
  afterEach(() => vi.unstubAllGlobals())

  it('asks the relay once per page', async () => {
    const fetchMock = stubRelayHost({ ok: true, body: info({ lanHost: '192.168.0.50' }) })
    expect(fetchMock).toHaveBeenCalledTimes(0)
    const results = await Promise.all([loadTeammateBases(), loadTeammateBases(), loadTeammateBases()])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // The signal is what lets the deadline end a lookup that never settles.
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/relay/host', expect.objectContaining({ credentials: 'include', signal: expect.any(AbortSignal) }))
    expect(results.map((r) => r.linkBase)).toEqual(Array(3).fill('http://192.168.0.50:4000'))
  })

  it('does not cache a failed lookup', async () => {
    const fetchMock = stubRelayHost({ ok: false, body: { error: 'Unauthorized' } })
    await loadTeammateBases()
    await loadTeammateBases()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('accepts a legacy host response with no warning reason', async () => {
    const fetchMock = stubRelayHost({ ok: true, body: info() })
    const result = await loadTeammateBases()
    expect(result).not.toHaveProperty('publicUrlWarning')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('keeps independently valid fields from a partial legacy host response', async () => {
    stubRelayHost({ ok: true, body: { publicBaseUrl: 'https://relay.example.com' } })
    await expect(loadTeammateBases()).resolves.toMatchObject({
      linkBase: 'https://relay.example.com',
      agentWsBase: `ws://${window.location.host}`,
    })
  })

  it('ignores an unknown warning reason without losing the host addresses', async () => {
    stubRelayHost({ ok: true, body: { ...info({ publicBaseUrl: 'https://relay.example.com' }), publicUrlWarning: 'future-reason' } })
    await expect(loadTeammateBases()).resolves.toMatchObject({ linkBase: 'https://relay.example.com' })
    await expect(loadTeammateBases()).resolves.not.toHaveProperty('publicUrlWarning')
  })

  it('preserves the known warning reason from the host response', async () => {
    stubRelayHost({ ok: true, body: { ...info(), publicUrlWarning: 'container-without-public-url' } })
    await expect(loadTeammateBases()).resolves.toMatchObject({ publicUrlWarning: 'container-without-public-url' })
  })

  it('gives up on a lookup that never settles, falls back, and does not cache it', async () => {
    vi.useFakeTimers()
    try {
      // Settles only when aborted, as a real fetch does.
      const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      }))
      vi.stubGlobal('fetch', fetchMock)

      const lookup = loadTeammateBases()
      await vi.advanceTimersByTimeAsync(LOOKUP_DEADLINE_MS)
      await expect(lookup).resolves.toEqual({ linkBase: 'http://localhost:3000', agentWsBase: 'ws://localhost:3000' })

      void loadTeammateBases()
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([
    ['a refused request', { ok: false, body: { error: 'Unauthorized' } }],
    ['a network error', new Error('offline')],
  ] as const)('falls back to the viewer on %s, without throwing', async (_label, response) => {
    expect(window.location.origin).toBe('http://localhost:3000')
    stubRelayHost(response)
    await expect(loadTeammateBases()).resolves.toEqual({ linkBase: 'http://localhost:3000', agentWsBase: 'ws://localhost:3000' })
  })
})

// Every other dashboard test runs with jsdom's default viewer, localhost:3000, so none of them could tell
// a wrapper that reads window.location from one that assumes localhost.
describe('loadTeammateBases reads the viewer from the page', () => {
  const dom = (globalThis as unknown as { jsdom: { reconfigure(options: { url: string }): void } }).jsdom
  const original = window.location.href

  beforeEach(() => resetTeammateBasesForTests())
  afterEach(() => {
    dom.reconfigure({ url: original })
    vi.unstubAllGlobals()
  })

  it('does not substitute the LAN address for a viewer already on the LAN (row A)', async () => {
    dom.reconfigure({ url: 'http://192.168.0.7:4000/settings/team' })
    expect(window.location.origin).toBe('http://192.168.0.7:4000')
    stubRelayHost({ ok: true, body: info({ lanHost: '10.0.0.2' }) })
    await expect(loadTeammateBases()).resolves.toEqual({ linkBase: 'http://192.168.0.7:4000', agentWsBase: 'ws://192.168.0.7:4000' })
  })
})
