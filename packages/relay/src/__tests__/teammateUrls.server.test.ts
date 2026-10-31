import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import http from 'http'
import os from 'os'
import path from 'path'
import { RelayServer } from '../RelayServer'
import { initDb, closeDb, getDb } from '../db'
import { signJwt } from '../middleware/auth'
import { config, type TapflowConfig } from '../lib/config'
import type { TunnelRuntime } from '../lib/publicUrl'

// The invite link a teammate is mailed and the one the dashboard copies must be the same link (#788),
// and both must follow the tunnel the CLI actually started rather than the one config names (#794).

const state = vi.hoisted(() => ({ inContainer: false }))

vi.mock('../lib/mailer.js', () => ({ sendMail: vi.fn(async () => true) }))
vi.mock('../lib/lanAddress.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/lanAddress.js')>()),
  runningInContainer: () => state.inContainer,
}))

const { sendMail } = await import('../lib/mailer.js')

const cookie = () => `tapflow_token=${signJwt({ userId: 1, email: 'admin@test.local', role: 'Admin' })}`

const rathole = (publicUrl: string): TapflowConfig['tunnel'] =>
  ({ provider: 'rathole', serverAddr: 'vps.example.com:2333', publicUrl, ssh: null })

/** Sets both keys every time: config.load() reads the shell's TAPFLOW_RELAY_URL and <dataDir>/.env, so a
 *  case that set only one would inherit whatever the machine running the suite has. */
function configure(tunnel: TapflowConfig['tunnel'], relayUrl: string | null) {
  config.tunnel = tunnel
  config.relay.url = relayUrl
}

interface Reply { status: number; body: { token?: string; inviteUrl?: string | null } }

/** node:http rather than fetch, so a forged Host header is actually sent. */
function post(port: number, pathname: string, payload: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  const data = JSON.stringify(payload)
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: pathname, method: 'POST', headers: { 'Content-Type': 'application/json', cookie: cookie(), ...headers } },
      (res) => {
        let text = ''
        res.on('data', (c) => { text += c })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text || '{}') }))
      },
    )
    req.on('error', reject)
    req.end(data)
  })
}

function mailedHref(): string {
  const calls = vi.mocked(sendMail).mock.calls
  expect(calls.length, 'no invitation mail was sent').toBe(1)
  const match = /href="([^"]+)"/.exec(calls[0][2])
  expect(match, 'the mail carries no link').not.toBeNull()
  return match![1]
}

async function withServer(tunnel: TunnelRuntime | undefined, run: (port: number) => Promise<void>) {
  const server = new RelayServer({ port: 0, ...(tunnel !== undefined ? { tunnel } : {}) })
  await server.start()
  try {
    await run((server.address() as { port: number }).port)
  } finally {
    await server.stop()
  }
}

