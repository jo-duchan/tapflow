// How a client reads which way a device is held, and turns a point drawn in the app's interface into the
// framebuffer a touch lands in. Platform knowledge, kept here for the reason the button tables are: the agents own
// what these values mean, and a client that guessed them would disagree with the agent the first time a platform
// changed. A subpath rather than the main entry, which must stay free of runtime values (see AGENTS.md).

import type { ChromePayload, UiTreeResponse } from '../index.js'

export type InterfaceTurn = NonNullable<UiTreeResponse['interfaceTurn']>

/**
 * Which way the device is held, from its chrome: `portrait` upright only, `landscape` on either side, `upside-down`
 * (neither — a client asking for portrait turns it, as the agents meet `portrait` only upright), and `undefined` when
 * the chrome cannot say: a multi-panel iOS device (its value includes the lit panel's own turn, so upright reads as
 * 90; #1116), or a chrome that carries no turn at all (Android's scrcpy path, an older agent).
 *
 * The device's orientation, not the app's: what `input:rotate` changes and what the agents compare a target with.
 * A point is turned by the app's (`UiTreeResponse.interfaceTurn`), which can differ.
 */
export function chromeOrientation(chrome: ChromePayload): 'portrait' | 'landscape' | 'upside-down' | undefined {
  // iOS chrome carries the bezel image; Android's never does. `streamRotation` means different things on the two.
  const turn = 'framePng' in chrome
    ? (chrome.scaleBasis !== undefined ? undefined : chrome.streamRotation)
    : chrome.bodyRotation
  if (turn === 0) return 'portrait'
  if (turn === 90 || turn === 270) return 'landscape'
  if (turn === 180) return 'upside-down'
  return undefined
}

/**
 * A normalized point in the app's upright interface, carried into the portrait framebuffer a touch is placed in.
 * `turn` is `UiTreeResponse.interfaceTurn`; absent leaves the point as it is. The inverse of the dashboard's
 * picture-to-frame mapping (`iosToNormScreen`), measured at 90 and 270 on an iPhone simulator.
 */
export function toFramePoint(turn: InterfaceTurn | undefined, [u, v]: [number, number]): [number, number] {
  switch (turn) {
    case 90: return [v, 1 - u]
    case 180: return [1 - u, 1 - v]
    case 270: return [1 - v, u]
    default: return [u, v]
  }
}

/** `interfaceTurn` off a ui-tree body a client parsed itself: anything but 0, 90, 180 or 270 is no information. */
export function interfaceTurnOf(value: unknown): InterfaceTurn | undefined {
  return value === 0 || value === 90 || value === 180 || value === 270 ? value : undefined
}
