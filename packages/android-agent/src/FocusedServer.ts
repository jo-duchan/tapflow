import { randomBytes } from 'crypto'
import type { ChildProcessWithoutNullStreams } from 'child_process'
import { createLogger } from '@tapflowio/agent-core'

const logger = createLogger('android-agent:focused-server')

/** A request to the jar's `Focused`: read the field, set its text, or press its IME action. */
export type FocusedOp = 'read' | 'set' | 'ime' | 'reach'

/**
 * What became of a request. `not-sent`: nothing reached the device, so the one-shot `Focused` may do it instead.
 * `sent`: it was written; `out` is the answer, or `null` when none came — the device may have done it, so a set or an
 * IME action must not be done again (a set inserts at the caret: twice is the text twice).
 */
export type FocusedOutcome = { sent: false } | { sent: true; out: string | null }

export interface FocusedServerOptions {
  /** Start the server: the adb arguments go to a child whose stdin and stdout are the server's. */
  spawn: (...args: string[]) => ChildProcessWithoutNullStreams
  /** Kill the server on the device by its nonce, for one the child's death did not take with it. */
  kill: (serial: string, pattern: string) => Promise<void>
  answerTimeoutMs?: number
  readyTimeoutMs?: number
  /** After a start that failed, how long requests go to the one-shot run before the server is tried again. */
  retryAfterMs?: number
  idleStopMs?: number
  now?: () => number
}

interface Server {
  child: ChildProcessWithoutNullStreams
  nonce: string
  ready: Promise<boolean>
  pending: Map<string, (out: string | null) => void>
  exited: Promise<void>
  /** Ended on purpose (`stop`): a request waiting for it is not a start that failed. */
  stopping: boolean
  idle: ReturnType<typeof setTimeout> | undefined
}

/** Answers come within ~50 ms (measured p95 45 ms); a set waits 150 ms for the field to take the text. */
const ANSWER_TIMEOUT_MS = 2_000
/** app_process starts in ~1 s (measured), the first connect after it a little more. */
const READY_TIMEOUT_MS = 5_000
const RETRY_AFTER_MS = 30_000
/** Before the server's own minute idle exit: ended from here, a request is never written to one choosing to exit. */
const IDLE_STOP_MS = 50_000

/**
 * The jar's `FocusedServer`, one per device, started on the first request and kept (#1135): a field read through it
 * costs its own ~30 ms rather than starting app_process (~1 s), which made a read asked 600 ms after the last key land
 * after the person's next input, and the value was lost. Over the adb shell's pipes, not a socket: nothing else on the
 * device or the Mac can reach it, and it ends when this agent's pipe closes.
 *
 * Callers serialise requests per device (the dump queue): a device takes one UiAutomation connection at a time, and the
 * server's is per request, so a tree dump between two requests connects as it does today.
 */
export class FocusedServers {
  private readonly servers = new Map<string, Server>()
  private readonly failedUntil = new Map<string, number>()
  private nextId = 0
  private readonly answerTimeoutMs: number
  private readonly readyTimeoutMs: number
  private readonly retryAfterMs: number
  private readonly idleStopMs: number
  private readonly now: () => number

  constructor(private readonly opts: FocusedServerOptions) {
    this.answerTimeoutMs = opts.answerTimeoutMs ?? ANSWER_TIMEOUT_MS
    this.readyTimeoutMs = opts.readyTimeoutMs ?? READY_TIMEOUT_MS
    this.retryAfterMs = opts.retryAfterMs ?? RETRY_AFTER_MS
    this.idleStopMs = opts.idleStopMs ?? IDLE_STOP_MS
    this.now = opts.now ?? Date.now
  }

