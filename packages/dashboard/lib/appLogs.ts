import type { BrowserToRelay } from '@tapflowio/protocol'

/** Lines the viewer holds, about: it trims once `APP_LOG_TRIM_STEP` past this. Only the rows in view are drawn. */
export const APP_LOG_MAX_LINES = 50_000
/** Lines dropped at a time once over the cap, so the front of the array is cut once per this many lines. */
export const APP_LOG_TRIM_STEP = 1_000
/**
 * Characters the held lines may add up to, about 32 MB as UTF-16. The line cap alone does not bound memory: a logcat
 * entry runs to about 4,000 characters (a response body logged whole), and 50,000 of those would be 400 MB. Typical
 * output (lines of 80–250 characters) reaches the line cap first: 50,000 of them measured 32–37 MB of heap in all.
 */
export const APP_LOG_MAX_CHARS = 16_000_000
/** Text the feed holds waiting for a frame before it applies it anyway (a hidden tab runs none). */
export const APP_LOG_PENDING_CHARS = 1_000_000

/**
 * The launched app's output as lines (#1233). Appended to in place and never copied, since the viewer holds it in a ref
 * and redraws only the rows in view. A chunk can end mid-line (or mid surrogate pair): that tail is `partial`, shown
 * as the last row and finished by the next chunk.
 */
export class AppLogBuffer {
  readonly lines: string[] = []
  partial = ''
  /** Lines dropped from the front since the launch. */
  dropped = 0
  /** Which lines are run separators ("App started (pid 4521)"), by line number since the start (`dropped + index`). */
  private readonly marks = new Set<number>()
  /**
   * Characters in `lines`. The unfinished line is not counted and not capped: the agents send whole entries (iOS
   * `log stream`, Android logcat, each ending in a newline), so it lasts until the next chunk.
   */
  private chars = 0

  constructor(
    private readonly maxLines = APP_LOG_MAX_LINES,
    private readonly trimStep = APP_LOG_TRIM_STEP,
    private readonly maxChars = APP_LOG_MAX_CHARS,
  ) {}

  /** Returns how many lines this append dropped from the front. */
  append(text: string): number {
    const pieces = (this.partial + text).split('\n')
    this.partial = pieces.pop() ?? ''
    for (const line of pieces) {
      this.lines.push(line)
      this.chars += line.length
    }
    if (this.lines.length < this.maxLines + this.trimStep && this.chars <= this.maxChars) return 0
    let trimmed = Math.max(0, this.lines.length - this.maxLines)
    for (let i = 0; i < trimmed; i++) this.chars -= this.lines[i].length
    // Over the size budget, down to 90% of it, so a run of long lines trims once per tenth of the budget, not every
    // frame. The newest line stays, however long.
    if (this.chars > this.maxChars) {
      while (trimmed < this.lines.length - 1 && this.chars > this.maxChars * 0.9) this.chars -= this.lines[trimmed++].length
    }
    this.lines.splice(0, trimmed)
    this.dropped += trimmed
    for (const mark of this.marks) if (mark < this.dropped) this.marks.delete(mark)
    return trimmed
  }

  /**
   * A separator line between runs of the app. An unfinished line is ended first, so the separator never splits one,
   * and it is held as a line like any other: counted for the caps, and in Copy as its text.
   */
  mark(text: string): number {
    if (this.partial !== '') this.append('\n')
    this.marks.add(this.dropped + this.lines.length)
    return this.append(`${text}\n`)
  }

  isMark(index: number): boolean {
    return this.marks.has(this.dropped + index)
  }

  get rowCount(): number {
    return this.lines.length + (this.partial === '' ? 0 : 1)
  }

  row(index: number): string {
    return index < this.lines.length ? this.lines[index] : this.partial
  }

  text(): string {
    return this.partial === '' ? this.lines.join('\n') : [...this.lines, this.partial].join('\n')
  }
}

/**
 * What DeviceViewer tells the log. `launch` opens a new stream (a launch this viewer sent), `text` is a chunk of it,
 * and `clear` ends it: the box is shown only between a launch and whatever ends that app, never before a launch or for
 * an install that failed, where "waiting for logs" would promise output that is not coming.
 *
 * A watched app (an agent naming `app-log-watch`) has no launch to wait for: `open` shows the box as it is, at the
 * watch's first output, and `mark` adds a separator line between runs, in order with the text around it.
 * `onlyIfShown` drops a mark while the box is hidden, where it would be the first line of the next run's box.
 */
export type AppLogEvent =
  | { kind: 'launch' }
  | { kind: 'open' }
  | { kind: 'text'; text: string }
  | { kind: 'mark'; text: string; onlyIfShown?: boolean }
  | { kind: 'clear' }

