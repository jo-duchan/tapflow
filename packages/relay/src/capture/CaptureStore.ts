import { randomUUID } from 'node:crypto'
import type { ClientKind } from '@tapflowio/protocol'
import type { ParsedInbound } from '@tapflowio/protocol/validate'

/**
 * Flow Capture's raw record of what a person did on a device (#1125): every input the relay passed on to the agent,
 * stamped with the relay's clock, kept in memory only. Turning it into a flow is the dashboard's job (flow-runner's
 * capture module); this keeps the messages exactly as they were sent, because which of them a flow can say is decided
 * later, against the tree the replay reads.
 *
 * **Typed text is in here.** `input:key`, `input:type` and `clipboard:write` carry it, and the relay otherwise keeps
 * none — its watchers are told a character count. So nothing here is written to disk or to a log, a capture is read
 * only by the person it belongs to and only with their browser cookie (`api/captures.ts`), and it is thrown away
 * whenever the device stops being theirs.
 */

/** The browser messages a capture keeps: the inputs, and the commands that change what is on the device. The parse
 *  product the relay forwards, so what is kept is what reached the agent — a key appended from devtools is gone. */
export type CapturedMessage = Extract<ParsedInbound, { type:
  | 'input:touch:start' | 'input:touch:move' | 'input:touch:end' | 'input:touch:cancel'
  | 'input:pinch:start' | 'input:pinch:move' | 'input:pinch:end'
  | 'input:key' | 'input:button' | 'input:type' | 'input:rotate' | 'input:posture' | 'input:keyboard:toggle'
  | 'app:install' | 'app:launch' | 'app:clear-state' | 'open-url'
  | 'clipboard:write' | 'clipboard:read' | 'network:set'
}>

export type CaptureEntry =
  | { at: number; kind: 'input'; msg: CapturedMessage }
  /** The agent's answer to an acked input, so a refused or failed one can be told from one that landed. */
  | { at: number; kind: 'ack'; requestId: string; ok: boolean }
  /** The device's chrome changed (a turn, a fold): coordinates before and after it are in different frames. */
  | { at: number; kind: 'chrome'; chrome: unknown }

export interface CaptureSnapshot {
  id: string
  takenAt: number
  entries: CaptureEntry[]
  thinned: boolean
}

interface Capture {
  id: string
  ownerUser: string
  startedAt: number
  entries: CaptureEntry[]
  bytes: number
  /** Entries were dropped to stay inside the budget (moves thinned first, then the oldest gestures). */
  thinned: boolean
  snapshot?: CaptureSnapshot
}

/** Who drives the session the input came through, as the relay recorded it at the join: the declared kind and the
 *  user id. Not protocol's `SessionHolder`, which is a label for people and only ever an AI kind. */
export interface Holder {
  kind: ClientKind | null
  user: string | null
}

export interface CaptureStoreOptions {
  /** The person's own setting (`users.flow_capture`), read from memory on every input. */
  isEnabled: (user: string) => boolean
  /** The device's chrome as the relay holds it now. A capture starts with it, since a capture begun after a turn would
   *  otherwise not know which frame its first points are in. */
  chromeOf?: (sessionId: string) => unknown
  now?: () => number
  maxEntries?: number
  maxBytes?: number
  /** Sizes are JSON characters, not bytes: an estimate of what is held, good for a bound. A snapshot shares its
   *  entries with the capture and is not counted, so one capture can hold up to twice its budget while a dialog is open.
   *  Across every capture on this relay: N held sessions × the per-session cap would otherwise be the bound. */
  maxTotalBytes?: number
  pauseTtlMs?: number
}

/** Messages that open a gesture; a head cut may stop just before one, never inside the gesture it opens. */
const OPENS = new Set(['input:touch:start', 'input:pinch:start'])
/** Kept through every cut: the default start of a flow is "the first launch after the last clear-state or install",
 *  and losing these would leave the dashboard nothing to anchor it on. */
const ANCHORS = new Set(['app:launch', 'app:clear-state', 'app:install'])
const MOVES = new Set(['input:touch:move', 'input:pinch:move'])

const isMove = (e: CaptureEntry): boolean => e.kind === 'input' && MOVES.has(e.msg.type)
const isAnchor = (e: CaptureEntry): boolean => e.kind === 'input' && ANCHORS.has(e.msg.type)
/** An entry a head cut may start at: one that does not continue something before it. */
const startsClean = (e: CaptureEntry): boolean =>
  e.kind === 'input' && (OPENS.has(e.msg.type) || !/^input:(touch|pinch):(move|end|cancel)$/.test(e.msg.type))

