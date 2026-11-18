import type { ObservedElement, TouchObservation } from '@tapflowio/protocol'
import { DECOR_IDS, toRole } from './uiTree.js'

/**
 * Record-time observation on Android (Flow Capture P4): the facts iOS's app observer reports from inside the app,
 * read from outside it — what a touch-down hit (the jar's `Hit`, through the field server) and whether the app drew
 * after it (`dumpsys gfxinfo <pkg> framestats`). Pure functions; `AndroidAgent` asks and sends. Measurements and the
 * design review behind every rule here: the P4 plan in `.work` and android-agent AGENTS.md, "Touch observation".
 */

/** `AccessibilityWindowInfo` types. */
const TYPE_APPLICATION = 1
const TYPE_INPUT_METHOD = 2

/** As the iOS observer cuts them: the relay refuses an observation past 1024. */
const OBSERVED_TEXT_MAX = 256

/** One node of the branch under the point, deepest first, as `Hit.java` writes it. */
export interface HitNode {
  /** Class name. */
  c?: string
  /** Resource id. */
  id?: string
  /** Text; never a text field's or a password's. */
  t?: string
  /** Content description. */
  d?: string
  /** Flags: 1 clickable, 2 long-clickable, 4 editable, 8 password, 16 scrollable, 32 checkable. */
  k?: number
  /** Bounds in screen pixels: left, top, right, bottom. */
  b: [number, number, number, number]
}

/** The jar's answer to `hit x y`. Device times are `System.nanoTime` (CLOCK_MONOTONIC). */
export interface HitAnswer {
  /** When the server read the request. */
  rx: number
  /** When the branch was read; absent when no window was found. */
  done?: number
  /** The screen as drawn, in pixels: the basis frames are normalised by (Reach's). */
  w: number
  h: number
  /** The topmost window at the point: its type and package. */
  type?: number
  pkg?: string
  /** The package of the topmost application window anywhere: the app a soft keyboard is typing into. */
  under?: string
  branch?: HitNode[]
}

const K_CLICKABLE = 1, K_LONG_CLICKABLE = 2, K_EDITABLE = 4, K_PASSWORD = 8, K_SCROLLABLE = 16

export function parseHit(out: string | null | undefined): HitAnswer | null {
  if (!out) return null
  let v: unknown
  try { v = JSON.parse(out) } catch { return null }
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const num = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)
  if (!num(o['rx']) || !num(o['w']) || !num(o['h'])) return null
  const hit: HitAnswer = { rx: o['rx'], w: o['w'], h: o['h'] }
  if (num(o['done'])) hit.done = o['done']
  if (num(o['type'])) hit.type = o['type']
  if (typeof o['pkg'] === 'string') hit.pkg = o['pkg']
  if (typeof o['under'] === 'string') hit.under = o['under']
  if (Array.isArray(o['branch'])) {
    hit.branch = o['branch'].flatMap((n: unknown): HitNode[] => {
      if (!n || typeof n !== 'object') return []
      const r = n as Record<string, unknown>
      const b = r['b']
      if (!Array.isArray(b) || b.length !== 4 || !b.every(num)) return []
      const node: HitNode = { b: b as HitNode['b'] }
      for (const key of ['c', 'id', 't', 'd'] as const) if (typeof r[key] === 'string') node[key] = r[key] as string
      if (num(r['k'])) node.k = r['k']
      return [node]
    })
  }
  return hit
}

/** What the hit says about a touch, before any frame is counted. */
export type Seen =
  /** The topmost window there is not the app under test (the launcher, a permission dialog, the status bar): no report,
   *  as iOS's observer, which lives in the app, reports none. */
  | { kind: 'elsewhere' }
  | {
    kind: 'app'
    observation: Pick<TouchObservation, 'surface' | 'element' | 'button'>
    /** Some node on the branch takes touches (clickable, long-clickable, editable): a tap there drew nothing and still
     *  may have acted, so it is never `acted: false`. */
    takes: boolean
    /** Some node on the branch scrolls. */
    scrollable: boolean
    /** A surface the tree cannot see into or whose drawing says nothing about the touch: no `acted`. */
    opaque: boolean
  }

const isWeb = (c: string) => /WebView/.test(c)
const isFlutter = (c: string) => /flutter/i.test(c)
// A view that draws through its own surface (GL, video, a game, a map): its frames are not the app's view drawing.
const isOwnSurface = (c: string) => /SurfaceView|TextureView/.test(c)

