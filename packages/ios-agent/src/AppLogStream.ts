import { spawn } from 'child_process'
import type { ChildProcess } from 'child_process'

export const APP_LOG_CHUNK_LIMIT = 8192
export const APP_LOG_SOCKET_BUFFER_LIMIT = 512 * 1024
export const APP_LOG_PID_POLL_INTERVAL_MS = 250

function predicateString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export class AppLogStream {
  private readonly process: ChildProcess
  private readonly queue: string[] = []
  private drainTimer: NodeJS.Timeout | null = null
  private pidCheckTimer: NodeJS.Timeout | null = null
  private stopped = false
  private childClosed = false

  constructor(
    udid: string,
    pid: number,
    processImagePath: string,
    private readonly onText: (text: string) => boolean | void,
    onError: (error: Error) => void,
    spawnProcess: typeof spawn = spawn,
    private readonly targetIsAlive: (pid: number) => boolean = isProcessAlive
  ) {
    this.process = spawnProcess(
      'xcrun',
      [
        'simctl',
        'spawn',
        udid,
        'log',
        'stream',
        '--style',
        'compact',
        '--predicate',
        `processIdentifier == ${pid} AND processImagePath == ${predicateString(processImagePath)}`,
      ],
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
    this.process.once('error', (error) => {
      this.stop()
      onError(error)
    })
    this.process.once('close', () => {
      this.childClosed = true
      this.stopPidCheck()
      this.flush()
    })
    this.pidCheckTimer = setInterval(() => {
      if (!this.targetIsAlive(pid)) this.stop()
    }, APP_LOG_PID_POLL_INTERVAL_MS)
    this.pidCheckTimer.unref()
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.stopPidCheck()
    if (this.drainTimer) clearInterval(this.drainTimer)
    this.drainTimer = null
    this.queue.length = 0
    if (!this.childClosed && this.process.pid !== undefined && this.process.exitCode === null && !this.process.killed) {
      this.process.kill('SIGTERM')
    }
  }

  private stopPidCheck(): void {
    if (this.pidCheckTimer) clearInterval(this.pidCheckTimer)
    this.pidCheckTimer = null
  }

  private flush(): void {
    if (this.stopped) return
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
