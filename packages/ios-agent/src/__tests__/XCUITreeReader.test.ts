import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { XCUITreeReader, computeRunnerStamp, toFocusedField, toKeyboardState, type RunnerNative } from '../XCUITreeReader'

type FakeProc = EventEmitter & {
  pid?: number
  exitCode: number | null
  signalCode: string | null
  killed: boolean
  kill: () => boolean
  stdout: EventEmitter
}

// A fake child process with no real pid, so killHandle never touches a real OS
// process group (it falls back to proc.kill()). Killing it exits it, as a real one would.
function fakeProc(): FakeProc {
  const p = new EventEmitter() as FakeProc
  p.pid = undefined
  p.exitCode = null
  p.signalCode = null
  p.killed = false
  p.stdout = new EventEmitter()
  p.kill = vi.fn(() => {
    p.killed = true
    queueMicrotask(() => p.emit('exit', null, 'SIGTERM'))
    return true
  })
  return p
}

const TREE = [
  "Attributes: Application, 0x1, pid: 1, label: 'App'",
  'Element subtree:',
  " →Application, 0x1, pid: 1, label: 'App'",
  '    Window (Main), 0x2, {{0.0, 0.0}, {100.0, 200.0}}',
  "      Button, 0x3, {{0.0, 0.0}, {50.0, 20.0}}, identifier: 'ok', label: 'OK'",
].join('\n')

interface Spawned { udid: string; token: string; port: number; proc: FakeProc }

// Every spawn gets its own port and announces it the way the runner does, unless `announce` says otherwise.
function makeNative(overrides: Partial<RunnerNative> = {}, announce: (s: Spawned) => void = (s) => {
  queueMicrotask(() => s.proc.stdout.emit('data', `Testing started\nTAPFLOW_TREE_READY port=${s.port}\n`))
}) {
  const spawned: Spawned[] = []
  const native = {
    sourceStamp: vi.fn(async () => 'stamp-1'),
    builtStamp: vi.fn((): string | undefined => 'stamp-1'), // built and current: skip the build
    build: vi.fn(async () => {}),
    spawn: vi.fn((destination: string, token: string) => {
      const s: Spawned = { udid: destination.replace(/.*id=/, ''), token, port: 23000 + spawned.length, proc: fakeProc() }
      spawned.push(s)
      announce(s)
      return s.proc
    }),
    terminateRunner: vi.fn(),
    ...overrides,
  }
  return { native: native as RunnerNative & typeof native, spawned }
}

const portOf = (url: string): number => Number(/localhost:(\d+)/.exec(url)![1])

