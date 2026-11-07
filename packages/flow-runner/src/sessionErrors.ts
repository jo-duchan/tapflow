import type { InputErrorReason, SessionTerminatedReason } from '@tapflowio/protocol'
import { PlatformError } from '@tapflowio/agent-core/errors'

// The errors a session's requests fail with, apart from the client that raised them: `SessionChannel` and
// `SocketFlowDriver` run in a browser too, so nothing here may reach Node. `RelayClient` re-exports every one.

// Carries the HTTP status so ui-tree queries can tell a transient failure (retry) from a permanent one.
// status 0 marks a network-level failure (fetch rejected before a response).
export class RelayHttpError extends PlatformError {
  constructor(message: string, readonly status: number, options?: ErrorOptions, readonly permanent = false) {
    super(message, options)
  }
}

/**
 * The relay connection went away while a waiter was pending.
 *
 * A distinct class because it and a timeout mean the same thing to the *caller* — the reply is
 * unconfirmed either way — and different things to whoever has to fix it. Silence past a deadline
 * says something about the agent; a closed socket says nothing about the agent at all, only that we
 * stopped being able to hear it, so the version-skew diagnosis `warnInputAckSilence` prints would be
 * a false accusation.
 */
export class RelayClosedError extends PlatformError {}

/**
 * A waiter that reached its deadline.
 *
 * `awaitInputAck` used to read this as "not a `RelayClosedError`", which is an inverse test: it stands for
 * "timed out" only while the set of rejection sources stays closed, and it silently starts meaning
 * something else the day one is added. The twin in `mcp-server` had the same shape spelled as a message
 * comparison and this change replaced it there; leaving the inverse here would keep the weaker half.
 */
export class RequestTimeoutError extends PlatformError {}

/** A request could not be confirmed because the relay connection went away or the input ack expired. */
export class InputUnconfirmedError extends PlatformError {}

/** A relay request could not be sent because the client is not connected. */
export class RelayUnavailableError extends PlatformError {}

/**
 * An input the relay refused, carrying the machine-readable `reason` (#543).
 *
 * The message is the same one `failed()` builds (prose plus the session note), so this
 * changes the classification without changing a word the operator reads. The
 * sessionNoteCoverage gate keeps holding, since the construction still reaches
 * `this.failed()`. `RelayDriver` maps the environmental reasons to exit 2; the rest
 * stay product failures.
 */
export class InputRefusedError extends PlatformError {
  constructor(readonly reason: InputErrorReason, failure: PlatformError) {
    super(failure.message, { cause: failure })
  }
}

/**
 * Input refusal reasons that name the environment rather than the product under test:
 * the device is not booted, the agent/relay channel is down or starting, the relay
 * could not dispatch, or the session belongs to someone else. `unsupported`,
 * `malformed` and `no-gesture` stay out: the first two name the test's own request,
 * and the last one's wire semantics cannot tell a clean refusal from a partially
 * applied gesture, so it must not read as infrastructure.
 */
export const ENVIRONMENTAL_INPUT_REASONS: ReadonlySet<InputErrorReason> = new Set([
  'not-booted',
  'channel-unavailable',
  'channel-starting',
  'dispatch-failed',
  'not-session-owner',
])

/**
 * A ui-tree query failed for a session the relay has told us is gone or unbound
 * (terminated, or rebound without a device binding). Same message the inline
 * `PlatformError` carried. The type is what lets the engine tell an environment
 * failure from a product one without branching on prose.
 */
export class SessionUnavailableError extends PlatformError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
  }
}

/**
 * The relay said this session ended while a request was still in flight (#512, finding 4).
 *
 * Distinct from a timeout because the two carry different certainty. A deadline says only that no reply
 * arrived in time; this says the session the reply would have been addressed to **no longer exists** —
 * `RelayServer` removes it in the same breath as sending the message. What stays unknown is the same
 * thing every unconfirmed reply leaves unknown: whether the request reached the device before the agent
 * went, which is why the prose keeps the two apart rather than reporting a clean failure.
 */
export class SessionEndedError extends PlatformError {
  constructor(message: string, readonly reason: SessionTerminatedReason | 'unknown', options?: ErrorOptions) {
    super(message, options)
  }
}

/**
 * The caller left this session while a request was still in flight (#514).
 *
 * **Not `SessionEndedError`, and not a subclass of it.** That one's content is *the relay ended this and
 * that much is certain*, carried in a `reason` this case has no value for — nobody terminated anything,
 * the caller walked away from a session that is still there. The next move differs too: that one says get
 * a live session, this one says re-join if you still want this one.
 *
 * **The prose carries the uncertainty itself**, which is what lets `awaitInputAck` rethrow it untouched.
 * Wrapping it would bury the cause; rethrowing a message that did not mention the device would drop the
 * warning. Both are needed, so the message states both — the same shape `SessionEndedError` already has,
 * and the reason its own guard is a bare rethrow.
 */
export class SessionLeftError extends PlatformError {}

