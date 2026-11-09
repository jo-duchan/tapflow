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

/** Select-all, which `inputText { replace: true }` presses before it types. iOS takes it as a hardware chord. */
export const SELECT_ALL = { code: 'KeyA', modifiers: ['meta'] } as const

/**
 * The first `inputText { replace: true }` on a platform that cannot select a field's text, or `null`. Android's agent
 * presses no select-all (it refuses the chord as unsupported), so the step would type after what the field holds.
 */
export function unavailableReplace(flow: Pick<Flow, 'steps'>, platform: string): number | null {
  if (platform !== 'android') return null
  const index = flow.steps.findIndex((s) => (s.type === 'inputText' || s.type === 'inputSecret') && s.replace === true)
  return index < 0 ? null : index
}

export function unavailableReplaceMessage(platform: string): string {
  const where = PLATFORM_NAMES[platform] ?? platform
  return `${where} cannot select what a field holds, so "inputText" with "replace" cannot run there — type into an empty field without "replace", or tag the flow and run it only on iOS`
}
