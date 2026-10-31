import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { RelayServer } from '../RelayServer'
import { initDb, getDb, closeDb } from '../db'
import { signJwt, hashPat } from '../middleware/auth'
import { purgeExpiredBuilds } from '../api/builds'
import { purgeRunVideos, shortfall, writeFully } from '../api/runVideos'
import type { RunHolders } from '../api/runs'

// A flow's video (A4): the runner opens it, sends chunks while the flow runs, and ends it; the relay writes the
// bytes at a committed offset and never reads them, and keeps them by the retention policy and the disk cap.

const PAT_CI = 'tflw_pat_video_ci'
const PAT_SOMEONE = 'tflw_pat_video_someone'
const PAT_VIEW = 'tflw_pat_video_view'
const bearer = (pat: string) => ({ Authorization: `Bearer ${pat}` })
const adminCookie = () => ({ cookie: `tapflow_token=${signJwt({ userId: 1, email: 'admin@example.test', role: 'Admin' })}` })
const noHolders: RunHolders = { connectedKeys: () => new Set(), heldSessions: () => [] }

interface Index {
  meta: { formatVersion: number }
  bytes: number
  ended: boolean
  endReason: string | null
  evicted: boolean
  chunks: { seq: number; offset: number; length: number; startMs: number; keyframe: boolean }[]
  gaps: number[]
}