describe('teammate-facing URLs from the relay', () => {
  let tmpDir: string
  const saved = { tunnel: config.tunnel, relayUrl: config.relay.url }

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-teammate-urls-'))
    initDb(path.join(tmpDir, 'test.db'))
    getDb().prepare("INSERT INTO users (id, email, display_name, role, password_hash) VALUES (1, 'admin@test.local', 'Admin', 'Admin', 'x')").run()
  })

  afterAll(() => {
    closeDb()
    fs.rmSync(tmpDir, { recursive: true })
  })

  beforeEach(() => {
    vi.mocked(sendMail).mockClear()
    state.inContainer = false
  })

  afterEach(() => {
    config.tunnel = saved.tunnel
    config.relay.url = saved.relayUrl
  })

  describe('POST /api/v1/team/invite', () => {
    it('returns the same link it mails (#788)', async () => {
      configure(null, 'http://192.168.219.113:4000')
      await withServer(undefined, async (port) => {
        const res = await post(port, '/api/v1/team/invite', { email: 'qa@test.local', role: 'QA' })
        expect(res.status).toBe(201)
        expect(res.body.inviteUrl).toBe(`http://192.168.219.113:4000/invite?token=${res.body.token}`)
        expect(mailedHref()).toBe(res.body.inviteUrl)
      })
    })

    it('does not take the address from a forged Host header', async () => {
      configure(null, 'http://192.168.219.113:4000')
      await withServer(undefined, async (port) => {
        const res = await post(port, '/api/v1/team/invite', { email: 'qa@test.local' }, { Host: 'evil.example' })
        expect(res.status).toBe(201)
        expect(res.body.inviteUrl).toMatch(/^http:\/\/192\.168\.219\.113:4000\/invite\?token=/)
        expect(mailedHref()).toBe(res.body.inviteUrl)
      })
    })

    it('returns the link without an email, and sends nothing', async () => {
      configure(null, 'http://192.168.219.113:4000')
      await withServer(undefined, async (port) => {
        const res = await post(port, '/api/v1/team/invite', { role: 'QA' })
        expect(res.status).toBe(201)
        expect(res.body.inviteUrl).toBe(`http://192.168.219.113:4000/invite?token=${res.body.token}`)
        expect(sendMail).not.toHaveBeenCalled()
      })
    })

    it('returns null with nothing configured, while mail keeps its localhost fallback', async () => {
      configure(null, null)
      await withServer(undefined, async (port) => {
        const res = await post(port, '/api/v1/team/invite', { email: 'qa@test.local' })
        expect(res.status).toBe(201)
        expect(res.body.inviteUrl).toBeNull()
        expect(mailedHref()).toBe(`http://localhost:${config.local.port}/invite?token=${res.body.token}`)
      })
    })

    it('returns null for a loopback relay.url, while mail is unchanged', async () => {
      configure(null, 'ws://localhost:4000')
      await withServer(undefined, async (port) => {
        const res = await post(port, '/api/v1/team/invite', { email: 'qa@test.local' })
        expect(res.status).toBe(201)
        expect(res.body.inviteUrl).toBeNull()
        expect(mailedHref()).toBe(`http://localhost:4000/invite?token=${res.body.token}`)
      })
    })

    it('prefers the tunnel over relay.url in both', async () => {
      configure(rathole('https://vps.example.com'), 'http://192.168.0.9:4000')
      await withServer(undefined, async (port) => {
        const res = await post(port, '/api/v1/team/invite', { email: 'qa@test.local' })
        expect(res.body.inviteUrl).toBe(`https://vps.example.com/invite?token=${res.body.token}`)
        expect(mailedHref()).toBe(res.body.inviteUrl)
      })
    })

    it('uses the tunnel URL the CLI detected (#794)', async () => {
      configure({ provider: 'tailscale' }, null)
      await withServer({ publicUrl: 'http://mac.tailnet.ts.net:4000' }, async (port) => {
        const res = await post(port, '/api/v1/team/invite', { email: 'qa@test.local' })
        expect(res.body.inviteUrl).toBe(`http://mac.tailnet.ts.net:4000/invite?token=${res.body.token}`)
        expect(mailedHref()).toBe(res.body.inviteUrl)
      })
    })

    it('drops a configured tunnel the CLI reports did not start', async () => {
      configure(rathole('https://vps.example.com'), null)
      await withServer({ publicUrl: null }, async (port) => {
        const res = await post(port, '/api/v1/team/invite', { email: 'qa@test.local' })
        expect(res.body.inviteUrl).toBeNull()
        expect(mailedHref()).toBe(`http://localhost:${config.local.port}/invite?token=${res.body.token}`)
      })
    })

    it('trusts config when no entry point reports tunnel state (standalone relay)', async () => {
      configure(rathole('https://vps.example.com'), null)
      await withServer(undefined, async (port) => {
        const res = await post(port, '/api/v1/team/invite', { email: 'qa@test.local' })
        expect(res.body.inviteUrl).toBe(`https://vps.example.com/invite?token=${res.body.token}`)
        expect(mailedHref()).toBe(res.body.inviteUrl)
      })
    })
  })

  describe('POST /api/v1/team/members/:id/send-reset', () => {
    it('uses the tunnel URL the CLI detected (#794)', async () => {
      configure({ provider: 'tailscale' }, null)
      await withServer({ publicUrl: 'http://mac.tailnet.ts.net:4000' }, async (port) => {
        const res = await post(port, '/api/v1/team/members/1/send-reset', {})
        expect(res.status).toBe(200)
        expect(mailedHref()).toMatch(/^http:\/\/mac\.tailnet\.ts\.net:4000\/reset-password\?token=/)
      })
    })
  })

  describe('GET /api/v1/relay/host', () => {
    interface HostInfo { lanHost: string | null; port: number; publicBaseUrl: string | null; agentRelayUrl: string | null; publicUrlWarning?: 'container-without-public-url' }
    const hostInfo = async (port: number): Promise<HostInfo> => {
      const res = await fetch(`http://localhost:${port}/api/v1/relay/host`, { headers: { cookie: cookie() } })
      expect(res.status).toBe(200)
      return await res.json() as HostInfo
    }

    it('reports the teammate link base and the agent address separately', async () => {
      configure(rathole('https://vps.example.com'), 'http://192.168.0.9:4000')
      await withServer(undefined, async (port) => {
        const body = await hostInfo(port)
        expect(body.publicBaseUrl).toBe('https://vps.example.com')
        expect(body.agentRelayUrl).toBe('ws://192.168.0.9:4000')
        expect(body).not.toHaveProperty('publicUrlWarning')
        expect(body.port).toBe(port)
        if (body.lanHost !== null) expect(body.lanHost).toMatch(/^\d+\.\d+\.\d+\.\d+$/)
      })
    })

    it('reports null for both when nothing usable is configured', async () => {
      configure(null, null)
      await withServer(undefined, async (port) => {
        const body = await hostInfo(port)
        expect(body).toMatchObject({ publicBaseUrl: null, agentRelayUrl: null })
        expect(body).not.toHaveProperty('publicUrlWarning')
      })
      configure(null, 'ws://localhost:4000')
      await withServer(undefined, async (port) => {
        expect(await hostInfo(port)).toMatchObject({ publicBaseUrl: null, agentRelayUrl: null })
      })
      configure(rathole('https://vps.example.com'), null)
      await withServer({ publicUrl: null }, async (port) => {
        expect(await hostInfo(port)).toMatchObject({ publicBaseUrl: null, agentRelayUrl: null })
      })
    })

    it('does not offer a LAN guess from inside a container', async () => {
      configure(null, null)
      state.inContainer = true
      await withServer(undefined, async (port) => {
        const body = await hostInfo(port)
        expect(body.port).toBe(port)
        expect(body.lanHost).toBeNull()
      })
    })

    it('adds only the structured warning reason for a container without a teammate URL', async () => {
      configure(null, null)
      state.inContainer = true
      await withServer(undefined, async (port) => {
        expect(await hostInfo(port)).toMatchObject({
          lanHost: null,
          port,
          publicBaseUrl: null,
          agentRelayUrl: null,
          publicUrlWarning: 'container-without-public-url',
        })
      })
    })

    it('suppresses the warning for a reachable runtime tunnel URL', async () => {
      configure({ provider: 'tailscale' }, 'http://192.168.0.9:4000')
      state.inContainer = true
      await withServer({ publicUrl: 'https://mac.tailnet.ts.net:4000' }, async (port) => {
        const body = await hostInfo(port)
        expect(body.publicBaseUrl).toBe('https://mac.tailnet.ts.net:4000')
        expect(body.publicUrlWarning).toBeUndefined()
      })
    })

    it('uses failed runtime state instead of a configured tunnel URL', async () => {
      configure(rathole('https://stale.example.com'), null)
      state.inContainer = true
      await withServer({ publicUrl: null }, async (port) => {
        const body = await hostInfo(port)
        expect(body.publicBaseUrl).toBeNull()
        expect(body.publicUrlWarning).toBe('container-without-public-url')
      })
    })

    it('warns for an unusable selected tunnel even when relay.url is a valid secondary candidate', async () => {
      configure(rathole('http://127.0.0.1:4000'), 'https://relay.example.com')
      state.inContainer = true
      await withServer({ publicUrl: 'http://127.0.0.1:4000' }, async (port) => {
        const body = await hostInfo(port)
        expect(body.publicBaseUrl).toBeNull()
        expect(body.agentRelayUrl).toBe('wss://relay.example.com')
        expect(body.publicUrlWarning).toBe('container-without-public-url')
      })
    })
  })
})
