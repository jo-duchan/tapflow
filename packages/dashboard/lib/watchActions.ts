import type { WatchActionKind } from '@tapflowio/protocol'
import type { MachineTouch } from '@/lib/touchMarks'

/** A holder's action as the watch page keeps it (A2): when the relay saw it, and an id for lists and timers. */
export interface WatchedAction {
  id: number
  at: number
  action: WatchActionKind
}

/** The list keeps this many; older ones fall off. Nothing is stored anywhere — a reload starts empty. */
export const MAX_ACTIONS = 100

/**
 * An action's touch, to draw over the device from `at` (the page's clock when it arrived). Only the latest is drawn:
 * the motion is the same one a person's pointer makes (`lib/touchMarks`), so a touch the page has not drawn yet is
 * not queued behind one it is drawing.
 */
export function touchOfAction(id: number, a: Extract<WatchActionKind, { kind: 'tap' | 'swipe' }>, at: number): MachineTouch {
  return a.kind === 'tap'
    ? { id, at, kind: 'tap', point: { x: a.x, y: a.y } }
    : { id, at, kind: 'swipe', from: { x: a.from[0], y: a.from[1] }, to: { x: a.to[0], y: a.to[1] } }
}

/** A line for the Actions list. Positions as percentages of the screen, which is what they are on the wire. */
export function actionText(a: WatchActionKind): string {
  const pct = (n: number) => `${Math.round(n * 100)}%`
  switch (a.kind) {
    case 'label': return a.label
    case 'tap': return `Tap at ${pct(a.x)}, ${pct(a.y)}`
    case 'swipe': return `Swipe ${direction(a.from, a.to)}`
    case 'key': return a.key === 'character' ? 'Key (a character)' : `Key ${a.key}`
    case 'button': return `Button ${a.button}`
    case 'type': return `Typed ${a.chars} ${a.chars === 1 ? 'character' : 'characters'}`
    case 'pinch': return 'Pinch'
    case 'launch': return 'Launched the app'
    case 'install': return 'Installed a build'
    case 'clear-state': return 'Cleared the app\'s data'
    case 'open-url': return 'Opened a link'
  }
}

function direction(from: [number, number], to: [number, number]): string {
  const dx = to[0] - from[0]
  const dy = to[1] - from[1]
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 'right' : 'left'
  return dy > 0 ? 'down' : 'up'
}

/** Whether an action is drawn on the device. */
export function isMark(a: WatchActionKind): a is Extract<WatchActionKind, { kind: 'tap' | 'swipe' }> {
  return a.kind === 'tap' || a.kind === 'swipe'
}

/**
 * A point on an iOS screen (0–1) as a position in the whole device frame, which is the box the iOS screen's overlay
 * spans — the same conversion as the QA viewer's touch marks. `layout` is `iosScreenLayout(chrome)`.
 */
export function placeOnIosFrame(layout: { screenPctLeft: number; screenPctTop: number; screenPctW: number; screenPctH: number }) {
  return (x: number, y: number) => ({
    left: (layout.screenPctLeft + x * layout.screenPctW) / 100,
    top: (layout.screenPctTop + y * layout.screenPctH) / 100,
  })
}
