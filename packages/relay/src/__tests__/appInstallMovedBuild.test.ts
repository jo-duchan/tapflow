import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { WebSocket } from 'ws'
import { RelayServer } from '../RelayServer'
import { initDb, closeDb, getDb } from '../db'
import { waitForOpen, waitForType } from '@tapflowio/test-utils'
import type { AgentRegistered } from '@tapflowio/protocol'

/**
 * **A build uploaded before its data directory moved still installs** (#836).
 *
 * The row names the directory as it was at upload time; the file now sits in this relay's
 * `uploads/builds/`. The install used to stat the stored path, find nothing, and tell the tester the
 * build may have been deleted. What the agent receives — the local path, the ticket's path, the name —
 * has to be the file that exists.
 */
describe('app:install for a build whose data directory moved', () => {
  let server: RelayServer
  let port: number
  let tmpDir: string
  let uploadsDir: string

  beforeAll(async () => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-moved-build-')))
    uploadsDir = path.join(tmpDir, 'new-install', 'uploads')
    initDb(path.join(tmpDir, 'test.db'))
    server = new RelayServer({ port: 0, uploadsDir })
    await server.start()
    port = (server.address() as { port: number }).port
  })

  afterAll(async () => {
    await server.stop()
    closeDb()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('sends the agent the file where it is now', async () => {
    const name = '1789-abcd1234_Demo.app.zip'
    const moved = path.join(uploadsDir, 'builds', name)
    fs.mkdirSync(path.dirname(moved), { recursive: true })
    fs.writeFileSync(moved, 'a real file in the new location')
    const db = getDb()
    db.prepare(`INSERT INTO apps (name, platform) VALUES ('Demo', 'ios')`).run()
    const app = db.prepare('SELECT id FROM apps ORDER BY id DESC LIMIT 1').get() as { id: number }
    const buildId = Number(db.prepare(`
      INSERT INTO builds (app_id, version_name, build_number, bundle_id, file_path)
      VALUES (?, '1.0.0', '1', 'com.example.moved', ?)
    `).run(app.id, path.join(tmpDir, 'old-install', 'uploads', 'builds', name)).lastInsertRowid)

    const agent = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(agent)
    agent.send(JSON.stringify({
      type: 'agent:register', platform: 'ios', agentName: 'moved-build',
      devices: [{ id: 'dev-1', name: 'iPhone', platform: 'ios', status: 'booted' }],
    }))
    const sessionId = (await waitForType<AgentRegistered>(agent, 'agent:registered')).registeredSessions[0]!.sessionId
    const browser = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(browser)
    browser.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForType(browser, 'session:joined')

    browser.send(JSON.stringify({ type: 'app:install', requestId: 'rq-moved', sessionId, buildId }))
    const install = await waitForType<{ type: 'app:install'; payload: { filePath: string; buildName: string; buildBytes: number } }>(agent, 'app:install')

    expect(install.payload.filePath).toBe(moved)
    expect(install.payload.buildName).toBe(name)
    expect(install.payload.buildBytes).toBe(fs.statSync(moved).size)

    agent.close(); browser.close()
  })
})
