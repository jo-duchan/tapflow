import type { ChromeButton, FormFactor } from '@tapflowio/protocol'

export interface Rect { left: number; top: number; right: number; bottom: number }

/**
 * Where a physical side button sits when nothing is hovering it, in 2× composite px.
 *
 * **These are the numbers `IOSDeviceScreen` draws the button at**, and they have to stay that way: a hit
 * area computed from a different position than the pixels the user is aiming at is a target that
 * lies about where it is. The renderer's resting placement is
 * `left: rolloverOffset.x - buttonW / 2`, and a top-edge button (an iPad's power button, an iPad
 * mini's volume pair) takes its `top` from `rolloverOffset.y` while every other anchor measures from
 * `normalOffset.y`.
 *
 * `normalOffset` is the retracted position and `rolloverOffset` the extended one; this UI draws
 * buttons extended at rest, which is why the horizontal centre comes from the rollover pair.
 */
export function buttonHitRect(btn: ChromeButton): Rect {
  const left = btn.rolloverOffset.x - btn.buttonW / 2
  const top = btn.anchor === 'top' ? btn.rolloverOffset.y : btn.normalOffset.y - btn.buttonH / 2
  return { left, top, right: left + btn.buttonW, bottom: top + btn.buttonH }
}

/**
 * The area each button answers to, in 2× composite px, laid out once per layout as an element the
 * browser hit-tests — so the landscape rotation is the container's transform, not arithmetic here.
 *
 * **Along its edge a target is exactly as long as the button.** WCAG 2.5.8's 24 × 24 CSS px counts
 * the whole target, and every side button is already longer than that (an iPhone 15 Pro's Action is
 * about 29 CSS px). The 100 composite px margin the hit test carried before #785 added about 40 CSS
 * px above and below each button on top of that, which no criterion asked for and which a tester
 * found too wide. With no growth along the edge two targets cannot overlap, so there is nothing to
 * split and nothing for listing order to decide — the two halves of #783.
 *
 * **Across the edge it runs from the frame's box to the button's centre line.**
 *
 * - Outwards, the box: the old hit test ran in the container's pointer handlers, so nothing outside
 *   the box could press anything. An element can overflow its container, and an unclipped target
 *   reached about 35 CSS px into the page, where a click in the gap between the device and the
 *   status card pressed Power.
 * - Inwards, the centre line, which is where the frame's body begins. Half of an edge button is
 *   tucked under the frame, and the device chrome centres it on the body's edge. Measured on
 *   2026-10-01 from rendered frames, body edge against centre in composite px: 30 / 32 on the left
 *   of an iPhone 15 Pro, 17 Pro and SE (3rd gen); 879 / 878 for the 15 Pro's power button; 12–14 /
 *   16 for the top buttons of an iPad Pro 13 (M5), iPad mini (A17 Pro), iPad (A16) and iPad Air 11
 *   (M4); 2243 / 2242 and 1873 / 1870 for the iPads' right-side volume. Reaching on to the screen's
 *   edge instead, as before #785, made the black bezel between button and screen a Volume Down
 *   press. The body's exact edge is known only inside `ios-agent` and is not on the wire; the
 *   centre is, to within 4 composite px.
 *
 * That leaves a side target about 13 CSS px across on an iPhone and about 5 on an iPad's top edge —
 * under 24, so the criterion's spacing exception is the one it meets: a 24 px circle on each target
 * touches no other. `buttonHit.test.ts` holds that on measured layouts.
 *
 * **Which side faces the device comes from `anchor`**, not from where the button sits against the
 * screen: a top button near a corner can lie wholly left of the screen's left edge, and a position
 * test would read it as a left-edge button. **A button on the device's face (`onTop`, the iPhone SE
 * home button) is its own rectangle**: its whole face is bezel, so there is no body edge to reach to.
 */
export function buttonTargets(buttons: readonly ChromeButton[], box: { width: number; height: number }): Rect[] {
  return buttons.map((btn) => {
    const r = buttonHitRect(btn)
    if (btn.onTop) return r
    const cx = (r.left + r.right) / 2
    const cy = (r.top + r.bottom) / 2
    switch (btn.anchor) {
      case 'left': return { ...r, left: 0, right: cx }
      case 'right': return { ...r, left: cx, right: box.width }
      case 'top': return { ...r, top: 0, bottom: cy }
      case 'bottom': return { ...r, top: cy, bottom: box.height }
      // An anchor no measured chrome has: the button's own pixels, and nothing more.
      default: return r
    }
  })
}

/** HID Consumer page, and its Volume Increment / Decrement usages — what Apple's device chrome states
 *  for each volume input, and so what identifies the pair without leaning on its `name` string. */
const CONSUMER_PAGE = 12
const VOLUME_INCREMENT = 233
const VOLUME_DECREMENT = 234

/**
 * The tooltip for each button: what pressing it does, which on an iPad is not always its name.
 *
 * iPadOS (15.4+) raises the volume with whichever button is on the right or on top as the device is
 * held, and current iPads cannot turn that off. The press still sends the physical button's HID
 * usage — the device does the remapping — so only the title follows the effect. An iPhone's volume
 * does not follow orientation, so anything but a `tablet` keeps the physical names.
 *
 * `landscape` is the viewer's `rotate(-90deg)`, counter-clockwise: a composite point (x, y) is seen
 * at (y, width − x). Of the two volume buttons as seen, the one further right wins when they are
 * apart side by side, and the one higher up when they are stacked. Measured on 2026-10-01 against the
 * real chrome: an iPad Pro's right-edge pair swaps in landscape, an iPad mini's top-edge pair does not
 * — the pair that would both be wrong if the turn were the other way.
 */
export function buttonTitles(
  buttons: readonly ChromeButton[],
  box: { width: number; height: number },
  landscape: boolean,
  formFactor: FormFactor | undefined,
): string[] {
  const titles = buttons.map((b) => b.accessibilityTitle)
  if (formFactor !== 'tablet') return titles
  const find = (usage: number) => buttons.findIndex((b) => b.usagePage === CONSUMER_PAGE && b.usage === usage)
  const up = find(VOLUME_INCREMENT)
  const down = find(VOLUME_DECREMENT)
  if (up < 0 || down < 0) return titles
  const seen = (b: ChromeButton) => {
    const r = buttonHitRect(b)
    const cx = (r.left + r.right) / 2
    const cy = (r.top + r.bottom) / 2
    return landscape ? { x: cy, y: box.width - cx } : { x: cx, y: cy }
  }
  const u = seen(buttons[up])
  const d = seen(buttons[down])
  const upRaises = Math.abs(u.x - d.x) > Math.abs(u.y - d.y) ? u.x > d.x : u.y < d.y
  if (!upRaises) [titles[up], titles[down]] = [titles[down], titles[up]]
  return titles
}
