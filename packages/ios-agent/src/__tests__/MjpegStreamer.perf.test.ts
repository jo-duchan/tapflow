import { describe, it, expect, vi, afterEach } from 'vitest'
import { MjpegStreamer } from '../MjpegStreamer'
import type { SimctlWrapper } from '../SimctlWrapper'

type Screenshottable = Pick<SimctlWrapper, 'screenshot'>

afterEach(() => vi.useRealTimers())

describe('MjpegStreamer — 성능', () => {
  it('30fps(33ms 간격) 10초 시뮬레이션: screenshot ≥ 300회 호출', async () => {
    vi.useFakeTimers()

    const INTERVAL_MS = 33   // ~30fps
    const DURATION_MS = 10_000
    // 첫 호출(즉시) + 10000/33 ≈ 303 interval 발생 → 최소 300회 이상
    const EXPECTED_MIN = 300

    const screenshot = vi.fn().mockResolvedValue(Buffer.alloc(1024, 0xff))
    const simctl: Screenshottable = { screenshot }
    const streamer = new MjpegStreamer(simctl, INTERVAL_MS)

    streamer.start()
    await vi.advanceTimersByTimeAsync(DURATION_MS)

    expect(screenshot.mock.calls.length).toBeGreaterThanOrEqual(EXPECTED_MIN)
  })

  it('프레임 캡처가 interval보다 느릴 때 겹치지 않음 (concurrency guard)', async () => {
    vi.useFakeTimers()

    // 캡처 1회에 500ms가 걸리는 상황
    const CAPTURE_DELAY = 500
    const INTERVAL_MS = 100
    const DURATION_MS = 2000

    let resolveCapture!: () => void
    const slowScreenshot = vi.fn(() =>
      new Promise<Buffer>((r) => { resolveCapture = () => r(Buffer.alloc(100)) })
    )
    const simctl: Screenshottable = { screenshot: slowScreenshot }
    const streamer = new MjpegStreamer(simctl, INTERVAL_MS)

    streamer.start()

    // 첫 캡처 시작 (capturing=true)
    await vi.advanceTimersByTimeAsync(0)
    expect(slowScreenshot).toHaveBeenCalledTimes(1)

    // interval이 여러 번 발생해도 capturing=true이므로 추가 호출 없음
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 4)
    expect(slowScreenshot).toHaveBeenCalledTimes(1)

    // 첫 캡처 완료 → 다음 interval에 두 번째 캡처 시작
    resolveCapture()
    await vi.advanceTimersByTimeAsync(CAPTURE_DELAY + INTERVAL_MS)

    // 총 호출 수는 2 이하 (무제한 병렬 호출이 발생하지 않았음)
    expect(slowScreenshot.mock.calls.length).toBeLessThanOrEqual(2)
  })

  it('10초 시뮬레이션에서 cancel 후 추가 호출 없음', async () => {
    vi.useFakeTimers()

    const INTERVAL_MS = 33
    const screenshot = vi.fn().mockResolvedValue(Buffer.alloc(100))
    const simctl: Screenshottable = { screenshot }
    const streamer = new MjpegStreamer(simctl, INTERVAL_MS)

    const stream = streamer.start()
    const reader = stream.getReader()

    await vi.advanceTimersByTimeAsync(330)  // ~10 프레임
    await reader.cancel()

    const callsAtCancel = screenshot.mock.calls.length
    await vi.advanceTimersByTimeAsync(10_000) // cancel 이후 10초
    expect(screenshot.mock.calls.length).toBe(callsAtCancel) // 추가 호출 없음
  })
})
