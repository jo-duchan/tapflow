// The shortest contact a tap is given. Clients that drive a device — flow-runner, the MCP server — send
// the touch's down and up back to back. Measured on iPhone 17 Pro / iOS 26.5, 20 taps each on a
// `UISwitch`: 3 toggled with the up sent at once, 20 with this 50ms hold (a button took every tap either
// way). A person's tap and a swipe usually last longer already, so they are rarely held, and one that is
// held only gains contact time. Both channels hold a fast tap's up until it has lasted this long.
export const MIN_CONTACT_MS = 50

/**
 * Everything IOSAgent sends to a device as input, behind one seam.
 *
 * Two implementations: `TouchHelper` (Indigo, from the host — every single-panel iPhone and iPad) and
 * `FoldableInput` (the in-simulator `guest-helper` — a device with more than one integrated panel, where the
 * Indigo path has no receiver for the cover and drops keys, buttons and rotation). **Which one a device
 * gets is decided in one place** (`IOSAgent.createInputChannel`), so a handler that forgets the
 * distinction still reaches the right path, and a multi-panel device never holds an Indigo channel whose
 * writes would answer success and land nowhere — `input:type`'s ⌘V did exactly that before this seam.
 *
 * The contract is TouchHelper's, documented there: writes return whether they reached a ready channel
 * (synchronously — `IOSAgent.refusalReason` relies on it), `inputState` separates starting from gone,
 * and a gesture is owned by whatever took its opening frame.
 */
export interface InputChannel {
  start(): void
  /** Releases this channel. For `FoldableInput` it detaches only: the guest helper outlives a relay
   *  reconnect and is stopped by the device teardown, not by whoever drops the channel. */
  stop(): void
  inputState(): 'ready' | 'starting' | 'unavailable'
  /** Resolves `true` once a write would reach the device, `false` once this channel is stopped. Unbounded otherwise:
   *  a helper that dies before it is ready is replaced, and the waiter keeps waiting, so the caller sets the limit. */
  whenReady(): Promise<boolean>
  ownsGesture(): boolean

  touchStart(x: number, y: number): boolean
  touchMove(x: number, y: number): boolean
  touchEnd(): boolean
  touchEndAfterMinContact(): Promise<boolean>
  /** Lift the open single-finger touch as cancelled, or with an up where the channel cannot cancel. False when no
   *  touch is down. The end that follows writes nothing. */
  touchCancel(): boolean

  pinchStart(x1: number, y1: number, x2: number, y2: number): boolean
  pinchMove(x1: number, y1: number, x2: number, y2: number): boolean
  pinchEnd(): boolean

  /** `modifiers`: the USB HID modifier bitmap (0x01 LeftCtrl, 0x02 LeftShift, 0x04 LeftAlt, 0x08 LeftMeta…). */
  sendKey(usage: number, modifiers?: number): boolean
  pressButton(usagePage: number, usage: number): boolean
  pressButtonDown(usagePage: number, usage: number): boolean
  pressButtonUp(usagePage: number, usage: number): boolean
  /** 0 = home, 1 = lock. */
  pressLegacyButton(code: number): boolean
}
