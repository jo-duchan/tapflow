import { spawn } from 'child_process'
import type { ChildProcess } from 'child_process'

export const APP_LOG_CHUNK_LIMIT = 8192
export const APP_LOG_SOCKET_BUFFER_LIMIT = 512 * 1024
export const APP_LOG_PID_POLL_INTERVAL_MS = 250
const APP_LOG_ERROR_TEXT_LIMIT = 2048

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
  private targetExited = false
  private errorReported = false
  private stderrText = ''

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
        '--level',
        'debug',
        '--style',
        'compact',
        '--predicate',
        `processIdentifier == ${pid} AND processImagePath == ${predicateString(processImagePath)}`,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )
    this.process.stdout?.setEncoding('utf8')
    this.process.stderr?.setEncoding('utf8')
    this.process.stderr?.on('data', (text: string) => {
      if (this.stderrText.length < APP_LOG_ERROR_TEXT_LIMIT) {
        this.stderrText += text.slice(0, APP_LOG_ERROR_TEXT_LIMIT - this.stderrText.length)
      }
    })
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
      this.errorReported = true
      this.stop()
      onError(error)
    })
    this.process.once('close', (code) => {
      this.childClosed = true
      this.stopPidCheck()
      if (code !== null && code !== 0 && !this.stopped && !this.targetExited && !this.errorReported) {
        this.errorReported = true
        const detail = this.stderrText.trim()
        onError(new Error(`iOS app log stream exited with code ${code}${detail ? `: ${detail}` : ''}`))
      }
      this.flush()
    })
    this.pidCheckTimer = setInterval(() => {
      if (!this.targetIsAlive(pid)) this.finishForTargetExit()
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

  private finishForTargetExit(): void {
    if (this.stopped || this.targetExited) return
    this.targetExited = true
    this.stopPidCheck()
    if (!this.childClosed && this.process.pid !== undefined && this.process.exitCode === null && !this.process.killed) {
      this.process.kill('SIGTERM')
    }
    this.flush()
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
    // A target exit asks the log child to stop, but its pipe can still contain final lines. Keep
    // accepting stdout until the child closes; explicit stop is the only path that drops the queue.
    if (this.childClosed) this.stopped = true
    this.process.stdout?.resume()
  }
}
