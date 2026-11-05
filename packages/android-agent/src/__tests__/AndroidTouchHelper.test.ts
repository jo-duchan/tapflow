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
      void helper.touchEnd()
      await vi.waitFor(() => expect(adb.sendInput).toHaveBeenCalled(), { timeout: 500 })
      expect(adb.sendInput).toHaveBeenCalledWith(
        'emulator-5554', 'tap', '540', '960'
      )
    })

    it('move 없이 touchEnd하면 tap', async () => {
      helper.touchStart(0.1, 0.2)
      void helper.touchEnd()
      await vi.waitFor(() => expect(adb.sendInput).toHaveBeenCalled(), { timeout: 500 })
      const [, action] = vi.mocked(adb.sendInput).mock.calls[0]
      expect(action).toBe('tap')
    })

    // `adb input tap` has no duration, so a held touch dispatched as one became a tap answered `delivered` — a
    // flow's long press landing as a tap with nothing reporting it. A swipe that stays put is adb's long press.
    it('replays a held touch that did not move as a same-point swipe lasting as long as it was held', async () => {
      vi.useFakeTimers()
      try {
        helper.touchStart(0.5, 0.5)
        vi.advanceTimersByTime(1000)
        const outcome = helper.touchEnd()
        await vi.runAllTimersAsync()
        expect(await outcome).toBe('delivered')
        expect(adb.sendInput).toHaveBeenCalledWith('emulator-5554', 'swipe', '540', '960', '540', '960', '1000')
      } finally {
        vi.useRealTimers()
      }
    })

    it('keeps a quick touch a tap', async () => {
      vi.useFakeTimers()
      try {
        helper.touchStart(0.5, 0.5)
        vi.advanceTimersByTime(120)
        const outcome = helper.touchEnd()
        await vi.runAllTimersAsync()
        expect(await outcome).toBe('delivered')
        expect(adb.sendInput).toHaveBeenCalledWith('emulator-5554', 'tap', '540', '960')
      } finally {
        vi.useRealTimers()
      }
    })

    it('충분히 이동하면 swipe 호출', async () => {
      helper.touchStart(0.1, 0.5)
      helper.touchMove(0.9, 0.5)
      void helper.touchEnd()
      await vi.waitFor(() => expect(adb.sendInput).toHaveBeenCalled(), { timeout: 500 })
      expect(adb.sendInput).toHaveBeenCalledWith(
        'emulator-5554', 'swipe', '108', '960', '972', '960', '300'
      )
    })

    it('swipe 시 start·end 좌표가 모두 포함됨', async () => {
      helper.touchStart(0.0, 0.0)
      helper.touchMove(1.0, 1.0)
      void helper.touchEnd()
      await vi.waitFor(() => expect(adb.sendInput).toHaveBeenCalled(), { timeout: 500 })
      expect(adb.sendInput).toHaveBeenCalledWith(
        'emulator-5554', 'swipe', '0', '0', '1080', '1920', '300'
      )
    })
  })

  describe('좌표 정규화 (0~1 → px)', () => {
    it('정규화 좌표를 화면 해상도 기준 px로 변환', async () => {
      helper.touchStart(0.25, 0.75)
      void helper.touchEnd()
      await vi.waitFor(() => expect(adb.sendInput).toHaveBeenCalled(), { timeout: 500 })
      expect(adb.sendInput).toHaveBeenCalledWith(
        'emulator-5554', 'tap', '270', '1440'
      )
    })

    it('getScreenSize는 최초 1회만 호출 (캐시)', async () => {
      helper.touchStart(0.5, 0.5); void helper.touchEnd()
      await vi.waitFor(() => expect(adb.sendInput).toHaveBeenCalledTimes(1), { timeout: 500 })

      vi.mocked(adb.sendInput).mockClear()

      helper.touchStart(0.3, 0.3); void helper.touchEnd()
      await vi.waitFor(() => expect(adb.sendInput).toHaveBeenCalledTimes(1), { timeout: 500 })
      expect(adb.getScreenSize).toHaveBeenCalledTimes(1)
    })

    it('경계값 (0, 0) → px (0, 0)', async () => {
      helper.touchStart(0, 0); void helper.touchEnd()
      await vi.waitFor(() => expect(adb.sendInput).toHaveBeenCalled(), { timeout: 500 })
      expect(adb.sendInput).toHaveBeenCalledWith('emulator-5554', 'tap', '0', '0')
    })

    it('경계값 (1, 1) → px (1080, 1920)', async () => {
      helper.touchStart(1, 1); void helper.touchEnd()
      await vi.waitFor(() => expect(adb.sendInput).toHaveBeenCalled(), { timeout: 500 })
      expect(adb.sendInput).toHaveBeenCalledWith('emulator-5554', 'tap', '1080', '1920')
    })
  })

  describe('touchEnd 가드', () => {
    it('touchStart 없이 touchEnd 호출 시 아무것도 하지 않음', async () => {
      void helper.touchEnd()
      await new Promise<void>((r) => setImmediate(r))
      expect(adb.sendInput).not.toHaveBeenCalled()
    })

    it('touchEnd 두 번 호출해도 sendInput은 1회', async () => {
      helper.touchStart(0.5, 0.5)
      void helper.touchEnd()
      void helper.touchEnd()
      await vi.waitFor(() => expect(adb.sendInput).toHaveBeenCalledTimes(1), { timeout: 500 })
    })
  })

  describe('pressButton', () => {
    it('home 버튼 → KEYCODE_HOME', () => {
      void helper.pressButton('home')
      expect(adb.sendKeyEvent).toHaveBeenCalledWith('emulator-5554', 'KEYCODE_HOME')
    })

    it('back 버튼 → KEYCODE_BACK', () => {
      void helper.pressButton('back')
      expect(adb.sendKeyEvent).toHaveBeenCalledWith('emulator-5554', 'KEYCODE_BACK')
    })

    it('recent_apps → KEYCODE_APP_SWITCH', () => {
      void helper.pressButton('recent_apps')
      expect(adb.sendKeyEvent).toHaveBeenCalledWith('emulator-5554', 'KEYCODE_APP_SWITCH')
    })

    it('lock 별칭 → KEYCODE_POWER (크로스플랫폼 어휘)', () => {
      void helper.pressButton('lock')
      expect(adb.sendKeyEvent).toHaveBeenCalledWith('emulator-5554', 'KEYCODE_POWER')
    })

    it('volume_up / volume_down → KEYCODE_VOLUME_*', () => {
      void helper.pressButton('volume_up')
      void helper.pressButton('volume_down')
      expect(adb.sendKeyEvent).toHaveBeenCalledWith('emulator-5554', 'KEYCODE_VOLUME_UP')
      expect(adb.sendKeyEvent).toHaveBeenCalledWith('emulator-5554', 'KEYCODE_VOLUME_DOWN')
    })

    it('알 수 없는 버튼은 sendKeyEvent 호출하지 않고 unsupported로 답한다', async () => {
      // Not "the device has no such button" — the map is ours. iOS answers success for its own
      // unmapped case because there the button genuinely does not exist on the device.
      await expect(helper.pressButton('unknown_button')).resolves.toBe('unsupported')
      expect(adb.sendKeyEvent).not.toHaveBeenCalled()
    })
  })
})

