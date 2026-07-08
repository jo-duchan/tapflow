import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import { XCUITreeReader, type RunnerNative } from '../XCUITreeReader'

// A fake child process with no real pid, so killHandle never touches a real OS
// process group (it falls back to proc.kill()).
function fakeProc() {
  const p = new EventEmitter() as EventEmitter & { pid?: number; exitCode: number | null; killed: boolean; kill: () => boolean }
  p.pid = undefined
  p.exitCode = null
  p.killed = false
  p.kill = vi.fn(() => { p.killed = true; return true })
  return p
}

const TREE = [
  "Attributes: Application, 0x1, pid: 1, label: 'App'",
  'Element subtree:',
  " →Application, 0x1, pid: 1, label: 'App'",
  '    Window (Main), 0x2, {{0.0, 0.0}, {100.0, 200.0}}',
  "      Button, 0x3, {{0.0, 0.0}, {50.0, 20.0}}, identifier: 'ok', label: 'OK'",
].join('\n')

function makeNative(overrides: Partial<RunnerNative> = {}): RunnerNative & {
  spawn: ReturnType<typeof vi.fn>
  terminateHost: ReturnType<typeof vi.fn>
  build: ReturnType<typeof vi.fn>
} {
  return {
    xctestrunReady: () => true, // skip the build
    build: vi.fn(async () => {}),
    spawn: vi.fn(() => fakeProc()),
    terminateHost: vi.fn(),
    ...overrides,
  } as RunnerNative & { spawn: ReturnType<typeof vi.fn>; terminateHost: ReturnType<typeof vi.fn>; build: ReturnType<typeof vi.fn> }
}

describe('XCUITreeReader', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn(async (url: string) =>
      url.includes('/health')
        ? ({ ok: true } as Response)
        : ({ ok: true, text: async () => TREE } as Response),
    )
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('spawns the runner once and returns parsed elements', async () => {
    const native = makeNative()
    const reader = new XCUITreeReader(native)
    const els = await reader.read('udid-A', 'com.app')
    expect(native.spawn).toHaveBeenCalledTimes(1)
    expect(els.find((e) => e.identifier === 'ok')?.label).toBe('OK')
    reader.stop()
  })

  it('serializes concurrent reads into a single spawn (mutex)', async () => {
    const native = makeNative()
    const reader = new XCUITreeReader(native)
    const [a, b] = await Promise.all([reader.read('udid-A', 'com.app'), reader.read('udid-A', 'com.app')])
    expect(native.spawn).toHaveBeenCalledTimes(1)
    expect(a.length).toBe(b.length)
    reader.stop()
  })

  it('rejects a garbage body instead of returning an empty tree', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.includes('/health') ? ({ ok: true } as Response) : ({ ok: true, text: async () => '<html>error</html>' } as Response),
    )
    const reader = new XCUITreeReader(makeNative())
    await expect(reader.read('udid-A', 'com.app')).rejects.toThrow(/unexpected response/)
    reader.stop()
  })

  it('stopIfDevice stops only the matching device', async () => {
    const native = makeNative()
    const reader = new XCUITreeReader(native)
    await reader.read('udid-A', 'com.app')
    reader.stopIfDevice('udid-B') // different device → no-op
    expect(native.terminateHost).not.toHaveBeenCalled()
    reader.stopIfDevice('udid-A') // matches → stop
    expect(native.terminateHost).toHaveBeenCalledWith('udid-A')
  })

  it('throws without a bundleId', async () => {
    const reader = new XCUITreeReader(makeNative())
    await expect(reader.read('udid-A', '')).rejects.toThrow(/foreground app/)
  })
})
