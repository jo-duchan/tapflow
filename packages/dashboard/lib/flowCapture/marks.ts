import type { RawStep } from '@tapflowio/flow-runner/browser'
import type { ChromePayload } from '@tapflowio/protocol'
import { chromeOrientation } from '@tapflowio/protocol/screen'
import { trailOf, type WatchMarks } from '@/lib/watchActions'

/** Where a step touched the screen, as fractions of it: a point, or a stroke's two ends. */
export type StepMark = { kind: 'tap'; x: number; y: number } | { kind: 'swipe'; from: [number, number]; to: [number, number] }

/**
 * The touch a recorded step made, to draw on a picture of the screen, as the MCP watch view draws an agent's. Only
 * while the device was upright: a turned screen's points are in another frame than its picture, and a mark in the
 * wrong place says more than none.
 */
export function markOf(raw: RawStep): StepMark | null {
  const orientation = typeof raw.chrome === 'object' && raw.chrome !== null ? chromeOrientation(raw.chrome as ChromePayload) : undefined
  if (orientation !== undefined && orientation !== 'portrait') return null
  switch (raw.kind) {
    case 'tap': case 'longPress': case 'keyboardKey': return { kind: 'tap', x: raw.point[0], y: raw.point[1] }
    case 'swipe': case 'holdDrag': return { kind: 'swipe', from: raw.from, to: raw.to }
    default: return null
  }
}

/** The marks after one more touch: the cursor moves to it and it leaves a trail, the last few kept. */
export function addMark(marks: WatchMarks, id: number, mark: StepMark): WatchMarks {
  const action = mark.kind === 'tap' ? { kind: 'tap' as const, x: mark.x, y: mark.y } : { kind: 'swipe' as const, from: mark.from, to: mark.to }
  const to = mark.kind === 'tap' ? { x: mark.x, y: mark.y } : { x: mark.to[0], y: mark.to[1] }
  return { cursor: to, trails: [...marks.trails.slice(-3), trailOf(id, action, marks.cursor)] }
}
