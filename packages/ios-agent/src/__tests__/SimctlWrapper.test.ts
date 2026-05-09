import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SimctlWrapper } from '../SimctlWrapper'
import type { SimctlRunner } from '../simctl'

vi.mock('child_process', () => ({
  execFile: vi.fn((_cmd: string, _args: string[], cb: (err: null, stdout: string, stderr: string) => void) => {
    cb(null, '', '')
    return { on: vi.fn() }
  }),
}))

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    promises: {
      ...actual.promises,
      readFile: vi.fn(),
      unlink: vi.fn().mockResolvedValue(undefined),
    },
  }
})

const SIMCTL_LIST_OUTPUT = JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-17-0': [
      { udid: 'device-1', name: 'iPhone 15', state: 'Booted', isAvailable: true },
      { udid: 'device-2', name: 'iPhone 15 Pro', state: 'Shutdown', isAvailable: true },
      { udid: 'device-3', name: 'iPhone 14', state: 'Shutdown', isAvailable: false },
    ],
  },
})

function mockRunner(outputs: Record<string, string> = {}): SimctlRunner {
  return {
    exec: vi.fn(async (...args: string[]) => outputs[args[0]] ?? ''),
    execBinary: vi.fn().mockResolvedValue(Buffer.alloc(0)),
  }
}

describe('SimctlWrapper', () => {
  describe('listDevices', () => {
    it('returns only available devices', async () => {
      const runner = mockRunner({ list: SIMCTL_LIST_OUTPUT })
      const wrapper = new SimctlWrapper(runner)
      const devices = await wrapper.listDevices()
      expect(devices).toHaveLength(2)
    })

    it('maps state to DeviceStatus correctly', async () => {
      const runner = mockRunner({ list: SIMCTL_LIST_OUTPUT })
      const wrapper = new SimctlWrapper(runner)
      const devices = await wrapper.listDevices()
      expect(devices.find((d) => d.id === 'device-1')?.status).toBe('booted')
      expect(devices.find((d) => d.id === 'device-2')?.status).toBe('shutdown')
    })

    it('sets platform to ios', async () => {
      const runner = mockRunner({ list: SIMCTL_LIST_OUTPUT })
      const wrapper = new SimctlWrapper(runner)
      const [device] = await wrapper.listDevices()
      expect(device.platform).toBe('ios')
    })
  })

  describe('boot', () => {
    it('calls simctl boot with the deviceId', async () => {
      const runner = mockRunner()
      const wrapper = new SimctlWrapper(runner)
      await wrapper.boot('device-1')
      expect(runner.exec).toHaveBeenCalledWith('boot', 'device-1')
    })

    it('does not throw if device is already booted', async () => {
      const runner: SimctlRunner = {
        exec: vi.fn().mockRejectedValue(
          Object.assign(new Error(), { stderr: 'Unable to boot device in current state: Booted' })
        ),
      }
      const wrapper = new SimctlWrapper(runner)
      await expect(wrapper.boot('device-1')).resolves.toBeUndefined()
    })

    it('rethrows unexpected errors', async () => {
      const runner: SimctlRunner = {
        exec: vi.fn().mockRejectedValue(new Error('xcrun not found')),
      }
      const wrapper = new SimctlWrapper(runner)
      await expect(wrapper.boot('device-1')).rejects.toThrow('xcrun not found')
    })
  })

  describe('shutdown', () => {
    it('calls simctl shutdown with the deviceId', async () => {
      const runner = mockRunner()
      const wrapper = new SimctlWrapper(runner)
      await wrapper.shutdown('device-1')
      expect(runner.exec).toHaveBeenCalledWith('shutdown', 'device-1')
    })
  })

  describe('installApp', () => {
    it('calls simctl install booted with the app path', async () => {
      const runner = mockRunner()
      const wrapper = new SimctlWrapper(runner)
      await wrapper.installApp('/path/to/App.app')
      expect(runner.exec).toHaveBeenCalledWith('install', 'booted', '/path/to/App.app')
    })
  })

  describe('launchApp', () => {
    it('calls simctl launch booted with the bundleId', async () => {
      const runner = mockRunner()
      const wrapper = new SimctlWrapper(runner)
      await wrapper.launchApp('com.example.app')
      expect(runner.exec).toHaveBeenCalledWith('launch', 'booted', 'com.example.app')
    })
  })

  describe('rotate', () => {
    it('calls osascript with Cmd+Right for landscapeRight', async () => {
      const { execFile } = await import('child_process')
      const wrapper = new SimctlWrapper()
      await wrapper.rotate('device-1', 'landscapeRight')
      expect(vi.mocked(execFile)).toHaveBeenCalledWith(
        'osascript',
        expect.arrayContaining([expect.stringContaining('key code 124')]),
        expect.any(Function),
      )
    })

    it('calls osascript with Cmd+Left for portrait', async () => {
      const { execFile } = await import('child_process')
      const wrapper = new SimctlWrapper()
      await wrapper.rotate('device-1', 'portrait')
      expect(vi.mocked(execFile)).toHaveBeenCalledWith(
        'osascript',
        expect.arrayContaining([expect.stringContaining('key code 123')]),
        expect.any(Function),
      )
    })
  })

  describe('screenshot', () => {
    beforeEach(() => vi.clearAllMocks())

    it('saves to temp file and returns PNG buffer', async () => {
      const { promises: fsMock } = await import('fs')
      const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47])
      vi.mocked(fsMock.readFile as (path: string) => Promise<Buffer>).mockResolvedValue(pngMagic)

      const runner: SimctlRunner = {
        exec: vi.fn().mockResolvedValue(''),
        execBinary: vi.fn(),
      }
      const wrapper = new SimctlWrapper(runner)
      const buf = await wrapper.screenshot()

      expect(runner.exec).toHaveBeenCalledWith(
        'io', 'booted', 'screenshot',
        expect.stringMatching(/tapflow-.+\.png$/)
      )
      expect(buf).toEqual(pngMagic)
    })
  })
})