/**
 * The touch as the app's accessibility names it, by `uiTree.ts`'s rules, so the element named is one the replay's
 * tree has: the role from the class, the label as text else content description, the id unless it is the window's
 * decor, an input named by its id only. `null` when the hit found no window.
 */
export function seenAt(hit: HitAnswer, appPackage: string): Seen | null {
  if (hit.type === undefined) return null
  if (hit.type === TYPE_INPUT_METHOD) {
    // The soft keyboard over the app under test: a key, said as iOS says it, with nothing else.
    return hit.under === appPackage
      ? { kind: 'app', observation: { surface: 'keyboard' }, takes: true, scrollable: false, opaque: true }
      : { kind: 'elsewhere' }
  }
  if (hit.type !== TYPE_APPLICATION || hit.pkg !== appPackage) return { kind: 'elsewhere' }
  const branch = hit.branch ?? []
  const has = (k: number) => branch.some((n) => ((n.k ?? 0) & k) !== 0)
  const takes = has(K_CLICKABLE | K_LONG_CLICKABLE | K_EDITABLE)
  const scrollable = has(K_SCROLLABLE)
  const classes = branch.map((n) => n.c ?? '')
  const surface = classes.some(isWeb) ? 'web' as const : classes.some(isFlutter) ? 'flutter' as const : undefined
  if (surface) return { kind: 'app', observation: { surface }, takes, scrollable, opaque: true }
  const opaque = classes.some(isOwnSurface)

  const observation: Pick<TouchObservation, 'element' | 'button'> = {}
  for (const n of branch) {
    const named = observedOf(n, hit)
    if (!named) continue
    observation.element ??= named
    if (named.traits & 1) { observation.button = named; break }
  }
  return { kind: 'app', observation, takes, scrollable, opaque }
}

/** A node as an `ObservedElement`, or `null` for one the tree would not let a selector find by name. */
function observedOf(n: HitNode, hit: HitAnswer): ObservedElement | null {
  const role = toRole(n.c ?? '')
  // Editable whatever its class (a custom view, React Native): a content description there can hold the value.
  const input = role === 'input' || ((n.k ?? 0) & (K_EDITABLE | K_PASSWORD)) !== 0
  const identifier = n.id && !DECOR_IDS.has(n.id) ? n.id.slice(0, OBSERVED_TEXT_MAX) : undefined
  const label = input ? undefined : (n.t || n.d || '').slice(0, OBSERVED_TEXT_MAX) || undefined
  if (!identifier && !label) return null
  const el: ObservedElement = { traits: role === 'button' ? 1 : 0 }
  if (identifier) el.identifier = identifier
  if (label) el.label = label
  if (input) el.input = true
  const frame = frameOf(n.b, hit.w, hit.h)
  if (frame) el.frame = frame
  return el
}

/** Clipped to the screen and normalised, as `uiTree.ts` makes a tree's frames. */
function frameOf([l, t, r, b]: HitNode['b'], w: number, h: number): ObservedElement['frame'] | undefined {
  if (w <= 0 || h <= 0) return undefined
  const x1 = Math.max(0, l), y1 = Math.max(0, t), x2 = Math.min(w, r), y2 = Math.min(h, b)
  if (x2 <= x1 || y2 <= y1) return undefined
  const r4 = (v: number) => Math.round(v * 10000) / 10000
  const f4 = (v: number) => Math.max(0, Math.floor(v * 10000 + 1e-9) / 10000)
  return { x: r4(x1 / w), y: r4(y1 / h), width: f4(x2 / w - r4(x1 / w)), height: f4(y2 / h - r4(y1 / h)) }
}

/** The app's frames, from one `dumpsys gfxinfo <pkg> framestats`. Times are device CLOCK_MONOTONIC ns. */
export interface Frames {
  /** The app's process: what a touch's `seq` counts in. */
  pid: number
  /** When each frame the app drew completed, ascending; one per vsync across its windows. */
  completed: number[]
  /** From when on every frame is listed: a window whose ring of recent frames is full lists only its newest. */
  since: number
}

/** gfxinfo keeps the last 120 frames per window (`FrameInfo` ring, Android 14). */
const RING = 120
/** `FrameInfoFlags::SkippedFrame`: a frame that drew nothing. */
const SKIPPED = 8

