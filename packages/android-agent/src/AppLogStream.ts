import { spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import { getAdbPath } from './sdk.js'

export const APP_LOG_CHUNK_LIMIT = 8192
export const APP_LOG_SOCKET_BUFFER_LIMIT = 512 * 1024
export const APP_LOG_TARGET_CHECK_INTERVAL_MS = 1_000
export const APP_LOG_TARGET_FAILURE_LIMIT = 3

interface AppLogStreamOptions {
  spawnProcess?: typeof spawn
  isTargetAlive?: () => Promise<boolean>
  targetCheckIntervalMs?: number
  startTime?: string
}

export class AppLogStream {
  private readonly process: ChildProcess
  private readonly queue: string[] = []
  private drainTimer: NodeJS.Timeout | null = null
  private targetCheckTimer: NodeJS.Timeout | null = null
  private targetCheckInFlight = false
  private processClosed = false
  private stopped = false
  private stopRequested = false
  private targetCheckFailures = 0

  constructor(
    serial: string,
    uid: number,
    private readonly onText: (text: string) => boolean | void,
    onError: (error: Error) => void,
    options: AppLogStreamOptions = {}
  ) {
    this.process = (options.spawnProcess ?? spawn)(
      getAdbPath(),
      ['-s', serial, 'logcat', `--uid=${uid}`, ...(options.startTime ? ['-T', options.startTime] : []), '-v', 'raw'],
      { stdio: ['ignore', 'pipe', 'ignore'] }
    )
    this.process.stdout?.setEncoding('utf8')
    this.process.stdout?.on('data', (text: string) => {
      if (this.stopped || this.processClosed) return
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
        this.stopped = true
        this.stopRequested = false
        this.flush()
        onError(new Error(`Android app logcat exited with code ${code}`))
      } else if (!this.stopped) {
        this.stopRequested = true
        this.stopped = true
        this.flush() // Natural exit: drain all output received before close.
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

  stop(drain = false): void {
    if (this.stopped || (this.stopRequested && drain)) return
    this.clearTargetCheck()

    if (drain) {
      this.stopRequested = true
      if (!this.processClosed && this.process.exitCode === null && !this.process.killed) this.process.kill('SIGTERM')
      if (this.processClosed) {
        this.stopped = true
        this.flush()
      }
    } else {
      this.stopped = true
      if (!this.processClosed && this.process.exitCode === null && !this.process.killed) this.process.kill('SIGTERM')
      this.flush()
    }
  }

  private async checkTarget(isTargetAlive: () => Promise<boolean>, onError: (error: Error) => void): Promise<void> {
    if (this.stopped || this.processClosed || this.targetCheckInFlight) return
    this.targetCheckInFlight = true
    try {
      const alive = await isTargetAlive()
      if (alive) this.targetCheckFailures = 0
      else this.stop(true)
    } catch (error) {
      this.targetCheckFailures++
      if (this.targetCheckFailures >= APP_LOG_TARGET_FAILURE_LIMIT) {
        onError(error instanceof Error ? error : new Error(String(error)))
        this.stop(true)
      }
    } finally {
      this.targetCheckInFlight = false
    }
  }

  private clearTargetCheck(): void {
    if (this.targetCheckTimer) clearInterval(this.targetCheckTimer)
    this.targetCheckTimer = null
  }

  private flush(): void {
    if (this.stopped && !this.stopRequested) {
      if (this.drainTimer) clearInterval(this.drainTimer)
      this.drainTimer = null
      this.queue.length = 0
      return
    }
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
