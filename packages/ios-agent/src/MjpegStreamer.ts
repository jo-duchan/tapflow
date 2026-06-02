import type { SimctlWrapper } from './SimctlWrapper.js'
import type { StreamFrame } from './ScreenCaptureStreamer.js'

type Screenshottable = Pick<SimctlWrapper, 'screenshot'>

export class MjpegStreamer {
  constructor(
    private readonly simctl: Screenshottable,
    private readonly intervalMs: number = 100,
  ) {}

  start(): ReadableStream<StreamFrame> {
    let timer: ReturnType<typeof setInterval> | null = null
    let capturing = false

    return new ReadableStream<StreamFrame>({
      start: (controller) => {
        const capture = async () => {
          if (capturing) return
          capturing = true
          try {
            const frame = await this.simctl.screenshot()
            controller.enqueue({ payload: frame, keyframe: false })
          } catch (err) {
            controller.error(err)
          } finally {
            capturing = false
          }
        }

        void capture()
        timer = setInterval(capture, this.intervalMs)
      },
      cancel: () => {
        if (timer !== null) {
          clearInterval(timer)
          timer = null
        }
      },
    })
  }
}
