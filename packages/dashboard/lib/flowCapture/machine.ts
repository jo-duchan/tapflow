import {
  askedValues, defaultRange, stepsBeforeRange, type CapturedFlow, type CapturedStep, type FlowResult, type RawStep, type ScreenRect, type Selector,
  type StepRange,
} from '@tapflowio/flow-runner/browser'
import type { AfterTouch } from './runner'
import type { HeldResetReport } from './channel'

/**
 * Flow Capture's dialog as states and the events between them (#1125). Pure: the screens draw a state, the runner
 * sends events. Kept apart from both because the design keeps changing and the order of the five steps does not.
 */
export type Phase = 'loading' | 'range' | 'matching' | 'edit' | 'verifying' | 'export' | 'failed'

/** A step of a verification as it runs: started, then passed or failed, with how long it took. */
export interface LiveStep {
  index: number
  name: string
  status: 'running' | 'passed' | 'failed'
  startedAt: number
  durationMs?: number
}

/** The engine's mark for a step starting or ending (`runFlow`'s `onStep`). */
export interface StepMark {
  index: number
  name: string
  phase: 'start' | 'end'
  status?: 'passed' | 'failed'
}

export interface MatchProgress {
  done: number
  total: number
}

export interface CaptureState {
  phase: Phase
  steps: RawStep[]
  range: StepRange
  name: string
  tags: string
  progress: MatchProgress
  /** One per replayed step of the range, in order. */
  matched: CapturedStep[]
  /** The replay's screenshot of each matched step, an object URL, by index into `matched`. */
  screenshots: Array<string | undefined>
  captured: CapturedFlow | null
  /** Matched steps the person removed in Edit, by index into `captured.steps`. */
  removed: number[]
  /** Secrets the person renamed: old name → new name. */
  renamed: Record<string, string>
  /** Typed text the person made a secret in Edit (1b-3c), by index into `captured.steps`: the name it was given. A field
   *  the app does not mark as hiding its text — a card number, an API key — is otherwise written into the file. */
  made: Record<number, string>
  /** The screen each touch left, by index into `matched` (one to one with `captured.steps`): Edit's "after this tap". */
  after: Record<number, AfterTouch>
  /** What the person expects each touch to bring (1b-3c), by index into `captured.steps`: written as an `assertVisible`
   *  right after it. */
  expected: Record<number, Selector[]>
  /** `live`: the steps the run has reached, as they start and end, for showing it while it runs; `result` replaces it. */
  verify: { status: 'running' | 'passed' | 'failed'; done: number; live: LiveStep[]; result?: FlowResult } | null
  /** Why the dialog stopped, said in the dialog. */
  error: string | null
  /** The range the matched steps were replayed from. Moved off it, they no longer describe the range. */
  matchedRange: StepRange | null
  /** The furthest step (stepper index) reached since the last replay, so a step back is not a step lost. */
  reached: number
  /** What the person said a password typed on the soft keyboard was (#1140), by index into `steps`: Match types it.
   *  Only ever in this state, never written down; gone with the dialog. */
  asked: Record<number, string>
  /** What the device reset did before the replay running or last run (#1139): `null` when its agent could not reset
   *  it, absent until it has answered. */
  reset?: HeldResetReport | null
  /** Match is waiting at a step whose screen looked different from its recording (1b-3b). `diff` is kept to tune the
   *  threshold by: what a stop measured is the only data there will be. */
  diverged?: Divergence
  /** Back to Range moved the start to take in steps before it, said on Range until the range changes. Indices. */
  moved?: number[]
  /** How many of the last matched steps the replay added (a focus tap, a turn): taken to Edit without the step they were
   *  added for, they would be a flow of its own. */
  insertedTail: number
}

export interface Divergence {
  /** Into `steps`. */
  index: number
  diff: number
  recordedUrl: string | null
  nowUrl: string
  /** What was left out of the comparison, as fractions of the picture: drawn as not compared. */
  masks: ScreenRect[]
}

