import { useId } from 'react'
import type { WatchMarks } from '@/lib/watchActions'

const BLUE = 'rgb(59 130 246)'
const pct = (n: number) => `${n * 100}%`

/**
 * A swipe's stroke, inside an SVG laid over the picture (positions as fractions of it): dashed, faint where the finger
 * went down and strong where it lifted, with a dot there, so its direction reads at a glance. One look for every place a
 * touch is drawn — the MCP watch view, and Flow Capture's replay and its step pictures.
 */
export function SwipeStroke({ from, to }: { from: { left: number; top: number }; to: { left: number; top: number } }) {
  // A url(#…) reference with React's `:r1:` ids in it is not resolved everywhere: the colons go.
  const id = `swipe-${useId().replace(/:/g, '')}`
  return (
    <>
      <defs>
        <linearGradient id={id} gradientUnits="userSpaceOnUse" x1={pct(from.left)} y1={pct(from.top)} x2={pct(to.left)} y2={pct(to.top)}>
          <stop offset="0" stopColor={BLUE} stopOpacity={0.1} />
          <stop offset="1" stopColor={BLUE} stopOpacity={0.9} />
        </linearGradient>
      </defs>
      <line x1={pct(from.left)} y1={pct(from.top)} x2={pct(to.left)} y2={pct(to.top)}
        stroke={`url(#${id})`} strokeWidth={4} strokeLinecap="round" strokeDasharray="1 9" />
      <circle cx={pct(to.left)} cy={pct(to.top)} r={5} fill={BLUE} />
    </>
  )
}

/**
 * The agent's pointer on the device (A2), the way computer-use views show one: a blue cursor that stays at the last
 * tap and glides to the next, a trail of where it came from that fades, and a ripple where it lands. A swipe draws its
 * stroke and leaves the cursor at its end. `place` turns a point on the device's screen (0–1, as on the wire) into a
 * position in the overlay's own box — the whole device frame on iOS, the screen on Android.
 *
 * Under the stalled-stream notice (z 8), so nothing here suggests live input on a picture the page says has stopped.
 * With reduced motion the cursor moves without gliding and nothing ripples.
 */
export function TapMarks({ marks, place }: {
  marks: WatchMarks
  place: (x: number, y: number) => { left: number; top: number }
}) {
  const cursor = marks.cursor && place(marks.cursor.x, marks.cursor.y)
  return (
    <div aria-hidden="true" data-testid="tap-marks" className="pointer-events-none absolute inset-0" style={{ zIndex: 5 }}>
      {marks.trails.map((t) => {
        const b = place(...t.to)
        const a = t.from && place(...t.from)
        return (
          <span key={t.id}>
            {a && (
              <svg data-testid="trail" className="absolute inset-0 size-full overflow-visible motion-safe:animate-[swipe-mark_0.8s_ease-out_forwards]">
                {t.kind === 'swipe'
                  ? <SwipeStroke from={a} to={b} />
                  : <line x1={pct(a.left)} y1={pct(a.top)} x2={pct(b.left)} y2={pct(b.top)}
                      stroke={BLUE} strokeOpacity={0.45} strokeWidth={3} strokeLinecap="round" strokeDasharray="1 7" />}
              </svg>
            )}
            <span
              data-testid="ripple"
              className="absolute size-10 rounded-full border-2 border-blue-500 opacity-0 motion-safe:animate-[tap-mark_0.7s_ease-out_0.2s_forwards]"
              style={{ left: pct(b.left), top: pct(b.top), transform: 'translate(-50%, -50%)' }}
            />
          </span>
        )
      })}
      {cursor && (
        <span
          data-testid="tap-cursor"
          className="absolute size-7 rounded-full border-2 border-blue-500 bg-blue-500/35 shadow-[0_0_0_2px_rgba(255,255,255,0.85),0_2px_8px_rgba(0,0,0,0.3)] motion-safe:transition-[left,top] motion-safe:duration-300 motion-safe:ease-out"
          style={{ left: pct(cursor.left), top: pct(cursor.top), transform: 'translate(-50%, -50%)' }}
        />
      )}
    </div>
  )
}
