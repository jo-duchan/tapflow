import type { SimctlWrapper } from './SimctlWrapper'

type Screenshottable = Pick<SimctlWrapper, 'screenshot'>

export class MjpegStreamer {
  constructor(
    private readonly simctl: Screenshottable,
    private readonly intervalMs: number = 100,
  ) {}

  start(): ReadableStream<Buffer> {
    let timer: ReturnType<typeof setInterval> | null = null
    let capturing = false

    return new ReadableStream<Buffer>({
      start: (controller) => {
        const capture = async () => {
          if (capturing) return
          capturing = true
          try {
            const frame = await this.simctl.screenshot()
            controller.enqueue(frame)
          } catch (err) {
            controller.error(err)
          } finally {
            capturing = false
          }
        }

        capture()
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
