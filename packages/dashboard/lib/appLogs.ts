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
    return trimmed
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
 * Whether sending `msg` ends the launch whose logs are shown. The relay forgets that launch on each of these (Flow
 * Capture's replay sends them through the same socket), and the agent's next output carries another launch id, so the
 * box would wait on output that is not coming. The viewer's own Launch sets the shown id before it sends, so it is not
 * one of them.
 */
export function endsShownLaunch(msg: BrowserToRelay, shownLaunchId: string | null): boolean {
  if (msg.type === 'app:clear-state' || msg.type === 'app:install') return true
  return msg.type === 'app:launch' && msg.requestId !== shownLaunchId
}