  /**
   * `startFailed` says the server could not be started on this device: the jar on it may be gone (a wiped emulator on
   * the same serial), so the caller pushes it again.
   */
  async request(serial: string, jar: string, op: FocusedOp, text?: string): Promise<FocusedOutcome & { startFailed?: true }> {
    if ((this.failedUntil.get(serial) ?? 0) > this.now()) return { sent: false }
    const server = this.servers.get(serial) ?? this.start(serial, jar)
    if (server.idle) clearTimeout(server.idle)
    if (!(await server.ready)) {
      if (server.stopping) return { sent: false }
      this.failedUntil.set(serial, this.now() + this.retryAfterMs)
      await this.stop(serial)
      return { sent: false, startFailed: true }
    }
    const id = String(++this.nextId)
    const answer = new Promise<string | null>((resolve) => server.pending.set(id, resolve))
    const body = text === undefined ? '' : ` ${Buffer.from(text, 'utf8').toString('base64')}`
    if (!server.child.stdin.write(`${id} ${op}${body}\n`) && server.child.stdin.destroyed) {
      server.pending.delete(id)
      return { sent: false }
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const out = await Promise.race([answer, new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), this.answerTimeoutMs) })])
    clearTimeout(timer)
    server.pending.delete(id)
    // No answer: the server may be stuck inside a connection, which would refuse the next dump's. It goes before the
    // queue moves on, and the next request starts another.
    if (out === null) {
      logger.warn(`${serial}: no answer from the field server in ${this.answerTimeoutMs} ms; restarting it`)
      await this.stop(serial)
    } else if (this.servers.get(serial) === server) {
      server.idle = setTimeout(() => { void this.stop(serial) }, this.idleStopMs)
      server.idle.unref?.()
    }
    return { sent: true, out }
  }

  /** End the device's server and wait for it, bounded: a device gone, an agent going away, a server that hung. */
  async stop(serial: string): Promise<void> {
    const server = this.servers.get(serial)
    if (!server) return
    this.servers.delete(serial)
    server.stopping = true
    if (server.idle) clearTimeout(server.idle)
    server.child.stdin.end()
    server.child.kill()
    await Promise.race([
      Promise.all([server.exited, this.opts.kill(serial, `FocusedServer ${server.nonce}`).catch(() => {})]),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ])
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.servers.keys()].map((serial) => this.stop(serial)))
  }

  private start(serial: string, jar: string): Server {
    const nonce = randomBytes(6).toString('hex')
    const child = this.opts.spawn(
      '-s', serial, 'shell', `CLASSPATH=${jar}:/system/framework/uiautomator.jar`,
      'app_process', '/system/bin', 'dev.tapflow.uidump.FocusedServer', nonce,
    )
    const pending = new Map<string, (out: string | null) => void>()
    let markReady: (ready: boolean) => void = () => {}
    const ready = new Promise<boolean>((resolve) => { markReady = resolve })
    const readyTimer = setTimeout(() => markReady(false), this.readyTimeoutMs)
    const exited = new Promise<void>((resolve) => {
      let gone = false
      // `error` without `exit` is a child that never started (no adb); either way it is gone once.
      const onGone = () => {
        if (gone) return
        gone = true
        clearTimeout(readyTimer)
        markReady(false)
        for (const resolveOne of pending.values()) resolveOne(null)
        pending.clear()
        if (this.servers.get(serial)?.child === child) this.servers.delete(serial)
        resolve()
      }
      child.once('exit', onGone)
      child.once('error', onGone)
    })
    child.stdin.on('error', () => {})
    // Drained though unused: adb carries stdout and stderr on one stream, and an unread stderr that filled would stall
    // the answers behind it.
    child.stderr.resume()
    let buffer = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk
      for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (line === 'READY') { clearTimeout(readyTimer); markReady(true); continue }
        const space = line.indexOf(' ')
        const resolveOne = space > 0 ? pending.get(line.slice(0, space)) : undefined
        // Never logged: an answer can hold what a person typed.
        resolveOne?.(line.slice(space + 1))
      }
    })
    const server: Server = { child, nonce, ready, pending, exited, stopping: false, idle: undefined }
    this.servers.set(serial, server)
    return server
  }
}
