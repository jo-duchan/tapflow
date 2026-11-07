// The entry a browser imports: the flow engine and the session semantics, with no Node anywhere in reach. The
// dashboard runs a flow through the same code `tapflow flow run` does — over its own socket, not `ws` — so a flow
// that passes in one passes in the other. `scripts/__tests__/flowRunnerBrowserGraph.test.mjs` walks every import
// from here and fails on a Node builtin, `ws`, or a secure-context-only API.
export { parseFlow, keyModifierBits } from './schema.js'
export type { Flow, Step, Selector, ScrollDirection, KeyModifier } from './schema.js'
export { runFlow, matchSelector, activityLabel, refusedFlow } from './engine.js'
export type { FlowDriver, FlowResult, StepResult, EngineOptions, SelectorSuggestion, PinchFingers } from './engine.js'
export { unavailableButton, unavailableButtonMessage } from './platformCheck.js'
export type { UnavailableButton } from './platformCheck.js'
export { DeviceLacksError, EnvironmentStepError, TransientQueryError, isEnvironmentStepFailure, markEnvironmentFailure } from './errors.js'
export {
  ENVIRONMENTAL_INPUT_REASONS, InputRefusedError, InputUnconfirmedError, RelayClosedError, RelayHttpError,
  RelayUnavailableError, RequestTimeoutError, SessionEndedError, SessionLeftError, SessionUnavailableError,
} from './sessionErrors.js'
export { SessionChannel, newRequestId } from './sessionChannel.js'
export type { RelayMsg } from './sessionChannel.js'
export { SocketFlowDriver } from './SocketFlowDriver.js'
export type { SessionDevice } from './SocketFlowDriver.js'
