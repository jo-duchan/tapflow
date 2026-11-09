import type { FieldReadReason, FocusedField, KeyboardState } from '@tapflowio/protocol'
import type { FocusedRead } from './AdbWrapper.js'

type Rect = NonNullable<KeyboardState['rect']>
type Turn = 0 | 90 | 180 | 270

// `AndroidAgent.toNaturalPoint`'s turn, here so this file does not import the agent that imports it.
function turnPoint(turn: Turn, x: number, y: number): { x: number; y: number } {
  switch (turn) {
    case 0: return { x, y }
    case 90: return { x: 1 - y, y: x }
    case 180: return { x: 1 - x, y: 1 - y }
    case 270: return { x: y, y: 1 - x }
  }
}

/** Device pixels in the screen Android draws, as fractions of it: the space a touch with no `space` is in. */
export function normalizeRect(r: Rect, screen: { width: number; height: number }): Rect {
  return { x: r.x / screen.width, y: r.y / screen.height, width: r.width / screen.width, height: r.height / screen.height }
}

/**
 * A screen rect in the frame's space: where the dashboard's body mode measures a touch (`space: 'frame'`). The inverse
 * of `AndroidAgent.fromFrame`, which turns a frame point onto the screen by `turn`; so the same skin and rotation have
 * to be passed in.
 */
export function toFrameRect(r: Rect, turn: Turn): Rect {
  if (turn === 0) return r
  const back = ((360 - turn) % 360) as Turn
  const a = turnPoint(back, r.x, r.y)
  const b = turnPoint(back, r.x + r.width, r.y + r.height)
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return { x, y, width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) }
}

/** The keyboard as `dumpsys window InputMethod` reported it, in both spaces a recorded tap can be in. */
export function keyboardStateOf(
  ime: { shown: boolean; rect?: Rect } | null, screen: { width: number; height: number } | null, frameTurn: Turn,
): KeyboardState {
  if (!ime) return { shown: null }
  if (!ime.shown) return { shown: false }
  if (!ime.rect || !screen) return { shown: true }
  const rect = normalizeRect(ime.rect, screen)
  return { shown: true, rect, frameRect: toFrameRect(rect, frameTurn) }
}

const REASONS = new Set<string>(['no-app', 'no-focus', 'ambiguous', 'secure', 'failed'])

/**
 * The jar's `Focused read` as `ui:field:response` carries it. The frame is normalised like the tree's, which is how an
 * Android field is told from another; a password's value never left the device. The keyboard is stated only when the
 * jar saw its window, since a read that did not is not proof it is down.
 */
export function fieldResponseOf(
  read: FocusedRead | null, screen: { width: number; height: number } | null, frameTurn: Turn,
): { field: FocusedField | null; reason?: FieldReadReason; keyboard?: KeyboardState; language?: string } {
  const keyboard = read?.keyboard && screen ? keyboardStateOf({ shown: true, rect: read.keyboard }, screen, frameTurn) : undefined
  const extra = {
    ...(keyboard ? { keyboard } : {}),
    ...(read?.keyboard && read.language ? { language: read.language } : {}),
  }
  if (!read || !screen) return { field: null, reason: 'failed' }
  if (typeof read.identifier !== 'string' || !read.frame) {
    const reason = read.reason !== undefined && REASONS.has(read.reason) ? read.reason as FieldReadReason : 'failed'
    return { field: null, reason, ...extra }
  }
  const field: FocusedField = {
    identifier: read.identifier,
    // The jar does not read a hint: an Android field's `placeholder` is absent from its tree too (uiautomator dumps none).
    placeholder: '',
    frame: normalizeRect(read.frame, screen),
    secure: read.secure === true,
    ...(read.secure !== true && typeof read.value === 'string' ? { value: read.value } : {}),
  }
  return { field, ...(field.secure ? { reason: 'secure' as const } : {}), ...extra }
}