describe('XCUITreeReader', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  let spawned: Spawned[]
  // /health answers with the token of whichever runner was spawned on that port.
  const healthy = async (url: string) => {
    const port = portOf(url)
    if (url.includes('/health')) {
      const s = spawned.find((x) => x.port === port)
      if (!s) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
      return { ok: true, text: async () => s.token } as Response
    }
    return { ok: true, text: async () => TREE } as Response
  }
  const setup = (overrides: Partial<RunnerNative> = {}, announce?: (s: Spawned) => void) => {
    const made = makeNative(overrides, announce)
    spawned = made.spawned
    return made.native
  }
  beforeEach(() => {
    spawned = []
    fetchMock = vi.fn(healthy)
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('spawns the runner once and reads the tree from the port it announced', async () => {
    const native = setup()
    const reader = new XCUITreeReader(native)
    const els = await reader.read('udid-A', 'com.app')
    expect(native.spawn).toHaveBeenCalledTimes(1)
    expect(els.find((e) => e.identifier === 'ok')?.label).toBe('OK')
    const treeUrl = fetchMock.mock.calls.map((c) => String(c[0])).find((u) => u.includes('/tree'))!
    expect(portOf(treeUrl)).toBe(spawned[0]!.port)
    reader.stop()
  })

  // An attached runner made a busy SwiftUI app lag with no query running (Food Truck, iOS 26.5): one started for a
  // person's Capture dialog (a tree read, a reach) is let go once nothing has been asked of it for a while.
  describe('a runner nobody kept', () => {
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

    it('is released once no request has been in flight for the idle period', async () => {
      const native = setup()
      const reader = new XCUITreeReader(native, 30)
      await reader.read('udid-A', 'com.app')
      expect(native.terminateRunner).not.toHaveBeenCalled()
      await vi.waitFor(() => expect(native.terminateRunner).toHaveBeenCalledWith('udid-A'), { timeout: 1000 })
      // The next read starts it again.
      await reader.read('udid-A', 'com.app')
      expect(native.spawn).toHaveBeenCalledTimes(2)
      reader.stop()
    })

    it('is held while a request is still in flight, and released after the last one', async () => {
      const native = setup()
      let release!: () => void
      const slow = new Promise<void>((r) => { release = r })
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes('/tree') && url.includes('slow')) { await slow; return { ok: true, text: async () => TREE } as Response }
        return healthy(url)
      })
      const reader = new XCUITreeReader(native, 30)
      const held = reader.read('udid-A', 'com.slow')
      await reader.read('udid-A', 'com.app')
      await wait(90)
      expect(native.terminateRunner).not.toHaveBeenCalled()
      release()
      await held
      await vi.waitFor(() => expect(native.terminateRunner).toHaveBeenCalledWith('udid-A'), { timeout: 1000 })
      reader.stop()
    })

    it('is let go once a person boots the device an automation client warmed', async () => {
      const native = setup()
      const reader = new XCUITreeReader(native, 30)
      reader.warm('udid-A')
      await reader.read('udid-A', 'com.app')
      reader.unkeep('udid-A')
      await vi.waitFor(() => expect(native.terminateRunner).toHaveBeenCalledWith('udid-A'), { timeout: 1000 })
      reader.stop()
    })

    // `unkeep` while the warm-up was still building found no runner to time out; the runner it then started stayed
    // attached, and the person's app lagged, until the next read (review finding).
    it('is let go when the person\'s boot came while the warm-up was still building it', async () => {
      let finishBuild!: () => void
      const native = setup({ builtStamp: vi.fn(() => undefined), build: vi.fn(() => new Promise<void>((r) => { finishBuild = r })) })
      const reader = new XCUITreeReader(native, 30)
      reader.warm('udid-A')
      await vi.waitFor(() => expect(native.build).toHaveBeenCalled())
      reader.unkeep('udid-A')
      finishBuild()
      await vi.waitFor(() => expect(native.spawn).toHaveBeenCalled())
      await vi.waitFor(() => expect(native.terminateRunner).toHaveBeenCalledWith('udid-A'), { timeout: 1000 })
      reader.stop()
    })

    // Read, then warm and unkeep: the read's countdown was left pending beside unkeep's, fired first, and the later one
    // then stopped the runner the next read started (review finding).
    it('counts down once per device, so an earlier countdown cannot stop a runner a later read is using', async () => {
      const native = setup()
      // 150 ms of slack on each side, against a loaded machine's event loop: the read's countdown would end at 400,
      // unkeep's at 600, and the second read comes at 450.
      const reader = new XCUITreeReader(native, 400)
      await reader.read('udid-A', 'com.app')
      await wait(200)
      reader.warm('udid-A')
      reader.unkeep('udid-A')
      await wait(250)
      await reader.read('udid-A', 'com.app')
      await wait(250)
      expect(native.terminateRunner).not.toHaveBeenCalled()
      expect(native.spawn).toHaveBeenCalledTimes(1)
      reader.stop()
    })

    it('is not a runner an automation client\'s boot warmed, which stays for the device\'s life', async () => {
      const native = setup()
      const reader = new XCUITreeReader(native, 30)
      reader.warm('udid-A')
      await reader.read('udid-A', 'com.app')
      await wait(90)
      expect(native.terminateRunner).not.toHaveBeenCalled()
      reader.stop()
    })
  })

  it('serializes concurrent reads into a single spawn (mutex)', async () => {
    const native = setup()
    const reader = new XCUITreeReader(native)
    const [a, b] = await Promise.all([reader.read('udid-A', 'com.app'), reader.read('udid-A', 'com.app')])
    expect(native.spawn).toHaveBeenCalledTimes(1)
    expect(a.length).toBe(b.length)
    reader.stop()
  })

  it('returns the app turn the runner reads beside the tree, and the same tree as before', async () => {
    const reader = new XCUITreeReader(setup())
    fetchMock.mockImplementation(async (url: string) =>
      url.includes('/tree') ? ({ ok: true, text: async () => `TAPFLOW_INTERFACE_ORIENTATION 3\n${TREE}` } as Response) : healthy(url))
    const read = await reader.readWithTurn('udid-A', 'com.app')
    expect(read.interfaceTurn).toBe(270)
    expect(read.elements.length).toBeGreaterThan(0)
    expect(await reader.read('udid-A', 'com.app')).toEqual(read.elements)
  })

  it('rejects a body that is only the header, as it rejects garbage', async () => {
    const reader = new XCUITreeReader(setup())
    fetchMock.mockImplementation(async (url: string) =>
      url.includes('/tree') ? ({ ok: true, text: async () => 'TAPFLOW_INTERFACE_ORIENTATION 0\nNo matches found for Application' } as Response) : healthy(url))
    await expect(reader.readWithTurn('udid-A', 'com.app')).rejects.toThrow(/unexpected response/)
  })

  it('rejects a garbage body instead of returning an empty tree', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.includes('/health') ? healthy(url) : ({ ok: true, text: async () => '<html>error</html>' } as Response),
    )
    const reader = new XCUITreeReader(setup())
    await expect(reader.read('udid-A', 'com.app')).rejects.toThrow(/unexpected response/)
    reader.stop()
  })

  describe('one runner per device', () => {
    it('reads two devices from two runners, each on its own port, and stops neither', async () => {
      const native = setup()
      const reader = new XCUITreeReader(native)
      await reader.read('udid-A', 'com.app')
      await reader.read('udid-B', 'com.app')
      await reader.read('udid-A', 'com.app')
      expect(native.spawn).toHaveBeenCalledTimes(2)
      expect(spawned.map((s) => s.udid)).toEqual(['udid-A', 'udid-B'])
      expect(native.terminateRunner).not.toHaveBeenCalled()
      const treePorts = fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.includes('/tree')).map(portOf)
      expect(treePorts).toEqual([spawned[0]!.port, spawned[1]!.port, spawned[0]!.port])
      reader.stop()
    })

    it('stopIfDevice stops only that device', async () => {
      const native = setup()
      const reader = new XCUITreeReader(native)
      await reader.read('udid-A', 'com.app')
      await reader.read('udid-B', 'com.app')
      reader.stopIfDevice('udid-C') // no runner → no-op
      expect(native.terminateRunner).not.toHaveBeenCalled()
      reader.stopIfDevice('udid-A')
      expect(native.terminateRunner).toHaveBeenCalledWith('udid-A')
      expect(native.terminateRunner).not.toHaveBeenCalledWith('udid-B')
      await reader.read('udid-B', 'com.app')
      expect(native.spawn).toHaveBeenCalledTimes(2)
      reader.stop()
    })

    it('starts one runner for two reads of a device while another device starts', async () => {
      const native = setup()
      const reader = new XCUITreeReader(native)
      const a = reader.read('udid-A', 'com.app')
      const [b1, b2] = [reader.read('udid-B', 'com.app'), reader.read('udid-B', 'com.app')]
      await Promise.all([a, b1, b2])
      expect(native.spawn).toHaveBeenCalledTimes(2)
      reader.stop()
    })

    it('stop() stops every device and holds nothing afterwards', async () => {
      const native = setup()
      const reader = new XCUITreeReader(native)
      await reader.read('udid-A', 'com.app')
      await reader.read('udid-B', 'com.app')
      reader.stop()
      expect(native.terminateRunner).toHaveBeenCalledWith('udid-A')
      expect(native.terminateRunner).toHaveBeenCalledWith('udid-B')
      reader.stopIfDevice('udid-A')
      expect(native.terminateRunner).toHaveBeenCalledTimes(2)
    })

    it('a start that fails on one device leaves the other device\'s runner serving', async () => {
      const native = setup({}, (s) => {
        if (s.udid === 'udid-B') queueMicrotask(() => s.proc.stdout.emit('data', `TAPFLOW_TREE_READY port=${s.port}\n`))
        else queueMicrotask(() => s.proc.stdout.emit('data', 'TAPFLOW_TREE_READY port=0\n'))
      })
      const reader = new XCUITreeReader(native)
      await reader.read('udid-B', 'com.app')
      await expect(reader.read('udid-A', 'com.app')).rejects.toThrow(/out of date/)
      expect(native.terminateRunner).not.toHaveBeenCalledWith('udid-B')
      await reader.read('udid-B', 'com.app')
      expect(native.spawn).toHaveBeenCalledTimes(2)
      reader.stop()
    })

    it('a read that arrives while the runner is starting waits for its port', async () => {
      let announce!: () => void
      const native = setup({}, (s) => { announce = () => s.proc.stdout.emit('data', `TAPFLOW_TREE_READY port=${s.port}\n`) })
      const reader = new XCUITreeReader(native)
      const first = reader.read('udid-A', 'com.app')
      await vi.waitFor(() => expect(native.spawn).toHaveBeenCalled())
      const second = reader.read('udid-A', 'com.app')
      announce()
      await expect(Promise.all([first, second])).resolves.toHaveLength(2)
      const treePorts = fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.includes('/tree')).map(portOf)
      expect(treePorts).toEqual([spawned[0]!.port, spawned[0]!.port])
      reader.stop()
    })
  })

  describe('the port handshake', () => {
    it('finds the port in a line split across chunks', async () => {
      const native = setup({}, (s) => queueMicrotask(() => {
        s.proc.stdout.emit('data', 'noise\nTAPFLOW_TREE_RE')
        s.proc.stdout.emit('data', `ADY port=${s.port}\n`)
      }))
      const reader = new XCUITreeReader(native)
      await expect(reader.read('udid-A', 'com.app')).resolves.not.toHaveLength(0)
      reader.stop()
    })

    it('fails at once when the runner exits before announcing a port', async () => {
      const native = setup({}, (s) => queueMicrotask(() => { s.proc.exitCode = 65; s.proc.emit('exit', 65, null) }))
      const reader = new XCUITreeReader(native)
      await expect(reader.read('udid-A', 'com.app')).rejects.toThrow(/exited before becoming ready/)
    })

    it('does not read from a port answered by another runner', async () => {
      const native = setup()
      fetchMock.mockImplementation(async (url: string) =>
        url.includes('/health') ? ({ ok: true, text: async () => 'ok' } as Response) : ({ ok: true, text: async () => TREE } as Response))
      const reader = new XCUITreeReader(native)
      await expect(reader.read('udid-A', 'com.app')).rejects.toThrow(/another tree runner/)
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/tree'))).toBe(false)
      expect(native.terminateRunner).toHaveBeenCalledWith('udid-A')
    })

    it('does not hand back a runner stopped while it was answering its first /health', async () => {
      // A killed xcodebuild takes seconds to exit, and its runner answers until then.
      const native = setup()
      let answerHealth!: () => void
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes('/health')) await new Promise<void>((r) => { answerHealth = r })
        return healthy(url)
      })
      const reader = new XCUITreeReader(native)
      const read = reader.read('udid-A', 'com.app')
      await vi.waitFor(() => expect(answerHealth).toBeTypeOf('function'))
      reader.stopIfDevice('udid-A')
      answerHealth()
      await expect(read).rejects.toThrow(/cancelled/)
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/tree'))).toBe(false)
    })

    it('names a runner built before the handshake (it announces port 0) as out of date', async () => {
      const native = setup({}, (s) => queueMicrotask(() => s.proc.stdout.emit('data', 'TAPFLOW_TREE_READY port=0\n')))
      const reader = new XCUITreeReader(native)
      await expect(reader.read('udid-A', 'com.app')).rejects.toThrow(/out of date/)
    })

    it('waits for the runner on the clock, not a count of polls', async () => {
      vi.useFakeTimers()
      try {
        fetchMock.mockImplementation(async (url: string) => {
          if (url.includes('/health')) throw new Error('ECONNREFUSED')
          return { ok: true, text: async () => TREE } as Response
        })
        const reader = new XCUITreeReader(setup())
        const read = reader.read('udid-A', 'com.app')
        let settled = false
        read.then(() => { settled = true }, () => { settled = true })
        // A refused connection fails at once, so a count of polls would have given up long before 60 s.
        await vi.advanceTimersByTimeAsync(60_000)
        expect(settled).toBe(false)
        fetchMock.mockImplementation(healthy)
        await vi.advanceTimersByTimeAsync(500)
        await expect(read).resolves.not.toHaveLength(0)
        reader.stop()
      } finally {
        vi.useRealTimers()
      }
    })

    it('gives up at the deadline when no port is ever announced', async () => {
      vi.useFakeTimers()
      try {
        const native = setup({}, () => {})
        const reader = new XCUITreeReader(native)
        const read = reader.read('udid-A', 'com.app')
        const outcome = read.catch((e: Error) => e)
        await vi.advanceTimersByTimeAsync(90_001)
        expect(String(await outcome)).toMatch(/did not become ready in time/)
        expect(native.terminateRunner).toHaveBeenCalledWith('udid-A')
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('the built runner', () => {
    it('is used as it is when its stamp matches the sources', async () => {
      const native = setup()
      const reader = new XCUITreeReader(native)
      await reader.read('udid-A', 'com.app')
      expect(native.build).not.toHaveBeenCalled()
      reader.stop()
    })

    it('is rebuilt with the current stamp when its sources or Xcode changed', async () => {
      const native = setup({ builtStamp: vi.fn(() => 'stamp-old') })
      const reader = new XCUITreeReader(native)
      await reader.read('udid-A', 'com.app')
      expect(native.build).toHaveBeenCalledWith('platform=iOS Simulator,id=udid-A', 'stamp-1')
      reader.stop()
    })

    it('gives every device waiting on a failed build the short error, not the build log', async () => {
      const log = 'Command failed: xcodebuild build-for-testing\n' + 'x'.repeat(5000)
      const native = setup({ builtStamp: vi.fn(() => undefined), build: vi.fn(async () => { throw new Error(log) }) })
      const reader = new XCUITreeReader(native)
      const results = await Promise.allSettled([reader.read('udid-A', 'com.app'), reader.read('udid-B', 'com.app')])
      for (const r of results) {
        expect(r.status).toBe('rejected')
        const message = (r as PromiseRejectedResult).reason.message as string
        expect(message).toMatch(/^failed to build the UI-tree runner/)
        expect(message.length).toBeLessThan(600)
      }
      expect(native.build).toHaveBeenCalledTimes(1)
    })

    it('stamps the sources once per process, not on every start', async () => {
      const native = setup()
      const reader = new XCUITreeReader(native)
      await reader.read('udid-A', 'com.app')
      await reader.read('udid-B', 'com.app')
      expect(native.sourceStamp).toHaveBeenCalledTimes(1)
      reader.stop()
    })
  })

  describe('a launch cancelled while the runner is being built', () => {
    // `test-without-building` boots a shut-down simulator: spawning after a stop would power the device back up.
    const building = () => {
      let finishBuild!: () => void
      const build = vi.fn(() => new Promise<void>((r) => { finishBuild = r }))
      const native = setup({ builtStamp: vi.fn(() => undefined), build })
      return { native: { ...native, build }, finish: () => finishBuild() }
    }

    it('does not spawn for a device shut down during the build', async () => {
      const { native, finish } = building()
      const reader = new XCUITreeReader(native)
      reader.warm('udid-A')
      await vi.waitFor(() => expect(native.build).toHaveBeenCalled())
      reader.stopIfDevice('udid-A')
      finish()
      await new Promise((r) => setTimeout(r, 0))
      expect(native.spawn).not.toHaveBeenCalled()
    })

    it('does not spawn after stop(), though the device held no runner yet', async () => {
      const { native, finish } = building()
      const reader = new XCUITreeReader(native)
      reader.warm('udid-A')
      await vi.waitFor(() => expect(native.build).toHaveBeenCalled())
      reader.stop()
      finish()
      await new Promise((r) => setTimeout(r, 0))
      expect(native.spawn).not.toHaveBeenCalled()
    })

    it('still starts the other device that shared the build', async () => {
      const { native, finish } = building()
      const reader = new XCUITreeReader(native)
      reader.warm('udid-A')
      await vi.waitFor(() => expect(native.build).toHaveBeenCalled())
      const b = reader.read('udid-B', 'com.app')
      reader.stopIfDevice('udid-A')
      finish()
      await b
      expect(spawned.map((s) => s.udid)).toEqual(['udid-B'])
      reader.stop()
    })

    it('stays cancelled when the device is stopped twice', async () => {
      // A count that went back to 0 would match the launch that began before it.
      const { native, finish } = building()
      const reader = new XCUITreeReader(native)
      reader.stopIfDevice('udid-A')
      reader.warm('udid-A')
      await vi.waitFor(() => expect(native.build).toHaveBeenCalled())
      reader.stopIfDevice('udid-A')
      finish()
      await new Promise((r) => setTimeout(r, 0))
      expect(native.spawn).not.toHaveBeenCalled()
    })
  })

  describe('warm', () => {
    it('starts the runner before any read, and a read during the warm-up joins it', async () => {
      const native = setup()
      const reader = new XCUITreeReader(native)
      reader.warm('udid-A')
      const els = await reader.read('udid-A', 'com.app')
      expect(native.spawn).toHaveBeenCalledTimes(1)
      expect(els.length).toBeGreaterThan(0)
      reader.stop()
    })

    it('starts a second device\'s runner without touching the first', async () => {
      const native = setup()
      const reader = new XCUITreeReader(native)
      await reader.read('udid-A', 'com.app')
      reader.warm('udid-B')
      await vi.waitFor(() => expect(native.spawn).toHaveBeenCalledTimes(2))
      expect(spawned[1]!.udid).toBe('udid-B')
      expect(native.terminateRunner).not.toHaveBeenCalled()
      reader.stop()
    })
  })

  it('starts a new runner when the last one was killed from outside', async () => {
    const native = setup()
    const reader = new XCUITreeReader(native)
    await reader.read('udid-A', 'com.app')
    // What `pkill xcodebuild` leaves: a signal, no exit code, and `killed` false since this process did not kill it.
    spawned[0]!.proc.signalCode = 'SIGTERM'
    await reader.read('udid-A', 'com.app')
    expect(native.spawn).toHaveBeenCalledTimes(2)
    reader.stop()
  })

  describe('a runner that stopped answering (its simulator was shut down outside tapflow)', () => {
    const refused = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })

    it('is dropped on a refused read, so the next read starts a new one', async () => {
      const native = setup()
      const reader = new XCUITreeReader(native)
      await reader.read('udid-A', 'com.app')
      fetchMock.mockImplementationOnce(async () => { throw refused() })
      await expect(reader.read('udid-A', 'com.app')).rejects.toThrow(/fetch failed/)
      await reader.read('udid-A', 'com.app')
      expect(native.spawn).toHaveBeenCalledTimes(2)
      reader.stop()
    })

    it('takes no other device\'s runner down with it', async () => {
      const native = setup()
      const reader = new XCUITreeReader(native)
      await reader.read('udid-A', 'com.app')
      await reader.read('udid-B', 'com.app')
      fetchMock.mockImplementationOnce(async () => { throw refused() })
      await expect(reader.read('udid-A', 'com.app')).rejects.toThrow(/fetch failed/)
      expect(native.terminateRunner).toHaveBeenCalledWith('udid-A')
      expect(native.terminateRunner).not.toHaveBeenCalledWith('udid-B')
      await reader.read('udid-B', 'com.app')
      expect(native.spawn).toHaveBeenCalledTimes(2)
      reader.stop()
    })

    it('a late refusal from the runner already replaced does not drop its replacement', async () => {
      const native = setup()
      const reader = new XCUITreeReader(native)
      await reader.read('udid-A', 'com.app')
      let refuseLate!: () => void
      fetchMock
        .mockImplementationOnce(() => new Promise((_, reject) => { refuseLate = () => reject(refused()) }))
        .mockImplementationOnce(async () => { throw refused() })
      const late = reader.read('udid-A', 'com.app').catch(() => {})
      await expect(reader.read('udid-A', 'com.app')).rejects.toThrow(/fetch failed/)
      await reader.read('udid-A', 'com.app') // the replacement
      refuseLate()
      await late
      await reader.read('udid-A', 'com.app')
      expect(native.spawn).toHaveBeenCalledTimes(2)
      reader.stop()
    })

    it('is kept on a read that timed out — slow is not gone', async () => {
      const native = setup()
      const reader = new XCUITreeReader(native)
      await reader.read('udid-A', 'com.app')
      fetchMock.mockImplementationOnce(async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError') })
      await expect(reader.read('udid-A', 'com.app')).rejects.toThrow(/timeout/)
      await reader.read('udid-A', 'com.app')
      expect(native.spawn).toHaveBeenCalledTimes(1)
      reader.stop()
    })

    it('is replaced by a warm-up for the same device', async () => {
      const native = setup()
      const reader = new XCUITreeReader(native)
      await reader.read('udid-A', 'com.app')
      fetchMock.mockImplementationOnce(async () => { throw refused() })
      reader.warm('udid-A')
      await vi.waitFor(() => expect(native.spawn).toHaveBeenCalledTimes(2))
      reader.stop()
    })

    it('is dropped by a warm-up without touching another device', async () => {
      const native = setup()
      const reader = new XCUITreeReader(native)
      await reader.read('udid-A', 'com.app')
      await reader.read('udid-B', 'com.app')
      fetchMock.mockImplementationOnce(async () => { throw refused() })
      reader.warm('udid-A')
      await vi.waitFor(() => expect(native.spawn).toHaveBeenCalledTimes(3))
      expect(native.terminateRunner).not.toHaveBeenCalledWith('udid-B')
      reader.stop()
    })

    it.each([
      ['the device was shut down', (r: XCUITreeReader) => r.stopIfDevice('udid-A')],
      ['the agent stopped', (r: XCUITreeReader) => r.stop()],
    ])('is not restarted by a warm-up whose probe failed because %s meanwhile', async (_, stopNow) => {
      // `test-without-building` boots its simulator: restarting here would power the device back up, or leave a
      // runner nothing will stop.
      const native = setup()
      const reader = new XCUITreeReader(native)
      await reader.read('udid-A', 'com.app')
      let failProbe!: () => void
      fetchMock.mockImplementationOnce(() => new Promise((_, reject) => { failProbe = () => reject(refused()) }))
      reader.warm('udid-A')
      await vi.waitFor(() => expect(failProbe).toBeTypeOf('function'))
      stopNow(reader)
      failProbe()
      await new Promise((r) => setTimeout(r, 10))
      expect(native.spawn).toHaveBeenCalledTimes(1)
    })

    it('is kept by a warm-up when it still answers', async () => {
      const native = setup()
      const reader = new XCUITreeReader(native)
      await reader.read('udid-A', 'com.app')
      reader.warm('udid-A')
      await new Promise((r) => setTimeout(r, 10))
      expect(native.spawn).toHaveBeenCalledTimes(1)
      expect(native.terminateRunner).not.toHaveBeenCalled()
      reader.stop()
    })
  })

  it('throws without a bundleId', async () => {
    const reader = new XCUITreeReader(setup())
    await expect(reader.read('udid-A', '')).rejects.toThrow(/foreground app/)
  })
})