/** Only a signed-in person: `anon` and `unidentified:*` have no cookie to read their capture back with. */
export const isPersonUser = (user: string | null): user is string => user !== null && /^\d+$/.test(user)

export class CaptureStore {
  private readonly captures = new Map<string, Capture>()
  /** A replay or verification is running in the owner's dialog: what reaches the device now is not the person. */
  private readonly paused = new Map<string, { user: string; until: number }>()
  private totalBytes = 0
  private readonly now: () => number
  private readonly maxEntries: number
  private readonly maxBytes: number
  private readonly maxTotalBytes: number
  readonly pauseTtlMs: number

  constructor(private readonly opts: CaptureStoreOptions) {
    this.now = opts.now ?? Date.now
    this.maxEntries = opts.maxEntries ?? 20_000
    this.maxBytes = opts.maxBytes ?? 4 * 1024 * 1024
    this.maxTotalBytes = opts.maxTotalBytes ?? 64 * 1024 * 1024
    this.pauseTtlMs = opts.pauseTtlMs ?? 30_000
  }

  /**
   * An input the relay just sent to the agent. Called only after the send — a refused input never reached the device
   * — and never throws, because a capture failing must not cost the person their input.
   */
  recordInput(sessionId: string, holder: Holder, msg: CapturedMessage): void {
    try {
      if (msg.type === 'clipboard:write' && msg.payload.pasteAfter !== true) return
      // A copy only reads the device; a cut changes it.
      if (msg.type === 'clipboard:read' && msg.payload?.press !== 'cut') return
      const capture = this.captureFor(sessionId, holder)
      if (capture) this.append(capture, { at: this.now(), kind: 'input', msg })
    } catch { /* see above */ }
  }

  recordAck(sessionId: string, holder: Holder, requestId: string, ok: boolean): void {
    try {
      const capture = this.captures.get(sessionId)
      if (!capture || !this.recording(sessionId, holder, capture)) return
      this.append(capture, { at: this.now(), kind: 'ack', requestId, ok })
    } catch { /* see recordInput */ }
  }

  recordChrome(sessionId: string, holder: Holder, chrome: unknown): void {
    try {
      const capture = this.captureFor(sessionId, holder)
      if (capture) this.append(capture, { at: this.now(), kind: 'chrome', chrome })
    } catch { /* see recordInput */ }
  }

  /**
   * Someone joined the session. The capture goes on only for the same person coming back in a dashboard — a reload,
   * a dropped Wi-Fi. Anything else drives the device in between, the person's own `flow run` or MCP client included,
   * and steps recorded on either side of that would read as one flow with a hole in it.
   */
  noteJoin(sessionId: string, holder: Holder): void {
    const capture = this.captures.get(sessionId)
    if (capture && (holder.kind !== 'dashboard' || holder.user !== capture.ownerUser)) this.seal(sessionId)
  }

  /** The device is no longer the one the steps were taken on: shut down, booted cold, or the session gone. */
  seal(sessionId: string): void {
    const capture = this.captures.get(sessionId)
    if (capture) this.totalBytes -= capture.bytes
    this.captures.delete(sessionId)
    this.paused.delete(sessionId)
  }

  /** The person turned capturing off: everything recorded for them goes now. */
  sealUser(user: string): void {
    for (const [sessionId, capture] of this.captures) if (capture.ownerUser === user) this.seal(sessionId)
  }

  /** Freeze what is recorded so far for the dialog, which reads only this; recording goes on beside it. */
  takeSnapshot(sessionId: string, user: string): CaptureSnapshot | null {
    const capture = this.owned(sessionId, user)
    if (!capture) return null
    capture.snapshot = { id: randomUUID(), takenAt: this.now(), entries: capture.entries.slice(), thinned: capture.thinned }
    return capture.snapshot
  }

  snapshot(sessionId: string, user: string): CaptureSnapshot | null {
    return this.owned(sessionId, user)?.snapshot ?? null
  }

  dropSnapshot(sessionId: string, user: string): boolean {
    const capture = this.owned(sessionId, user)
    if (!capture?.snapshot) return false
    capture.snapshot = undefined
    return true
  }

  /**
   * Stop recording this session for `pauseTtlMs`, or extend a pause already held. A lease rather than a flag tied to
   * a socket: a Wi-Fi blink in the middle of a replay keeps it (the browser renews it before it sends again), and a tab
   * that dies lets it run out instead of leaving the person unrecorded for the rest of the session.
   */
  pause(sessionId: string, user: string): boolean {
    if (!this.owned(sessionId, user)) return false
    this.paused.set(sessionId, { user, until: this.now() + this.pauseTtlMs })
    return true
  }

