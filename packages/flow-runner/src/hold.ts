/** How often a held finger's point is sent again: a 60 Hz frame. */
export const HOLD_FRAME_MS = 16
/** A held finger is never quite still, and the same point sent again is no new sample to iOS: held without it, the
 *  content still glided on at the lift as after a fling (measured, SwiftUI List). 0.0005 of the screen, ~75 px/s on a
 *  phone, under Android's minimum fling velocity too. */
export const HOLD_WOBBLE = 0.0005
/** The longest hold a swipe takes: a drag that has to stop needs a fraction of a second. */
export const MAX_HOLD_MS = 60_000

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * Keep a finger still at `to` for `holdMs` before it lifts, so the release has no speed and the content stops where
 * the finger left it: a drag rather than a fling. Sends the point (wobbling by `HOLD_WOBBLE`) every frame, starting at
 * `to` itself — the end carries no point the agents use, they lift at the last move. Bounded by the clock, not a count:
 * a hidden tab's timers run a second apart. `false` when `stillOpen` says the gesture was taken away meanwhile.
 * Android's adb fallback replays a gesture as one `input swipe` after its end, and so still flings.
 */
export async function holdStill(
  to: readonly [number, number],
  holdMs: number,
  move: (point: { x: number; y: number }) => void,
  stillOpen: () => boolean = () => true,
  now: () => number = () => performance.now(),
): Promise<boolean> {
  // On a monotonic clock: a wall clock set back mid-hold would hold the finger down until it caught up (CodeRabbit).
  const until = now() + holdMs
  // Toward the middle at an edge, so every point stays on the screen.
  const wobble = to[1] + HOLD_WOBBLE > 1 ? -HOLD_WOBBLE : HOLD_WOBBLE
  let tick = 0
  do {
    if (!stillOpen()) return false
    move({ x: to[0], y: to[1] + (tick++ % 2 === 0 ? 0 : wobble) })
    await delay(Math.max(0, Math.min(HOLD_FRAME_MS, until - now())))
  } while (now() < until)
  // Taken away during the last wait is taken away too.
  return stillOpen()
}
