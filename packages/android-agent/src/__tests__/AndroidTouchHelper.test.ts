import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AndroidTouchHelper } from '../AndroidTouchHelper.js'
import type { AdbWrapper } from '../AdbWrapper.js'

function makeMockAdb(): AdbWrapper {
  return {
    getScreenSize: vi.fn().mockResolvedValue({ width: 1080, height: 1920 }),
    sendInput: vi.fn().mockResolvedValue(undefined),
    sendKeyEvent: vi.fn().mockResolvedValue(undefined),
  } as unknown as AdbWrapper
}

describe('AndroidTouchHelper', () => {
  let adb: AdbWrapper
  let helper: AndroidTouchHelper

  beforeEach(() => {
    adb = makeMockAdb()
    helper = new AndroidTouchHelper(adb, 'emulator-5554')
  })

  describe('tap vs swipe 판정', () => {
    it('start == end이면 tap 호출', async () => {
      helper.touchStart(0.5, 0.5)
      helper.touchEnd()
      await vi.waitFor(() => expect(adb.sendInput).toHaveBeenCalled(), { timeout: 500 })
      expect(adb.sendInput).toHaveBeenCalledWith(
        'emulator-5554', 'tap', '540', '960'
      )
    })

    it('move 없이 touchEnd하면 tap', async () => {
      helper.touchStart(0.1, 0.2)
      helper.touchEnd()
      await vi.waitFor(() => expect(adb.sendInput).toHaveBeenCalled(), { timeout: 500 })
      const [, action] = vi.mocked(adb.sendInput).mock.calls[0]
      expect(action).toBe('tap')
    })

    it('충분히 이동하면 swipe 호출', async () => {
      helper.touchStart(0.1, 0.5)
      helper.touchMove(0.9, 0.5)
      helper.touchEnd()
      await vi.waitFor(() => expect(adb.sendInput).toHaveBeenCalled(), { timeout: 500 })
      expect(adb.sendInput).toHaveBeenCalledWith(
        'emulator-5554', 'swipe', '108', '960', '972', '960', '300'
      )
    })

    it('swipe 시 start·end 좌표가 모두 포함됨', async () => {
      helper.touchStart(0.0, 0.0)
      helper.touchMove(1.0, 1.0)
      helper.touchEnd()
      await vi.waitFor(() => expect(adb.sendInput).toHaveBeenCalled(), { timeout: 500 })
      expect(adb.sendInput).toHaveBeenCalledWith(
        'emulator-5554', 'swipe', '0', '0', '1080', '1920', '300'
      )
    })
  })

  describe('좌표 정규화 (0~1 → px)', () => {
    it('정규화 좌표를 화면 해상도 기준 px로 변환', async () => {
      helper.touchStart(0.25, 0.75)
      helper.touchEnd()
      await vi.waitFor(() => expect(adb.sendInput).toHaveBeenCalled(), { timeout: 500 })
      expect(adb.sendInput).toHaveBeenCalledWith(
        'emulator-5554', 'tap', '270', '1440'
      )
    })

    it('getScreenSize는 최초 1회만 호출 (캐시)', async () => {
      helper.touchStart(0.5, 0.5); helper.touchEnd()
      await vi.waitFor(() => expect(adb.sendInput).toHaveBeenCalledTimes(1), { timeout: 500 })

      vi.mocked(adb.sendInput).mockClear()

      helper.touchStart(0.3, 0.3); helper.touchEnd()
      await vi.waitFor(() => expect(adb.sendInput).toHaveBeenCalledTimes(1), { timeout: 500 })
      expect(adb.getScreenSize).toHaveBeenCalledTimes(1)
    })

    it('경계값 (0, 0) → px (0, 0)', async () => {
      helper.touchStart(0, 0); helper.touchEnd()
      await vi.waitFor(() => expect(adb.sendInput).toHaveBeenCalled(), { timeout: 500 })
      expect(adb.sendInput).toHaveBeenCalledWith('emulator-5554', 'tap', '0', '0')
    })

    it('경계값 (1, 1) → px (1080, 1920)', async () => {
      helper.touchStart(1, 1); helper.touchEnd()
      await vi.waitFor(() => expect(adb.sendInput).toHaveBeenCalled(), { timeout: 500 })
      expect(adb.sendInput).toHaveBeenCalledWith('emulator-5554', 'tap', '1080', '1920')
    })
  })

  describe('touchEnd 가드', () => {
    it('touchStart 없이 touchEnd 호출 시 아무것도 하지 않음', async () => {
      helper.touchEnd()
      await new Promise<void>((r) => setImmediate(r))
      expect(adb.sendInput).not.toHaveBeenCalled()
    })

    it('touchEnd 두 번 호출해도 sendInput은 1회', async () => {
      helper.touchStart(0.5, 0.5)
      helper.touchEnd()
      helper.touchEnd()
      await vi.waitFor(() => expect(adb.sendInput).toHaveBeenCalledTimes(1), { timeout: 500 })
    })
  })

  describe('pressButton', () => {
    it('home 버튼 → KEYCODE_HOME', () => {
      helper.pressButton('home')
      expect(adb.sendKeyEvent).toHaveBeenCalledWith('emulator-5554', 'KEYCODE_HOME')
    })

    it('back 버튼 → KEYCODE_BACK', () => {
      helper.pressButton('back')
      expect(adb.sendKeyEvent).toHaveBeenCalledWith('emulator-5554', 'KEYCODE_BACK')
    })

    it('recent_apps → KEYCODE_APP_SWITCH', () => {
      helper.pressButton('recent_apps')
      expect(adb.sendKeyEvent).toHaveBeenCalledWith('emulator-5554', 'KEYCODE_APP_SWITCH')
    })

    it('lock 별칭 → KEYCODE_POWER (크로스플랫폼 어휘)', () => {
      helper.pressButton('lock')
      expect(adb.sendKeyEvent).toHaveBeenCalledWith('emulator-5554', 'KEYCODE_POWER')
    })

    it('volume_up / volume_down → KEYCODE_VOLUME_*', () => {
      helper.pressButton('volume_up')
      helper.pressButton('volume_down')
      expect(adb.sendKeyEvent).toHaveBeenCalledWith('emulator-5554', 'KEYCODE_VOLUME_UP')
      expect(adb.sendKeyEvent).toHaveBeenCalledWith('emulator-5554', 'KEYCODE_VOLUME_DOWN')
    })

    it('알 수 없는 버튼은 sendKeyEvent 호출하지 않음', () => {
      helper.pressButton('unknown_button')
      expect(adb.sendKeyEvent).not.toHaveBeenCalled()
    })
  })
})
