import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AdbWrapper } from '../AdbWrapper'
import type { AdbRunner } from '../adb'

function mockRunner(responses: {
  devices?: string
  avds?: string[]
  avdName?: string
  osVersion?: string
  screenSize?: string
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
})
