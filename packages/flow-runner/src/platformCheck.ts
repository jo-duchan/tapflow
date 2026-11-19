import type { ChromePayload } from '@tapflowio/protocol'
import { buttonAvailability } from '@tapflowio/protocol/buttons'
import type { Flow } from './schema.js'

/** A `pressButton` the device cannot press. `byDevice` when it took the device's own chrome to know. */
export interface UnavailableButton {
  index: number
  name: string
  byDevice: boolean
}

/**
 * The first `pressButton` in `flow` that `platform` cannot press, `'needs-chrome'` when one can only be answered by
 * the device's chrome (iOS buttons other than home), or `null` when nothing is refused. A platform with no table
 * refuses nothing — a third-party agent's buttons are its own to answer. Called twice per run: once before a device is
 * chosen, with no chrome, so a flow that cannot run on the platform at all is refused like a compile error; and by the
 * engine before its first step, with the chrome, for what only the device knows.
 */
export function unavailableButton(flow: Pick<Flow, 'steps'>, platform: string, chrome?: ChromePayload): UnavailableButton | 'needs-chrome' | null {
  let needsChrome = false
  for (const [index, step] of flow.steps.entries()) {
    if (step.type !== 'pressButton') continue
    const verdict = buttonAvailability(platform, step.name, chrome)
    if (verdict === 'unavailable') return { index, name: step.name, byDevice: chrome !== undefined && buttonAvailability(platform, step.name) === 'unknown' }
    // Only iOS answers `unknown` for a button it could still have; an unknown platform's `unknown` is final.
    if (verdict === 'unknown' && chrome === undefined && platform === 'ios') needsChrome = true
  }
  return needsChrome ? 'needs-chrome' : null
}

const PLATFORM_NAMES: Record<string, string> = { ios: 'iOS', android: 'Android' }

export function unavailableButtonMessage(problem: UnavailableButton, platform: string): string {
  const where = PLATFORM_NAMES[platform] ?? platform
  return problem.byDevice
    ? `this device has no "${problem.name}" button it can press — run the flow on a device that has one, or tag it and leave this one out`
    : `${where} has no "${problem.name}" button, so this flow cannot run on ${where} — press the app's own control with a selector instead, or tag the flow and run it only where the button exists`
}

/**
 * Select-all, which `inputText { replace: true }` presses before it types. iOS takes it as a hardware chord; Android's
 * agent holds Ctrl+A, which Android takes from 13 (#1135). Below that, or from an agent that predates it, the press is
 * refused as unsupported and the step fails with `SELECT_ALL_REFUSED`: typed anyway, the text would land after what
 * the field holds. Not refused before the run, since only the device can say.
 */
export const SELECT_ALL = { code: 'KeyA', modifiers: ['meta'] } as const

export const SELECT_ALL_REFUSED = 'this device cannot select what a field holds, so "inputText" with "replace" cannot run on it — '
  + 'Android needs version 13 or later and an up-to-date tapflow agent; otherwise type into an empty field without "replace"'

/** The key code a flow's `imeAction` step presses: tapflow's name for the field's own action (protocol `InputKey`). */
export const IME_ACTION = 'ImeAction'
