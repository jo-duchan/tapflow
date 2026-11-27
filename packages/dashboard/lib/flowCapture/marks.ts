import { toScreen, type RawStep } from '@tapflowio/flow-runner/browser'
import type { AndroidChrome, ChromePayload } from '@tapflowio/protocol'
import { chromeOrientation, toFramePoint } from '@tapflowio/protocol/screen'
import type { MachineTouch, StillTouch } from '@/lib/touchMarks'

/** Where a step touched the screen, as fractions of it — a point, or a stroke's two ends — and a swipe's own length.
 *  `inFrame`: the points are the video frame's own (Android body mode), for a picture that is that frame. */
export type StepMark = StillTouch & { durationMs?: number; inFrame?: boolean }

/**
 * The touch a recorded step made, to draw over a replay or on a picture of the screen, as the MCP watch view draws an
 * agent's. `into` is what the picture is: `frame`, the video frame the replay's mirror copies; `screen`, a screenshot,
 * the screen Android draws.
 *
 * An Android body-mode holder's step is in the frame's own points (`space: 'frame'`), and the agent places a replayed
 * one in the frame it holds — so over the mirror it is drawn as it is, however the frame is turned; until this, none
 * was drawn and Android's replays showed no touch at all. On a screenshot it is turned into the screen by the frame's
 * map there (`AndroidChrome.streamRotation`, recorded with the step), whichever way the body was held — the replay
 * turns the device to the range's start before its screenshots (`rangeStartOrientation`) — and with no map, not
 * drawn. Any other step on a screenshot only while the device was upright: its points are the screen's, which a
 * turned body's frame is not, and a mark in the wrong place says more than none. Over the mirror that is left to
 * `mirrorMark`, which knows the frame's map now: a turned body whose app turns with it has frame and screen the same
 * (CodeRabbit on #1216).
 */
export function markOf(raw: RawStep, into: 'frame' | 'screen' = 'screen'): StepMark | null {
  const chrome = typeof raw.chrome === 'object' && raw.chrome !== null ? raw.chrome as ChromePayload : undefined
  const inFrame = 'space' in raw && raw.space === 'frame'
  if (!inFrame && into === 'screen') {
    const orientation = chrome ? chromeOrientation(chrome) : undefined
    if (orientation !== undefined && orientation !== 'portrait') return null
  }
  let place = (p: [number, number]): { x: number; y: number } => ({ x: p[0], y: p[1] })
  if (inFrame && into === 'screen') {
    const turn = chrome && !('framePng' in chrome) ? (chrome as AndroidChrome).streamRotation : undefined
    if (turn === undefined) return null
    place = (p) => { const [x, y] = toScreen(p, 'frame', { frameTurn: turn }); return { x, y } }
  }
  const frame = inFrame && into === 'frame' ? { inFrame: true } : {}
  switch (raw.kind) {
    case 'tap': case 'longPress': case 'keyboardKey': return { kind: 'tap', point: place(raw.point), ...frame }
    case 'swipe': case 'holdDrag':
      return { kind: 'swipe', from: place(raw.from), to: place(raw.to), durationMs: raw.durationMs, ...frame }
    case 'pinch':
      return { kind: 'pinch', from: [place(raw.start[0]), place(raw.start[1])], to: [place(raw.end[0]), place(raw.end[1])], durationMs: raw.durationMs, ...frame }
    default: return null
  }
}

/**
 * A replayed touch as it is drawn over the mirror, which copies the video frame, or `null` where it cannot be. One in
 * the frame's own points is drawn as it is. One in the screen's — a named tap, Verify's steps — is carried into the frame
 * on Android by the inverse of the frame-to-screen map (`streamRotation`): an upright unfolded foldable, or an app locked
 * to landscape, has a turn there, and the point drawn as it is lands a quarter off (adversarial review; CodeRabbit on
 * #1216). A map of 0 — an app turning with a turned body — carries it as it is. With no map (iOS, the scrcpy path, an
 * older agent), only while the device is upright, the frame then being the screen.
 */
export function mirrorMark(mark: StepMark, chrome: ChromePayload | null): StepMark | null {
  if (mark.inFrame) return mark
  const turn = chrome && !('framePng' in chrome) ? (chrome as AndroidChrome).streamRotation : undefined
  if (turn !== undefined) {
    const f = (p: { x: number; y: number }) => { const [x, y] = toFramePoint(turn, [p.x, p.y]); return { x, y } }
    switch (mark.kind) {
      case 'tap': return { ...mark, point: f(mark.point), inFrame: true }
      case 'swipe': return { ...mark, from: f(mark.from), to: f(mark.to), inFrame: true }
      case 'pinch': return { ...mark, from: [f(mark.from[0]), f(mark.from[1])], to: [f(mark.to[0]), f(mark.to[1])], inFrame: true }
    }
  }
  const o = chrome ? chromeOrientation(chrome) : undefined
  return o === undefined || o === 'portrait' ? mark : null
}

/**
 * A replayed step's touch, to play over the device from `at`. Only the latest is drawn: a replay is watched for the step
 * it is on, and an earlier stroke left on the picture read as that swipe made again (user, session ff5d3d3c).
 */
export function touchOfMark(id: number, mark: StepMark, at: number): MachineTouch {
  switch (mark.kind) {
    case 'tap': return { id, at, kind: 'tap', point: mark.point }
    case 'swipe': return { id, at, kind: 'swipe', from: mark.from, to: mark.to, durationMs: mark.durationMs }
    case 'pinch': return { id, at, kind: 'pinch', from: mark.from, to: mark.to, durationMs: mark.durationMs }
  }
}
