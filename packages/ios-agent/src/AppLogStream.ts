import { spawn } from 'child_process'
import type { ChildProcess } from 'child_process'

export const APP_LOG_CHUNK_LIMIT = 8192
export const APP_LOG_SOCKET_BUFFER_LIMIT = 512 * 1024

export class AppLogStream {
  private readonly process: ChildProcess
  private readonly queue: string[] = []
  private drainTimer: NodeJS.Timeout | null = null

  constructor(
    udid: string,
    pid: number,
    private readonly onText: (text: string) => boolean | void,
    onError: (error: Error) => void,
    spawnProcess: typeof spawn = spawn
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
        `processIdentifier == ${pid}`,
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] }
    )
    this.process.stdout?.setEncoding('utf8')
    this.process.stdout?.on('data', (text: string) => {
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
    this.process.once('error', onError)
  }

  stop(): void {
    if (this.drainTimer) clearInterval(this.drainTimer)
    this.drainTimer = null
    this.queue.length = 0
    if (this.process.exitCode === null && !this.process.killed) this.process.kill('SIGTERM')
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