  resume(sessionId: string, user: string): boolean {
    const held = this.paused.get(sessionId)
    if (held?.user !== user) return false
    this.paused.delete(sessionId)
    return true
  }

  /** For tests and the chip: whether this session's inputs are being kept right now. */
  isRecording(sessionId: string, holder: Holder): boolean {
    return this.eligible(holder) && !this.isPaused(sessionId)
  }

  private owned(sessionId: string, user: string): Capture | undefined {
    const capture = this.captures.get(sessionId)
    return capture?.ownerUser === user ? capture : undefined
  }

  private eligible(holder: Holder): holder is { kind: 'dashboard'; user: string } {
    return holder.kind === 'dashboard' && isPersonUser(holder.user) && this.opts.isEnabled(holder.user)
  }

  private isPaused(sessionId: string): boolean {
    const held = this.paused.get(sessionId)
    if (!held) return false
    if (held.until > this.now()) return true
    this.paused.delete(sessionId)
    return false
  }

  private recording(sessionId: string, holder: Holder, capture: Capture): boolean {
    return this.eligible(holder) && holder.user === capture.ownerUser && !this.isPaused(sessionId)
  }

  private captureFor(sessionId: string, holder: Holder): Capture | null {
    if (!this.eligible(holder) || this.isPaused(sessionId)) return null
    let capture = this.captures.get(sessionId)
    // A join by anyone else has sealed it already; this covers an input racing that.
    if (capture && capture.ownerUser !== holder.user) { this.seal(sessionId); capture = undefined }
    if (!capture) {
      capture = { id: randomUUID(), ownerUser: holder.user, startedAt: this.now(), entries: [], bytes: 0, thinned: false }
      this.captures.set(sessionId, capture)
      const chrome = this.opts.chromeOf?.(sessionId)
      if (chrome !== undefined) this.append(capture, { at: this.now(), kind: 'chrome', chrome })
    }
    return capture
  }

  private append(capture: Capture, entry: CaptureEntry): void {
    const size = JSON.stringify(entry).length
    capture.entries.push(entry)
    capture.bytes += size
    this.totalBytes += size
    // Trimmed to three quarters, not to the line, so the next input does not trim again.
    if (capture.entries.length > this.maxEntries || capture.bytes > this.maxBytes) {
      this.trim(capture, Math.floor(this.maxEntries * 0.75), Math.floor(this.maxBytes * 0.75))
    }
    if (this.totalBytes > this.maxTotalBytes) {
      let largest = capture
      for (const c of this.captures.values()) if (c.bytes > largest.bytes) largest = c
      this.trim(largest, this.maxEntries, Math.floor(largest.bytes / 2))
    }
  }

  /** Bring a capture under a budget: thin moves first, then cut whole gestures off the head. */
  private trim(capture: Capture, maxEntries: number, maxBytes: number): void {
    const over = (): boolean => capture.entries.length > maxEntries || capture.bytes > maxBytes
    if (!over()) return
    capture.thinned = true
    // Every other move goes, start and end stay: the path keeps its shape at half the resolution. Repeated while it
    // still helps; a gesture never loses its endpoints.
    for (let pass = 0; pass < 4 && over(); pass++) {
      let odd = false
      const kept = capture.entries.filter((e) => !isMove(e) || (odd = !odd))
      if (kept.length === capture.entries.length) break
      this.replace(capture, kept)
    }
    if (!over()) return
    // Then the oldest steps, cut where a gesture begins, keeping every anchor.
    let cut = 0
    let bytes = capture.bytes
    let count = capture.entries.length
    while (cut < capture.entries.length && (count > maxEntries || bytes > maxBytes)) {
      const e = capture.entries[cut]!
      if (!isAnchor(e)) { bytes -= JSON.stringify(e).length; count-- }
      cut++
    }
    while (cut < capture.entries.length && !startsClean(capture.entries[cut]!)) cut++
    // The last chrome before the cut goes with the anchors: the points after it are in its frame.
    const head = capture.entries.slice(0, cut)
    let lastChrome = -1
    for (let i = 0; i < head.length; i++) if (head[i]!.kind === 'chrome') lastChrome = i
    this.replace(capture, [...head.filter((e, i) => isAnchor(e) || i === lastChrome), ...capture.entries.slice(cut)])
  }

  private replace(capture: Capture, entries: CaptureEntry[]): void {
    const bytes = entries.reduce((n, e) => n + JSON.stringify(e).length, 0)
    this.totalBytes += bytes - capture.bytes
    capture.entries = entries
    capture.bytes = bytes
  }
}
