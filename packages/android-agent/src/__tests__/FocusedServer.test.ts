import { describe, it, expect, vi, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import type { ChildProcessWithoutNullStreams } from 'child_process'
import { FocusedServers } from '../FocusedServer.js'
import { AdbWrapper } from '../AdbWrapper.js'
import type { AdbRunner } from '../adb.js'

/** A field server child: answers each request line with `answer(op, text)`, or never when it returns undefined. */
function fakeServer(answer: (op: string, text?: string) => string | undefined, opts: { ready?: boolean } = {}) {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  Object.assign(child, { stdin, stdout, stderr: new PassThrough(), kill: vi.fn(() => { setImmediate(() => child.emit('exit', 0, null)); return true }) })
  const lines: string[] = []
  stdin.setEncoding('utf8')
  stdin.on('data', (chunk: string) => {
    for (const line of chunk.split('\n').filter(Boolean)) {
      lines.push(line)
      const [id, op, b64] = line.split(' ')
      const out = answer(op!, b64 === undefined ? undefined : Buffer.from(b64, 'base64').toString('utf8'))
      if (out !== undefined) stdout.write(`${id} ${out}\n`)
    }
  })
  if (opts.ready !== false) setImmediate(() => stdout.write('READY\n'))
  return { child, lines }
}

afterEach(() => { vi.useRealTimers() })

describe('FocusedServers', () => {
  it('starts one server per device and answers through it', async () => {
    const server = fakeServer(() => '{"identifier":"a"}')
    const spawn = vi.fn(() => server.child)
    const servers = new FocusedServers({ spawn, kill: vi.fn(async () => {}) })
    expect(await servers.request('emulator-5554', '/j.jar', 'read')).toEqual({ sent: true, out: '{"identifier":"a"}' })
    expect(await servers.request('emulator-5554', '/j.jar', 'read')).toEqual({ sent: true, out: '{"identifier":"a"}' })
    expect(spawn).toHaveBeenCalledTimes(1)
    const args = spawn.mock.calls[0] as unknown as string[]
    expect(args.slice(0, 3)).toEqual(['-s', 'emulator-5554', 'shell'])
    expect(args.at(-2)).toBe('dev.tapflow.uidump.FocusedServer')
  })

  it('sends text on stdin as base64, never in argv', async () => {
    const server = fakeServer((_op, text) => `{"result":"${text === '비밀 pass\nword' ? 'ok' : 'wrong'}"}`)
    const spawn = vi.fn(() => server.child)
    const servers = new FocusedServers({ spawn, kill: vi.fn(async () => {}) })
    expect(await servers.request('emulator-5554', '/j.jar', 'set', '비밀 pass\nword')).toEqual({ sent: true, out: '{"result":"ok"}' })
    expect((spawn.mock.calls[0] as unknown as string[]).join(' ')).not.toMatch(/비밀|pass|word/)
  })

  // Review F1/F2: an unanswered request may have been done, and its server may hold a UiAutomation connection.
  it('kills a server that does not answer, says the request was sent, and starts another next time', async () => {
    const stuck = fakeServer(() => undefined)
    const fresh = fakeServer(() => '{"result":"ok"}')
    const spawn = vi.fn().mockReturnValueOnce(stuck.child).mockReturnValueOnce(fresh.child)
    const kill = vi.fn(async () => {})
    const servers = new FocusedServers({ spawn, kill, answerTimeoutMs: 20 })
    expect(await servers.request('emulator-5554', '/j.jar', 'set', 'x')).toEqual({ sent: true, out: null })
    expect(stuck.child.kill).toHaveBeenCalled()
    expect(kill).toHaveBeenCalledWith('emulator-5554', expect.stringMatching(/^FocusedServer [0-9a-f]{12}$/))
    expect(await servers.request('emulator-5554', '/j.jar', 'set', 'x')).toEqual({ sent: true, out: '{"result":"ok"}' })
    expect(spawn).toHaveBeenCalledTimes(2)
  })

  it('says a request was sent and not answered when the server dies under it', async () => {
    const dying = fakeServer(() => undefined)
    dying.child.stdin.on('data', () => setImmediate(() => dying.child.emit('exit', 1, null)))
    const servers = new FocusedServers({ spawn: vi.fn(() => dying.child), kill: vi.fn(async () => {}) })
    expect(await servers.request('emulator-5554', '/j.jar', 'ime')).toEqual({ sent: true, out: null })
  })

  // Review F4: a start that failed is retried later, never given up on for the agent's life.
  it('sends nothing when the server cannot start, and tries again only after a while', async () => {
    let now = 0
    const spawn = vi.fn(() => fakeServer(() => '{}', { ready: false }).child)
    const servers = new FocusedServers({ spawn, kill: vi.fn(async () => {}), readyTimeoutMs: 10, retryAfterMs: 1000, now: () => now })
    expect(await servers.request('emulator-5554', '/j.jar', 'read')).toEqual({ sent: false, startFailed: true })
    expect(await servers.request('emulator-5554', '/j.jar', 'read')).toEqual({ sent: false })
    expect(spawn).toHaveBeenCalledTimes(1)
    now = 1001
    await servers.request('emulator-5554', '/j.jar', 'read')
    expect(spawn).toHaveBeenCalledTimes(2)
  })
})

describe('FocusedServers, ended on purpose', () => {
  // Review F5: a relay reconnect stopping a server that was starting is not a start that failed.
  it('does not count a server stopped while it started as one that failed to start', async () => {
    const spawn = vi.fn()
      .mockReturnValueOnce(fakeServer(() => '{}', { ready: false }).child)
      .mockReturnValueOnce(fakeServer(() => '{"identifier":"a"}').child)
    const servers = new FocusedServers({ spawn, kill: vi.fn(async () => {}), readyTimeoutMs: 5_000 })
    const waiting = servers.request('emulator-5554', '/j.jar', 'read')
    await new Promise((r) => setImmediate(r))
    await servers.stop('emulator-5554')
    expect(await waiting).toEqual({ sent: false })
    expect(await servers.request('emulator-5554', '/j.jar', 'read')).toEqual({ sent: true, out: '{"identifier":"a"}' })
  })

  // Review F2: ended from here before the server's own idle exit, so nothing is written to one choosing to exit.
  it('ends an idle server itself', async () => {
    const server = fakeServer(() => '{}')
    const kill = vi.fn(async () => {})
    const servers = new FocusedServers({ spawn: vi.fn(() => server.child), kill, idleStopMs: 20 })
    await servers.request('emulator-5554', '/j.jar', 'read')
    await new Promise((r) => setTimeout(r, 60))
    expect(server.child.kill).toHaveBeenCalled()
  })
})

describe('AdbWrapper through the field server', () => {
  const runner = (server: ReturnType<typeof fakeServer> | null, oneShot = '{"identifier":"slow"}'): AdbRunner => ({
    exec: vi.fn(async (...args: string[]) => (args.includes('app_process') ? oneShot : '')),
    execInput: vi.fn(async () => '{"result":"ok"}'),
    execBinary: vi.fn(),
    listAvds: vi.fn(async () => []),
    ...(server ? { spawnPiped: vi.fn(() => server.child) } : {}),
  })

  // Review F1: adb joins the arguments and the device shell splits them; unquoted, the nonce was a second pattern.
  it('kills a server by its nonce as one quoted pattern', async () => {
    const r = runner(null)
    const adb = new AdbWrapper({ ...r, spawnPiped: vi.fn() })
    await (adb as unknown as { focusedServers: { opts: { kill: (s: string, p: string) => Promise<void> } } }).focusedServers.opts.kill('emulator-5554', 'FocusedServer 0a1b')
    expect(vi.mocked(r.exec).mock.calls.at(-1)).toEqual(['-s', 'emulator-5554', 'shell', 'pkill', '-f', "'FocusedServer 0a1b'"])
  })

  it('reads through the server, and runs no one-shot', async () => {
    const r = runner(fakeServer(() => '{"identifier":"fast"}'))
    expect(await new AdbWrapper(r).readFocused('emulator-5554')).toEqual({ identifier: 'fast' })
    expect(vi.mocked(r.exec).mock.calls.some((c) => c.includes('app_process'))).toBe(false)
  })

  it('never sets text a second time when the server took the request and gave no answer', async () => {
    const r = runner(fakeServer(() => undefined))
    const adb = new AdbWrapper(r)
    ;(adb as unknown as { focusedServers: FocusedServers }).focusedServers = new FocusedServers({
      spawn: r.spawnPiped!.bind(r), kill: async () => {}, answerTimeoutMs: 20,
    })
    expect(await adb.setFocusedText('emulator-5554', 'x')).toBe('failed')
    expect(r.execInput).not.toHaveBeenCalled()
  })

  it('reads the slow way when the server cannot start, and pushes the jar again', async () => {
    const r = runner(fakeServer(() => '{}', { ready: false }))
    const adb = new AdbWrapper(r)
    ;(adb as unknown as { focusedServers: FocusedServers }).focusedServers = new FocusedServers({
      spawn: r.spawnPiped!.bind(r), kill: async () => {}, readyTimeoutMs: 10,
    })
    expect(await adb.readFocused('emulator-5554')).toEqual({ identifier: 'slow' })
    await adb.readFocused('emulator-5554')
    expect(vi.mocked(r.exec).mock.calls.filter((c) => c.includes('push'))).toHaveLength(2)
  })
})