export interface AppLogSnapshot {
  buffer: AppLogBuffer
  /** Bumped by each frame that added to the buffer, which is appended to in place. */
  version: number
  rows: number
  dropped: number
  active: boolean
  /** Bumped each time the box opens, so its scroll box starts at the tail again. */
  opens: number
}

/**
 * The session's app log, held by DeviceViewer rather than by the box that shows it: the device's view is taken down
 * while it boots and while its agent is away, and a watched app's log carries on across both. The box subscribes
 * (`useSyncExternalStore`); text is applied once per frame however many chunks arrive in it (#1233).
 */
export class AppLogFeed {
  private buffer = new AppLogBuffer()
  private active = false
  private opens = 0
  private version = 0
  // Text and separators since the last frame, in order: a separator must land after the text before it.
  private pending: Array<{ text: string } | { mark: string }> = []
  private pendingChars = 0
  private frame: number | null = null
  private snapshot: AppLogSnapshot
  private readonly listeners = new Set<() => void>()

  constructor() {
    this.snapshot = this.snap()
  }

  readonly handle = (event: AppLogEvent): void => {
    if (event.kind === 'launch' || event.kind === 'clear') {
      if (this.frame !== null) cancelAnimationFrame(this.frame)
      this.frame = null
      this.pending = []
      this.pendingChars = 0
      this.buffer = new AppLogBuffer()
      this.version = 0
      this.active = false
      if (event.kind === 'launch') this.show()
      else this.changed()
      return
    }
    if (event.kind === 'open') {
      this.show()
      return
    }
    if (event.kind === 'mark' && event.onlyIfShown && !this.active) return
    const last = this.pending[this.pending.length - 1]
    if (event.kind === 'mark') this.pending.push({ mark: event.text })
    else if (last && 'text' in last) last.text += event.text
    else this.pending.push({ text: event.text })
    this.pendingChars += event.text.length
    // A hidden tab runs no frames, and a watched app writes all session: past this much, applied without waiting, so
    // what waits stays within the buffer's own cap.
    if (this.pendingChars > APP_LOG_PENDING_CHARS) {
      if (this.frame !== null) cancelAnimationFrame(this.frame)
      this.frame = null
      this.apply()
      return
    }
    if (this.frame !== null) return
    this.frame = requestAnimationFrame(() => {
      this.frame = null
      this.apply()
    })
  }

  private apply(): void {
    const items = this.pending
    this.pending = []
    this.pendingChars = 0
    for (const item of items) {
      if ('mark' in item) this.buffer.mark(item.mark)
      else this.buffer.append(item.text)
    }
    this.version++
    this.changed()
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  readonly getSnapshot = (): AppLogSnapshot => this.snapshot

  private show(): void {
    if (this.active) return
    this.active = true
    this.opens++
    this.changed()
  }

  private snap(): AppLogSnapshot {
    const { buffer } = this
    return { buffer, version: this.version, rows: buffer.rowCount, dropped: buffer.dropped, active: this.active, opens: this.opens }
  }

  private changed(): void {
    this.snapshot = this.snap()
    for (const listener of this.listeners) listener()
  }
}

/** The separator for a run boundary, or for the device coming up from off. */
export function appLogMarkText(event: 'started' | 'running' | 'exited' | 'device-restarted', pid?: number): string {
  const label = event === 'device-restarted' ? 'Device restarted'
    : event === 'started' ? `App started (pid ${pid})`
    : event === 'running' ? `App running (pid ${pid})`
    : `App exited (pid ${pid})`
  return `── ${label} ──`
}

/**
 * Whether sending `msg` empties a watched app's log: only an install or a clear state, the person's decision. A
 * Launch, a replay's launch, a reconnect all keep it, and the runs are told apart by their separators. The install a
 * viewer sends after every ready once the build is on the device (`keepIfInstalled`) is answered without touching the
 * app when it is still there, so it keeps the log too; a device that came up from off is marked instead.
 */
export function emptiesWatchedLog(msg: BrowserToRelay): boolean {
  return msg.type === 'app:clear-state' || (msg.type === 'app:install' && msg.keepIfInstalled !== true)
}

/**
 * Whether sending `msg` ends the launch whose logs are shown. The relay forgets that launch on each of these (Flow
 * Capture's replay sends them through the same socket), and the agent's next output carries another launch id, so the
 * box would wait on output that is not coming. The viewer's own Launch sets the shown id before it sends, so it is not
 * one of them.
 */
export function endsShownLaunch(msg: BrowserToRelay, shownLaunchId: string | null): boolean {
  if (msg.type === 'app:clear-state' || msg.type === 'app:install') return true
  return msg.type === 'app:launch' && msg.requestId !== shownLaunchId
}
