// Which hardware button names a platform can press, for every door that has to know before the agent does: a flow
// that presses a button the device lacks is refused before it runs (flow-runner, and run_flow in mcp-server), rather
// than answered with a no-op the next assertion fails on under the wrong name. The agents read the same tables, so a
// name this module calls available is one the agent dispatches. A subpath rather than the main entry, which must stay
// free of runtime values (see AGENTS.md).

import type { ChromePayload } from '../index.js'

/**
 * Android dispatches every button as an adb keyevent from one closed map, on every backend, so this list is the whole
 * answer there: a name outside it is refused by the agent as `unsupported`. `lock` is the cross-platform alias for
 * the power key.
 */
export const ANDROID_BUTTONS = ['home', 'back', 'recent_apps', 'power', 'lock', 'volume_up', 'volume_down'] as const
export type AndroidButtonName = (typeof ANDROID_BUTTONS)[number]

/**
 * The cross-platform names iOS maps onto a device's chrome button names. Anything else is looked up in the chrome as
 * given, which is how the dashboard's raw names (`volume-up`, `action`) reach the agent.
 */
export const IOS_BUTTON_ALIASES: Readonly<Record<string, string>> = {
  lock: 'power',
  volume_up: 'volume-up',
  volume_down: 'volume-down',
}

/**
 * Names another platform has that no iOS device does: Android's navigation buttons. Refused without asking the
 * device, because the agent would answer them with a success that pressed nothing (#484 — right for an agent that
 * looks at the screen again, wrong for a flow that cannot).
 */
const IOS_NEVER: ReadonlySet<string> = new Set(['back', 'recent_apps'])

/**
 * `available` and `unavailable` are answers. `unknown` is not one: iOS buttons other than home exist only when the
 * device's chrome declares them with a HID usage, so without the chrome the question is still open. A platform these
 * tables do not cover is always `unknown` — a third-party agent's buttons are its own to answer, and a refusal here
 * would be a false failure.
 */
export type ButtonAvailability = 'available' | 'unavailable' | 'unknown'

export function buttonAvailability(platform: string, name: string, chrome?: ChromePayload): ButtonAvailability {
  if (platform === 'android') return (ANDROID_BUTTONS as readonly string[]).includes(name) ? 'available' : 'unavailable'
  if (platform !== 'ios') return 'unknown'
  if (name === 'home') return 'available'
  if (IOS_NEVER.has(name)) return 'unavailable'
  if (chrome === undefined) return 'unknown'
  const chromeName = IOS_BUTTON_ALIASES[name] ?? name
  // The agent writes nothing for a button whose usage is 0 ("unknown") and still answers success, so it is not one
  // this device can press. `framePng` tells iOS chrome from Android's, which carries no usage at all.
  if (!('framePng' in chrome)) return 'unknown'
  return chrome.buttons.some((b) => b.name === chromeName && b.usagePage > 0 && b.usage > 0) ? 'available' : 'unavailable'
}