export function parseFramestats(text: string): Frames | null {
  const pid = /\*\* Graphics info for pid (\d+) \[/.exec(text)
  if (!pid) return null
  const byVsync = new Map<string, number>()
  let since = 0
  const sections = text.split('---PROFILEDATA---')
  // Sections alternate: text, data, text, data … — each window's data sits between a pair of markers.
  for (let i = 1; i < sections.length; i += 2) {
    const lines = sections[i]!.split('\n').map((l) => l.trim()).filter(Boolean)
    const header = lines[0]?.split(',') ?? []
    const flagsAt = header.indexOf('Flags'), vsyncAt = header.indexOf('IntendedVsync'), doneAt = header.indexOf('FrameCompleted')
    if (flagsAt < 0 || vsyncAt < 0 || doneAt < 0) continue
    const rows = lines.slice(1).map((l) => l.split(',')).filter((r) => r.length > doneAt)
    let earliest = Infinity
    for (const r of rows) {
      const done = Number(r[doneAt])
      if (!(done > 0)) continue
      earliest = Math.min(earliest, done)
      if ((Number(r[flagsAt]) & SKIPPED) !== 0) continue
      const key = r[vsyncAt]!
      byVsync.set(key, Math.max(byVsync.get(key) ?? 0, done))
    }
    if (rows.length >= RING && Number.isFinite(earliest)) since = Math.max(since, earliest)
  }
  return { pid: Number(pid[1]), completed: [...byVsync.values()].sort((a, b) => a - b), since }
}

const MS = 1_000_000
/** The window before a down the app must have been quiet in for its frames after to mean the touch (m3). */
const BEFORE_NS = 150 * MS
/** Frames the app draws after a lift on its own response: the iOS observer's verdict window, near enough (m3). */
export const AFTER_NS = 800 * MS
/** A list still gliding draws every vsync: at least this many in [down−150, down−10] ms (60 Hz gives ~8). */
const GLIDING_FRAMES = 6
/** …and stops when the touch stops it: no more than this many from 50 ms after the down to the end of the verdict
 *  window. A spinner or a shimmer goes on drawing through the touch, and is not a list the touch stopped. */
const STOPPED_FRAMES = 3
/** A fling that left a list gliding ended this recently. */
export const GLIDE_AFTER_SWIPE_NS = 3_000 * MS
/** More frames than a View row's one redraw: a control that answered (m3: 6–53 on Compose and React Native). */
const ACTED_FRAMES = 2

export interface TouchFacts {
  frames: Frames | null
  /** The down and the up on the device's clock. */
  downNs: number
  upNs: number
  /** The finger moved past the slop: a swipe or a drag, which get no `acted` (as iOS). */
  moved: boolean
  /** The previous touch was a swipe or drag that ended at this time (device clock). */
  swipeEndNs?: number
  /** The previous tap's lift (device clock): a tap inside its after-window cannot be told from its answer. */
  previousTapUpNs?: number
  seen: Extract<Seen, { kind: 'app' }>
}

/**
 * `moving` and `acted` from the frames. Biased the way a wrong answer costs least: `moving` true drops the tap from
 * the replay, so it needs every sign (a fling just before, the app drawing every vsync up to the touch, a list under
 * it); `acted` is left unknown wherever the frames could be someone else's — the app drawing already, the previous
 * tap's answer, a surface — and false only where nothing on the branch takes touches.
 */
export function judgeTouch(f: TouchFacts): { moving: boolean; acted?: boolean } {
  const frames = f.frames
  const covered = frames !== null && frames.since <= f.downNs - BEFORE_NS
  const count = (from: number, to: number) => frames ? frames.completed.filter((t) => t >= from && t <= to).length : 0
  const moving = covered
    && f.swipeEndNs !== undefined && f.downNs - f.swipeEndNs <= GLIDE_AFTER_SWIPE_NS
    && f.seen.scrollable
    && count(f.downNs - BEFORE_NS, f.downNs - 10 * MS) >= GLIDING_FRAMES
    && count(f.downNs + 50 * MS, f.upNs + AFTER_NS) <= STOPPED_FRAMES
  if (!covered || f.moved || f.seen.opaque || f.seen.observation.surface) return { moving }
  if (f.previousTapUpNs !== undefined && f.downNs - f.previousTapUpNs < AFTER_NS) return { moving }
  if (count(f.downNs - BEFORE_NS, f.downNs) > 0) return { moving }
  const after = count(f.downNs + 1, f.upNs + AFTER_NS)
  if (after >= ACTED_FRAMES) return { moving, acted: true }
  if (after === 0 && !f.seen.takes) return { moving, acted: false }
  return { moving }
}
