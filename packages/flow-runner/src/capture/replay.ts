import type { ReplayInput, SessionChannel } from '../sessionChannel.js'
import { InputRefusedError } from '../sessionErrors.js'
import type { ChromePayload } from '@tapflowio/protocol'
import { chromeOrientation } from '@tapflowio/protocol/screen'
import type { RawStep } from './segment.js'
import type { StepRange } from './range.js'

/** The part of a session channel the replayer drives. */
export type ReplayChannel = Pick<SessionChannel,
  'replayInputs' | 'pasteText' | 'typeText' | 'launchApp' | 'installApp' | 'clearState' | 'openUrl'>

/** `replayed`, or why the step was not sent: the device refused it the first time, or it is not replayed at all. */
export type ReplayOutcome = 'replayed' | 'refused-before' | 'not-replayed'

/**
 * Send one recorded action again, on `sessionId`. Gestures, keys, held buttons, turns and folds go as they were
 * recorded, at their recorded pace (`replayInputs`); typed text as the flow's `inputText` types it (below); the rest through the channel's own requests, so their meaning is
 * the request's and not the recording's — an install installs fresh even when the viewer had asked to keep the app,
 * as a dashboard coming back to a device does, because a flow starts from a clean app.
 *
 * Not replayed: an input the device refused (it changed nothing), a network switch and a cut (a flow cannot say them,
 * and taking the device offline in the middle of the dialog would leave it unable to read the screen), the keyboard
 * toggle. A turn is replayed as recorded and may be relative (`direction`), so the host first puts the device in
 * `rangeStartOrientation` — from another orientation every point after the turn would land somewhere else.
 */
export async function replayStep(channel: ReplayChannel, sessionId: string, raw: RawStep, signal?: AbortSignal): Promise<ReplayOutcome> {
  // Checked first: a launch, an install or a clear-state after a cancel would wipe the app the person left.
  signal?.throwIfAborted()
  if (raw.outcome === 'refused') return 'refused-before'
  switch (raw.kind) {
    // Typed as the flow types it, not as keys: a key code becomes a character by the device's keyboard layout, and an
    // iOS simulator takes that from the Mac's input source at the moment it arrives (Simulator's "Use the Same Keyboard
    // Language as macOS", on by default). Measured: `a@b.com` typed while the Mac was set to English replayed as
    // `ㅁ@ㅠ.채ㅡ` once it was set to Korean, and every step after it was matched on a screen the flow never makes. A
    // device that refuses the text gets the keys, as recorded.
    //
    // A run typed with Caps Lock in force is typed as text too, though its text is a guess (`capsLock`). Its keys would
    // type by the language the device is left in, which nothing resets between replays: measured, two Matches of one
    // recording typed `aㅁaㅁ` and `ㅁAㅁa`. A wrong guess the same every time beats a right one by chance.
    case 'text':
      try {
        await channel.typeText(sessionId, raw.text)
      } catch (e) {
        if (!(e instanceof InputRefusedError)) throw e
        await channel.replayInputs(sessionId, raw.messages as Array<{ at: number; msg: ReplayInput }>, signal)
      }
      return 'replayed'
    case 'tap': case 'longPress': case 'swipe': case 'holdDrag': case 'pinch': case 'key': case 'button':
    case 'rotate': case 'posture':
      await channel.replayInputs(sessionId, raw.messages as Array<{ at: number; msg: ReplayInput }>, signal)
      return 'replayed'
    case 'paste': await channel.pasteText(sessionId, raw.text); return 'replayed'
    case 'type': await channel.typeText(sessionId, raw.text); return 'replayed'
    case 'launch': {
      const msg = raw.messages[0]!.msg
      const options = msg.type === 'app:launch' && (msg.arguments || msg.env)
        ? { ...(msg.arguments ? { arguments: msg.arguments } : {}), ...(msg.env ? { env: msg.env } : {}) }
        : undefined
      await channel.launchApp(sessionId, raw.buildId, options)
      return 'replayed'
    }
    case 'install': await channel.installApp(sessionId, raw.buildId); return 'replayed'
    case 'clearState': await channel.clearState(sessionId, raw.bundleId); return 'replayed'
    case 'openUrl': await channel.openUrl(sessionId, raw.url); return 'replayed'
    // The keyboard toggle is relative, and a flow cannot say it: replayed from another state it would hide a keyboard
    // the person had shown.
    case 'network': case 'cut': case 'keyboardToggle': return 'not-replayed'
  }
}

export interface ReplayHooks {
  /** Before each step: hold the recording pause (the dialog renews its lease on a timer) and wait for the screen to
   *  settle, then read it. A rejection stops the replay — a lapsed pause would record the replay as the person. */
  beforeStep?: (index: number, raw: RawStep) => Promise<void>
  /** After each step, with what happened to it. */
  afterStep?: (index: number, raw: RawStep, outcome: ReplayOutcome) => Promise<void>
  signal?: AbortSignal
}

/** Replay `steps` in order, one at a time, with the host's reads around each. */
export async function replaySteps(channel: ReplayChannel, sessionId: string, steps: readonly RawStep[], hooks: ReplayHooks = {}): Promise<void> {
  for (const [i, raw] of steps.entries()) {
    await hooks.beforeStep?.(i, raw)
    const outcome = await replayStep(channel, sessionId, raw, hooks.signal)
    await hooks.afterStep?.(i, raw, outcome)
  }
}

/**
 * How the device was held when the range began, from the chrome in force then, for the host to restore before it
 * replays (`setOrientation`). `undefined` when the chrome cannot say (a multi-panel iOS device, Android's scrcpy) or
 * none was recorded; the host replays from where the device is.
 */
export function rangeStartOrientation(steps: readonly RawStep[], range: StepRange): 'portrait' | 'landscape' | undefined {
  const chrome = steps[range.start]?.chrome
  if (typeof chrome !== 'object' || chrome === null) return undefined
  const o = chromeOrientation(chrome as ChromePayload)
  return o === 'portrait' || o === 'landscape' ? o : undefined
}
