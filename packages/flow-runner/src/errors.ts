import { PlatformError } from '@tapflowio/agent-core'

// A ui-tree query failure the runner should treat as transient — poll again until the step deadline
// instead of failing the step (e.g. the app isn't in the foreground yet right after launch, or the
// screen hasn't gone idle). Permanent failures (bad request, auth, missing session) are not wrapped
// in this and fail the step immediately.
export class TransientQueryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'TransientQueryError'
  }
}

// A step failure whose cause is the environment rather than the product under test: relay, agent
// or session level (a refused input with an environmental reason, a session lost to an agent restart,
// a dropped relay connection). The engine marks the flow result with it so the CLI can exit 2;
// anything else stays a product failure (exit 1). A PlatformError subclass, not a bare Error, so
// consumers catching PlatformError around driver calls keep seeing the environmental path too.
// Carries the original error as `cause` so no diagnosis is lost in the retype. Messages are preserved
// verbatim.
export class EnvironmentStepError extends PlatformError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'EnvironmentStepError'
  }
}

/**
 * The device cannot do what the step asks — a posture on a device that does not fold, an orientation on one that does
 * not report how it is held. The environment's for the exit code, like any device fault, but **the device is not
 * suspect**: a `--parallel` worker keeps it for the next flow (`FlowResult.deviceLacks`), as it keeps one after a
 * button refusal (`failedBeforeRun`). Leaving it would cost the run a healthy device per such flow.
 */
export class DeviceLacksError extends EnvironmentStepError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'DeviceLacksError'
  }
}

const markedEnvironmentFailures = new WeakSet<object>()

// Keep the original error object for callers that already narrow on a public error class, while
// giving the engine an explicit classification for relay-driver failures.
export function markEnvironmentFailure<T extends Error>(error: T): T {
  markedEnvironmentFailures.add(error)
  return error
}

export function isEnvironmentStepFailure(error: unknown): boolean {
  return error instanceof EnvironmentStepError
    || (typeof error === 'object' && error !== null && markedEnvironmentFailures.has(error))
}
