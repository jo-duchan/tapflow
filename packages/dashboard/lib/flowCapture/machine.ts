import { askedValues, type CapturedFlow, type CapturedStep, type FlowResult, type RawStep, type StepRange } from '@tapflowio/flow-runner/browser'

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
  | { type: 'remove-step'; index: number }
  | { type: 'rename-secret'; from: string; to: string }
  /** The stepper: go to a step already reached (`canGoTo`). */
  | { type: 'go-to'; step: number }
  | { type: 'verify-started' }
  /** `at`: when the dialog heard it, which times the step. */
  | { type: 'verify-step'; mark: StepMark; at: number }
  | { type: 'verify-finished'; result: FlowResult }
  | { type: 'to-export' }

export const initialState: CaptureState = {
  phase: 'loading', steps: [], range: { start: 0, end: 0 }, name: '', tags: '', progress: { done: 0, total: 0 },
  matched: [], screenshots: [], captured: null, removed: [], renamed: {}, verify: null, error: null,
  matchedRange: null, reached: 0, asked: {},
}

/**
 * What a new replay throws away: what the last one produced, and the removals made on it, whose indices may not mean
 * the same steps in the next. Renamed secrets carry over: they are keyed by the name the capture gave the secret.
 */
const replayed = { matched: [], screenshots: [], captured: null, removed: [], verify: null, error: null, matchedRange: null, reached: 1 }

const PHASE_AT: Record<number, Phase> = { 0: 'range', 2: 'edit', 3: 'verifying', 4: 'export' }

/** An edit makes a verification a check of a different flow: dropped, and Verify and Export must be reached again. */
const edited = (state: CaptureState) => ({ verify: null, reached: Math.min(state.reached, 2) })

export function reduce(state: CaptureState, event: CaptureEvent): CaptureState {
  switch (event.type) {
    case 'loaded': return { ...state, phase: 'range', steps: event.steps, range: event.range, name: event.name, error: null, asked: {} }
    case 'load-failed': return { ...state, phase: 'failed', error: event.error }
    case 'set-range': return { ...state, range: event.range }
    case 'set-name': return { ...state, name: event.name }
    case 'set-tags': return { ...state, tags: event.tags }
    case 'set-asked': return { ...state, asked: { ...state.asked, [event.index]: event.value } }
    case 'match-started': return { ...state, ...replayed, phase: 'matching', progress: { done: 0, total: event.total } }
    case 'step-matched': return {
      ...state,
      matched: [...state.matched, event.step],
      screenshots: [...state.screenshots, event.screenshot],
      progress: { ...state.progress, done: state.progress.done + (event.inserted ? 0 : 1) },
    }
    case 'match-finished': return { ...state, phase: 'edit', captured: event.captured, matchedRange: state.range, reached: 2 }
    // Stays on Match, so what was matched so far can still be taken into Edit or replayed from the start.
    case 'match-failed': return { ...state, error: event.error }
    case 'remove-step': return state.removed.includes(event.index) ? state : { ...state, ...edited(state), removed: [...state.removed, event.index] }
    // A rename to the name it already has changes no flow, so it keeps the verification.
    case 'rename-secret': return (state.renamed[event.from] ?? event.from) === event.to ? state : { ...state, ...edited(state), renamed: { ...state.renamed, [event.from]: event.to } }
    case 'go-to': {
      const phase = PHASE_AT[event.step]
      return phase && canGoTo(state, event.step) ? { ...state, phase, error: null } : state
    }
    case 'verify-started': return { ...state, phase: 'verifying', verify: { status: 'running', done: 0, live: [] }, reached: 3 }
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
