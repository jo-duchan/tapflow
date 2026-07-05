import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PlatformError, ValidationError } from '@tapflowio/agent-core'
import { AdbWrapper } from '../AdbWrapper'
import type { AdbRunner } from '../adb'

function mockRunner(responses: {
  devices?: string
  avds?: string[]
  avdName?: string
  osVersion?: string
  screenSize?: string
  uiDump?: string
} = {}): AdbRunner {
  return {
    exec: vi.fn(async (...args: string[]) => {
      if (args[0] === 'devices') {
        return responses.devices ?? 'List of devices attached\n'
      }
      if (args.includes('emu') && args.includes('avd') && args.includes('name')) {
        return `${responses.avdName ?? ''}\nOK\n`
      }
      if (args.includes('ro.build.version.release')) {
        return `${responses.osVersion ?? '14'}\n`
      }
      if (args.includes('wm') && args.includes('size')) {
        return `Physical size: ${responses.screenSize ?? '1080x2400'}\n`
      }
      if (args.includes('uiautomator')) {
        return responses.uiDump ?? ''
      }
      return ''
    }),
    execBinary: vi.fn().mockResolvedValue(Buffer.from('PNG')),
    listAvds: vi.fn().mockResolvedValue(responses.avds ?? []),
  }
}

describe('AdbWrapper', () => {
  describe('listDevices', () => {
    it('returns empty array when no AVDs exist', async () => {
      const wrapper = new AdbWrapper(mockRunner({ avds: [] }))
      expect(await wrapper.listDevices()).toEqual([])
    })

    it('returns shutdown device when AVD exists but emulator not running', async () => {
      const wrapper = new AdbWrapper(mockRunner({
        avds: ['Pixel_8_API_34'],
        devices: 'List of devices attached\n',
      }))
      const devices = await wrapper.listDevices()
      expect(devices).toHaveLength(1)
      expect(devices[0]).toMatchObject({
        id: 'avd:Pixel_8_API_34',
        name: 'Pixel_8_API_34',
        platform: 'android',
        status: 'shutdown',
      })
    })

    it('returns booted device when emulator is running and AVD name matches', async () => {
      const wrapper = new AdbWrapper(mockRunner({
        avds: ['Pixel_8_API_34'],
        devices: 'List of devices attached\nemulator-5554\tdevice\n',
        avdName: 'Pixel_8_API_34',
        osVersion: '14',
      }))
      const devices = await wrapper.listDevices()
      expect(devices).toHaveLength(1)
      expect(devices[0]).toMatchObject({
        id: 'avd:Pixel_8_API_34',
        status: 'booted',
        osVersion: 'Android 14',
      })
    })

    it('uses avd: prefix as stable id regardless of serial', async () => {
      const wrapper = new AdbWrapper(mockRunner({
        avds: ['Pixel_8_API_34'],
        devices: 'List of devices attached\nemulator-5556\tdevice\n',
        avdName: 'Pixel_8_API_34',
      }))
      const devices = await wrapper.listDevices()
      expect(devices[0].id).toBe('avd:Pixel_8_API_34')
    })

    it('tracks serial in serialMap after listDevices', async () => {
      const wrapper = new AdbWrapper(mockRunner({
        avds: ['Pixel_8_API_34'],
        devices: 'List of devices attached\nemulator-5554\tdevice\n',
        avdName: 'Pixel_8_API_34',
      }))
      await wrapper.listDevices()
      expect(wrapper.getSerial('avd:Pixel_8_API_34')).toBe('emulator-5554')
    })

    it('clears stale serial when emulator is no longer running', async () => {
      const wrapper = new AdbWrapper(mockRunner({
        avds: ['Pixel_8_API_34'],
        devices: 'List of devices attached\nemulator-5554\tdevice\n',
        avdName: 'Pixel_8_API_34',
      }))
      await wrapper.listDevices()
      expect(wrapper.getSerial('avd:Pixel_8_API_34')).toBe('emulator-5554')

      // Emulator shuts down externally
      const runner2 = mockRunner({ avds: ['Pixel_8_API_34'], devices: 'List of devices attached\n' })
      const wrapper2 = new AdbWrapper(runner2)
      wrapper2.setSerial('avd:Pixel_8_API_34', 'emulator-5554')
      await wrapper2.listDevices()
      expect(wrapper2.getSerial('avd:Pixel_8_API_34')).toBeUndefined()
    })
  })

  describe('installApp', () => {
    it('calls adb install -r with serial and path', async () => {
      const runner = mockRunner()
      const wrapper = new AdbWrapper(runner)
      await wrapper.installApp('emulator-5554', '/tmp/app.apk')
      expect(runner.exec).toHaveBeenCalledWith('-s', 'emulator-5554', 'install', '-r', '/tmp/app.apk')
    })

    it('throws ValidationError when adb returns INSTALL_FAILED code', async () => {
      const runner = mockRunner()
      ;(runner.exec as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
        stderr: 'Failure [INSTALL_FAILED_VERSION_DOWNGRADE]',
      })
      const wrapper = new AdbWrapper(runner)
      await expect(wrapper.installApp('emulator-5554', '/tmp/app.apk')).rejects.toBeInstanceOf(ValidationError)
    })
  })

  describe('launchApp', () => {
    it('calls adb shell monkey with LAUNCHER intent', async () => {
      const runner = mockRunner()
      const wrapper = new AdbWrapper(runner)
      await wrapper.launchApp('emulator-5554', 'com.example.app')
      expect(runner.exec).toHaveBeenCalledWith(
        '-s', 'emulator-5554', 'shell', 'monkey',
        '-p', 'com.example.app', '-c', 'android.intent.category.LAUNCHER', '1',
      )
    })
  })

  describe('getScreenSize', () => {
    it('parses wm size output correctly', async () => {
      const wrapper = new AdbWrapper(mockRunner({ screenSize: '1080x2400' }))
      const size = await wrapper.getScreenSize('emulator-5554')
      expect(size).toEqual({ width: 1080, height: 2400 })
    })

    it('throws PlatformError when wm size output is malformed', async () => {
      const wrapper = new AdbWrapper(mockRunner({ screenSize: 'unknown' }))
      await expect(wrapper.getScreenSize('emulator-5554')).rejects.toBeInstanceOf(PlatformError)
    })
  })

  describe('serial map', () => {
    it('setSerial / getSerial / clearSerial work correctly', () => {
      const wrapper = new AdbWrapper(mockRunner())
      wrapper.setSerial('avd:Pixel_8', 'emulator-5554')
      expect(wrapper.getSerial('avd:Pixel_8')).toBe('emulator-5554')
      wrapper.clearSerial('avd:Pixel_8')
      expect(wrapper.getSerial('avd:Pixel_8')).toBeUndefined()
    })
  })

  describe('openUrl', () => {
    it('calls adb shell am start with VIEW intent and url', async () => {
      const runner = mockRunner()
      const wrapper = new AdbWrapper(runner)
      await wrapper.openUrl('emulator-5554', 'myapp://home')
      expect(runner.exec).toHaveBeenCalledWith(
        '-s', 'emulator-5554', 'shell', 'am', 'start',
        '-a', 'android.intent.action.VIEW', '-d', 'myapp://home',
      )
    })
  })

  describe('setRotation', () => {
    it('locks display to landscape via wm user-rotation', async () => {
      const runner = mockRunner()
      const wrapper = new AdbWrapper(runner)
      await wrapper.setRotation('emulator-5554', 3)
      expect(runner.exec).toHaveBeenCalledWith(
        '-s', 'emulator-5554', 'shell', 'wm', 'user-rotation', 'lock', '3',
      )
    })

    it('locks display back to portrait via wm user-rotation', async () => {
      const runner = mockRunner()
      const wrapper = new AdbWrapper(runner)
      await wrapper.setRotation('emulator-5554', 0)
      expect(runner.exec).toHaveBeenCalledWith(
        '-s', 'emulator-5554', 'shell', 'wm', 'user-rotation', 'lock', '0',
      )
    })

    // Legacy `settings put system user_rotation` is silently ignored on newer Android
    // (API 37): the display does not rotate, only a rotation-suggestion appears. wm
    // user-rotation lock works on API 34 and 37, and locks regardless of auto-rotate,
    // so the legacy settings writes are dropped entirely.
    it('does not use legacy settings user_rotation / accelerometer_rotation', async () => {
      const runner = mockRunner()
      const wrapper = new AdbWrapper(runner)
      await wrapper.setRotation('emulator-5554', 3)
      const calls = (runner.exec as ReturnType<typeof vi.fn>).mock.calls
      expect(calls.every((c) => !c.includes('user_rotation') && !c.includes('accelerometer_rotation'))).toBe(true)
    })
  })

  describe('dumpUiHierarchy', () => {
    const XML = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>\n<hierarchy rotation="0"><node bounds="[0,0][1080,2400]" /></hierarchy>`

    it('runs uiautomator dump under the device-side timeout command', async () => {
      const runner = mockRunner({ uiDump: XML })
      const wrapper = new AdbWrapper(runner)
      await wrapper.dumpUiHierarchy('emulator-5554')
      expect(runner.exec).toHaveBeenCalledWith(
        '-s', 'emulator-5554', 'exec-out',
        'timeout', '10', 'uiautomator', 'dump', '/dev/tty',
      )
    })

    it('strips the trailing status line and returns clean XML', async () => {
      const runner = mockRunner({ uiDump: `${XML}UI hierarchy dumped to: /dev/tty\n` })
      const wrapper = new AdbWrapper(runner)
      const xml = await wrapper.dumpUiHierarchy('emulator-5554')
      expect(xml).toBe(XML)
    })

    it('throws PlatformError when the timed-out dump produced no XML', async () => {
      const runner = mockRunner({ uiDump: '' })
      const wrapper = new AdbWrapper(runner)
      await expect(wrapper.dumpUiHierarchy('emulator-5554')).rejects.toThrow(PlatformError)
    })

    it('throws PlatformError on truncated XML (dump killed mid-write)', async () => {
      const runner = mockRunner({ uiDump: `<?xml version='1.0'?>\n<hierarchy rotation="0"><node ` })
      const wrapper = new AdbWrapper(runner)
      await expect(wrapper.dumpUiHierarchy('emulator-5554')).rejects.toThrow(PlatformError)
    })
  })
})
