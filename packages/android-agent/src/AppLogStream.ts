import { spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import { getAdbPath } from './sdk.js'

export const APP_LOG_CHUNK_LIMIT = 8192
export const APP_LOG_SOCKET_BUFFER_LIMIT = 512 * 1024
export const APP_LOG_TARGET_CHECK_INTERVAL_MS = 1_000

interface AppLogStreamOptions {
  spawnProcess?: typeof spawn
  isTargetAlive?: () => Promise<boolean>
  targetCheckIntervalMs?: number
}

export class AppLogStream {
  private readonly process: ChildProcess
  private readonly queue: string[] = []
  private drainTimer: NodeJS.Timeout | null = null
  private targetCheckTimer: NodeJS.Timeout | null = null
  private targetCheckInFlight = false
  private processClosed = false
  private stopped = false

  constructor(
    serial: string,
    uid: number,
    private readonly onText: (text: string) => boolean | void,
    onError: (error: Error) => void,
    options: AppLogStreamOptions = {}
  ) {
    this.process = (options.spawnProcess ?? spawn)(
      getAdbPath(),
      ['-s', serial, 'logcat', `--uid=${uid}`, '-v', 'raw'],
      { stdio: ['ignore', 'pipe', 'ignore'] }
    )
    this.process.stdout?.setEncoding('utf8')
    this.process.stdout?.on('data', (text: string) => {
      if (this.stopped) return
      let chunk = ''
      let bytes = 0
      for (const character of text) {
        const characterBytes = Buffer.byteLength(character, 'utf8')
        if (bytes + characterBytes > APP_LOG_CHUNK_LIMIT) {
          this.queue.push(chunk)
          chunk = ''
          bytes = 0
        }
        chunk += character
        bytes += characterBytes
      }
      if (chunk) this.queue.push(chunk)
      this.flush()
    })
    this.process.once('error', (error: Error) => {
      onError(error)
      this.stop()
    })
    this.process.once('close', (code) => {
      this.processClosed = true
      this.clearTargetCheck()
      if (code !== null && code !== 0 && !this.stopped) {
        this.stop()
        onError(new Error(`Android app logcat exited with code ${code}`))
      }
    })

    const isTargetAlive = options.isTargetAlive
    if (isTargetAlive) {
      this.targetCheckTimer = setInterval(() => {
        void this.checkTarget(isTargetAlive, onError)
      }, options.targetCheckIntervalMs ?? APP_LOG_TARGET_CHECK_INTERVAL_MS)
      this.targetCheckTimer.unref()
    }
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    if (this.drainTimer) clearInterval(this.drainTimer)
    this.drainTimer = null
    this.clearTargetCheck()
    this.queue.length = 0
    if (!this.processClosed && this.process.exitCode === null && !this.process.killed) {
      this.process.kill('SIGTERM')
    }
  }

  private async checkTarget(isTargetAlive: () => Promise<boolean>, onError: (error: Error) => void): Promise<void> {
    if (this.stopped || this.processClosed || this.targetCheckInFlight) return
    this.targetCheckInFlight = true
    try {
      if (!(await isTargetAlive())) this.stop()
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)))
      this.stop()
    } finally {
      this.targetCheckInFlight = false
    }
  }

  private clearTargetCheck(): void {
    if (this.targetCheckTimer) clearInterval(this.targetCheckTimer)
    this.targetCheckTimer = null
  }

  private flush(): void {
    while (this.queue.length > 0) {
      if (this.onText(this.queue[0]!) === false) {
        // Keep the child pipe paused until the WebSocket accepts more data.
        this.process.stdout?.pause()
        if (!this.drainTimer) {
          this.drainTimer = setInterval(() => this.flush(), 20)
          this.drainTimer.unref()
        }
        return
      }
      this.queue.shift()
    }
    if (this.drainTimer) clearInterval(this.drainTimer)
    this.drainTimer = null
    this.process.stdout?.resume()
  }
}
