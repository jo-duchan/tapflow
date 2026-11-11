import { randomUUID } from 'node:crypto'
import type { ClientKind, FieldReadReason, FocusedField, KeyboardState } from '@tapflowio/protocol'
import type { CapturedMessage, CaptureEntry, CaptureSnapshot } from '@tapflowio/protocol/capture'

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

export type { CapturedMessage, CaptureEntry, CaptureSnapshot }

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

/** An agent's answer about the keyboard-focused text field (`ui:field:response`). */
export interface FieldRead { field: FocusedField | null; reason?: FieldReadReason; keyboard?: KeyboardState; language?: string }

/** How long typing has to pause before the relay reads the field. Short, because a read is only kept when it
 *  answered before the next input; measured, reading every 0.5 s did not slow typing (a read takes 40–90 ms). 600 ms
 *  lost the value of soft-keyboard typing on iOS, where a read took 0.45 s and the person tapped the next field 0.87 s
 *  after the last key (E2E of #1135); a key typed within this window puts the read off, so fast typing asks no more. */
export const FIELD_IDLE_MS = 250
/** How long a snapshot waits for a read still in flight, so the last field typed before Capture flow is not lost. */
export const SNAPSHOT_READ_WAIT_MS = 1_000
/** How long the relay waits for an agent's field read before it counts as not read. */
export const FIELD_READ_TIMEOUT_MS = 5_000
/** How long after a person's last input the keyboard is read again, to see it where it came to rest: iOS slides it in
 *  and out over ~250 ms. A read matching the one before it is `settled`. */
export const KEYBOARD_SETTLE_MS = 300
/** Reads after the last input before the keyboard is taken as never settling (a keyboard animating for good). */
const KEYBOARD_SETTLE_TRIES = 3
/**
 * While the home screen is in front (`onHome`), reads go on whether or not they settle: an app opened from its icon takes
 * seconds to come up, and the read after the tap would otherwise be the last word on the screen until the next input —
 * the first tap in the app, which the default range then left out as one on the home screen. Bounded, since a person
 * may stay on the home screen.
 */
export const HOME_READ_MS = 500
export const HOME_READS = 20

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
  /** Ask the session's agent for its focused text field (#1135), or `null` when it cannot answer. */
  readField?: (sessionId: string) => Promise<FieldRead> | null
  /** Ask the session's agent where the soft keyboard is (#1135), or `null` when it cannot answer. */
  readKeyboard?: (sessionId: string) => Promise<KeyboardState> | null
}

/** Keys that move focus or submit, and chords: a run of typing ends at them, as flow-runner's grouping does, so the
 *  next key asks again which field it is in — Tab is how a form is filled in. */
const ENDS_TYPING = new Set(['Tab', 'Enter', 'NumpadEnter', 'Escape'])
const CHORD = 0x01 | 0x04 | 0x08

/** An input that types into the focused field: a character, an edit key, or `input:type`. */
function typesIntoField(msg: CapturedMessage): boolean {
  if (msg.type === 'input:type') return true
  if (msg.type !== 'input:key') return false
  return !ENDS_TYPING.has(msg.payload.code) && ((msg.payload.modifiers ?? 0) & CHORD) === 0
}

/** A run of typing the relay is reading the field for: what it typed into, and the pause timer after its last input. */
interface Typing {
  holder: Holder
  timer: ReturnType<typeof setTimeout> | null
}

/**
 * The keyboard reads of one session (#1135). One at a time: an input while one is out asks for another when it
 * returns, rather than a second beside it. `last` is the newest answer, and `tap` the keyboard as it was when the
 * gesture in progress began — what decides, at its end, whether it was a key on the keyboard.
 */
interface KeyboardProbe {
  holder: Holder
  inFlight: boolean
  again: boolean
  settleTimer: ReturnType<typeof setTimeout> | null
  settleTries: number
  last?: KeyboardState
  tap?: { x: number; y: number; frame: boolean; keyboard: KeyboardState | undefined }
}