describe('computeRunnerStamp', () => {
  let dir: string
  const write = (rel: string, body: string) => {
    mkdirSync(join(dir, rel, '..'), { recursive: true })
    writeFileSync(join(dir, rel), body)
  }
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'runner-stamp-'))
    write('TreeRunner/TreeServer.swift', 'server')
    write('TreeHost/App.swift', 'host')
    write('TapflowTreeRunner.xcodeproj/project.pbxproj', 'project')
    write('TapflowTreeRunner.xcodeproj/xcshareddata/xcschemes/TreeRunner.xcscheme', 'scheme')
    write('project.yml', 'spec')
    write('build/Build/Products/x.xctestrun', 'built')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it.each([
    ['a runner source', () => write('TreeRunner/TreeServer.swift', 'server 2')],
    ['a new runner source', () => write('TreeRunner/Extra.swift', 'extra')],
    ['a host source', () => write('TreeHost/App.swift', 'host 2')],
    ['the checked-in project', () => write('TapflowTreeRunner.xcodeproj/project.pbxproj', 'project 2')],
    ['the shared scheme', () => write('TapflowTreeRunner.xcodeproj/xcshareddata/xcschemes/TreeRunner.xcscheme', 'scheme 2')],
  ])('changes with %s', (_, change) => {
    const before = computeRunnerStamp(dir, 'Xcode 26.5')
    change()
    expect(computeRunnerStamp(dir, 'Xcode 26.5')).not.toBe(before)
  })

  it('changes with the Xcode that builds it', () => {
    expect(computeRunnerStamp(dir, 'Xcode 27.0')).not.toBe(computeRunnerStamp(dir, 'Xcode 26.5'))
  })

  it('ignores what nothing builds from: the build output and project.yml', () => {
    const before = computeRunnerStamp(dir, 'Xcode 26.5')
    write('build/Build/Products/x.xctestrun', 'rebuilt')
    write('project.yml', 'spec 2')
    expect(computeRunnerStamp(dir, 'Xcode 26.5')).toBe(before)
  })
})

