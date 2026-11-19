import type { KeyboardState, PointSpace } from '@tapflowio/protocol'
import type { CaptureEntry } from '@tapflowio/protocol/capture'

type KeyboardRead = Extract<CaptureEntry, { kind: 'keyboard' }>

/**
 * What a touch was, by the soft keyboard read on either side of it (#1135). A tap on a key types by the device's
 * keyboard, in its language, and only the field's value says what it typed; a tap on the app is a step. No recorder
 * judges this by the point alone (Espresso, Detox and Robo record the field's value instead), so this is judged by
 * reads, and said `unknown` when they cannot tell.
 */
export type TouchVerdict = 'app' | 'key' | 'imeAction' | 'unknown'

/** Where a keyboard's own action key is: its right edge, low down. Generous on purpose — an `imeAction` also needs the
 *  keyboard to have closed after the tap, which no other key on it does. */
const ACTION_KEY = { fromRight: 0.3, fromBottom: 0.45 }

const rectIn = (k: KeyboardState, space: PointSpace | undefined) => (space === 'frame' ? k.frameRect ?? k.rect : k.rect)

function on(k: KeyboardState | undefined, [x, y]: [number, number], space: PointSpace | undefined): boolean {
  const r = k?.shown === true ? rectIn(k, space) : undefined
  return r !== undefined && x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height
}

type Rect = NonNullable<KeyboardState['rect']>

/** Down, or up with no part on the screen: iOS still reads its keyboard as shown after the action key put it away, at
 *  the bottom edge and below it (measured, iOS 26.5: `y` 1.0, `height` 0.05), and so with a hardware keyboard. */
function closed(k: KeyboardState | undefined): boolean {
  if (k?.shown === false) return true
  const r = k?.shown === true ? k.rect : undefined
  return r !== undefined && (r.y >= 1 || r.x >= 1 || r.y + r.height <= 0 || r.x + r.width <= 0)
}
const sameRect = (a: Rect, b: Rect): boolean => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height

function onActionKey(k: KeyboardState, [x, y]: [number, number], space: PointSpace | undefined): boolean {
  const r = rectIn(k, space)
  if (!r) return false
  // A turned frame's rect has the keyboard's sides somewhere else: only an unturned one (the same rect) is judged.
  if (space === 'frame' && k.frameRect && k.rect && !sameRect(k.frameRect, k.rect)) return false
  return x >= r.x + r.width * (1 - ACTION_KEY.fromRight) && y >= r.y + r.height * (1 - ACTION_KEY.fromBottom)
}

/** The keyboard reads of a capture and the times of its inputs, for judging each touch against them. */
export interface KeyboardTimeline {
  reads: KeyboardRead[]
  inputs: number[]
  /** When the soft keyboard was toggled from the dashboard. */
  toggles: number[]
}

export function keyboardTimeline(entries: readonly CaptureEntry[]): KeyboardTimeline | null {
  // A read that could not tell is no read: taken as one, it made the touch after it unknown although the next read said
  // the keyboard was down (measured on iOS, the first reads of a session before its runner answered).
  // Still a timeline when every read was one: a device that answers is asked about each touch, and none known is unknown.
  const reads = entries.flatMap((e) => (e.kind === 'keyboard' ? [e] : []))
  if (reads.length === 0) return null
  return {
    reads: reads.filter((r) => r.keyboard.shown !== null),
    inputs: entries.flatMap((e) => (e.kind === 'input' ? [e.at] : [])),
    toggles: entries.flatMap((e) => (e.kind === 'input' && e.msg.type === 'input:keyboard:toggle' ? [e.at] : [])),
  }
}