/** Opening and moving frames: a keyboard read waits for the gesture's end, which is what can change it. */
const MID_GESTURE = new Set(['input:touch:start', 'input:touch:move', 'input:pinch:start', 'input:pinch:move'])
/** The commands whose ack says the app changed under the screen the read before it saw. */
const APP_COMMANDS = new Set(['app:install', 'app:launch', 'app:clear-state'])

function findLastInput(entries: readonly CaptureEntry[], requestId: string): CapturedMessage | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!
    if (e.kind === 'input' && 'requestId' in e.msg && e.msg.requestId === requestId) return e.msg
  }
  return undefined
}

const near = (a: number, b: number): boolean => Math.abs(a - b) < 0.005
function sameKeyboard(a: KeyboardState | undefined, b: KeyboardState): boolean {
  if (!a || a.shown !== b.shown || a.onHome !== b.onHome) return false
  if (!a.rect || !b.rect) return !a.rect && !b.rect
  return near(a.rect.x, b.rect.x) && near(a.rect.y, b.rect.y) && near(a.rect.width, b.rect.width) && near(a.rect.height, b.rect.height)
}

/** Whether a point is on the keyboard as it was read, in the space the point was sent in. */
function onKeyboard(tap: NonNullable<KeyboardProbe['tap']>): boolean {
  const rect = tap.frame ? tap.keyboard?.frameRect ?? tap.keyboard?.rect : tap.keyboard?.rect
  if (tap.keyboard?.shown !== true || !rect) return false
  return tap.x >= rect.x && tap.x <= rect.x + rect.width && tap.y >= rect.y && tap.y <= rect.y + rect.height
}

/** Messages that open a gesture; a head cut may stop just before one, never inside the gesture it opens. */
const OPENS = new Set(['input:touch:start', 'input:pinch:start'])
/** Kept through every cut: the default start of a flow is "the first launch after the last clear-state or install",
 *  and losing these would leave the dashboard nothing to anchor it on. */
const ANCHORS = new Set(['app:launch', 'app:clear-state', 'app:install'])
const MOVES = new Set(['input:touch:move', 'input:pinch:move'])

const isMove = (e: CaptureEntry): boolean => e.kind === 'input' && MOVES.has(e.msg.type)
const isAnchor = (e: CaptureEntry): boolean => e.kind === 'input' && ANCHORS.has(e.msg.type)
/** The index of each gesture's first and final move: the moves at either end of a row of moves. */
function gestureMoveEnds(entries: CaptureEntry[]): Set<number> {
  const out = new Set<number>()
  let pending = -1
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!
    if (e.kind !== 'input') continue
    if (isMove(e)) {
      if (pending < 0) out.add(i)
      pending = i
    } else { if (pending >= 0) out.add(pending); pending = -1 }
  }
  if (pending >= 0) out.add(pending)
  return out
}

/** An entry a head cut may start at: one that does not continue something before it. */
const startsClean = (e: CaptureEntry): boolean =>
  e.kind === 'input' && (OPENS.has(e.msg.type) || !/^input:(touch|pinch):(move|end|cancel)$/.test(e.msg.type))

/**
 * The chrome with its pictures emptied: the bezel (`framePng`) and each button's images are base64 PNGs, often hundreds
 * of kilobytes, and a capture needs the geometry, not the artwork. `framePng` is kept as a key, set to `''`, because its
 * presence is what marks an iOS chrome (`chromeOrientation` in `@tapflowio/protocol/screen` reads it that way).
 */
export function withoutImages(chrome: unknown): unknown {
  if (typeof chrome !== 'object' || chrome === null || Array.isArray(chrome)) return chrome
  const out: Record<string, unknown> = { ...chrome }
  if (typeof out['framePng'] === 'string') out['framePng'] = ''
  if (Array.isArray(out['buttons'])) {
    out['buttons'] = out['buttons'].map((b: unknown) => {
      if (typeof b !== 'object' || b === null) return b
      const { buttonPng: _b, pressedPng: _p, ...rest } = b as Record<string, unknown>
      return rest
    })
  }
  return out
}