describe('toFocusedField', () => {
  const frame = { x: 20, y: 122, width: 362, height: 34 }

  it('takes the runner\'s field whole, commas and Hangul still composing included', () => {
    // Measured on iOS 26.4: the tree prints this value cut to 18 characters, unquoted; /field gives all of it.
    expect(toFocusedField({ identifier: 'form.email', placeholder: 'Email', frame, type: 'text', value: 'Ab, cdefghijklmnopqrs안' }))
      .toEqual({ field: { identifier: 'form.email', placeholder: 'Email', frame, secure: false, value: 'Ab, cdefghijklmnopqrs안' } })
  })

  it('keeps no value for a secure field, even one the runner sent', () => {
    expect(toFocusedField({ identifier: 'form.password', placeholder: 'Password', frame, type: 'secure', value: '•••', reason: 'secure' }))
      .toEqual({ field: { identifier: 'form.password', placeholder: 'Password', frame, secure: true }, reason: 'secure' })
  })

  it('says why there is no field, and calls anything it cannot vouch for a failed read', () => {
    expect(toFocusedField({ reason: 'no-focus' })).toEqual({ field: null, reason: 'no-focus' })
    expect(toFocusedField({ reason: 'ambiguous' })).toEqual({ field: null, reason: 'ambiguous' })
    expect(toFocusedField({ reason: 'something-new' })).toEqual({ field: null, reason: 'failed' })
    expect(toFocusedField({ identifier: 'x', frame: { x: 1 } })).toEqual({ field: null, reason: 'failed' })
    expect(toFocusedField('not json')).toEqual({ field: null, reason: 'failed' })
  })
})