/**
 * A touch from `startAt` to `endAt` at `point`, judged by the read just before it and the one it settled to after:
 *
 * - On the keyboard before and after: a key. Its keyboard stayed up through it, so even a read taken before an earlier
 *   key says where it was, and one taken after a later key says it stayed: fast typing outruns the reads, and a keyboard
 *   cannot close and open again between two keys (it slides for ~250 ms).
 * - On the keyboard before, closed after: its action key when the tap was there and the read before it is fresh;
 *   anything else closing the keyboard is not known.
 * - No keyboard read before it at all (a capture's first touch): an app tap if the keyboard was down or elsewhere after.
 * - Otherwise only a fresh read before it decides — asked after the input before this one, so nothing came between
 *   it and the touch — and a keyboard that was down, or up elsewhere, makes it an app tap. A field at the bottom of
 *   the screen that a keyboard then covers is an app tap by this, as it was. Not when the keyboard was up elsewhere and
 *   settled over the point after: a keyboard still sliding in reads as up but not yet there (measured on iOS: two reads
 *   350 ms apart after a soft-keyboard toggle both had it below the screen, and it was over the point 2 s later).
 */
export function judgeTouch(
  t: KeyboardTimeline, startAt: number, endAt: number, point: [number, number], space: PointSpace | undefined,
): TouchVerdict {
  const before = t.reads.filter((r) => r.at <= startAt).at(-1)
  const previousInput = t.inputs.filter((at) => at < startAt).at(-1)
  const nextInput = t.inputs.find((at) => at > endAt)
  const after = t.reads.filter((r) => r.requestedAt >= endAt && (nextInput === undefined || r.at < nextInput))
  const settledAfter = after.filter((r) => r.settled).at(-1) ?? after.at(-1)
  const b = before?.keyboard
  const a = settledAfter?.keyboard
  const onBefore = on(b, point, space)
  const fresh = before !== undefined && (previousInput === undefined || before.requestedAt >= previousInput)

  // The read after this touch, or failing that, the first after a later one: for a key only (see above).
  const later = a ?? t.reads.find((r) => r.requestedAt >= endAt)?.keyboard
  // Just after a toggle, the reads before the touch say where the keyboard was, not where it is: iOS went on reading the
  // keyboard it put up as below the screen until the next input (measured twice in one E2E), and that first key was
  // left unknown. The read after says where it came to rest; a person tapping there was tapping the keyboard they saw.
  if (previousInput !== undefined && t.toggles.includes(previousInput)) {
    if (on(a, point, space)) return 'key'
    // The toggle put the keyboard up and this touch put it away: its action key, by everything but a read that could
    // place it (review: Return as the first touch after a toggle replayed onto a tab).
    const beforeToggle = t.reads.filter((r) => r.at <= previousInput).at(-1)?.keyboard
    if (closed(a) && closed(beforeToggle)) return 'unknown'
    return a?.shown === false || a?.shown === true ? 'app' : 'unknown'
  }
  if (onBefore && on(later, point, space)) return 'key'
  if (onBefore && closed(a)) return fresh && onActionKey(b!, point, space) ? 'imeAction' : 'unknown'
  if (!before) return a?.shown === false || (a?.shown === true && !on(a, point, space)) ? 'app' : 'unknown'
  if (!fresh) return 'unknown'
  if (b!.shown === false) return 'app'
  if (b!.shown === true && !onBefore) return on(a, point, space) ? 'unknown' : 'app'
  return 'unknown'
}

/**
 * The keyboard language a replay of the steps from `startAt` begins in (#1135): the first the relay read from then on,
 * else the last before it. A replay is the person's actions again, so it starts from the keyboard they started from — a
 * keyboard left in another language shows other keys, and a key the reads could not place lands on another character.
 * `undefined` when no read named one: the host then puts the device in its first language.
 */
export function rangeStartKeyboard(entries: readonly CaptureEntry[], startAt: number): string | undefined {
  const named = entries.flatMap((e) => (e.kind === 'field' && e.language ? [{ at: e.at, language: e.language }] : []))
  return (named.find((r) => r.at >= startAt) ?? named.filter((r) => r.at < startAt).at(-1))?.language
}