export type CaptureEvent =
  | { type: 'loaded'; steps: RawStep[]; range: StepRange; name: string }
  | { type: 'load-failed'; error: string }
  | { type: 'set-range'; range: StepRange }
  | { type: 'set-name'; name: string }
  | { type: 'set-tags'; tags: string }
  | { type: 'set-asked'; index: number; value: string }
  | { type: 'match-started'; total: number }
  | { type: 'step-matched'; step: CapturedStep; screenshot?: string; inserted?: boolean }
  | { type: 'match-finished'; captured: CapturedFlow }
  | { type: 'match-failed'; error: string }
  | ({ type: 'diverged' } & Divergence)
  /** Continue anyway: the step is replayed and the comparison goes on from the next. */
  | { type: 'went-on' }
  /** Back to Range from a stop: the start moves to take in the steps before it, when it is still the default. */
  | { type: 'back-to-range' }
  | { type: 'remove-step'; index: number }
  | { type: 'rename-secret'; from: string; to: string }
  | { type: 'step-after'; index: number; after: AfterTouch }
  | { type: 'add-expected'; index: number; selector: Selector }
  | { type: 'remove-expected'; index: number; n: number }
  | { type: 'make-secret'; index: number }
  | { type: 'keep-as-text'; index: number }
  /** The stepper: go to a step already reached (`canGoTo`). */
  | { type: 'go-to'; step: number }
  | { type: 'verify-started' }
  | { type: 'device-reset'; report: HeldResetReport | null }
  /** `at`: when the dialog heard it, which times the step. */
  | { type: 'verify-step'; mark: StepMark; at: number }
  | { type: 'verify-finished'; result: FlowResult }
  | { type: 'to-export' }

export const initialState: CaptureState = {
  phase: 'loading', steps: [], range: { start: 0, end: 0 }, name: '', tags: '', progress: { done: 0, total: 0 },
  matched: [], screenshots: [], captured: null, removed: [], renamed: {}, made: {}, after: {}, expected: {}, verify: null, error: null,
  matchedRange: null, reached: 0, asked: {}, insertedTail: 0,
}

/**
 * What a new replay throws away: what the last one produced, and the removals made on it, whose indices may not mean
 * the same steps in the next. Renamed secrets carry over: they are keyed by the name the capture gave the secret.
 */
const replayed = {
  matched: [], screenshots: [], captured: null, removed: [], made: {}, after: {}, expected: {}, verify: null, error: null, matchedRange: null, reached: 1, reset: undefined,
  diverged: undefined, moved: undefined, insertedTail: 0,
}

const PHASE_AT: Record<number, Phase> = { 0: 'range', 2: 'edit', 3: 'verifying', 4: 'export' }

/** An edit makes a verification a check of a different flow: dropped, and Verify and Export must be reached again. */
const edited = (state: CaptureState) => ({ verify: null, reached: Math.min(state.reached, 2) })