// Every terminal method used to swallow its adb promise, so a failed dispatch was indistinguishable
// from a delivered one — and `touchEnd`'s command only fires here, after `touchStart`/`touchMove`
// have merely accumulated coordinates.
describe('AndroidTouchHelper — outcomes', () => {
  let adb: AdbWrapper
  let helper: AndroidTouchHelper

  beforeEach(() => {
    adb = makeMockAdb()
    helper = new AndroidTouchHelper(adb, 'emulator-5554')
  })

  it('reports delivered once the adb command resolves, and fires it before resolving', async () => {
    helper.touchStart(0.5, 0.5)
    const result = helper.touchEnd()
    expect(adb.sendInput).not.toHaveBeenCalled() // still awaiting the screen size

    await expect(result).resolves.toBe('delivered')
    expect(adb.sendInput).toHaveBeenCalledWith('emulator-5554', 'tap', '540', '960')
  })

  it('reports failed when the adb command rejects', async () => {
    ;(adb.sendInput as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('device offline'))
    helper.touchStart(0.5, 0.5)

    await expect(helper.touchEnd()).resolves.toBe('failed')
  })

  it('reports failed when the screen-size lookup rejects', async () => {
    // The first tap of a session pays this round trip, so it is a real failure point.
    ;(adb.getScreenSize as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('no wm'))
    helper.touchStart(0.5, 0.5)

    await expect(helper.touchEnd()).resolves.toBe('failed')
  })

  // Not channel-down: the adb path is fine, there was simply nothing to finish. The viewer sends
  // touch:end on pointerup and pointercancel without checking that a pointerdown reached the video,
  // so this arrives in normal use and must not read as a dead channel.
  it('reports no-gesture for a terminal frame with no gesture open on this path', async () => {
    await expect(helper.touchEnd()).resolves.toBe('no-gesture')
    expect(adb.sendInput).not.toHaveBeenCalled()
  })

  it('looks the screen size up once for a burst of terminal frames', async () => {
    // Caching on the resolved value instead of the promise lets each frame in a burst spawn its own
    // `wm size` child — the extra process the "one child per input" ceiling does not account for.
    const ends = [0, 1, 2].map((i) => { helper.touchStart(0.5, 0.5 + i * 0.001); return helper.touchEnd() })
    await Promise.all(ends)

    expect(adb.getScreenSize).toHaveBeenCalledTimes(1)
  })

  it('dispatches the coordinates of the gesture it is answering for', async () => {
    // A gesture opened while the size lookup is in flight used to overwrite the fields, so the
    // pending dispatch landed at the new position and still answered for the old one.
    let release: (v: { width: number; height: number }) => void = () => {}
    ;(adb.getScreenSize as ReturnType<typeof vi.fn>).mockReturnValue(new Promise((r) => { release = r }))

    helper.touchStart(0.25, 0.25)
    const first = helper.touchEnd()
    helper.touchStart(0.75, 0.75) // a second gesture opens mid-lookup
    release({ width: 1000, height: 1000 })

    await expect(first).resolves.toBe('delivered')
    expect(adb.sendInput).toHaveBeenCalledWith('emulator-5554', 'tap', '250', '250')
  })

  // The name arrives off the wire. Indexing the map by truthiness lets a prototype member resolve to
  // a function, which then gets dispatched as a keycode and answers `failed` — a wrong reason, and a
  // wasted adb call, for something we simply do not support.
  it('reports unsupported for a name that is only a prototype member', async () => {
    for (const name of ['constructor', 'toString', 'hasOwnProperty']) {
      await expect(helper.pressButton(name), name).resolves.toBe('unsupported')
    }
    expect(adb.sendKeyEvent).not.toHaveBeenCalled()
  })

  it('reports delivered for a mapped button, failed when adb rejects', async () => {
    await expect(helper.pressButton('back')).resolves.toBe('delivered')
    ;(adb.sendKeyEvent as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('offline'))
    await expect(helper.pressButton('back')).resolves.toBe('failed')
  })

  // The worst of the old lies: three empty methods that accepted every pinch frame and answered
  // success while nothing whatsoever reached the device.
  it('reports unsupported for every pinch frame, since this path has no pinch', () => {
    expect(helper.pinchStart(0.1, 0.1, 0.9, 0.9)).toBe('unsupported')
    expect(helper.pinchMove(0.2, 0.2, 0.8, 0.8)).toBe('unsupported')
    expect(helper.pinchEnd()).toBe('unsupported')
    expect(adb.sendInput).not.toHaveBeenCalled()
  })

  // #487: `touching` was cleared only by `touchEnd`, so a helper abandoned mid-gesture answered the
  // next end it received with a tap at the abandoned gesture's position.
  it('forgets an open gesture when stopped', async () => {
    helper.touchStart(0.3, 0.7)
    helper.stop()
    expect(await helper.touchEnd()).toBe('no-gesture')
    expect(adb.sendInput).not.toHaveBeenCalled()
  })
})
