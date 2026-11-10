import type { RawStep } from './segment.js'

export interface StepRange {
  /** Indexes into the steps, `end` exclusive. */
  start: number
  end: number
}

export type RangeWarning =
  /** The range does not begin with a launch: the app was opened some other way, such as its icon on the home screen
   *  (the dashboard's install does not launch it, only its Launch button does). The flow is given a `launchApp` of its
   *  own (`toFlowSteps`), the replay launches the app before its first step, and a home-screen tap at the start is the
   *  person's to leave out by moving the start. */
  | 'no-launch-at-start'
  /** No clear-state or install before the launch: the app runs on data an earlier test left. */
  | 'no-clean-start'

/**
 * Where a captured flow begins by default: the first launch after the last clear-state or install — the point from
 * which the app's state is the app's own. With no launch after it, the step after it: measured, a person in the
 * dashboard opens the app they just installed from its home-screen icon as often as with Launch. Without a clean
 * start, the last launch; without either, the beginning. Always to the end. A launch the device refused is not one.
 */
export function defaultRange(steps: readonly RawStep[]): StepRange {
  const counts = (s: RawStep) => s.outcome !== 'refused'
  let clean = -1
  for (let i = 0; i < steps.length; i++) if ((steps[i]!.kind === 'clearState' || steps[i]!.kind === 'install') && counts(steps[i]!)) clean = i
  let start = clean < 0 ? -1 : steps.findIndex((s, i) => i > clean && s.kind === 'launch' && counts(s))
  if (start < 0 && clean >= 0) start = clean + 1
  // Nothing after the clean start (the last step was the install or clear): the range would be empty, with no step at
  // either handle. The rest of the rule picks one instead.
  if (start >= steps.length) start = -1
  if (start < 0) {
    start = 0
    for (let i = 0; i < steps.length; i++) if (steps[i]!.kind === 'launch' && counts(steps[i]!)) start = i
  }
  return { start, end: steps.length }
}

export function rangeWarnings(steps: readonly RawStep[], range: StepRange): RangeWarning[] {
  const first = steps[range.start]
  const out: RangeWarning[] = []
  if (first?.kind !== 'launch') out.push('no-launch-at-start')
  const before = steps.slice(0, range.start)
  const lastLaunch = before.map((s) => s.kind).lastIndexOf('launch')
  const cleanBefore = before.some((s, i) => (s.kind === 'clearState' || s.kind === 'install') && s.outcome !== 'refused' && i > lastLaunch)
  if (first?.kind === 'launch' && !cleanBefore) out.push('no-clean-start')
  return out
}

/**
 * The steps in the range whose value the person has to give before Match (#1140): a password typed on the soft
 * keyboard, which neither the keys nor a read of the field can say. Indices into `steps`.
 */
export function askedValues(steps: readonly RawStep[], range: StepRange): number[] {
  const out: number[] = []
  for (let i = range.start; i < range.end; i++) {
    const s = steps[i]
    if (s?.kind === 'text' && s.askValue) out.push(i)
  }
  return out
}