describe('flow run videos', () => {
  let server: RelayServer
  let port: number
  let tmpDir: string
  let uploadsDir: string
  let videosDir: string
  let buildId: number

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-videos-'))
    initDb(path.join(tmpDir, 'test.db'))
    const db = getDb()
    const user = db.prepare('INSERT INTO users (id, email, role, password_hash) VALUES (?, ?, ?, ?)')
    user.run(1, 'admin@example.test', 'Admin', 'x')
    user.run(2, 'ci@example.test', 'Developer', 'x')
    user.run(3, 'someone@example.test', 'Developer', 'x')
    const pat = db.prepare('INSERT INTO personal_access_tokens (user_id, name, token_hash, scope) VALUES (?, ?, ?, ?)')
    pat.run(2, 'ci', hashPat(PAT_CI), 'view,builds:write')
    pat.run(3, 'someone', hashPat(PAT_SOMEONE), 'view,builds:write')
    pat.run(2, 'view', hashPat(PAT_VIEW), 'view')
  })
  afterAll(() => { closeDb(); fs.rmSync(tmpDir, { recursive: true, force: true }) })

  beforeEach(async () => {
    uploadsDir = path.join(fs.mkdtempSync(path.join(tmpDir, 'install-')), 'uploads')
    videosDir = path.join(uploadsDir, '../run-videos')
    fs.mkdirSync(path.join(uploadsDir, 'builds'), { recursive: true })
    const db = getDb()
    db.exec('DELETE FROM flow_runs; DELETE FROM builds; DELETE FROM apps')
    db.prepare('UPDATE team_settings SET video_pass_retention_days = 3, video_storage_cap_mb = 20480 WHERE id = 1').run()
    db.prepare(`INSERT INTO apps (id, name, platform) VALUES (1, 'Coffee', 'ios')`).run()
    const file = path.join(uploadsDir, 'builds', 'coffee.zip')
    fs.writeFileSync(file, 'zip')
    buildId = Number(db.prepare(`INSERT INTO builds (app_id, version_name, build_number, bundle_id, file_path) VALUES (1, '1.0', '1', 'com.example.coffee', ?)`).run(file).lastInsertRowid)
    server = new RelayServer({ port: 0, uploadsDir })
    await server.start()
    port = (server.address() as { port: number }).port
  })
  afterEach(async () => { await server.stop() })

  async function call(method: string, url: string, headers: Record<string, string> = {}, body?: unknown) {
    const raw = Buffer.isBuffer(body) ? new Uint8Array(body) : body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body)
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
      method, body: raw, headers: { ...(typeof raw === 'string' ? { 'Content-Type': 'application/json' } : {}), ...headers },
    })
    const buf = Buffer.from(await res.arrayBuffer())
    const isJson = res.headers.get('content-type')?.includes('json')
    return { status: res.status, headers: res.headers, buf, body: (isJson ? JSON.parse(buf.toString()) : null) as Record<string, unknown> }
  }

  async function newRun(flows = 2, pat = PAT_CI): Promise<string> {
    const r = await call('POST', '/api/v1/runs', bearer(pat), {
      client: 'runner', buildId, flows: Array.from({ length: flows }, (_, i) => ({ name: `flow${i}` })),
    })
    expect(r.status).toBe(201)
    return r.body.id as string
  }

  const v = (id: string, idx = 0) => `/api/v1/runs/${id}/flows/${idx}/video`
  const open = (id: string, idx = 0, pat = PAT_CI, meta: unknown = { formatVersion: 1, platform: 'ios', codec: 'h264' }) =>
    call('POST', `${v(id, idx)}/open`, bearer(pat), meta)
  const chunk = (id: string, seq: number, data: Buffer, opts: { idx?: number; keyframe?: boolean; startMs?: number; pat?: string } = {}) =>
    call('POST', `${v(id, opts.idx ?? 0)}/chunks/${seq}`, {
      ...bearer(opts.pat ?? PAT_CI), 'X-Start-Ms': String(opts.startMs ?? seq * 2000), 'X-Keyframe': opts.keyframe === false ? '0' : '1',
    }, data)
  const end = (id: string, lastSeq: number, reason = 'done', idx = 0) => call('POST', `${v(id, idx)}/end`, bearer(PAT_CI), { lastSeq, reason })
  const index = async (id: string, idx = 0) => (await call('GET', `${v(id, idx)}/index`, bearer(PAT_VIEW))).body as unknown as Index

  // ── writes ────────────────────────────────────────────────────────────────

  it('opens a video, writes chunks in order, and serves them back by index and by range', async () => {
    const id = await newRun()
    expect((await open(id)).status).toBe(201)
    expect((await chunk(id, 0, Buffer.from('aaaa'))).status).toBe(200)
    expect((await chunk(id, 1, Buffer.from('bbbbbb'), { keyframe: false })).status).toBe(200)

    const ix = await index(id)
    expect(ix.meta.formatVersion).toBe(1)
    expect(ix.bytes).toBe(10)
    expect(ix.chunks).toEqual([
      { seq: 0, offset: 0, length: 4, startMs: 0, keyframe: true },
      { seq: 1, offset: 4, length: 6, startMs: 2000, keyframe: false },
    ])
    expect(ix.gaps).toEqual([])
    expect(ix.ended).toBe(false)

    const all = await call('GET', v(id), bearer(PAT_VIEW))
    expect(all.status).toBe(200)
    expect(all.buf.toString()).toBe('aaaabbbbbb')
    expect(all.headers.get('cache-control')).toBe('no-store')
    expect(all.headers.get('content-type')).toBe('application/octet-stream')
    expect(all.headers.get('x-content-type-options')).toBe('nosniff')
    const part = await call('GET', v(id), { ...bearer(PAT_VIEW), Range: 'bytes=2-5' })
    expect(part.status).toBe(206)
    expect(part.buf.toString()).toBe('aabb')
    expect(part.headers.get('content-range')).toBe('bytes 2-5/10')
    expect((await call('GET', v(id), { ...bearer(PAT_VIEW), Range: 'bytes=10-' })).status).toBe(416)
  })

  it('takes a retried open and a retried chunk without writing twice, and records a skipped seq as a gap', async () => {
    const id = await newRun()
    await open(id)
    expect((await open(id)).status).toBe(200)
    await chunk(id, 0, Buffer.from('aaaa'))
    const again = await chunk(id, 0, Buffer.from('aaaa'))
    expect(again.body).toMatchObject({ duplicate: true })
    await chunk(id, 2, Buffer.from('cc'))
    const ix = await index(id)
    expect(ix.bytes).toBe(6)
    expect(ix.gaps).toEqual([1])
    expect((await call('GET', v(id), bearer(PAT_VIEW))).buf.toString()).toBe('aaaacc')
  })

  it('writes concurrent chunks of one video one after the other, at their own offsets', async () => {
    const id = await newRun()
    await open(id)
    await Promise.all([chunk(id, 0, Buffer.alloc(300_000, 1)), chunk(id, 1, Buffer.alloc(200_000, 2))])
    const ix = await index(id)
    expect(ix.bytes).toBe(500_000)
    const data = (await call('GET', v(id), bearer(PAT_VIEW))).buf
    const first = ix.chunks.find((c) => c.seq === 0)!
    expect(data.subarray(first.offset, first.offset + first.length).every((b) => b === 1)).toBe(true)
  })

  it('refuses writes from anyone but the run that created it, and without an open video', async () => {
    const id = await newRun()
    expect((await open(id, 0, PAT_SOMEONE)).status).toBe(403)
    expect((await chunk(id, 0, Buffer.from('x'))).status).toBe(404)
    await open(id)
    expect((await chunk(id, 0, Buffer.from('x'), { pat: PAT_SOMEONE })).status).toBe(403)
    expect((await open(id, 5)).status).toBe(404)
    expect((await open(id, 1, PAT_CI, { formatVersion: 2 })).status).toBe(400)
    const noStart = await call('POST', `${v(id)}/chunks/0`, bearer(PAT_CI), Buffer.from('x'))
    expect(noStart.status).toBe(400)
  })

  it('takes the last flow\'s tail after finish, within the grace, and not after it', async () => {
    const id = await newRun()
    await open(id)
    await call('POST', `/api/v1/runs/${id}/finish`, bearer(PAT_CI), { status: 'passed', exitCode: 0 })
    expect((await chunk(id, 0, Buffer.from('tail'))).status).toBe(200)
    getDb().prepare(`UPDATE flow_runs SET finished_at = datetime('now', '-3 minutes') WHERE id = ?`).run(id)
    expect((await chunk(id, 1, Buffer.from('late'))).status).toBe(409)
    // Past the grace a video with no end call has ended, and says it may be missing its end.
    expect(await index(id)).toMatchObject({ ended: true, endReason: 'truncated' })
  })

  it('ends a video with the last seq sent, so a lost tail shows as gaps; the first ending wins', async () => {
    const id = await newRun()
    await open(id)
    await chunk(id, 0, Buffer.from('aa'))
    expect((await end(id, 2, 'cancelled')).status).toBe(200)
    expect((await end(id, 0, 'done')).status).toBe(200)
    const ix = await index(id)
    expect(ix).toMatchObject({ ended: true, endReason: 'cancelled', gaps: [1, 2] })
    expect((await chunk(id, 1, Buffer.from('bb'))).status).toBe(409)
    expect((await end(id, 0, 'whatever')).status).toBe(400)
    const ended = await call('GET', v(id), bearer(PAT_VIEW))
    expect(ended.headers.get('cache-control')).toBe('private, max-age=3600')
    expect(ended.headers.get('etag')).toBe('"2"')
  })

  it('reads a video whose runner went away as ended by the runner\'s loss', async () => {
    const id = await newRun()
    await open(id)
    getDb().prepare(`UPDATE flow_runs SET status = 'aborted', finished_by = 'relay', finished_at = datetime('now') WHERE id = ?`).run(id)
    expect(await index(id)).toMatchObject({ ended: true, endReason: 'runner-lost' })
  })

  it('ends a video at its size limit instead of writing past it', async () => {
    const id = await newRun()
    await open(id)
    getDb().prepare(`UPDATE flow_run_videos SET bytes = ? WHERE idx = 0`).run(100 * 1024 * 1024 - 2)
    const r = await chunk(id, 0, Buffer.from('xyz'))
    expect(r.status).toBe(413)
    expect(r.body.reason).toBe('size-limit')
    expect((await index(id)).endReason).toBe('size-limit')
  })

  it('leaves no row behind when the video file cannot be created, so a retried open starts clean', async () => {
    const id = await newRun()
    const real = fs.writeFileSync
    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation((file, data, options) => {
      if (String(file).endsWith('.tfv')) throw Object.assign(new Error('no space left'), { code: 'ENOSPC' })
      real(file, data, options)
    })
    try {
      expect((await open(id)).status).toBe(500)
    } finally {
      spy.mockRestore()
    }
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM flow_run_videos').get()).toEqual({ n: 0 })
    expect((await open(id)).status).toBe(201)
    expect((await chunk(id, 0, Buffer.from('ok'))).status).toBe(200)
  })

  it('writes the rest of a chunk a short write left, and fails one that makes no progress', async () => {
    const out = Buffer.alloc(16)
    const short = { write: async (b: Buffer, off: number, len: number, pos: number) => {
      const n = Math.min(3, len)
      b.copy(out, pos, off, off + n)
      return { bytesWritten: n, buffer: b }
    } }
    await writeFully(short as never, Buffer.from('abcdefgh'), 4)
    expect(out.subarray(4, 12).toString()).toBe('abcdefgh')
    // Throws after a few calls, so a loop that ignores no progress fails here instead of hanging the worker.
    let calls = 0
    const stuck = { write: async (b: Buffer) => {
      if (++calls > 5) throw new Error('kept writing')
      return { bytesWritten: 0, buffer: b }
    } }
    await expect(writeFully(stuck as never, Buffer.from('x'), 0)).rejects.toThrow('no progress')
  })

  it('refuses a chunk whose body was still arriving when the video was ended', async () => {
    const id = await newRun()
    await open(id)
    let finish!: () => void
    const body = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new Uint8Array([1, 2])); finish = () => c.close() },
    })
    const pending = fetch(`http://127.0.0.1:${port}${v(id)}/chunks/0`, {
      method: 'POST', body, duplex: 'half', headers: { ...bearer(PAT_CI), 'X-Start-Ms': '0', 'X-Keyframe': '1' },
    } as RequestInit)
    // The chunk has passed its first check and is reading its body; the end call lands now. Nothing outside the
    // relay can see that point, so on a starved worker the end may land first and this passes through the first
    // check instead, which answers the same 409. Mutating the second check away fails this test on a normal run.
    await new Promise((r) => setTimeout(r, 50))
    expect((await end(id, -1, 'cancelled')).status).toBe(200)
    finish()
    expect((await pending).status).toBe(409)
    expect((await index(id)).bytes).toBe(0)
  })

  it('refuses a seq or lastSeq past the bound, so one request cannot make the index list millions of gaps', async () => {
    const id = await newRun()
    await open(id)
    expect((await chunk(id, 10_001, Buffer.from('x'))).status).toBe(400)
    expect((await chunk(id, 10_000, Buffer.from('x'))).status).toBe(200)
    expect((await end(id, 9007199254740991)).status).toBe(400)
    expect((await end(id, 10_001)).status).toBe(400)
  })

  it('releases reservations a crashed write left behind when the relay starts', async () => {
    const id = await finishedVideo('failed', 10)
    getDb().prepare('UPDATE flow_run_videos SET reserved_bytes = 5000').run()
    await server.stop()
    server = new RelayServer({ port: 0, uploadsDir })
    await server.start()
    port = (server.address() as { port: number }).port
    expect((await call('GET', '/api/v1/settings', adminCookie())).body.video_usage_bytes).toBe(10)
    expect((await index(id)).bytes).toBe(10)
  })

  it('tells the run page which flows have a video and in what state, before it loads one', async () => {
    const id = await newRun(3)
    await open(id, 0)
    await chunk(id, 0, Buffer.from('aaaa'))
    await open(id, 1, PAT_CI, { formatVersion: 1, codec: 'jpeg', notRecorded: 'jpeg' })
    await end(id, -1, 'done', 1)
    const run = (await call('GET', `/api/v1/runs/${id}`, bearer(PAT_VIEW))).body as { flows: { video: unknown }[] }
    expect(run.flows.map((f) => f.video)).toEqual([
      { ended: false, endReason: null, evicted: false, notRecorded: null, bytes: 4 },
      { ended: true, endReason: 'done', evicted: false, notRecorded: 'jpeg', bytes: 0 },
      null,
    ])
  })

  it('needs a view credential to read', async () => {
    const id = await newRun()
    await open(id)
    expect((await call('GET', `${v(id)}/index`)).status).toBe(401)
    expect((await call('GET', v(id))).status).toBe(401)
  })

  // ── the disk cap, on the append path ──────────────────────────────────────

  async function finishedVideo(status: 'passed' | 'failed', bytes: number): Promise<string> {
    const id = await newRun(1)
    await open(id)
    await chunk(id, 0, Buffer.alloc(bytes, 7))
    await call('POST', `/api/v1/runs/${id}/flows/0`, bearer(PAT_CI), { status, durationMs: 10, steps: [] })
    await end(id, 0)
    await call('POST', `/api/v1/runs/${id}/finish`, bearer(PAT_CI), { status, exitCode: status === 'passed' ? 0 : 1 })
    return id
  }

  it('evicts finished passes first to make room, never a running run, and answers 507 when nothing more can go', async () => {
    const passed = await finishedVideo('passed', 400_000)
    const failed = await finishedVideo('failed', 300_000)
    getDb().prepare('UPDATE team_settings SET video_storage_cap_mb = 1 WHERE id = 1').run()

    const live = await newRun()
    await open(live)
    expect((await chunk(live, 0, Buffer.alloc(500_000, 1))).status).toBe(200)
    expect((await index(passed)).evicted).toBe(true)
    expect((await call('GET', v(passed), bearer(PAT_VIEW))).status).toBe(410)
    expect((await index(failed)).evicted).toBe(false)

    // The failure goes next; after that only the running video is left, and it is never evicted.
    expect((await chunk(live, 1, Buffer.alloc(300_000, 1))).status).toBe(200)
    expect((await index(failed)).evicted).toBe(true)
    const full = await chunk(live, 2, Buffer.alloc(400_000, 1))
    expect(full.status).toBe(507)
    expect(full.body.reason).toBe('storage-full')
    expect(await index(live)).toMatchObject({ evicted: false, ended: true, endReason: 'storage-full' })
    expect(fs.readdirSync(videosDir)).toHaveLength(1)
  })

  // The two guards back each other up, so each is tested where the other one passes: a running run's flow can have
  // ended its video, and a finished run's video can be unended inside the grace.
  it('does not evict an ended video of a run still running, nor a finished run\'s video still inside its grace', async () => {
    const running = await newRun()
    await open(running)
    await chunk(running, 0, Buffer.alloc(400_000, 1))
    await end(running, 0)
    const tail = await newRun(1)
    await open(tail)
    await chunk(tail, 0, Buffer.alloc(400_000, 1))
    await call('POST', `/api/v1/runs/${tail}/finish`, bearer(PAT_CI), { status: 'passed', exitCode: 0 })
    getDb().prepare('UPDATE team_settings SET video_storage_cap_mb = 1 WHERE id = 1').run()

    const live = await newRun()
    await open(live)
    expect((await chunk(live, 0, Buffer.alloc(400_000, 1))).status).toBe(507)
    expect((await index(running)).evicted).toBe(false)
    expect((await index(tail)).evicted).toBe(false)
  })

  it('counts both the cap and the disk\'s floor', () => {
    expect(shortfall({ used: 900, reserved: 0 }, 100, 1000, { free: 10_000, floor: 0 })).toEqual({ overCap: 0, overDisk: -9900 })
    expect(shortfall({ used: 0, reserved: 0 }, 100, 1000, { free: 1050, floor: 1000 })).toEqual({ overCap: -900, overDisk: 50 })
    // Bytes another writer reserved are not on disk yet, so free space does not show them; they still count.
    expect(shortfall({ used: 0, reserved: 40 }, 30, 1000, { free: 1050, floor: 1000 }).overDisk).toBe(20)
  })

  // ── retention and deletion ────────────────────────────────────────────────

  it('purges passed videos past the window, keeps failures, sweeps orphans and marks missing files', async () => {
    const passed = await finishedVideo('passed', 10)
    const failed = await finishedVideo('failed', 10)
    const recent = await finishedVideo('passed', 10)
    getDb().prepare(`UPDATE flow_run_videos SET created_at = datetime('now', '-4 days') WHERE run_seq IN (SELECT seq FROM flow_runs WHERE id IN (?, ?))`).run(passed, failed)
    fs.writeFileSync(path.join(videosDir, 'stray.tfv'), 'x')
    const gone = await finishedVideo('failed', 10)
    const goneFile = getDb().prepare(`SELECT file FROM flow_run_videos v JOIN flow_runs r ON r.seq = v.run_seq WHERE r.id = ?`).get(gone) as { file: string }
    fs.unlinkSync(path.join(videosDir, goneFile.file))

    purgeRunVideos(videosDir, noHolders)
    expect((await index(passed)).evicted).toBe(true)
    expect((await index(failed)).evicted).toBe(false)
    expect((await index(recent)).evicted).toBe(false)
    expect((await index(gone)).evicted).toBe(true)
    expect(fs.existsSync(path.join(videosDir, 'stray.tfv'))).toBe(false)
  })

  it('marks every video gone when a restore left the whole directory out', async () => {
    const id = await finishedVideo('failed', 10)
    fs.rmSync(videosDir, { recursive: true })
    purgeRunVideos(videosDir, noHolders)
    expect((await index(id)).evicted).toBe(true)
  })

  it('deletes a build\'s videos with the build', async () => {
    await finishedVideo('failed', 10)
    getDb().prepare(`UPDATE builds SET delete_after = datetime('now', '-1 hour') WHERE id = ?`).run(buildId)
    purgeExpiredBuilds({ uploadsDir, recordingsDir: path.join(uploadsDir, '../recordings'), runScreenshotsDir: path.join(uploadsDir, '../run-screenshots'), runVideosDir: videosDir })
    expect(fs.readdirSync(videosDir)).toHaveLength(0)
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM flow_run_videos').get()).toEqual({ n: 0 })
  })

  // ── settings ──────────────────────────────────────────────────────────────

  it('shows the policy and its usage, and lets an Admin change it within bounds', async () => {
    await finishedVideo('failed', 1234)
    const got = await call('GET', '/api/v1/settings', adminCookie())
    expect(got.body).toMatchObject({ video_pass_retention_days: 3, video_storage_cap_mb: 20480, video_usage_bytes: 1234 })
    expect(Number(got.body.video_effective_cap_bytes)).toBeLessThanOrEqual(20480 * 1024 * 1024)

    const form = new FormData()
    form.set('video_pass_retention_days', '7')
    form.set('video_storage_cap_mb', '5000')
    expect((await call('PATCH', '/api/v1/settings', adminCookie(), form)).status).toBe(200)
    const bad = new FormData()
    bad.set('video_storage_cap_mb', '5')
    expect((await call('PATCH', '/api/v1/settings', adminCookie(), bad)).status).toBe(400)
    expect((await call('GET', '/api/v1/settings', adminCookie())).body).toMatchObject({ video_pass_retention_days: 7, video_storage_cap_mb: 5000 })
  })
})
