import { randomBytes } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { FieldReadReason, FocusedField, KeyboardState, ObservedElement, TouchObservation } from '@tapflowio/protocol'
import { toFocusedField, toKeyboardState } from './XCUITreeReader.js'

/**
 * The app observer's host side: asks the code inside the app under test (`src/app-observer.m`, linked into the nethook
 * dylib) for the soft keyboard and the focused field, which Flow Capture reads after a person's inputs (#1135).
 *
 * The XCUITest runner used to answer these, and an attached runner made a busy SwiftUI app visibly lag with no query
 * running; the observer reads the same things with no accessibility client at all. It answers in the runner's own
 * shapes, so `toKeyboardState` and `toFocusedField` read both. The rules are in AGENTS.md, "App observer".
 *
 * A request is a nonce and the bundle asked about, on two lines, written by rename to `request` in
 * `/tmp/tapflow-observe-<udid>` (0700): the host's /tmp is the simulator's, so the app sees it with no process started
 * on either side (3-4 ms measured, against 441 ms for a `simctl spawn` per request). Every app observed since the boot
 * watches the same directory, and one behind the app now asked about can still answer for a few seconds (measured on
 * iOS 27.0), so only the app named answers. The answer is `<nonce>.json` (0600) in the same directory, read and removed
 * here; one whose nonce or bundle is not the one asked is dropped.
 */
export type ObserverRead =
  | { kind: 'answer'; keyboard: unknown; field: unknown }
  /** The app left the foreground (its background marker) or has no process: the runner's "not in front". */
  | { kind: 'away' }
  /** The app is running and did not answer: not judged. */
  | { kind: 'silent' }

export interface ObserverHost {
  /** Whether the app has a process on the device (`launchctl list`). Asked only when no answer came. */
  appRunning(udid: string, bundleId: string): Promise<boolean>
}

export interface AppObserverOptions {
  root?: string
  /** How long to wait for an answer. The observer itself waits up to 1 s for an app still coming up to be active. */
  deadlineMs?: number
  pollMs?: number
  /** How long after giving up an answer that lands late is removed. */
  lateAnswerMs?: number
  /** How long a read may wait behind others before it is answered unknown without asking. */
  staleQueueMs?: number
  nonce?: () => bigint
}

/** An answer this old has no reader: its request was taken back. Holds a non-secure value, so it does not stay. */
const STRAY_ANSWER_MS = 5_000
/** The longest an answer can trail its request: a request under 2 s old answered at start, after up to 1 s of waiting. */
const LATE_ANSWER_MS = 3_000
/** A read queued longer than this is one the relay (`FIELD_READ_TIMEOUT_MS`, 5 s) has given up on. */
const STALE_QUEUE_MS = 4_000

const randomNonce = (): bigint => (randomBytes(8).readBigUInt64BE() >> 1n) + 1n

export class AppObserver {
  private readonly root: string
  private readonly deadlineMs: number
  private readonly pollMs: number
  private readonly lateAnswerMs: number
  private readonly staleQueueMs: number
  private readonly nonce: () => bigint
  // One request at a time per device: the observer answers the request it reads, and a second written before the
  // first is answered would replace it — a keyboard probe and a field read are often asked together.
  private readonly queues = new Map<string, Promise<unknown>>()
  private readonly touchTakes = new Map<string, Promise<AppTouch[]>>()

  constructor(private readonly host: ObserverHost, opts: AppObserverOptions = {}) {
    this.root = opts.root ?? '/tmp'
    this.deadlineMs = opts.deadlineMs ?? 1_500
    this.pollMs = opts.pollMs ?? 5
    this.lateAnswerMs = opts.lateAnswerMs ?? LATE_ANSWER_MS
    this.staleQueueMs = opts.staleQueueMs ?? STALE_QUEUE_MS
    this.nonce = opts.nonce ?? randomNonce
  }

  dir(udid: string): string {
    return join(this.root, `tapflow-observe-${udid}`)
  }