/** Only a signed-in person: `anon` and `unidentified:*` have no cookie to read their capture back with. */
export const isPersonUser = (user: string | null): user is string => user !== null && /^\d+$/.test(user)

export class CaptureStore {
  private readonly captures = new Map<string, Capture>()
  /** A replay or verification is running in the owner's dialog: what reaches the device now is not the person. */
  private readonly paused = new Map<string, { user: string; until: number }>()
  private readonly typing = new Map<string, Typing>()
  /** A session's value read in flight, and whether another was asked for meanwhile (single-flight, as keyboard probes). */
  private readonly valueReads = new Map<string, { again: Holder | null }>()
  private readonly reads = new Map<string, Set<Promise<void>>>()
  private readonly keyboards = new Map<string, KeyboardProbe>()
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
      if (!capture) return
      // One time for the input and the read it starts, so a one-key run's focus read is never a millisecond past it.
      const at = this.now()
      this.append(capture, { at, kind: 'input', msg })
      this.noteKeyboard(sessionId, holder, msg)
      this.noteTyping(sessionId, holder, msg, at)
    } catch { /* see above */ }
  }

  /**
   * Read the soft keyboard after each input that can change it (#1135): what tells a tap on the keyboard from a tap on
   * the app, judged by flow-runner from the reads on either side of it. A gesture's start is remembered with the
   * keyboard as last read, so its end can say whether it was a key.
   */
  private noteKeyboard(sessionId: string, holder: Holder, msg: CapturedMessage): void {
    if (!this.opts.readKeyboard) return
    let probe = this.keyboards.get(sessionId)
    if (!probe) this.keyboards.set(sessionId, probe = { holder, inFlight: false, again: false, settleTimer: null, settleTries: 0 })
    probe.holder = holder
    if (msg.type === 'input:touch:start') {
      probe.tap = { x: msg.payload.x, y: msg.payload.y, frame: msg.payload.space === 'frame', keyboard: probe.last }
    }
    if (MID_GESTURE.has(msg.type)) return
    if (probe.settleTimer) clearTimeout(probe.settleTimer)
    probe.settleTimer = null
    probe.settleTries = 0
    if (probe.inFlight) probe.again = true
    else this.probeKeyboard(sessionId, probe, false)
  }

  private probeKeyboard(sessionId: string, probe: KeyboardProbe, settling: boolean): void {
    const answer = this.opts.readKeyboard?.(sessionId)
    if (!answer) return
    const requestedAt = this.now()
    probe.inFlight = true
    const done = answer.then((keyboard) => {
      probe.inFlight = false
      if (this.keyboards.get(sessionId) !== probe) return
      const capture = this.captures.get(sessionId)
      if (!capture || !this.recording(sessionId, probe.holder, capture)) return
      // Settled only on a read taken after a quiet spell, matching the one before it: an input in between asked again.
      const settled = settling && !probe.again && sameKeyboard(probe.last, keyboard)
      this.append(capture, { at: this.now(), kind: 'keyboard', requestedAt, keyboard, settled })
      // The app came up: its keyboard gets the usual reads to settle, which the home screen's had used up.
      if (probe.last?.onHome === true && keyboard.onHome !== true) probe.settleTries = 0
      probe.last = keyboard
      if (probe.again) {
        probe.again = false
        this.probeKeyboard(sessionId, probe, false)
        return
      }
      const home = keyboard.onHome === true
      if (home ? probe.settleTries >= HOME_READS : settled || keyboard.shown === null || probe.settleTries >= KEYBOARD_SETTLE_TRIES) return
      probe.settleTries++
      probe.settleTimer = setTimeout(() => {
        probe.settleTimer = null
        this.probeKeyboard(sessionId, probe, true)
      }, home ? HOME_READ_MS : KEYBOARD_SETTLE_MS)
    }).catch(() => { probe.inFlight = false })
    this.track(sessionId, done)
  }

  /**
   * Read the focused field around a run of typing (#1135): which field at its first key, and what it holds once the
   * person pauses. A key types by the device's IME and language, which the key code cannot say — the field can. Any
   * key extends the run, Backspace and arrows too, so a pause read after an edit sees the edit. Anything else ends it.
   * Reads never hold an input back: the reader decides afterwards which ones saw the field undisturbed.
   */
  private noteTyping(sessionId: string, holder: Holder, msg: CapturedMessage, at: number): void {
    if (!this.opts.readField) return
    const typing = this.typing.get(sessionId)
    // A gesture is judged at its end: one that ends on the soft keyboard typed (its start was there), any other did not.
    if (msg.type === 'input:touch:start' || msg.type === 'input:touch:move') return
    const tap = msg.type === 'input:touch:end' ? this.keyboards.get(sessionId)?.tap : undefined
    const onKeys = tap !== undefined && onKeyboard(tap)
    if (!typesIntoField(msg) && !onKeys) {
      if (typing?.timer) clearTimeout(typing.timer)
      this.typing.delete(sessionId)
      return
    }
    if (!typing) void this.read(sessionId, holder, 'focus', at)
    if (typing?.timer) clearTimeout(typing.timer)
    const next: Typing = { holder, timer: null }
    next.timer = setTimeout(() => {
      next.timer = null
      this.readValue(sessionId, next.holder)
    }, FIELD_IDLE_MS)
    this.typing.set(sessionId, next)
  }

  /**
   * One value read at a time per session. A field read can take 0.45 s on iOS, where the runner answers one query at a
   * time, and a pause of 250 ms between keys asked for one per key: they queued, and the last one answered after the
   * person's next input and was not kept. Asked while one is in flight, the read is made once that one answers — still
   * after the last key, which is all a value read needs.
   */
  private readValue(sessionId: string, holder: Holder): void {
    const inFlight = this.valueReads.get(sessionId)
    if (inFlight) { inFlight.again = holder; return }
    const slot = { again: null as Holder | null }
    this.valueReads.set(sessionId, slot)
    const done = this.read(sessionId, holder, 'value')
    void (done ?? Promise.resolve()).finally(() => {
      if (this.valueReads.get(sessionId) !== slot) return
      this.valueReads.delete(sessionId)
      if (slot.again) this.readValue(sessionId, slot.again)
    })
  }

  private read(sessionId: string, holder: Holder, phase: 'focus' | 'value', requestedAt = this.now()): Promise<void> | undefined {
    const answer = this.opts.readField?.(sessionId)
    if (!answer) return undefined
    const done = answer.then((read) => {
      const capture = this.captures.get(sessionId)
      // The person may have stopped being recorded while the agent answered: a pause, a seal, a setting turned off.
      if (!capture || !this.recording(sessionId, holder, capture)) return
      this.append(capture, {
        at: this.now(), kind: 'field', phase, requestedAt, field: read.field,
        ...(read.reason ? { reason: read.reason } : {}),
        ...(read.keyboard ? { keyboard: read.keyboard } : {}),
        ...(read.language ? { language: read.language } : {}),
      })
    }).catch(() => { /* a read that failed is a read that is not there */ })
    this.track(sessionId, done)
    return done
  }

  /** A read a snapshot waits for (`settleReads`). */
  private track(sessionId: string, done: Promise<void>): void {
    let pending = this.reads.get(sessionId)
    if (!pending) this.reads.set(sessionId, pending = new Set())
    pending.add(done)
    void done.finally(() => pending.delete(done))
  }

  recordAck(sessionId: string, holder: Holder, requestId: string, ok: boolean): void {
    try {
      const capture = this.captures.get(sessionId)
      if (!capture || !this.recording(sessionId, holder, capture)) return
      this.append(capture, { at: this.now(), kind: 'ack', requestId, ok })
    } catch { /* see recordInput */ }
  }

  /**
   * An install, launch or clear-state the agent reports done. It took seconds, and the keyboard read it started answered
   * at once, about the screen before it (the previous build open): read again, or that stale read is the last word
   * before the person's first step, taken for one in the app when it was on the home screen. Not an ack: those replies
   * have their own types (`app:install-done`), which `recordAck` never sees.
   */
  noteAppDone(sessionId: string, holder: Holder, requestId: string): void {
    try {
      const capture = this.captures.get(sessionId)
      if (!capture || !this.recording(sessionId, holder, capture)) return
      const sent = findLastInput(capture.entries, requestId)
      if (sent && APP_COMMANDS.has(sent.type)) this.noteKeyboard(sessionId, holder, sent)
    } catch { /* see recordInput */ }
  }

  recordChrome(sessionId: string, holder: Holder, chrome: unknown): void {
    try {
      const capture = this.captureFor(sessionId, holder)
      if (capture) this.append(capture, { at: this.now(), kind: 'chrome', chrome: withoutImages(chrome) })
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
    const typing = this.typing.get(sessionId)
    if (typing?.timer) clearTimeout(typing.timer)
    this.typing.delete(sessionId)
    const probe = this.keyboards.get(sessionId)
    if (probe?.settleTimer) clearTimeout(probe.settleTimer)
    this.keyboards.delete(sessionId)
    this.valueReads.delete(sessionId)
    const capture = this.captures.get(sessionId)
    if (capture) this.totalBytes -= capture.bytes
    this.captures.delete(sessionId)
    this.paused.delete(sessionId)
  }

  /** The person turned capturing off: everything recorded for them goes now. */
  sealUser(user: string): void {
    for (const [sessionId, capture] of this.captures) if (capture.ownerUser === user) this.seal(sessionId)
  }

  /**
   * Let the field reads finish before a snapshot (#1135): a field still being typed in is read now, and a read in
   * flight is waited for, up to `SNAPSHOT_READ_WAIT_MS`. The person may open the dialog right after their last key,
   * and that field's value would otherwise never be read.
   */
  async settleReads(sessionId: string, user: string): Promise<void> {
    if (!this.owned(sessionId, user)) return
    const typing = this.typing.get(sessionId)
    if (typing?.timer) {
      clearTimeout(typing.timer)
      typing.timer = null
      // Straight away, not behind one in flight: the snapshot waits only for reads already asked.
      void this.read(sessionId, typing.holder, 'value')
    }
    // The keyboard's settling read too, now: a Done tapped just before the dialog opened closes the keyboard after the
    // first read, and only the settling read sees it closed — without it the tap reads as a key, not `imeAction`.
    const probe = this.keyboards.get(sessionId)
    if (probe?.settleTimer) {
      clearTimeout(probe.settleTimer)
      probe.settleTimer = null
      this.probeKeyboard(sessionId, probe, true)
    }
    const pending = [...(this.reads.get(sessionId) ?? [])]
    if (pending.length === 0) return
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([Promise.all(pending), new Promise((r) => { timer = setTimeout(r, SNAPSHOT_READ_WAIT_MS) })])
    clearTimeout(timer)
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
      if (chrome !== undefined) this.append(capture, { at: this.now(), kind: 'chrome', chrome: withoutImages(chrome) })
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
    // still helps. A gesture's first and last moves are kept too: the dashboard's end carries no point, so the last
    // move is where the finger lifted (without it a short swipe reads as a tap and a pinch as no pinch), and the first
    // move's time is what tells a swipe from a drag after a hold.
    for (let pass = 0; pass < 4 && over(); pass++) {
      let odd = false
      const ends = gestureMoveEnds(capture.entries)
      const kept = capture.entries.filter((e, i) => !isMove(e) || ends.has(i) || (odd = !odd))
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
