import type { RawStep } from '@tapflowio/flow-runner/browser'
import type { ChromePayload } from '@tapflowio/protocol'
import { chromeOrientation } from '@tapflowio/protocol/screen'
import type { MachineTouch, StillTouch } from '@/lib/touchMarks'

/** Where a step touched the screen, as fractions of it — a point, or a stroke's two ends — and a swipe's own length. */
export type StepMark = StillTouch & { durationMs?: number }

/**
 * The touch a recorded step made, to draw on a picture of the screen or over a replay, as the MCP watch view draws an
 * agent's. Only while the device was upright: a turned screen's points are in another frame than its picture, and a
 * mark in the wrong place says more than none.
 */
export function markOf(raw: RawStep): StepMark | null {
  const orientation = typeof raw.chrome === 'object' && raw.chrome !== null ? chromeOrientation(raw.chrome as ChromePayload) : undefined
  if (orientation !== undefined && orientation !== 'portrait') return null
  switch (raw.kind) {
    case 'tap': case 'longPress': case 'keyboardKey': return { kind: 'tap', point: { x: raw.point[0], y: raw.point[1] } }
    case 'swipe': case 'holdDrag':
      return { kind: 'swipe', from: { x: raw.from[0], y: raw.from[1] }, to: { x: raw.to[0], y: raw.to[1] }, durationMs: raw.durationMs }
    default: return null
  }
}

/**
 * A replayed step's touch, to play over the device from `at`. Only the latest is drawn: a replay is watched for the step
 * it is on, and an earlier stroke left on the picture read as that swipe made again (user, session ff5d3d3c).
 */
export function touchOfMark(id: number, mark: StepMark, at: number): MachineTouch {
  return mark.kind === 'tap'
    ? { id, at, kind: 'tap', point: mark.point }
    : { id, at, kind: 'swipe', from: mark.from, to: mark.to, durationMs: mark.durationMs }
}