  /**
   * The directory, made 0700 and emptied of answers and requests: at each boot, before the app can be launched, so
   * nothing a previous boot or process left is read as this one's. The background marker stays: a device picked up again
   * may hold the app suspended behind the home screen, which cannot answer, and the marker is what says so. A new app
   * process clears the marker itself, and it is matched against the bundle asked about. A path that is not a plain
   * directory (a symlink) is removed rather than followed.
   */
  async prepare(udid: string): Promise<void> {
    const dir = this.dir(udid)
    const st = await lstat(dir).catch(() => undefined)
    if (st && (!st.isDirectory() || st.isSymbolicLink())) await rm(dir, { force: true, recursive: true })
    await mkdir(dir, { recursive: true, mode: 0o700 })
    // `mkdir` leaves one that already exists as it was: one a previous run left 0755 would stay readable by anyone.
    await chmod(dir, 0o700)
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      if (name !== 'background') await rm(join(dir, name), { force: true })
    }
  }

  /** Whether the app reports each touch-down (record-time observation): the `touches` file app-observer.m looks for. */
  async watchTouches(udid: string, on: boolean): Promise<void> {
    const flag = join(this.dir(udid), 'touches')
    if (on) await writeFile(flag, '', { mode: 0o600 })
    else await rm(flag, { force: true })
  }

  /**
   * Touch reports off and any left on disk removed: for a device the agent no longer records, or one an earlier agent
   * left reporting (it stopped while the device ran). The reports name what a person touched; nothing else sweeps them.
   */
  async stopTouches(udid: string): Promise<void> {
    const dir = this.dir(udid)
    await rm(join(dir, 'touches'), { force: true })
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      if (/^touch-\d+\.json(\.tmp)?$/.test(name)) await rm(join(dir, name), { force: true })
    }
  }

  /**
   * The touch-downs the app reported since the last call, oldest first. Each file is read once and removed; one that
   * cannot be read is dropped. Stray ones a reader never came for are swept with the answers (5 s), as they name what
   * a person touched.
   */
  takeTouches(udid: string): Promise<AppTouch[]> {
    // One take at a time per device: each gesture's pairing takes on its own, and two takes in flight together both
    // read a report before either removed it, so one touch could be paired with two gestures (CodeRabbit, #1166).
    const next = (this.touchTakes.get(udid) ?? Promise.resolve()).catch(() => undefined).then(() => this.takeTouchFiles(udid))
    this.touchTakes.set(udid, next)
    void next.finally(() => { if (this.touchTakes.get(udid) === next) this.touchTakes.delete(udid) }).catch(() => undefined)
    return next
  }

  private async takeTouchFiles(udid: string): Promise<AppTouch[]> {
    const dir = this.dir(udid)
    const out: AppTouch[] = []
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      if (!/^touch-\d+\.json$/.test(name)) continue
      const text = await readFile(join(dir, name), 'utf8').catch(() => undefined)
      await unlink(join(dir, name)).catch(() => undefined)
      const touch = text === undefined ? undefined : touchOf(parse(text))
      if (touch) out.push(touch)
    }
    return out.sort((a, b) => a.seq - b.seq)
  }

  read(udid: string, bundleId: string): Promise<ObserverRead> {
    const before = this.queues.get(udid) ?? Promise.resolve()
    const queuedAt = Date.now()
    // Behind reads on an app that stopped answering, a read can wait longer than the relay does (5 s): asked then, its
    // answer has no reader and only holds up the reads behind it, which the app may answer again.
    const next = before.catch(() => undefined)
      .then(() => (Date.now() - queuedAt > this.staleQueueMs ? { kind: 'silent' as const } : this.ask(udid, bundleId)))
    this.queues.set(udid, next)
    void next.finally(() => { if (this.queues.get(udid) === next) this.queues.delete(udid) }).catch(() => undefined)
    return next
  }

  private async ask(udid: string, bundleId: string): Promise<ObserverRead> {
    if (!bundleId) return { kind: 'silent' }
    const dir = this.dir(udid)
    // Behind the home screen or another app: a suspended app cannot answer, and waiting out the deadline would only
    // make every read there slow.
    if (await this.markedAway(dir, bundleId)) return { kind: 'away' }
    // An answer that came after its asker gave up has no reader; it holds a value, so it does not wait for the next
    // timeout to be cleared.
    await this.takeBack(dir, '')
    const nonce = this.nonce().toString()
    const request = `${nonce}\n${bundleId}`
    const answer = join(dir, `${nonce}.json`)
    try {
      await writeFile(join(dir, 'request.tmp'), request, { mode: 0o600 })
      await rename(join(dir, 'request.tmp'), join(dir, 'request'))
    } catch {
      return { kind: 'silent' }   // no directory: the device was not prepared (an older boot path)
    }
    const deadline = Date.now() + this.deadlineMs
    for (;;) {
      const text = await readFile(answer, 'utf8').catch(() => undefined)
      if (text !== undefined) {
        await unlink(answer).catch(() => undefined)
        // The request too: one left behind is answered again by a process started within 2 s, into a file nobody reads.
        await this.takeBack(dir, request)
        const body = parse(text)
        if (body && body['nonce'] === nonce && body['bundle'] === bundleId) {
          return { kind: 'answer', keyboard: body['keyboard'], field: body['field'] }
        }
        return { kind: 'silent' }
      }
      if (Date.now() >= deadline) break
      await new Promise((r) => setTimeout(r, this.pollMs))
    }
    // Given up on: the request is taken back, so an app that starts later does not answer it into a file nobody reads,
    // and an answer already on its way (an app that read the nonce and waited to become active, up to 1 s) is removed
    // when it lands.
    await this.takeBack(dir, request)
    setTimeout(() => { void unlink(answer).catch(() => undefined) }, this.lateAnswerMs).unref()
    if (await this.markedAway(dir, bundleId)) return { kind: 'away' }
    return (await this.host.appRunning(udid, bundleId).catch(() => true)) ? { kind: 'silent' } : { kind: 'away' }
  }

  /** Remove `request` if it is still ours, and any answer older than a few seconds that nobody came for. */
  private async takeBack(dir: string, ours: string): Promise<void> {
    const request = join(dir, 'request')
    if ((await readFile(request, 'utf8').catch(() => undefined)) === ours) await unlink(request).catch(() => undefined)
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      if (!/\.json(\.tmp)?$/.test(name)) continue
      const st = await lstat(join(dir, name)).catch(() => undefined)
      if (st && Date.now() - st.mtimeMs > STRAY_ANSWER_MS) await unlink(join(dir, name)).catch(() => undefined)
    }
  }

  private async markedAway(dir: string, bundleId: string): Promise<boolean> {
    const marker = await readFile(join(dir, 'background'), 'utf8').catch(() => undefined)
    return marker === bundleId
  }
}