describe('toKeyboardState', () => {
  const rect = { x: 0, y: 0.6, width: 1, height: 0.4 }

  it('keeps a portrait app\'s keyboard as it is', () => {
    expect(toKeyboardState({ shown: true, rect, orientation: 1 })).toEqual({ shown: true, rect, onHome: false })
    // 0: the runtime has no orientation getter, which only a portrait app has ever met.
    expect(toKeyboardState({ shown: true, rect, orientation: 0 })).toEqual({ shown: true, rect, onHome: false })
  })

  it('carries a landscape app\'s keyboard into the portrait framebuffer a touch lands in', () => {
    // UIInterfaceOrientation 4 is a turn of 90 (as `/tree` reads it), which `toFramePoint` carries as (u, v) → (v, 1 − u):
    // the keyboard along the app's bottom edge lies along the framebuffer's right one.
    const k = toKeyboardState({ shown: true, rect: { x: 0, y: 0.5, width: 1, height: 0.5 }, orientation: 4 })
    expect(k).toEqual({ shown: true, rect: { x: 0.5, y: 0, width: 0.5, height: 1 }, onHome: false })
  })

  it('tells hidden from unknown', () => {
    expect(toKeyboardState({ shown: false, orientation: 1 })).toEqual({ shown: false, onHome: false })
    expect(toKeyboardState('nonsense')).toEqual({ shown: null })
    expect(toKeyboardState({ orientation: 1 })).toEqual({ shown: null })
  })

  // The runner answers `shown: null` for one reason only, that the app is not in front: the home screen, for Flow
  // Capture's default range. A read that failed never reaches the runner and carries no `onHome`.
  it('reads the runner\'s null as the app not in front', () => {
    expect(toKeyboardState({ shown: null, orientation: 0 })).toEqual({ shown: null, onHome: true })
  })

  it('is shown with no rect when the rect cannot be read', () => {
    expect(toKeyboardState({ shown: true, rect: { x: 'a' }, orientation: 1 })).toEqual({ shown: true, onHome: false })
  })
})
