import { landedHome, type RawStep } from './segment.js'

export interface StepRange {
  /** Indexes into the steps, `end` exclusive. */
  start: number
  end: number
}

export type RangeWarning =
  /** The range does not begin with a launch, nor with a step the reads place in the app (`onHome: false`): the app was
   *  opened some other way, such as its icon on the home screen (the dashboard's install does not launch it, only its
   *  Launch button does), on an agent that cannot say where it was. The flow is given a `launchApp` of its own
   *  (`toFlowSteps`), the replay launches the app before its first step, and a home-screen tap at the start is the
   *  person's to leave out by moving the start. */
  | 'no-launch-at-start'
  /** No clear-state or install before the launch: the app runs on data an earlier test left. */
  | 'no-clean-start'

/**
 * Where a captured flow begins by default: the first launch after the last clear-state or install — the point from
 * which the app's state is the app's own. With no launch after it, the first step after it taken in the app: measured,
 * a person in the dashboard opens the app they just installed from its home-screen icon as often as with Launch, and
 * the swipes and taps that found it are the home screen's. Without a clean start, the last launch; without either, the
 * beginning. Always to the end. A launch the device refused is not one.
 */
export function defaultRange(steps: readonly RawStep[]): StepRange {
  const counts = (s: RawStep) => s.outcome !== 'refused'
  let clean = -1
  for (let i = 0; i < steps.length; i++) if ((steps[i]!.kind === 'clearState' || steps[i]!.kind === 'install') && counts(steps[i]!)) clean = i
  let start = clean < 0 ? -1 : steps.findIndex((s, i) => i > clean && s.kind === 'launch' && counts(s))
  if (start < 0 && clean >= 0) {
    // Opened from its icon: the steps on the home screen before it are the person finding the app, which a replay that
    // launches it would make on top of it. Only the run straight after the clean start, and only steps the reads place
    // there — a step they cannot place stops it, and a visit home later is the person's own — unless the app's first
    // report says the app had not been touched yet (`pastOtherSurfaces`).
    start = clean + 1
    let inApp = pastLanded(steps, start)
    inApp = pastOtherSurfaces(steps, inApp)
    if (inApp < steps.length) start = inApp
  }
  // Nothing after the clean start (the last step was the install or clear): the range would be empty, with no step at
  // either handle. The rest of the rule picks one instead.
  if (start >= steps.length) start = -1
  if (start < 0) {
    start = 0
    for (let i = 0; i < steps.length; i++) if (steps[i]!.kind === 'launch' && counts(steps[i]!)) start = i
  }
  // A step left out before the replay replays nothing, so it cannot be where the replay starts — whichever rule chose it.
  while (start < steps.length - 1 && steps[start]!.dropped) start++
  return { start, end: steps.length }
}

/**
 * Past the steps that found the app, from `from`: the run the reads or the agent place on the home screen, a system
 * surface the agent placed (a banner, Control Center or the shade pulled down before the app opened), and a run of
 * another app's touches with the home screen after it (Android's Google feed, swiped back from) — #1214. Another app's
 * touches with the app after them are a sheet the app raised as it opened (a sign-in, a purchase) and stay, as does a
 * prompt (`alert`) or a step nothing places.
 */
function pastLanded(steps: readonly RawStep[], from: number): number {
  const landed = (s: RawStep) => ('landed' in s ? s.landed : undefined)
  let i = from
  while (i < steps.length && findsTheApp(steps[i]!)) {
    const s = steps[i]!
    if (homeHere(s) || landed(s)?.on === 'system') { i++; continue }
    if (landed(s)?.on !== 'other' || landedHome(landed(s))) break
    let j = i
    while (j < steps.length && findsTheApp(steps[j]!) && landed(steps[j]!)?.on === 'other' && !landedHome(landed(steps[j]!))) j++
    if (j < steps.length && steps[j]!.onHome === true && findsTheApp(steps[j]!)) { i = j; continue }
    break
  }
  return i
}

/**
 * On the home screen by its reads, unless the agent placed it on another app: iOS reads say home for any app off the
 * screen, a sheet another process shows over the app included, and that sheet with the app after it stays (#1214).
 */
function homeHere(s: RawStep): boolean {
  const landed = 'landed' in s ? s.landed : undefined
  if (landed?.on === 'other' && !landedHome(landed)) return false
  return s.onHome === true
}