/** One touch-down as app-observer.m reports it: the observation, and when (the Mac's clock, ms) and in which app. */
export interface AppTouch {
  seq: number
  at: number
  bundle: string
  observation: TouchObservation
}

/** The longest identifier or label a touch report keeps. */
const OBSERVED_TEXT_MAX = 256

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** Only the fields the protocol carries, of the types it carries: the app's file is not trusted to be anything else. */
function touchOf(body: Record<string, unknown> | undefined): AppTouch | undefined {
  if (!body) return undefined
  const point = body['point'] as Record<string, unknown> | undefined
  if (!num(body['seq']) || !num(body['at']) || typeof body['bundle'] !== 'string' || !point || !num(point['x']) || !num(point['y'])) return undefined
  const observation: TouchObservation = { point: { x: point['x'], y: point['y'] }, moving: body['moving'] === true }
  const surface = body['surface']
  if (surface === 'keyboard' || surface === 'web' || surface === 'flutter') {
    observation.surface = surface
  } else {
    const element = elementOf(body['element'])
    const button = elementOf(body['button'])
    if (element) observation.element = element
    if (button) observation.button = button
  }
  return { seq: body['seq'], at: body['at'], bundle: body['bundle'], observation }
}

function elementOf(v: unknown): ObservedElement | undefined {
  if (typeof v !== 'object' || v === null) return undefined
  const e = v as Record<string, unknown>
  if (!num(e['traits'])) return undefined
  const out: ObservedElement = { traits: e['traits'] }
  if (typeof e['identifier'] === 'string') out.identifier = e['identifier'].slice(0, OBSERVED_TEXT_MAX)
  if (e['input'] === true) out.input = true
  // A text input is named by its identifier only, whatever the file says: its label can be what was typed. A label is
  // cut, too: a cell's combined label can be a whole article, on every tap, inside the capture's budget.
  else if (typeof e['label'] === 'string') out.label = e['label'].slice(0, OBSERVED_TEXT_MAX)
  const f = e['frame'] as Record<string, unknown> | undefined
  if (f && num(f['x']) && num(f['y']) && num(f['width']) && num(f['height'])) out.frame = { x: f['x'], y: f['y'], width: f['width'], height: f['height'] }
  return out
}

function parse(text: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(text) as unknown
    return typeof v === 'object' && v !== null ? v as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

/** `UIApplicationState`: active 0, inactive 1, background 2. */
const INACTIVE = 1
const BACKGROUND = 2

/**
 * A read as the keyboard Flow Capture records. Away — or an answer from an app in the background, which keeps running
 * for a while after it leaves the foreground (measured on iOS 27) — is the runner's "not in front" (the home screen, or
 * another app). An inactive app's keyboard is unknown when it is up: Home was just pressed and the app has not reached
 * the background yet (0.5–2 s, measured), and a touch on the home screen there must not be judged against a keyboard
 * that is no longer in front. Down, it is read as down: an alert over the app, the common case, leaves no keyboard.
 */
export function keyboardOf(read: ObserverRead): KeyboardState {
  if (read.kind === 'away') return { shown: null, onHome: true }
  if (read.kind === 'silent') return { shown: null }
  const state = (read.keyboard as { state?: unknown } | null)?.state
  if (state === BACKGROUND) return { shown: null, onHome: true }
  const keyboard = toKeyboardState(read.keyboard)
  return state === INACTIVE && keyboard.shown === true ? { shown: null } : keyboard
}

/** A read as the focused field: away is `no-app`, as the runner answered an app not in front; silent is `failed`. */
export function fieldOf(read: ObserverRead): { field: FocusedField | null; reason?: FieldReadReason; keyboard?: KeyboardState } {
  if (read.kind === 'away') return { field: null, reason: 'no-app' }
  if (read.kind === 'silent') return { field: null, reason: 'failed' }
  if ((read.keyboard as { state?: unknown } | null)?.state === BACKGROUND) return { field: null, reason: 'no-app' }
  const keyboard = keyboardOf({ kind: 'answer', keyboard: (read.field as { keyboard?: unknown } | null)?.keyboard, field: read.field })
  return { ...toFocusedField(read.field), ...(keyboard.shown !== null ? { keyboard } : {}) }
}