export function reduce(state: CaptureState, event: CaptureEvent): CaptureState {
  switch (event.type) {
    case 'loaded': return { ...state, phase: 'range', steps: event.steps, range: event.range, name: event.name, error: null, asked: {} }
    case 'load-failed': return { ...state, phase: 'failed', error: event.error }
    case 'set-range': return { ...state, range: event.range, moved: undefined }
    case 'set-name': return { ...state, name: event.name }
    case 'set-tags': return { ...state, tags: event.tags }
    case 'set-asked': return { ...state, asked: { ...state.asked, [event.index]: event.value } }
    case 'match-started': {
      // A secret made in Edit is the replay's step, and goes with it; so does a rename of it, or the next replay's own
      // secret of that name would take it.
      const made = new Set(Object.values(state.made))
      const renamed = Object.fromEntries(Object.entries(state.renamed).filter(([from]) => !made.has(from)))
      return { ...state, ...replayed, renamed, phase: 'matching', progress: { done: 0, total: event.total } }
    }
    case 'step-matched': return {
      ...state,
      matched: [...state.matched, event.step],
      screenshots: [...state.screenshots, event.screenshot],
      progress: { ...state.progress, done: state.progress.done + (event.inserted ? 0 : 1) },
      insertedTail: event.inserted ? state.insertedTail + 1 : 0,
    }
    // Clears a stop's message: Edit what matched after Stop used to carry "stopped" into Verify, which then began failed.
    case 'match-finished': return {
      ...state, phase: 'edit', captured: event.captured, renamed: joinsThatHold(state.renamed, event.captured.secrets),
      matchedRange: state.range, reached: 2, error: null, diverged: undefined,
    }
    // Stays on Match, so what was matched so far can still be taken into Edit or replayed from the start. Only while a
    // run is on screen: a run stopped by Back to Range or Edit what matched answers after the dialog has moved on.
    case 'match-failed': return state.phase === 'matching' || state.phase === 'verifying' ? { ...state, error: event.error, diverged: undefined } : state
    case 'diverged': {
      const { type: _, ...divergence } = event
      return state.phase === 'matching' ? { ...state, diverged: divergence } : state
    }
    case 'went-on': return { ...state, diverged: undefined }
    case 'back-to-range': {
      const before = stepsBeforeRange(state.steps, state.range)
      // A range the person chose is theirs: only one still at the default is moved, and the move is said.
      const move = before.length > 0 && state.range.start === defaultRange(state.steps).start
      return {
        ...state, phase: 'range', error: null, diverged: undefined,
        ...(move ? { range: { ...state.range, start: before[0]! }, moved: before } : {}),
      }
    }
    case 'remove-step': return state.removed.includes(event.index) ? state : { ...state, ...edited(state), removed: [...state.removed, event.index] }
    // A rename to the name it already has changes no flow, so it keeps the verification.
    case 'rename-secret': {
      const current = state.renamed[event.from] ?? event.from
      if (current === event.to) return state
      // Every secret going by the old name goes by the new one, whichever of two joined (1b-3c) is renamed — the one
      // still under its own name too, which has no entry to sweep.
      const renamed = { ...state.renamed }
      for (const name of secretNames(state)) if ((renamed[name] ?? name) === current) renamed[name] = event.to
      return { ...state, ...edited(state), renamed: { ...renamed, [event.from]: event.to } }
    }
    case 'step-after': return { ...state, after: { ...state.after, [event.index]: event.after } }
    case 'add-expected': {
      const list = state.expected[event.index] ?? []
      if (list.some((s) => JSON.stringify(s) === JSON.stringify(event.selector))) return state
      return { ...state, ...edited(state), expected: { ...state.expected, [event.index]: [...list, event.selector] } }
    }
    case 'remove-expected': {
      const list = (state.expected[event.index] ?? []).filter((_, n) => n !== event.n)
      return { ...state, ...edited(state), expected: { ...state.expected, [event.index]: list } }
    }
    case 'make-secret': {
      const step = state.captured?.steps[event.index]?.step
      if (step?.type !== 'inputText' || state.made[event.index] !== undefined) return state
      return { ...state, ...edited(state), made: { ...state.made, [event.index]: freeSecretName(state) } }
    }
    case 'keep-as-text': {
      const name = state.made[event.index]
      if (name === undefined) return state
      const { [event.index]: _, ...made } = state.made
      const { [name]: __, ...renamed } = state.renamed
      return { ...state, ...edited(state), made, renamed }
    }
    case 'go-to': {
      const phase = PHASE_AT[event.step]
      return phase && canGoTo(state, event.step) ? { ...state, phase, error: null } : state
    }
    case 'verify-started': return { ...state, phase: 'verifying', verify: { status: 'running', done: 0, live: [] }, reached: 3, reset: undefined, error: null }
    case 'device-reset': return { ...state, reset: event.report }
    case 'verify-step': return state.verify ? { ...state, verify: liveStep(state.verify, event.mark, event.at) } : state
    case 'verify-finished': return state.verify
      ? { ...state, verify: { ...state.verify, status: event.result.status, done: event.result.steps.length, result: event.result } }
      : state
    case 'to-export': return { ...state, phase: 'export', reached: 4 }
  }
}

/** Whether something is running on the device: the replay, or the verification. Nothing is gone back to then. */
export function isRunning(state: CaptureState): boolean {
  // An error ends either run: a verification that threw is left `running`, with the reason in `error`.
  return state.error === null && (state.phase === 'matching' || (state.phase === 'verifying' && state.verify?.status === 'running'))
}

const sameRange = (a: StepRange, b: StepRange | null) => b !== null && a.start === b.start && a.end === b.end

