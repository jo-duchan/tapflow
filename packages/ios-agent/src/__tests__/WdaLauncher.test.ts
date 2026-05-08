import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  rmSync: vi.fn(),
}))

import { spawn } from 'node:child_process'
import { existsSync, writeFileSync, rmSync } from 'node:fs'

const mockSpawn = vi.mocked(spawn)
const mockExistsSync = vi.mocked(existsSync)
const mockWriteFileSync = vi.mocked(writeFileSync)
const mockRmSync = vi.mocked(rmSync)

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function makeProcess(pid = 1234): ChildProcess {
  const proc = new EventEmitter() as unknown as ChildProcess
  ;(proc as Record<string, unknown>).pid = pid
  ;(proc as Record<string, unknown>).stderr = new EventEmitter()
  ;(proc as Record<string, unknown>).kill = vi.fn()
  return proc
}

// Dynamic import after mocks are set up
const { WdaLauncher, WdaNotInstalledError, WDA_XCTESTRUN_CACHE } = await import('../WdaLauncher')

const UDID = 'test-udid-1234'

function healthOk() {
  return Promise.resolve(new Response('{}', { status: 200 }))
}
function healthFail() {
  return Promise.reject(new Error('ECONNREFUSED'))
}

describe('WdaLauncher', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env['WDA_PATH']
  })

  afterEach(() => {
    delete process.env['WDA_PATH']
  })

  describe('ensureRunning — already healthy', () => {
    it('returns without spawning when WDA is already responding', async () => {
      mockFetch.mockResolvedValueOnce(healthOk())
      const launcher = new WdaLauncher({ udid: UDID })
      await launcher.ensureRunning()
      expect(mockSpawn).not.toHaveBeenCalled()
    })
  })

  describe('ensureRunning — WDA_PATH env priority', () => {
    it('uses WDA_PATH env over cache when both exist', async () => {
      process.env['WDA_PATH'] = '/env/path/WDA.xctestrun'
      mockFetch.mockRejectedValueOnce(new Error('fail'))
      mockExistsSync.mockImplementation((p) =>
        p === '/env/path/WDA.xctestrun' || p === WDA_XCTESTRUN_CACHE
      )
      const proc = makeProcess()
      mockSpawn.mockReturnValueOnce(proc)
      mockFetch.mockResolvedValue(healthOk())

      const launcher = new WdaLauncher({ udid: UDID })
      await launcher.ensureRunning()

      const [, args] = mockSpawn.mock.calls[0]
      expect(args).toContain('/env/path/WDA.xctestrun')
    })
  })

  describe('ensureRunning — explicit xctestrunPath', () => {
    it('uses constructor xctestrunPath over env and cache', async () => {
      process.env['WDA_PATH'] = '/env/path/WDA.xctestrun'
      mockFetch.mockRejectedValueOnce(new Error('fail'))
      mockExistsSync.mockImplementation((p) => p === '/explicit/WDA.xctestrun')
      const proc = makeProcess()
      mockSpawn.mockReturnValueOnce(proc)
      mockFetch.mockResolvedValue(healthOk())

      const launcher = new WdaLauncher({ udid: UDID, xctestrunPath: '/explicit/WDA.xctestrun' })
      await launcher.ensureRunning()

      const [, args] = mockSpawn.mock.calls[0]
      expect(args).toContain('/explicit/WDA.xctestrun')
    })
  })

  describe('ensureRunning — cache fallback', () => {
    it('spawns xcodebuild with cached xctestrun', async () => {
      mockFetch.mockRejectedValueOnce(new Error('fail'))
      mockExistsSync.mockImplementation((p) => p === WDA_XCTESTRUN_CACHE)
      const proc = makeProcess()
      mockSpawn.mockReturnValueOnce(proc)
      mockFetch.mockResolvedValue(healthOk())

      const launcher = new WdaLauncher({ udid: UDID })
      await launcher.ensureRunning()

      expect(mockSpawn).toHaveBeenCalledWith(
        'xcodebuild',
        expect.arrayContaining([
          'test-without-building',
          '-xctestrun', WDA_XCTESTRUN_CACHE,
          '-destination', `platform=iOS Simulator,id=${UDID}`,
        ]),
        expect.any(Object),
      )
      expect(mockWriteFileSync).toHaveBeenCalled()
    })
  })

  describe('ensureRunning — nothing found', () => {
    it('throws WdaNotInstalledError when no xctestrun exists', async () => {
      mockFetch.mockRejectedValue(new Error('fail'))
      mockExistsSync.mockReturnValue(false)

      const launcher = new WdaLauncher({ udid: UDID })
      await expect(launcher.ensureRunning()).rejects.toThrow(WdaNotInstalledError)
      expect(mockSpawn).not.toHaveBeenCalled()
    })
  })

  describe('ensureRunning — custom port', () => {
    it('health-checks on the configured port', async () => {
      mockFetch.mockResolvedValueOnce(healthOk())
      const launcher = new WdaLauncher({ udid: UDID, port: 8200 })
      await launcher.ensureRunning()
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8200/status',
        expect.any(Object),
      )
    })
  })

  describe('stop', () => {
    it('kills the spawned process and removes PID file', async () => {
      mockFetch.mockRejectedValueOnce(new Error('fail'))
      mockExistsSync.mockImplementation((p) => p === WDA_XCTESTRUN_CACHE)
      const proc = makeProcess()
      mockSpawn.mockReturnValueOnce(proc)
      mockFetch.mockResolvedValue(healthOk())

      const launcher = new WdaLauncher({ udid: UDID })
      await launcher.ensureRunning()

      launcher.stop()
      expect(proc.kill).toHaveBeenCalled()
      expect(mockRmSync).toHaveBeenCalled()
    })

    it('does not throw when called without a running process', () => {
      const launcher = new WdaLauncher({ udid: UDID })
      expect(() => launcher.stop()).not.toThrow()
    })
  })
})
