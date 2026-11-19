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
    expect(await servers.request('emulator-5554', '/j.jar', 'read')).toEqual({ sent: true, out: '{"identifier":"a"}', writtenAt: expect.any(Number) })
    expect(await servers.request('emulator-5554', '/j.jar', 'read')).toEqual({ sent: true, out: '{"identifier":"a"}', writtenAt: expect.any(Number) })
    expect(spawn).toHaveBeenCalledTimes(1)
    const args = spawn.mock.calls[0] as unknown as string[]
    expect(args.slice(0, 3)).toEqual(['-s', 'emulator-5554', 'shell'])
    expect(args.at(-2)).toBe('dev.tapflow.uidump.FocusedServer')
  })

  it('sends text on stdin as base64, never in argv', async () => {
    const server = fakeServer((_op, text) => `{"result":"${text === '비밀 pass\nword' ? 'ok' : 'wrong'}"}`)
    const spawn = vi.fn(() => server.child)
    const servers = new FocusedServers({ spawn, kill: vi.fn(async () => {}) })
    expect(await servers.request('emulator-5554', '/j.jar', 'set', '비밀 pass\nword')).toEqual({ sent: true, out: '{"result":"ok"}', writtenAt: expect.any(Number) })
    expect((spawn.mock.calls[0] as unknown as string[]).join(' ')).not.toMatch(/비밀|pass|word/)
  })

  // Review F1/F2: an unanswered request may have been done, and its server may hold a UiAutomation connection.
  it('kills a server that does not answer, says the request was sent, and starts another next time', async () => {
    const stuck = fakeServer(() => undefined)
    const fresh = fakeServer(() => '{"result":"ok"}')
    const spawn = vi.fn().mockReturnValueOnce(stuck.child).mockReturnValueOnce(fresh.child)
    const kill = vi.fn(async () => {})
    const servers = new FocusedServers({ spawn, kill, answerTimeoutMs: 20 })
    expect(await servers.request('emulator-5554', '/j.jar', 'set', 'x')).toEqual({ sent: true, out: null, writtenAt: expect.any(Number) })
    expect(stuck.child.kill).toHaveBeenCalled()
    expect(kill).toHaveBeenCalledWith('emulator-5554', expect.stringMatching(/^FocusedServer [0-9a-f]{12}$/))
    expect(await servers.request('emulator-5554', '/j.jar', 'set', 'x')).toEqual({ sent: true, out: '{"result":"ok"}', writtenAt: expect.any(Number) })
    expect(spawn).toHaveBeenCalledTimes(2)
  })

  it('says a request was sent and not answered when the server dies under it', async () => {
    const dying = fakeServer(() => undefined)
    dying.child.stdin.on('data', () => setImmediate(() => dying.child.emit('exit', 1, null)))
    const servers = new FocusedServers({ spawn: vi.fn(() => dying.child), kill: vi.fn(async () => {}) })
    expect(await servers.request('emulator-5554', '/j.jar', 'ime')).toEqual({ sent: true, out: null, writtenAt: expect.any(Number) })
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

describe('FocusedServers, holding the connection (P4)', () => {
  it('knows its server holds the connection once it says so, and not after a release or a restart', async () => {
    const first = fakeServer((op) => (op === 'hold' ? '{"held":true}' : '{}'))
    const second = fakeServer(() => undefined)
    const third = fakeServer(() => '{}')
    const spawn = vi.fn().mockReturnValueOnce(first.child).mockReturnValueOnce(second.child).mockReturnValueOnce(third.child)
    const servers = new FocusedServers({ spawn, kill: vi.fn(async () => {}), answerTimeoutMs: 20 })
    expect(servers.isHeld('emulator-5554')).toBe(false)
    await servers.request('emulator-5554', '/j.jar', 'hold')
    expect(servers.isHeld('emulator-5554')).toBe(true)
    await servers.request('emulator-5554', '/j.jar', 'release')
    expect(servers.isHeld('emulator-5554')).toBe(false)
    await servers.request('emulator-5554', '/j.jar', 'hold')
    expect(servers.isHeld('emulator-5554')).toBe(true)
    // A server that stops answering is restarted, and the new one holds nothing.
    await servers.stop('emulator-5554')
    await servers.request('emulator-5554', '/j.jar', 'hold')
    expect(servers.isHeld('emulator-5554')).toBe(false)
    await servers.request('emulator-5554', '/j.jar', 'read')
    expect(servers.isHeld('emulator-5554')).toBe(false)
  })

  it('does not take an error for a hold', async () => {
    const server = fakeServer(() => '{"error":"java.lang.IllegalStateException: already registered"}')
    const servers = new FocusedServers({ spawn: vi.fn(() => server.child), kill: vi.fn(async () => {}) })
    await servers.request('emulator-5554', '/j.jar', 'hold')
    expect(servers.isHeld('emulator-5554')).toBe(false)
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
    expect(await servers.request('emulator-5554', '/j.jar', 'read')).toEqual({ sent: true, out: '{"identifier":"a"}', writtenAt: expect.any(Number) })
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

  // A set the server answered with an exception said nothing about why (Android 16, four in one evening).
  it('logs the error the server answered a set with, and never the text', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const r = runner(fakeServer(() => '{"error":"java.lang.NullPointerException: field"}'))
      expect(await new AdbWrapper(r).setFocusedText('emulator-5554', 'hunter2')).toBe('failed')
      const logged = warn.mock.calls.map((c) => c.join(' ')).join('\n')
      expect(logged).toMatch(/field set failed: java\.lang\.NullPointerException: field/)
      expect(logged).not.toMatch(/hunter2/)
    } finally {
      warn.mockRestore()
    }
  })

  // The server is asked for the dump first; these tests are about a server that cannot answer one (it says '{}'), so the
  // dump goes the one-shot way and the hold is let go of for it.
  const opsBut = (server: ReturnType<typeof fakeServer>) => server.lines.map((l) => l.split(' ')[1]).filter((op) => op !== 'dump')

  // A tree read through the server (no app_process to start) keeps a held connection held, and runs no one-shot dump.
  it('dumps the tree through the server when it answers, without letting go of a held connection', async () => {
    const xml = '<?xml version="1.0"?><hierarchy rotation="0"><node bounds="[0,0][10,10]" /></hierarchy>'
    const server = fakeServer((op) => (op === 'hold' ? '{"held":true}' : op === 'dump' ? `{"xml":"${Buffer.from(xml).toString('base64')}"}` : '{}'))
    const r = runner(server)
    const adb = new AdbWrapper(r)
    await adb.holdConnection('emulator-5554', true)
    expect(await adb.dumpUiHierarchy('emulator-5554')).toBe(xml)
    expect(server.lines.map((l) => l.split(' ')[1])).toEqual(['hold', 'dump'])
    expect(vi.mocked(r.exec).mock.calls.some((c) => c.includes('dev.tapflow.uidump.TreeDump'))).toBe(false)
  })

  // Review: the server's time comes off the one-shot's, or a stuck server plus both one-shot dumps outlasts the
  // relay's 15 s tree deadline.
  it('gives the one-shot dumps only what the server left of the budget', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      const server = fakeServer(() => undefined)
      const r = runner(server)
      const dump = new AdbWrapper(r).dumpUiHierarchy('emulator-5554', 10).catch(() => {})
      await vi.advanceTimersByTimeAsync(6_000)
      await dump
      const fallback = vi.mocked(r.exec).mock.calls.find((c) => c.includes('uiautomator') && c.includes('dump'))!
      // 10 s less the server's 5 s and a little, rounded up so the two never outlast the budget.
      const left = Number(fallback[fallback.indexOf('timeout') + 1])
      expect(left).toBeGreaterThanOrEqual(1)
      expect(left).toBeLessThanOrEqual(5)
    } finally {
      vi.useRealTimers()
    }
  })

  // CodeRabbit on #1193: a served dump right after a one-shot one keeps the re-hold the one-shot set.
  it('holds again after a served dump that followed a one-shot one', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const xml = '<?xml version="1.0"?><hierarchy rotation="0"><node bounds="[0,0][10,10]" /></hierarchy>'
      let serve = false
      const server = fakeServer((op) => (op === 'hold' ? '{"held":true}' : op === 'dump' && serve ? `{"xml":"${Buffer.from(xml).toString('base64')}"}` : '{}'))
      const adb = new AdbWrapper(runner(server))
      await adb.holdConnection('emulator-5554', true)
      await adb.dumpUiHierarchy('emulator-5554').catch(() => {})
      serve = true
      await vi.advanceTimersByTimeAsync(1_000)
      expect(await adb.dumpUiHierarchy('emulator-5554')).toBe(xml)
      await vi.advanceTimersByTimeAsync(4_000)
      await vi.waitFor(() => expect(opsBut(server)).toEqual(['hold', 'release', 'hold']))
    } finally {
      vi.useRealTimers()
    }
  })

  it('falls back to the one-shot dump when the server answers with an error', async () => {
    const server = fakeServer((op) => (op === 'dump' ? '{"error":"no active window to read"}' : '{}'))
    const r = runner(server)
    await new AdbWrapper(r).dumpUiHierarchy('emulator-5554').catch(() => {})
    expect(vi.mocked(r.exec).mock.calls.some((c) => c.includes('dev.tapflow.uidump.TreeDump'))).toBe(true)
  })

  // P4: a held connection refuses the tree dump's own, so the dump lets go of it; the next ping or hit holds it again,
  // not the dump, which a replay runs before every step.
  it('lets go of a held connection for a tree dump, and a ping holds it again while a person is recorded', async () => {
    const server = fakeServer((op) => (op === 'hold' ? '{"held":true}' : '{}'))
    const r = runner(server)
    const adb = new AdbWrapper(r)
    await adb.holdConnection('emulator-5554', true)
    await adb.dumpUiHierarchy('emulator-5554').catch(() => {})
    expect(opsBut(server)).toEqual(['hold', 'release'])
    await adb.pingFocusedServer('emulator-5554')
    await adb.pingFocusedServer('emulator-5554')
    expect(opsBut(server)).toEqual(['hold', 'release', 'hold', 'ping'])
    await adb.holdConnection('emulator-5554', false)
    await adb.pingFocusedServer('emulator-5554')
    expect(opsBut(server)).toEqual(['hold', 'release', 'hold', 'ping', 'release', 'ping'])
  })

  // Measured on the Compose sample: left to the 30 s ping, the first tap after a tree read paid the hold's settling and
  // went unreported. Dumps one after another (a replay's) hold again only once they stop.
  it('holds again once tree dumps have stopped for a while, not after each', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const server = fakeServer((op) => (op === 'hold' ? '{"held":true}' : '{}'))
    const adb = new AdbWrapper(runner(server))
    await adb.holdConnection('emulator-5554', true)
    await adb.dumpUiHierarchy('emulator-5554').catch(() => {})
    await vi.advanceTimersByTimeAsync(1_000)
    await adb.dumpUiHierarchy('emulator-5554').catch(() => {})
    await vi.advanceTimersByTimeAsync(2_000)
    expect(opsBut(server)).toEqual(['hold', 'release'])
    await vi.advanceTimersByTimeAsync(1_500)
    await vi.waitFor(() => expect(opsBut(server)).toEqual(['hold', 'release', 'hold']))
    await adb.holdConnection('emulator-5554', false)
    await adb.dumpUiHierarchy('emulator-5554').catch(() => {})
    await vi.advanceTimersByTimeAsync(5_000)
    expect(opsBut(server)).toEqual(['hold', 'release', 'hold', 'release'])
  })

  // CodeRabbit on #1187: a re-hold falling due during a long dump ran right after it, between two dumps.
  it('does not hold again during, or right after, a dump that outlasts the last one\'s wait', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const server = fakeServer((op) => (op === 'hold' ? '{"held":true}' : '{}'))
    const r = runner(server)
    const adb = new AdbWrapper(r)
    await adb.holdConnection('emulator-5554', true)
    await adb.dumpUiHierarchy('emulator-5554').catch(() => {})
    await vi.advanceTimersByTimeAsync(2_000)
    let finish: (out: string) => void = () => {}
    vi.mocked(r.exec).mockImplementationOnce(() => new Promise<string>((res) => { finish = res }))
    const slow = adb.dumpUiHierarchy('emulator-5554').catch(() => {})
    await vi.advanceTimersByTimeAsync(2_000)
    finish('')
    await slow
    await vi.advanceTimersByTimeAsync(1_000)
    expect(opsBut(server)).toEqual(['hold', 'release'])
    await vi.advanceTimersByTimeAsync(2_500)
    await vi.waitFor(() => expect(opsBut(server)).toEqual(['hold', 'release', 'hold']))
  })

  // Review of #1187: a device whose cache cannot be cleared refuses the hold, and asking again before every hit would
  // make every hit pay a connection twice.
  it('does not ask a server that refused a hold for one again', async () => {
    const server = fakeServer((op) => (op === 'hold' ? '{"error":"cache cannot be cleared"}' : '{"rx":1,"w":1,"h":1}'))
    const adb = new AdbWrapper(runner(server))
    await adb.holdConnection('emulator-5554', true)
    await adb.hitTest('emulator-5554', 0.5, 0.5)
    await adb.pingFocusedServer('emulator-5554')
    expect(opsBut(server)).toEqual(['hold', 'hit', 'ping'])
  })

  // Review of #1187: a re-hold falling due while a dump waits behind another request was queued ahead of that dump.
  it('does not hold again between a dump and the request it waited behind', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let reads = 0
    const server = fakeServer((op) => (op === 'hold' ? '{"held":true}' : op === 'read' ? (reads++ === 0 ? undefined : '{}') : '{}'))
    const adb = new AdbWrapper(runner(server))
    ;(adb as unknown as { focusedServers: FocusedServers }).focusedServers = new FocusedServers({
      spawn: runner(server).spawnPiped!.bind(null), kill: async () => {}, answerTimeoutMs: 60_000,
    })
    await adb.holdConnection('emulator-5554', true)
    await adb.dumpUiHierarchy('emulator-5554').catch(() => {})
    await vi.advanceTimersByTimeAsync(2_000)
    const read = adb.readFocused('emulator-5554')
    await vi.waitFor(() => expect(server.lines.some((l) => l.split(' ')[1] === 'read')).toBe(true))
    const dump = adb.dumpUiHierarchy('emulator-5554').catch(() => {})
    await vi.advanceTimersByTimeAsync(2_000)
    const id = server.lines.find((l) => l.split(' ')[1] === 'read')!.split(' ')[0]
    ;(server.child.stdout as PassThrough).write(`${id} {}\n`)
    await read
    await dump
    // Anything queued behind the dump has run by now.
    await vi.advanceTimersByTimeAsync(100)
    await adb.readFocused('emulator-5554').catch(() => null)
    expect(opsBut(server).slice(0, 4)).toEqual(['hold', 'release', 'read', 'read'])
  })

  it('pushes the jar again when a hold or a ping could not start the server', async () => {
    const r = runner(fakeServer(() => '{}', { ready: false }))
    const adb = new AdbWrapper(r)
    ;(adb as unknown as { focusedServers: FocusedServers }).focusedServers = new FocusedServers({
      spawn: r.spawnPiped!.bind(r), kill: async () => {}, readyTimeoutMs: 10, retryAfterMs: 0,
    })
    await adb.holdConnection('emulator-5554', true)
    await adb.pingFocusedServer('emulator-5554')
    expect(vi.mocked(r.exec).mock.calls.filter((c) => c.includes('push'))).toHaveLength(2)
  })

  it('holds again before a hit when the server lost its hold, and says when the hit went out', async () => {
    const server = fakeServer((op, text) => (op === 'hold' ? '{"held":true}' : `{"rx":1,"w":1,"h":1,"echo":"${text}"}`))
    const r = runner(server)
    const adb = new AdbWrapper(r)
    ;(adb as unknown as { holdWanted: Set<string> }).holdWanted.add('emulator-5554')
    const hit = await adb.hitTest('emulator-5554', 0.25, 0.5)
    expect(hit).toEqual({ answer: '{"rx":1,"w":1,"h":1,"echo":"0.25000 0.50000"}', writtenAt: expect.any(Number) })
    expect(opsBut(server)).toEqual(['hold', 'hit'])
    expect(await new AdbWrapper(runner(null)).hitTest('emulator-5554', 0.5, 0.5)).toBeNull()
  })

  it('reads framestats for a package name only', async () => {
    const r = runner(null)
    const adb = new AdbWrapper(r)
    expect(await adb.framestats('emulator-5554', 'x; reboot')).toBe('')
    expect(r.exec).not.toHaveBeenCalled()
    await adb.framestats('emulator-5554', 'dev.tapflow.sample.compose')
    expect(vi.mocked(r.exec).mock.calls[0]).toEqual(['-s', 'emulator-5554', 'shell', 'dumpsys', 'gfxinfo', 'dev.tapflow.sample.compose', 'framestats'])
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
