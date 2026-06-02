import { describe, it, expect, vi, afterEach } from 'vitest'
import { MjpegStreamer } from '../MjpegStreamer'
import type { SimctlWrapper } from '../SimctlWrapper'

type Screenshottable = Pick<SimctlWrapper, 'screenshot'>

function mockSimctl(frame = Buffer.from('png')): Screenshottable {
  return { screenshot: vi.fn().mockResolvedValue(frame) }
}

describe('MjpegStreamer', () => {
  afterEach(() => vi.useRealTimers())

  it('emits the first frame immediately', async () => {
    const frame = Buffer.from('frame-data')
    const simctl = mockSimctl(frame)
    const streamer = new MjpegStreamer(simctl, 1000)

    const stream = streamer.start()
    const reader = stream.getReader()
    const { value } = await reader.read()

    expect(value).toEqual({ payload: frame, keyframe: false })
    await reader.cancel()
  })

  it('emits multiple frames at the given interval', async () => {
    vi.useFakeTimers()
    const simctl = mockSimctl()
    const streamer = new MjpegStreamer(simctl, 100)

    streamer.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(simctl.screenshot).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(200)
    expect(simctl.screenshot).toHaveBeenCalledTimes(3)
  })

  it('stops emitting after cancel', async () => {
    vi.useFakeTimers()
    const simctl = mockSimctl()
    const streamer = new MjpegStreamer(simctl, 100)

    const stream = streamer.start()
    const reader = stream.getReader()
    await reader.read()
    await reader.cancel()

    await vi.advanceTimersByTimeAsync(300)
    expect(simctl.screenshot).toHaveBeenCalledTimes(1)
  })

  it('skips a capture if the previous one is still in progress', async () => {
    vi.useFakeTimers()
    let resolve!: () => void
    const slowScreenshot = vi.fn(
      () => new Promise<Buffer>((r) => { resolve = () => r(Buffer.from('x')) })
    )
    const streamer = new MjpegStreamer({ screenshot: slowScreenshot }, 100)

    // capture() is called synchronously — capturing = true before first await
    streamer.start()

    // interval fires while first capture is still pending
    await vi.advanceTimersByTimeAsync(100)
    expect(slowScreenshot).toHaveBeenCalledTimes(1)

    resolve()
  })
})