/**
 * The furthest step the stepper shows as reached: what was reached, while the range is still the one replayed. Moved
 * off it, Edit and after describe a different range, and only Continue's new replay leads on.
 */
export function reachedStep(state: CaptureState): number {
  const at = stepIndex(state.phase)
  return sameRange(state.range, state.matchedRange) ? Math.max(at, state.reached) : at
}

/**
 * The steps the stepper offers to go to, back or forward: any reached step but the one shown, and none while the device
 * is replaying or verifying. Never Match: there is nothing to look at there, and the only thing to do is replay
 * again — Range's Continue, which is where that is said.
 */
export function canGoTo(state: CaptureState, step: number): boolean {
  if (isRunning(state) || step === 1 || step === stepIndex(state.phase)) return false
  return step === 0 || step <= reachedStep(state)
}

/** The stepper's index for a phase. */
export function stepIndex(phase: Phase): number {
  switch (phase) {
    case 'loading': case 'range': case 'failed': return 0
    case 'matching': return 1
    case 'edit': return 2
    case 'verifying': return 3
    case 'export': return 4
  }
}

/**
 * The recording as Match replays it: each password typed on the soft keyboard with the value the person gave (#1140),
 * else what the computer's keyboard typed of it.
 */
export function withAsked(state: Pick<CaptureState, 'steps' | 'asked'>): RawStep[] {
  return state.steps.map((s, i) => (s.kind === 'text' && s.askValue ? { ...s, text: state.asked[i] ?? s.text } : s))
}

/** Whether every password in the range that the person has to give has a value. */
export function askedReady(state: Pick<CaptureState, 'steps' | 'asked' | 'range'>): boolean {
  return askedValues(state.steps, state.range).every((i) => (state.asked[i] ?? (state.steps[i] as { text?: string }).text ?? '') !== '')
}

function liveStep(verify: NonNullable<CaptureState['verify']>, mark: StepMark, at: number): NonNullable<CaptureState['verify']> {
  if (mark.phase === 'start') {
    const live = [...verify.live.filter((s) => s.index !== mark.index), { index: mark.index, name: mark.name, status: 'running' as const, startedAt: at }]
    return { ...verify, live }
  }
  const live = verify.live.map((s) => (s.index === mark.index
    ? { ...s, name: mark.name, status: mark.status ?? 'passed', durationMs: at - s.startedAt }
    : s))
  return { ...verify, live, done: mark.index + 1 }
}

/** Every secret's own name: captured, and made in Edit. */
function secretNames(state: CaptureState): string[] {
  return [...Object.keys(state.captured?.secrets ?? {}), ...Object.values(state.made)]
}

/**
 * Renames kept through a replay, less the joins it broke: a replay of another range can give two secrets joined under
 * one name different values, and one name has one value, which would be typed into both fields. Every secret going by
 * a name whose values now differ goes back to its own — and a name given back can be one another secret was renamed
 * to since, so it is asked again until no name has two values. Each pass only drops renames, so it ends.
 */
function joinsThatHold(renamed: Record<string, string>, secrets: Record<string, string>): Record<string, string> {
  let kept = renamed
  for (;;) {
    const valuesUnder = new Map<string, Set<string>>()
    for (const [name, value] of Object.entries(secrets)) {
      const to = kept[name] ?? name
      valuesUnder.set(to, (valuesUnder.get(to) ?? new Set()).add(value))
    }
    const next = Object.fromEntries(Object.entries(kept).filter(([, to]) => (valuesUnder.get(to)?.size ?? 0) <= 1))
    if (Object.keys(next).length === Object.keys(kept).length) return kept
    kept = next
  }
}

/** The first of `SECRET`, `SECRET_2`, … no secret goes by, as captured, made or renamed. */
function freeSecretName(state: CaptureState): string {
  const names = new Set([
    ...Object.keys(state.captured?.secrets ?? {}), ...Object.values(state.made), ...Object.values(state.renamed),
  ])
  if (!names.has('SECRET')) return 'SECRET'
  let n = 2
  while (names.has(`SECRET_${n}`)) n++
  return `SECRET_${n}`
}
