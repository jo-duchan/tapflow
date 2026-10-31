import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import http from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { WebSocket } from 'ws'
import { RelayServer } from '../RelayServer'
import { initDb, getDb, closeDb } from '../db'
import { makePasswordHash } from '../api/auth'
import { signJwt } from '../middleware/auth'
import { waitForOpen, waitForType } from '@tapflowio/test-utils'
import type { AgentRegistered, AgentsListed, DeviceSummary } from '@tapflowio/protocol'

/**
 * How people organise the device list (#1085): an Admin hides or renames a device for the whole team, and each
 * person stars their own. Stored on the relay and laid over `agents:listed`, never removing a device from it — an MCP
 * client and a lease read the same listing and must keep seeing every device under its own name.
 */

const USERS = { Admin: 1, QA: 2, Viewer: 3 } as const
type Role = keyof typeof USERS
const cookie = (role: Role) => `tapflow_token=${signJwt({ userId: USERS[role], email: `${role}@example.com`, role })}`

function request(port: number, method: string, body: object, urlPath: string, role: Role): Promise<{ status: number; body: Record<string, unknown> }> {
  const payload = Buffer.from(JSON.stringify(body))
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path: urlPath, method,
      headers: { Cookie: cookie(role), 'Content-Type': 'application/json', 'Content-Length': payload.length },
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') as Record<string, unknown> }))
    })
    req.on('error', reject)
    req.end(payload)
  })
}

let tmpDir: string
beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-device-prefs-'))
  initDb(path.join(tmpDir, 'test.db'))
  for (const [role, id] of Object.entries(USERS)) {
    getDb().prepare('INSERT INTO users (id, email, display_name, role, password_hash) VALUES (?, ?, ?, ?, ?)')
      .run(id, `${role}@example.com`, role, role, makePasswordHash('password123'))
  }
})
afterAll(() => {
  closeDb()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('device prefs and favourites (#1085)', () => {
  let server: RelayServer
  let port: number
  let agent: WebSocket

  beforeEach(async () => {
    getDb().exec('DELETE FROM device_prefs; DELETE FROM device_favourites')
    server = new RelayServer({ port: 0 })
    await server.start()
    port = (server.address() as { port: number }).port
    agent = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(agent)
    agent.send(JSON.stringify({
      type: 'agent:register', agentId: 'mac-1', agentName: 'the-mac', platform: 'ios', capabilities: [],
      devices: [
        { id: 'devA', name: 'iPhone A', platform: 'ios', status: 'shutdown' },
        { id: 'devB', name: 'iPhone B', platform: 'ios', status: 'shutdown' },
      ],
    }))
    await waitForType<AgentRegistered>(agent, 'agent:registered')
  })

  afterEach(async () => {
    agent.close()
    await server.stop()
  })

  const put = (body: object, role: Role = 'Admin') => request(port, 'PUT', body, '/api/v1/device-prefs', role)
  const star = (method: 'PUT' | 'DELETE', deviceId: string, role: Role) =>
    request(port, method, { agent: 'mac-1', deviceId }, '/api/v1/device-favourites', role)

  /** The listing as `role` sees it, with credentials on the socket as the dashboard's are. No credentials at all is a
   *  local socket with no account, such as an MCP client on the relay's own Mac. */
  async function listed(role?: Role): Promise<Record<string, DeviceSummary>> {
    const ws = new WebSocket(`ws://localhost:${port}`, role ? { headers: { Cookie: cookie(role) } } : {})
    await waitForOpen(ws)
    ws.send(JSON.stringify({ type: 'agents:list' }))
    const reply = await waitForType<AgentsListed>(ws, 'agents:listed')
    ws.close()
    return Object.fromEntries(reply.sessions.flatMap((s) => s.devices).map((d) => [d.id, d]))
  }

  it('hides a device for everyone without removing it from the listing', async () => {
    expect((await put({ agent: 'mac-1', deviceId: 'devA', hidden: true })).status).toBe(200)
    const forQa = await listed('QA')
    expect(forQa['devA']).toMatchObject({ name: 'iPhone A', hidden: true })
    expect(forQa['devB']?.hidden).toBeUndefined()
    // Automation reads the same listing: the device is there.
    expect((await listed())['devA']).toMatchObject({ name: 'iPhone A', hidden: true })
  })

  it('gives a device a display name and keeps its own', async () => {
    await put({ agent: 'mac-1', deviceId: 'devA', displayName: '  QA iPhone  ' })
    expect((await listed('QA'))['devA']).toMatchObject({ name: 'iPhone A', displayName: 'QA iPhone' })
  })

  it('changes only the fields sent, and deletes a row left at every default', async () => {
    await put({ agent: 'mac-1', deviceId: 'devA', hidden: true, displayName: 'QA iPhone' })
    await put({ agent: 'mac-1', deviceId: 'devA', hidden: false })
    expect((await listed('QA'))['devA']).toMatchObject({ displayName: 'QA iPhone' })
    expect((await listed('QA'))['devA']?.hidden).toBeUndefined()

    await put({ agent: 'mac-1', deviceId: 'devA', displayName: '' })
    expect((await listed('QA'))['devA']?.displayName).toBeUndefined()
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM device_prefs').get()).toEqual({ n: 0 })
  })

  it('lets only an Admin change them', async () => {
    expect((await put({ agent: 'mac-1', deviceId: 'devA', hidden: true }, 'QA')).status).toBe(403)
    expect((await put({ agent: 'mac-1', deviceId: 'devA', hidden: true }, 'Viewer')).status).toBe(403)
    expect((await listed('Admin'))['devA']?.hidden).toBeUndefined()
  })

  it('refuses a request that names no device, or names a wrong type', async () => {
    expect((await put({ deviceId: 'devA', hidden: true })).status).toBe(400)
    expect((await put({ agent: 'mac-1', deviceId: 'devA', hidden: 'yes' })).status).toBe(400)
    expect((await put({ agent: 'mac-1', deviceId: 'devA', displayName: 'x'.repeat(101) })).status).toBe(400)
    // Every row is read on every listing, so the keys are bounded too.
    expect((await put({ agent: 'm'.repeat(201), deviceId: 'devA', hidden: true })).status).toBe(400)
    expect((await star('PUT', 'd'.repeat(201), 'QA')).status).toBe(400)
    expect((await request(port, 'PUT', null as unknown as object, '/api/v1/device-favourites', 'QA')).status).toBe(400)
  })

  it('keeps each person\'s favourites to themselves, Viewers included', async () => {
    expect((await star('PUT', 'devB', 'Viewer')).status).toBe(200)
    // Twice is once.
    expect((await star('PUT', 'devB', 'Viewer')).status).toBe(200)
    expect((await listed('Viewer'))['devB']?.favourite).toBe(true)
    expect((await listed('QA'))['devB']?.favourite).toBeUndefined()
    expect((await listed())['devB']?.favourite).toBeUndefined()

    await star('DELETE', 'devB', 'Viewer')
    expect((await listed('Viewer'))['devB']?.favourite).toBeUndefined()
  })

  it('drops a person\'s favourites with them', async () => {
    getDb().prepare('INSERT INTO users (id, email, display_name, role, password_hash) VALUES (9, ?, ?, ?, ?)')
      .run('gone@example.com', 'Gone', 'QA', makePasswordHash('password123'))
    getDb().prepare("INSERT INTO device_favourites (user_id, agent_key, device_id) VALUES (9, 'mac-1', 'devA')").run()
    getDb().prepare('DELETE FROM users WHERE id = 9').run()
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM device_favourites').get()).toEqual({ n: 0 })
  })
})
