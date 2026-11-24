import { execFile, spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

export const APP_LOG_CHUNK_LIMIT = 8192
export const APP_LOG_SOCKET_BUFFER_LIMIT = 512 * 1024
export const APP_LOG_PID_POLL_INTERVAL_MS = 250
const APP_LOG_ERROR_TEXT_LIMIT = 2048

function predicateString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * `log stream`'s own header, which is not the app's output. Measured on iOS 26.5: "Filtering the log data using …" comes
 * at once, and the column title only just before the first entry. Looked for until the first other line, never after.
 */
const HEADER_LINE = /^(?:Filtering the log data using |Timestamp\s+Ty\s+Process\[PID:TID\]\s*$)/

const HEADER_STARTS = ['Filtering the log data using ', 'Timestamp ']

/** How `log stream` shows in the simulator when tapflow spawned it, for one launch (this file) or for a watch
 *  (`AppLogWatch.ts`): what tells ours from a person's own. */
const OUR_LOG_STREAM = /^(?:.*\/)?log stream --level debug --style compact --predicate (?:processIdentifier == \d+ AND processImagePath == |processImagePath ENDSWITH "[^"]*\.app\/[^"/]+"$)/

/**
 * The app log streams left running in simulator `udid`, from `ps -o pid=,ppid=,command=` output (#1235). A SIGKILLed
 * `simctl spawn`, or an agent killed while its stream is quiet, leaves `log stream` running in the simulator until it
 * shuts down (measured on iOS 18.5 and 26.5); it is a child of that device's `launchd_sim`, whose argument names the
 * device's directory. A SIGTERM to it ends a surviving `simctl spawn` too (measured).
 */
export function orphanAppLogStreams(ps: string, udid: string): number[] {
  const rows: Array<{ pid: number; ppid: number; command: string }> = []
  for (const line of ps.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3]! })
  }
  const device = `/Devices/${udid}/`
  const launchd = new Set(rows.filter((r) => /^(?:\S*\/)?launchd_sim /.test(r.command) && r.command.includes(device)).map((r) => r.pid))
  return rows.filter((r) => launchd.has(r.ppid) && OUR_LOG_STREAM.test(r.command)).map((r) => r.pid)
}

export interface AppLogStreamDeps {
  spawn: typeof spawn
  findOrphans(udid: string): Promise<number[]>
  killPid(pid: number): void
}

export const defaultAppLogStreamDeps: AppLogStreamDeps = {
  spawn,
  async findOrphans(udid) {
    try {
      const { stdout } = await execFileAsync('/bin/ps', ['-axww', '-o', 'pid=,ppid=,command='], { timeout: 5_000, maxBuffer: 16 * 1024 * 1024 })
      return orphanAppLogStreams(stdout, udid)
    } catch {
      return []
    }
  },
  killPid(pid) {
    try { process.kill(pid, 'SIGTERM') } catch { /* already gone */ }
  },
}

/** Under vitest an agent streams nothing: a suite must never spawn into a real simulator. */
export const inertAppLogStreamDeps: AppLogStreamDeps = {
  spawn: (() => { throw new Error('no app log stream under test') }) as unknown as typeof spawn,
  findOrphans: async () => [],
  killPid: () => {},
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
  /** Text held while `log stream`'s header may still be coming; null once the first other line has passed. */
  private headerPending: string | null = ''

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
      this.enqueue(this.skipHeader(text))
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
      // What is still held can only be the start of the header (an entry starts with its date), so it is dropped.
      this.headerPending = null
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

  private skipHeader(text: string): string {
    if (this.headerPending === null) return text
    let pending = this.headerPending + text
    for (;;) {
      const end = pending.indexOf('\n')
      if (end === -1) {
        if (pending.length > APP_LOG_CHUNK_LIMIT || !HEADER_STARTS.some((h) => h.startsWith(pending) || pending.startsWith(h))) break
        this.headerPending = pending
        return ''
      }
      if (!HEADER_LINE.test(pending.slice(0, end))) break
      pending = pending.slice(end + 1)
    }
    this.headerPending = null
    return pending
  }

  private enqueue(text: string): void {
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