/**
 * Past the screens beside the home screen (#1194): Android reads only the launcher as home, and the Google feed a swipe
 * right opens is another package (`googlequicksearchbox`, measured on Android 16), so the skip stopped there with the
 * drawer's swipe and the icon's tap still to come. The swipe onto it is not placed either: home before it and not home
 * after reads as the icon's tap might (`withHome`). Read alone, a step there looks like a tap on a permission dialog the
 * app opened (another package too), so order decides: a touch is still finding the app when a home-screen step comes
 * after it, before the first touch the app reported. Only with such a report, since without one there is no point the
 * app was surely in front by; and only when that report is the app's first touch (`seq` 1), since a touch the app took
 * before it whose report was not paired is a step in the app. Anything but a touch or a navigation button (a link, a
 * launch, typing) stops it here.
 *
 * What this cannot tell from order alone: a tap on a dialog the app opened (another package, so unreported), then a trip
 * home and back before the app's first touch, reads like the feed's swipe. An agent that says where each touch landed
 * settles it (#1214): a step it placed on the app or on a prompt the app raised is never skipped here.
 */
function pastOtherSurfaces(steps: readonly RawStep[], from: number): number {
  // From `from`: a report before the clean start is another run of the app.
  const firstReported = steps.findIndex((s, i) => i >= from && 'touched' in s && s.touched)
  if (firstReported < 0) return from
  const first = steps[firstReported]!
  if (!('touched' in first) || first.touched?.seq !== 1) return from
  let start = from
  for (let i = from; i < firstReported; i++) {
    const s = steps[i]!
    const on = 'landed' in s ? s.landed?.on : undefined
    if (!findsTheApp(s) || on === 'app' || on === 'alert') break
    if (homeHere(s)) start = i + 1
  }
  return start
}

/** What a person does on the home screen to find the app: touches, and the buttons that move between screens. Not a
 *  command the dashboard sent — an `openUrl` from the home screen is how the app was opened, and the replay must open
 *  the same place — nor a volume or power press, which changes the device the flow then runs on. */
const FINDS_THE_APP = new Set<RawStep['kind']>(['tap', 'longPress', 'swipe', 'holdDrag', 'pinch'])
const NAVIGATION_BUTTONS = new Set(['home', 'back', 'recent_apps'])
const findsTheApp = (s: RawStep): boolean => FINDS_THE_APP.has(s.kind) || (s.kind === 'button' && NAVIGATION_BUTTONS.has(s.name))

export function rangeWarnings(steps: readonly RawStep[], range: StepRange): RangeWarning[] {
  // The first step the replay sends: one left out before it (`dropped`) launches nothing and is in no app.
  let at = range.start
  while (at < range.end - 1 && steps[at]?.dropped) at++
  const first = steps[at]
  const out: RangeWarning[] = []
  // A step the reads place in the app needs no launch of its own to start from: the replay launches the app first. So
  // does another app's sheet the app's own touch follows, which the range keeps (`pastLanded`) and iOS reads as home.
  if (first?.kind !== 'launch' && first?.onHome !== false && !sheetBeforeApp(steps, at)) out.push('no-launch-at-start')
  const before = steps.slice(0, range.start)
  const lastLaunch = before.map((s) => s.kind).lastIndexOf('launch')
  const cleanBefore = before.some((s, i) => (s.kind === 'clearState' || s.kind === 'install') && s.outcome !== 'refused' && i > lastLaunch)
  if (first?.kind === 'launch' && !cleanBefore) out.push('no-clean-start')
  return out
}

/** A run of another app's steps from `from`, with a step the agent placed in the app right after it. */
function sheetBeforeApp(steps: readonly RawStep[], from: number): boolean {
  const landed = (s: RawStep | undefined) => (s && 'landed' in s ? s.landed : undefined)
  let j = from
  while (j < steps.length && landed(steps[j])?.on === 'other' && !landedHome(landed(steps[j]))) j++
  return j > from && landed(steps[j])?.on === 'app'
}

/**
 * Steps the person took in the app before the range starts, back to the last clean start (1b-3b): what Match says, as a
 * fact and never as the cause, when a replayed step looks different from its recording. Only steps the reads place in
 * the app, and none before the last clear-state or install ahead of the range — with one inside the range, a replay
 * would clear what those steps did and stop at the same place again. Indices into `steps`.
 */
export function stepsBeforeRange(steps: readonly RawStep[], range: StepRange): number[] {
  let from = 0
  for (let i = 0; i < range.start; i++) {
    const s = steps[i]!
    if ((s.kind === 'clearState' || s.kind === 'install') && s.outcome !== 'refused') from = i + 1
  }
  const out: number[] = []
  for (let i = from; i < range.start; i++) if (steps[i]!.onHome === false && steps[i]!.outcome !== 'refused' && !steps[i]!.dropped) out.push(i)
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
