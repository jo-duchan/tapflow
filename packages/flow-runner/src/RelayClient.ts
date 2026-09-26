import { randomUUID } from 'node:crypto'
import type {
  BrowserToRelay, DeviceSummary, InputErrorReason, SessionStartFailure, SessionTerminatedReason,
} from '@tapflowio/protocol'
import { WebSocket } from 'ws'
import type { UIElement } from '@tapflowio/agent-core'
import { PlatformError } from '@tapflowio/agent-core'
import { TransientQueryError } from './errors.js'

// Carries the HTTP status so ui-tree queries can tell a transient failure (retry) from a permanent one.
// status 0 marks a network-level failure (fetch rejected before a response).
export class RelayHttpError extends PlatformError {
  constructor(message: string, readonly status: number, options?: ErrorOptions, readonly permanent = false) {
    super(message, options)
  }
}

// Statuses that won't self-heal by polling: bad request, auth, missing session, device-not-booted
// (a flow always boots first, so mid-flow 409 is a dead device, not a race). Everything else
// (agent/foreground-race 502, idle-timeout 504, 5xx, network 0) is retryable.
const PERMANENT_QUERY_STATUSES = new Set([400, 401, 403, 404, 409])
const UI_ROLES = new Set(['button', 'text', 'input', 'image', 'checkbox', 'switch', 'slider', 'list', 'cell', 'tab', 'other'])

function isUIElement(value: unknown): value is UIElement {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const frame = record.frame
  if (typeof frame !== 'object' || frame === null || Array.isArray(frame)) return false
  const rect = frame as Record<string, unknown>
  if (typeof record.role !== 'string' || !UI_ROLES.has(record.role) || typeof record.label !== 'string' || typeof record.enabled !== 'boolean') return false
  if (record.identifier !== undefined && typeof record.identifier !== 'string') return false
  if (record.rawRole !== undefined && typeof record.rawRole !== 'string') return false
  const x = rect.x
  const y = rect.y
  const width = rect.width
  const height = rect.height
  if (![x, y, width, height].every((n) => typeof n === 'number' && Number.isFinite(n))) return false
  return (x as number) >= 0 && (y as number) >= 0 && (width as number) >= 0 && (height as number) >= 0
    && (x as number) + (width as number) <= 1 && (y as number) + (height as number) <= 1
}

// An input ack is a local round trip — the agent answers from its own dispatch, not from the device, which
// HID is fire-and-forget about. Generous next to `typeText`'s 15s because that one drives a paste handshake
// on the device; this one only has to cross the relay.
const INPUT_ACK_TIMEOUT_MS = 10_000

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

/**
 * What the relay has told us about a session, for the three messages this client used to drop.
 *
 * **`terminated` settles every waiter for the session, and `rebound` settles the boot waiters.**
 * `agent-away` settles nothing, and that asymmetry is the whole reason this is state rather
 * than a handler that settles waiters:
 *
 * - `agent-away` means the relay is *holding* the session for `TAPFLOW_AGENT_GRACE_MS` (15s by default),
 *   precisely so a reconnecting agent keeps it. Rejecting here would kill the case the grace exists for.
 * - `rebound` settles **boot waiters only** (#583). The binding a boot creates is exactly what the
 *   rebind loses, so a boot already in flight can never be answered — while every other request type
 *   keeps waiting: both agents reconnect without restarting the process, so the request is still
 *   executing and its reply closure goes out through `sendMsg`, which reads `this.ws` at
 *   *completion* time. Finish after the reconnect and the reply lands on the new socket, the relay
 *   forwards it to the same session, and the waiter below matches it on `requestId` and resolves.
 *   Finish during the backoff and `this.ws` is null, so `?.` swallows it. So for a non-boot request
 *   a rebound is not evidence that no answer can come, and rejecting on it would fail requests that
 *   succeed today (#573 stays separate).
 *
 * What the un-settled states *are* good for is the **timeout** branch: when a waiter does give up, this is what
 * turns "timed out" into a cause. That is the half `agent-away` was costing us — see `awaitInputAck`.
 * Three of this file's nine deadlines are shorter than the relay's 15s grace and two more sit exactly on
 * it, so for those the outcome message cannot arrive in time to settle anything.
 */
interface SessionLifecycle {
  /** `session:agent-away` seen with no outcome yet. Cleared by either outcome. */
  away: boolean
  /** `session:rebound` seen. The agent is back but `_scheduleReconnect` cleared its `deviceStates`, so the
   *  session's device binding is gone until something boots it again. The simulator and the app are not —
   *  saying "the device reset" here would be false and would invite a reinstall nothing needs. */
  needsReboot: boolean
  /** `session:terminated`'s reason, or `null` while the session is alive. Terminal: ids are not reused. */
  terminated: SessionTerminatedReason | 'unknown' | null
}

/**
 * A runtime mirror of `SessionStartFailure`, which `protocol` cannot export as a value — its main entry has
 * to erase under `import type`.
 *
 * `Record<SessionStartFailure, true>` rather than a `string[]`: the array form degrades silently when the
 * union grows, and this makes that a **compile error** in this file while still erasing to nothing at
 * runtime on protocol's side. `typeAssertions.ts` is the same idea one package over.
 */
const SESSION_START_FAILURES: Record<SessionStartFailure, true> = {
  'session-not-found': true,
  'session-busy': true,
  'agent-resources-exhausted': true,
}

// `Object.hasOwn`, not `in`: this reads a value off the wire, and a name that happens to be a prototype
// member would otherwise pass. The agents narrow key codes the same way for the same reason.
function isSessionStartFailure(v: unknown): v is SessionStartFailure {
  return typeof v === 'string' && Object.hasOwn(SESSION_START_FAILURES, v)
}

/**
 * The same mirror for `InputErrorReason`, and it exists because the comment below it was describing
 * behaviour this file did not have.
 *
 * That comment said absence **and a member this build does not know** both read as
 * `channel-unavailable`, the conservative reading protocol/AGENTS.md makes the contract. The code
 * tested `typeof === 'string'` and passed anything else straight through, so a reason added to the
 * union after this build shipped reached the step's message verbatim and any caller branching on it
 * got a value it could not act on. `mcp-server` had it right — `Object.hasOwn(REASON_ADVICE, …)`.
 *
 * `Record<InputErrorReason, true>` rather than a `string[]`, for the reason stated on the twin above:
 * the array form degrades silently when the union grows, and this makes that a compile error here.
 */
const INPUT_ERROR_REASONS: Record<InputErrorReason, true> = {
  'not-booted': true,
  'channel-unavailable': true,
  'channel-starting': true,
  'dispatch-failed': true,
  unsupported: true,
  malformed: true,
  'no-gesture': true,
  'not-session-owner': true,
}

function asInputErrorReason(v: unknown): InputErrorReason {
  return typeof v === 'string' && Object.hasOwn(INPUT_ERROR_REASONS, v) ? (v as InputErrorReason) : 'channel-unavailable'
}

/**
 * A `session:start` the relay refused, carrying the machine-readable `reason` (#512, finding 2).
 *
 * The three want different responses, which is why the prose was never enough — but this class
 * deliberately does **not** rank them. A draft exposed a `retryable` getter that was true for
 * `session-busy` alone, and reading the relay refutes it in both directions: `session-busy` is another
 * browser socket being open (`handleSessionStart`), which is a person holding the device in the dashboard
 * and can last hours, while `agent-resources-exhausted` is a *sampled* CPU/memory reading over 80% — a
 * build spike that clears in seconds and is re-read on the next attempt. The transient one was the one
 * marked permanent.
 *
 * Ranking them needs to know whether the caller can wait and what else it could pick, which is the run's
 * business, not a transport method's. So the reason is reported and the policy stays with the caller.
 */
export class SessionJoinError extends PlatformError {
  constructor(message: string, readonly reason: SessionStartFailure | 'unknown', options?: ErrorOptions) {
    super(message, options)
  }
}

// Protocol owns the wire shape. The name stays `DeviceInfo` because it is exported from this
// package's public entry and `@tapflowio/cli` imports it — renaming would be a breaking change.
export type { DeviceSummary as DeviceInfo } from '@tapflowio/protocol'

export interface AgentSession {
  agentName?: string
  platform?: string
  devices: DeviceSummary[]
}

/** What arrives **from** the relay. Deliberately still loose, and that is a deferral rather than a decision —
 *  see #512. Narrowing it to `BrowserInbound` would check the reply predicates below (and would reject a live
 *  one: `error` is matched on a `sessionId` that member does not have), but it also makes `message: string`,
 *  which turns this file's `?? 'failed'` fallbacks into unreachable code. Deleting those while nothing
 *  validates inbound JSON removes a real defence, so the validators (#444) come first.
 *
 *  Outbound is `BrowserToRelay` — see `send` below. */
type RelayMsg = Record<string, unknown>

/**
 * Matches a reply whose correlator is **optional** — the lifecycle pair only. An absent `requestId` means
 * "this frame answers no request". Two ways that reaches this client, and only one is permanent: Android's
 * mid-session `device:boot-error` has no request behind it and never will, while an id-less `device:ready`
 * here can only be an agent predating the echo. Both are accepted and logged rather than dropped. The
 * relay's replayed `device:ready` does not arrive here at all — no `sessionId`, so the comparison ahead of
 * this call excludes it, which the "not satisfied by the replay" test pins. A present
 * one must match. It did not use to tell two concurrent boots apart — the agents answered a superseded boot
 * not at all (`bootSeq`), so one waiter timed out either way. `dispatch` resolves the first matching waiter
 * and stops, so on `sessionId` + type alone the single reply went to whichever boot registered first, and
 * the boot that actually happened was the one that timed out; the correlator fixed that attribution. Since
 * #526 the abandoned boot is answered too, addressed to its own request, so both waiters now settle and the
 * correlator is what keeps each reply with the boot it belongs to.
 *
 * Deliberately not used for the app commands, whose correlator is required: lending them this fallback
 * would restore the ambiguity that work removed. See protocol/AGENTS.md.
 */
function correlatesWith(msg: RelayMsg, requestId: string): boolean {
  const id = msg['requestId']
  if (id === undefined) {
    console.error(`[tapflow] ${String(msg['type'])} carried no requestId — matched on sessionId instead`)
    return true
  }
  return id === requestId
}

interface Waiter {
  predicate: (msg: RelayMsg) => boolean
  resolve: (msg: RelayMsg) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
  /** Which session this waiter belongs to, so a `session:terminated` can settle **that** session's waiters
   *  and no others. The session id lives inside `predicate` as a closure variable and cannot be read back
   *  out — `mcp-server`'s twin records the same constraint where it hit it from the other direction. Absent
   *  on `agents:list`, which carries no session on the wire and is unaffected by one ending. */
  sessionId?: string
  /** The operation's name, for the rejection's prose. `waitFor` already took it for the timeout message;
   *  keeping it on the record is what lets a message the *dispatcher* builds name the request too. */
  what: string
  /** Set only by `bootDevice`. Lets `session:rebound` settle the one request type a rebind provably
   *  invalidates, by metadata rather than by matching the prose in `what` (#583). */
  isBoot: boolean
}

/** How long to wait for a boot before giving up on it.
 *
 * **Larger than either agent's own boot ceiling, and that is the whole point.** iOS polls for up to 90s
 * (`SimctlWrapper.BOOT_READY_TIMEOUT_MS`) and Android for up to 120s
 * (`EmulatorLauncher.BOOT_READY_TIMEOUT_MS`) before answering `device:boot-error` themselves. A client
 * that gives up first replaces a reason with a bare timeout — `flow-runner` sat at 120s, inside both (#549).
 *
 * The margin over 120s is not decoration: those constants bound **one stage** of a boot — the wait for the
 * device to report itself up — and not the request. (Narrower still on iOS, where `BOOT_POLL_READ_TIMEOUT_MS`
 * is what bounds a single reading inside that wait.) A boot also runs `listDevices`, possibly `shutdown` and
 * `erase`, the boot itself, then opens a stream, none of which has a named ceiling. The margin is the
 * allowance for those, and `scripts/__tests__/bootDeadlineOutlivesAgent.test.mjs` requires it to be there
 * rather than checking a bare inequality, which today's flow-runner (120s against Android's 120s) would
 * have passed. **A margin is not the same as a ceiling** — nothing enforces a total, which is #588.
 *
 * This is **not** the backstop for a dead agent, which is the thing it looks like. The relay declares an
 * agent away and terminates the session after its grace window, and `session:terminated` settles every
 * waiter here — in ~15s when the agent process dies and its socket sends a FIN, and in ~60s when the
 * connection is merely lost, since the relay then has to notice through the heartbeat first (30s interval,
 * 1.5 of them to declare it dead) before the 15s grace starts. Both clear this deadline with room. What it
 * actually covers is a request no live relay will ever answer — whatever is not yet known. The rebound
 * session used to be that request (a new agent never saw the boot, #583), but an invalidated boot now
 * fails fast in `rejectInvalidatedBoots` instead of burning this deadline.
 *
 * **The cost is real and belongs here rather than in a changelog.** A wedged relay now blocks a caller for
 * three minutes where it used to fail in 30 seconds, and an MCP host with its own 60s tool timeout will cut
 * in first with a message that says nothing about tapflow. That trade is deliberate — the alternative is
 * the one #549 is about, where a boot that is simply slow reports a failure that never happened — but a
 * host timeout below this number turns the diagnosis back into silence.
 */
const BOOT_DEADLINE_MS = 180_000

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// Minimal relay client for the deterministic runner: WebSocket for session and
// input control, REST for ui-tree and screenshots. Mirrors the message shapes
// the dashboard and mcp-server already use.
export class RelayClient {
  private ws: WebSocket | null = null
  /** One identity per process, so a reconnect re-joins its own sessions instead of contending with the
   *  socket it replaces. Minted here rather than supplied: nothing outside this process shares it. */
  private readonly clientId = randomUUID()
  private waiters: Waiter[] = []

  constructor(
    private readonly relayUrl: string,
    private readonly token: string,
  ) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const headers = this.token ? { Authorization: `Bearer ${this.token}` } : undefined
      // One identity for the run — see `mcp-server`'s twin.
      const url = new URL(this.relayUrl)
      url.searchParams.set('client', this.clientId)
      const ws = new WebSocket(url.toString(), { headers })
      ws.once('open', () => {
        this.ws = ws
        resolve()
      })
      ws.once('error', (e) => reject(new RelayUnavailableError(`relay connection failed: ${(e as Error).message}`)))
      ws.on('message', (data, isBinary) => {
        if (isBinary) return
        try {
          this.dispatch(JSON.parse((data as Buffer).toString()) as RelayMsg)
        } catch { /* ignore malformed */ }
      })
      ws.on('close', () => {
        this.ws = null
        for (const w of this.waiters.splice(0)) {
          clearTimeout(w.timer)
          // The other place a waiter is settled without an answer, so the other place the note belongs. A
          // relay that dropped while its agent was already away has two things to say and only one of them
          // is about the relay.
          const note = w.sessionId ? this.sessionNote(w.sessionId) : undefined
          w.reject(new RelayClosedError(note ? `relay connection closed — ${note}` : 'relay connection closed'))
        }
      })
    })
  }

  disconnect(): void {
    const ws = this.ws
    this.ws = null
    if (!ws) return
    try {
      ws.close()
    } catch {
      // ignore close errors on half-open socket
    }
    try {
      if ((ws as unknown as { readyState: number }).readyState !== WebSocket.CLOSED) ws.terminate()
    } catch {
      // ignore terminate errors
    }
  }

  private addressSkewLogged = false
  private readonly inputSilenceLogged = new Set<string>()

  /**
   * Says out loud that an input went unanswered, once per session.
   *
   * Two causes and the client cannot tell them apart, which is exactly why it has to name both: an agent
   * predating input correlation answers with no `requestId`, so its ack matches nothing here and every input
   * in the run burns the deadline; or a current agent is simply slow, in which case the input landed. The
   * step's own failure says neither, and this file already logs the equivalent skew for the join
   * (`addressSkewLogged`) and for id-less lifecycle replies — the input path was the only one failing hard
   * and silently.
   *
   * **Two causes it does not cover**, and the caller withholds it for both. A closed socket says nothing
   * about whether the agent acks, and a session the relay has reported `session:agent-away` for has an agent
   * that is not there to ack. Naming either of those an agent-version problem would send an operator to
   * check installs while the actual cause is on the wire.
   *
   * Per **session**, unlike the join's per-client flag: one flow can address several, and a slow first input
   * after a boot is a per-session event.
   */
  private warnInputAckSilence(sessionId: string): void {
    if (this.inputSilenceLogged.has(sessionId)) return
    this.inputSilenceLogged.add(sessionId)
    console.error(
      `[tapflow] an input on session ${sessionId} went unanswered for ${INPUT_ACK_TIMEOUT_MS}ms. Either the ` +
      'agent predates input correlation (its acks carry no requestId and will never match), or it is slow — ' +
      'in which case the input did land. Upgrade the agent to tell the two apart.',
    )
  }

  /** The relay's word on a session, keyed by id. Grows one entry per session this client joins, which is
   *  one per device per agent registration — slow enough that a run cannot outlive its usefulness, unlike
   *  a ledger keyed on request ids. A flow run holds one client for one run. */
  private readonly lifecycle = new Map<string, SessionLifecycle>()

  private lifecycleOf(sessionId: string): SessionLifecycle {
    let s = this.lifecycle.get(sessionId)
    if (!s) {
      s = { away: false, needsReboot: false, terminated: null }
      this.lifecycle.set(sessionId, s)
    }
    return s
  }

  /**
   * What is currently wrong with this session, as a clause to append to a failure — or `undefined` when
   * the answer is "nothing we were told about".
   *
   * Ordered by **what stops the caller first**, which is not the same as most recent. `needsReboot` is
   * cleared only by a successful boot, so a flapping agent — away, back, away again — has both it and
   * `away` set at once, and only `away` is current. Reporting the rebound there would advise a boot that
   * nothing can carry out.
   */
  private sessionNote(sessionId: string): string | undefined {
    const s = this.lifecycle.get(sessionId)
    if (!s) return undefined
    if (s.terminated) return `the relay ended this session (${s.terminated})`
    if (s.away) return "the agent's connection to the relay went away, so nothing is reaching the device"
    if (s.needsReboot) {
      // Deliberately not "the device reset". `_scheduleReconnect` clears the agent's `deviceStates`, so the
      // session's binding is gone — but the simulator stays booted and the app stays on screen, which the
      // agent keeps `lastBundleIds` outside that map to preserve. Telling a runner the device reset would
      // point it at a reinstall it does not need.
      return 'the agent reconnected and cleared its device binding, so this session needs booting again ' +
        '(the app itself is still running)'
    }
    return undefined
  }

  /**
   * A step failure carrying whatever the relay has said about this session.
   *
   * The refusals these decorate already say *what* went wrong — an agent answers a command on a rebound
   * session with `No booted device`, which is true and gives a runner nowhere to go. The note is what
   * turns it into a cause: the device is not booted **because** the agent reconnected.
   */
  private failed(sessionId: string, message: string): PlatformError {
    const note = this.sessionNote(sessionId)
    return note ? new SessionUnavailableError(`${message} — ${note}`) : new PlatformError(message)
  }

  /** Settle every waiter tagged with this session, backwards so the splice cannot skip one.
   *
   *  `make` takes the **waiter**, not just the id: the terminate message below names the request
   *  (`${w.what} failed: …`) and that field lives nowhere else. A version of this taking only `sessionId`
   *  would have quietly dropped the request's name from every terminate rejection, which is the whole of
   *  what `runFlow` puts in front of an operator. */
  private settleSessionWaiters(sessionId: string, make: (w: Waiter) => Error): void {
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      const w = this.waiters[i]
      if (w.sessionId !== sessionId) continue
      this.waiters.splice(i, 1)
      clearTimeout(w.timer)
      w.reject(make(w))
    }
  }

  /**
   * Settle the boot waiters a rebound just invalidated, and only those (#583).
   *
   * The binding a boot creates is exactly what the rebind loses — `_scheduleReconnect` clears the
   * agent's `deviceStates`, and the parked boot resumes against an unowned state `abandonBoot`
   * answers with silence — so a boot already pending when the rebound arrives can never be
   * answered. Every other request type keeps waiting: the reply closure reads `this.ws` at
   * completion time, so a finish after the reconnect lands on the new socket and matches on
   * `requestId` (#573 stays separate, and a boot issued *after* the rebound is the recovery boot
   * that restores the binding, so it must remain untouched — settling here is synchronous, which
   * is what keeps a later boot out of it).
   *
   * Through `failed()` like every other session-scoped failure here, so the rejection carries the
   * rebound cause and `RelayDriver` classifies it environmental (exit 2). `SessionUnavailableError`,
   * not `SessionEndedError`: the session is alive, only its binding is gone.
   */
  private rejectInvalidatedBoots(sessionId: string): void {
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      const w = this.waiters[i]
      if (w.sessionId !== sessionId || !w.isBoot) continue
      this.waiters.splice(i, 1)
      clearTimeout(w.timer)
      w.reject(this.failed(
        sessionId,
        `${w.what} failed: session ${sessionId} rebounded to a new agent while it was in flight, ` +
        'and that agent never saw this request',
      ))
    }
  }

  /** Settle the waiters of a session the relay has just removed. */
  private rejectSession(sessionId: string, reason: SessionTerminatedReason | 'unknown'): void {
    this.settleSessionWaiters(sessionId, (w) => new SessionEndedError(
      `${w.what} failed: the relay ended session ${sessionId} (${reason}) while it was in flight. That the ` +
      'session is gone is certain; whether the request reached the device is not, so do not repeat it blindly',
      reason,
    ))
  }

  private dispatch(msg: RelayMsg): void {
    // Read before the waiter loop, and read whether or not anything is waiting. `terminated` settles every
    // waiter for its session and `rebound` settles the boot waiters (#583) — the frame that arrives with
    // nothing pending is exactly the one that has to be remembered, because it is the next request that
    // will be confused without it.
    const sessionId = msg['sessionId']
    if (typeof sessionId === 'string') {
      switch (msg['type']) {
        case 'session:agent-away':
          this.lifecycleOf(sessionId).away = true
          console.error(
            `[tapflow] the agent behind session ${sessionId} went away. The relay holds the session briefly ` +
            'for it to come back, so a request waiting on this socket is not cancelled here — one that ' +
            'finishes after the reconnect still answers. An in-flight screenshot or ui-tree query is a ' +
            'different matter: the relay fails those itself when it starts holding.',
          )
          break
        case 'session:rebound': {
          const s = this.lifecycleOf(sessionId)
          s.away = false
          s.needsReboot = true
          this.rejectInvalidatedBoots(sessionId)
          break
        }
        case 'session:terminated': {
          const reason = msg['reason']
          // `SessionTerminatedReason` is a one-member union today, so an unrecognised value means a relay
          // newer than this client rather than a malformed frame. Recorded as `unknown` instead of being
          // coerced: the caller reads this to explain a failure, and inventing `agent-disconnected` for a
          // reason we cannot name would be a specific claim on an unknown cause.
          const named: SessionTerminatedReason | 'unknown' = reason === 'agent-disconnected' ? reason : 'unknown'
          const s = this.lifecycleOf(sessionId)
          s.away = false
          s.terminated = named
          this.rejectSession(sessionId, named)
          break
        }
        case 'session:joined': {
          // **`away` only.** A first draft deleted the whole entry, which silently undid `needsReboot` — and
          // the comment on `bootDevice` says a boot is the one thing that clears it, because a boot is the
          // one thing that answers it. A join is not a boot: it says the relay accepted us onto a live
          // session and nothing at all about whether the device is bound.
          //
          // `away` genuinely does belong here. A browser socket that drops inside the hold window misses
          // whichever outcome arrives while it is gone, so a re-join has to start from "not away" and let
          // the relay restate it — which it does, sending `session:joined` and then `session:agent-away`
          // when the session is being held. `terminated` is left alone and is unreachable either way: the
          // relay removes a terminated session, so a join naming that id is refused rather than joined.
          const s = this.lifecycle.get(sessionId)
          if (s) s.away = false
          break
        }
        default:
          break
      }
    }
    if (msg['type'] === 'error' && typeof msg['sessionId'] !== 'string' && !this.addressSkewLogged) {
      // A relay older than L5d. The refusal matches no waiter, so the join times out with no reason — this is
      // the only trace. One flow run holds one client, so once is once.
      this.addressSkewLogged = true
      console.error(
        '[tapflow] a session:start refusal carried no sessionId — this relay predates addressed errors, so a ' +
        'refused join times out rather than reporting why. Upgrade the relay.',
      )
    }
    for (let i = 0; i < this.waiters.length; i++) {
      if (this.waiters[i].predicate(msg)) {
        const [w] = this.waiters.splice(i, 1)
        clearTimeout(w.timer)
        w.resolve(msg)
        return
      }
    }
  }

  /** Typed against the wire contract, so every literal below is checked. It used to take `RelayMsg`, which is
   *  `Record<string, unknown>` — the shape that let #489 and #490 happen on the agent side, and the reason
   *  `mcp-server`'s equivalent was typed in `7637be3`. */
  private send(msg: BrowserToRelay): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new RelayUnavailableError('not connected to relay')
    }
    this.ws.send(JSON.stringify(msg))
  }

  private waitFor(
    predicate: (msg: RelayMsg) => boolean,
    timeoutMs: number,
    what: string,
    sessionId?: string,
    isBoot = false,
  ): Promise<RelayMsg> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.resolve === resolve)
        if (idx !== -1) this.waiters.splice(idx, 1)
        // Read **at the deadline**, not when the waiter was created. That is the value of holding the
        // lifecycle as state at all: the waiters that cannot outlive the relay's 15s grace never hear the
        // outcome message, so this is the only moment anything can say why the wait ended.
        const note = sessionId ? this.sessionNote(sessionId) : undefined
        reject(new RequestTimeoutError(note ? `${what} timed out — ${note}` : `${what} timed out`))
      }, timeoutMs)
      this.waiters.push({ predicate, resolve, reject, timer, sessionId, what, isBoot })
    })
  }

  async listDevices(): Promise<AgentSession[]> {
    this.send({ type: 'agents:list' })
    const msg = await this.waitFor((m) => m['type'] === 'agents:listed', 5_000, 'agents:list')
    return (msg['sessions'] as AgentSession[]) ?? []
  }

  async joinSession(sessionId: string): Promise<void> {
    this.send({ type: 'session:start', sessionId })
    const msg = await this.waitFor(
      (m) =>
        (m['type'] === 'session:joined' && m['sessionId'] === sessionId) ||
        // No `=== undefined` escape — see the twin in `mcp-server`. `error` carries an address as of L5d, and
        // the escape *was* #512's first finding: with no such key the left half was always true, so any
        // refusal resolved any pending join. The cost is version skew — a client newer than its relay sees
        // unaddressed refusals, which match nothing, so the join burns its deadline instead of reporting why
        // it was refused. Taken deliberately: there is no version handshake in this protocol, and the
        // alternative is a fallback, which is the ambiguity this work removes. Logged once per **client**,
        // not per session — a relay is per client, and the frame carries no session to key on anyway.
        (m['type'] === 'error' && m['sessionId'] === sessionId),
      5_000,
      'session join',
      sessionId,
    )
    if (msg['type'] !== 'error') return
    // `reason` is what #506 added this field for: the dashboard was branching on the free prose, handled two
    // of the three wordings, and dropped `Session busy` silently. This client was still reading the prose.
    // It is **required** on `GenericError` — single producer, three sites in the relay's `handleSessionStart`
    // — so `unknown` here means a relay predating it, not a legitimate absence.
    const reason = msg['reason']
    throw new SessionJoinError(
      `session join refused (${typeof reason === 'string' ? reason : 'unknown'}): ${(msg['message'] as string) ?? 'no detail'}`,
      isSessionStartFailure(reason) ? reason : 'unknown',
    )
  }

  /**
   * Leave the session, and settle anything still waiting on it.
   *
   * **After the send, not before.** `send` throws when the socket is not open, and a leave that never left
   * must not take the waiters with it. Not because they are already gone — `disconnect()` nulls the socket
   * synchronously while the `close` event is still queued, so at that instant they are all still there —
   * but because the socket dying is not a leave, and `RelayClosedError` is the truthful diagnosis for it.
   *
   * Nothing arrives to settle them otherwise: `session:leave` has no reply by design, and the relay nulls
   * the session's `browserSocket` as it processes one, so every later reply for that session is dropped
   * before it reaches the wire. Without this the request simply runs to its deadline (#514).
   */
  leaveSession(sessionId: string): void {
    this.send({ type: 'session:leave', sessionId })
    this.settleSessionWaiters(sessionId, (w) => new SessionLeftError(
      `${w.what} failed: this client left session ${sessionId} while the request was in flight. Whether it ` +
      'reached the device is unknown, so do not repeat it blindly — re-join the session if you still want it',
    ))
  }

  async bootDevice(sessionId: string, deviceId: string): Promise<void> {
    const requestId = randomUUID()
    this.send({ type: 'device:boot', sessionId, requestId, payload: { deviceId } })
    const msg = await this.waitFor(
      (m) => (m['type'] === 'device:ready' || m['type'] === 'device:boot-error') && m['sessionId'] === sessionId && correlatesWith(m, requestId),
      BOOT_DEADLINE_MS,
      'device boot',
      sessionId,
      true,
    )
    if (msg['type'] === 'device:boot-error') throw this.failed(sessionId, (msg['message'] as string) ?? 'boot failed')
    // The one thing that clears `needsReboot`, because it is the one thing that answers it: a rebound session
    // is missing the agent-side binding a boot creates. Clearing it anywhere else would let the note go quiet
    // while the condition it describes is still true.
    const s = this.lifecycle.get(sessionId)
    if (s) s.needsReboot = false
  }

  async installApp(sessionId: string, buildId: number): Promise<void> {
    const requestId = randomUUID()
    this.send({ type: 'app:install', sessionId, requestId, buildId })
    const msg = await this.waitFor(
      (m) => (m['type'] === 'app:install-done' || m['type'] === 'app:install-error') && m['requestId'] === requestId,
      120_000,
      'app install',
      sessionId,
    )
    if (msg['type'] === 'app:install-error') throw this.failed(sessionId, (msg['message'] as string) ?? 'install failed')
  }

  async launchApp(sessionId: string, buildId: number): Promise<void> {
    const requestId = randomUUID()
    this.send({ type: 'app:launch', sessionId, requestId, buildId })
    const msg = await this.waitFor(
      (m) => (m['type'] === 'app:launch-done' || m['type'] === 'app:launch-error') && m['requestId'] === requestId,
      30_000,
      'app launch',
      sessionId,
    )
    if (msg['type'] === 'app:launch-error') throw this.failed(sessionId, (msg['message'] as string) ?? 'launch failed')
  }

  async clearState(sessionId: string, bundleId: string): Promise<void> {
    const requestId = randomUUID()
    this.send({ type: 'app:clear-state', sessionId, requestId, payload: { bundleId } })
    const msg = await this.waitFor(
      (m) => (m['type'] === 'app:clear-state-done' || m['type'] === 'app:clear-state-error') && m['requestId'] === requestId,
      30_000,
      'clear state',
      sessionId,
    )
    if (msg['type'] === 'app:clear-state-error') throw this.failed(sessionId, (msg['message'] as string) ?? 'clear state failed')
  }

  // The correlator these mint is now read. It always was on the wire — the terminal frame declares it
  // required because the relay gates on it and every ack echoes it — and this waiter is what it was minted
  // for (#512, finding 3).
  //
  // The **opening and move frames carry none**, and that is the contract rather than an omission: nothing
  // acks them, so an id there would name a waiter that does not exist.
  async tap(sessionId: string, x: number, y: number): Promise<void> {
    const payload = { x, y }
    const requestId = randomUUID()
    this.send({ type: 'input:touch:start', sessionId, payload })
    this.send({ type: 'input:touch:end', sessionId, requestId, payload })
    await this.awaitInputAck(sessionId, requestId, 'tap')
  }

  async swipe(sessionId: string, from: [number, number], to: [number, number], durationMs: number): Promise<void> {
    // No local RangeError: schema.ts is the gate (it rejects non-finite,
    // non-positive and over-limit durations, including fractional 250.5 which
    // stays valid for 0.23.0 compatibility), and a construction here breaks
    // the sessionNoteCoverage gate with no session note in reach.
    const STEPS = 8
    const interval = durationMs / STEPS
    const requestId = randomUUID()
    this.send({ type: 'input:touch:start', sessionId, payload: { x: from[0], y: from[1] } })
    for (let i = 1; i < STEPS; i++) {
      await delay(interval)
      const t = i / STEPS
      this.send({
        type: 'input:touch:move',
        sessionId,
        payload: { x: from[0] + (to[0] - from[0]) * t, y: from[1] + (to[1] - from[1]) * t },
      })
    }
    await delay(interval)
    this.send({ type: 'input:touch:end', sessionId, requestId, payload: { x: to[0], y: to[1] } })
    await this.awaitInputAck(sessionId, requestId, 'swipe')
  }

  async typeText(sessionId: string, text: string): Promise<void> {
    const requestId = randomUUID()
    this.send({ type: 'input:type', sessionId, requestId, payload: { text } })
    const msg = await this.waitFor(
      (m) => (m['type'] === 'input:type-done' || m['type'] === 'input:type-error')
        && m['sessionId'] === sessionId && m['requestId'] === requestId,
      15_000,
      'type text',
      sessionId,
    )
    if (msg['type'] === 'input:type-error') {
      const reason = asInputErrorReason(msg['reason'])
      throw new InputRefusedError(reason, this.failed(sessionId, `type text was refused by the device (${reason}): ${(msg['message'] as string) ?? 'no detail'}`))
    }
  }

  async pressKey(sessionId: string, code: string): Promise<void> {
    const requestId = randomUUID()
    this.send({ type: 'input:key', sessionId, requestId, payload: { code, modifiers: 0 } })
    await this.awaitInputAck(sessionId, requestId, `pressKey ${code}`)
  }

  /**
   * Waits for the terminal input's ack and turns a refusal into the step's failure, with the reason on it.
   *
   * Without this a refused input was reported as a **UI** problem: the tap landed nowhere, the next
   * `assertVisible` polled until its own deadline, and the flow failed with "selector not found". For a test
   * runner that is the worst place to lose a cause.
   *
   * The typed reason now also reaches the flow result. `runFlow` catches every throw from a step as
   * `status: 'failed'`, so `RelayDriver` marks environmental refusals and the CLI can return exit 2
   * without parsing this message. Product reasons remain ordinary flow failures and return exit 1.
   *
   * **No automatic retry, deliberately.** `channel-starting` is the reason that would succeed 200ms later, and
   * retrying it here would be one line — but the retry belongs to whoever owns the step's timeout, not to a
   * transport method that cannot see it. `RelayDriver` is where a policy would go. Naming the reason is what
   * makes that decision possible at all; today it is not even visible.
   *
   * **Silence fails the step, but it is never reported as a drop.** A draft said silence "means an agent older
   * than the ack contract"; that is false and the repo already records why. `IOSAgent.ackInput` awaits an
   * `isBooted` verify — an untimed `simctl list` — on the first input after a boot or reconnect, on the same
   * Mac the relay gates at 80% CPU, so **an ack past this window can belong to an input that did land.**
   * `mcp-server` answers that with "could not confirm" and never with "dropped" (#457), and the reasoning
   * transfers: a flow cannot continue on an unconfirmed input the way an LLM can re-observe the screen, so
   * the step fails — but "tap timed out" reads as *the tap did not happen*, which is the same false certainty
   * this change exists to remove with the sign flipped.
   */
  private async awaitInputAck(sessionId: string, requestId: string, what: string): Promise<void> {
    let msg: RelayMsg
    try {
      msg = await this.waitFor(
        (m) => (m['type'] === 'input:done' || m['type'] === 'input:error')
          && m['sessionId'] === sessionId && m['requestId'] === requestId,
        INPUT_ACK_TIMEOUT_MS,
        what,
        sessionId,
      )
    } catch (e) {
      // Already the most specific thing anyone can say about this input: the session it was addressed to is
      // gone, and by name. Re-wrapping would bury that a `cause` deeper and add nothing.
      //
      // `SessionLeftError` joins it for the same reason and **only because its prose already carries the
      // warning below**. Wrapping it would say the request was "not confirmed" without saying the caller
      // is what ended it; rethrowing a message that did not mention the device would drop "may have
      // reached the device". The class is rethrown here because the message does both jobs, not because
      // the cause outranks the warning.
      if (e instanceof SessionEndedError || e instanceof SessionLeftError) throw e
      // The step fails either way and for the same reason — the reply is unconfirmed — but only a
      // deadline is evidence about the *agent*. A closed relay says nothing about whether it acks,
      // so accusing it of being old or slow there would be a false diagnosis in the one place an
      // operator goes looking.
      //
      // An agent the relay has told us is **away** is the same false accusation with a second source: the
      // ack cannot arrive because the agent is not there, and this warning would send whoever reads it to
      // check agent versions. Narrowed to `away` rather than to any note — a rebound session is answering
      // again, so silence on it is once more the agent's to explain.
      if (e instanceof RequestTimeoutError && !this.lifecycle.get(sessionId)?.away) {
        this.warnInputAckSilence(sessionId)
      }
      // **No note appended here.** Both rejection sources already carry it — `waitFor` at the deadline and
      // the close handler on a dropped socket — so adding one produced the clause twice in the same
      // sentence. One source, and the wrapper says only what the wrapper knows.
      throw new InputUnconfirmedError(
        `${what} was not confirmed (${(e as Error).message}) — it may have reached the device, so do not ` +
        'repeat it blindly',
        { cause: e },
      )
    }
    if (msg['type'] !== 'input:error') return
    // **`reason` is required on the wire as of #491, and this branch stays.** That is not an oversight: this
    // client reads inbound as `Record<string, unknown>` on purpose (see `RelayMsg` above), so the declaration
    // obliges producers and buys this call site nothing. What can still arrive without one is an agent
    // outside this repo that predates the field — the population the required declaration exists to correct
    // and cannot retroactively fix. Absent, or a member this build does not know, both read as
    // `channel-unavailable`, which is the conservative one (protocol/AGENTS.md).
    const reason = asInputErrorReason(msg['reason'])
    throw new InputRefusedError(reason, this.failed(sessionId, `${what} was refused by the device (${reason}): ${(msg['message'] as string) ?? 'no detail'}`))
  }

  async openUrl(sessionId: string, url: string): Promise<void> {
    // Correlated by `requestId`, not by `sessionId` + type. Two `open-url` calls on one session are
    // sequential today (the engine awaits each step), so this changes nothing observable here — it is
    // the pattern the remaining pairs follow, and the input acks are where it stops being cosmetic.
    const requestId = randomUUID()
    this.send({ type: 'open-url', sessionId, requestId, payload: { url } })
    const msg = await this.waitFor(
      (m) => (m['type'] === 'open-url:done' || m['type'] === 'open-url:error') && m['requestId'] === requestId,
      15_000,
      'open url',
      sessionId,
    )
    if (msg['type'] === 'open-url:error') throw this.failed(sessionId, (msg['message'] as string) ?? 'open url failed')
  }

  private httpBase(): string {
    return this.relayUrl.replace(/^wss?/, (p) => (p === 'wss' ? 'https' : 'http'))
  }

  private async getJson<T>(path: string, what: string, signal?: AbortSignal): Promise<T> {
    let res: Response
    try {
      res = await fetch(new URL(path, this.httpBase()).toString(), {
        headers: this.token ? { Authorization: `Bearer ${this.token}` } : undefined,
        signal,
      })
    } catch (e) {
      throw new RelayHttpError(`${what} failed: ${(e as Error).message}`, 0, { cause: e })
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      let message = text || `${what} failed: ${res.status}`
      try {
        const body = JSON.parse(text) as { error?: string }
        if (body.error) message = body.error
      } catch { /* keep raw text */ }
      throw new RelayHttpError(message, res.status)
    }
    try {
      return (await res.json()) as T
    } catch (e) {
      throw new RelayHttpError(`${what} returned invalid JSON: ${(e as Error).message}`, res.status, { cause: e }, true)
    }
  }

  /**
   * Poll the session's UI tree.
   *
   * **What decides retryability is this client's own record of the session, and only then the status
   * code.** The status alone cannot tell a blip from a session that will never answer again, because the
   * relay does not know which it is either — it returns 502 while an agent is away and 504 when one is
   * connected but not answering, and both of those are the same code before and after the thing that
   * settles the question.
   *
   * - `terminated` — the relay removed the session as it sent the message, so the next poll gets a 404 and
   *   the step already fails. What this adds is the *cause*: `Session not found` names the symptom of a
   *   session that ended a second ago for a reason this client was told (#545).
   * - `needsReboot` — a rebound session has no device binding, and **the engine has no boot step**: the CLI
   *   boots once before `runFlow`, so nothing can restore it mid-run. Every remaining poll returns 504,
   *   which is *not* in the permanent set, so each remaining step used to burn its whole timeout and fail
   *   as `no element matched` — naming the selector when the cause is the binding (#573). Failing here is
   *   what this package's own contract asks for: replay is deterministic, and a run that repaired itself
   *   by rebooting would not be the same execution as one that did not.
   * - `away` — **unchanged, and deliberately.** That is the relay's 15s hold, and polling through it is the
   *   case the retry exists for.
   * - no record — unchanged: the status decides, as before.
   */
  async queryUITree(sessionId: string, signal?: AbortSignal): Promise<UIElement[]> {
    try {
      const body = await this.getJson<unknown>(`/api/v1/sessions/${sessionId}/ui-tree`, 'ui-tree query', signal)
      if (typeof body !== 'object' || body === null || Array.isArray(body) || !('elements' in body) || !Array.isArray(body.elements) || !body.elements.every(isUIElement)) {
        throw new RelayHttpError('ui-tree query returned an invalid response shape', 200, undefined, true)
      }
      return body.elements
    } catch (e) {
      const s = this.lifecycle.get(sessionId)
      if (s && (s.terminated || s.needsReboot)) {
        // **The note is built from the field this branched on, not from `sessionNote`.** The two disagree on
        // one state and it is reachable: a flapping agent — away, back, away again — carries `needsReboot`
        // *and* `away` at once, because only a boot clears the first and nothing in a flow boots.
        // `sessionNote` ranks `away` above `needsReboot`, deliberately, since for a caller that can still
        // act the away-ness is what is current. Here the caller cannot act — the step is being failed — so
        // taking that precedence would report a permanent failure in the sentence for a transient one, and
        // never mention the binding. That is #573's mis-blame, one layer up.
        const why = s.terminated
          ? `the relay ended this session (${s.terminated})`
          : 'the agent reconnected and cleared its device binding, so this session needs booting again ' +
            'and nothing in a flow can (the app itself is still running)'
        throw new SessionUnavailableError(`ui-tree query failed — ${why}`, { cause: e })
      }
      // A retryable condition (foreground race, idle timeout, agent blip, network) → let the runner
      // poll again until the step deadline. Permanent failures keep their type and fail the step now.
      if (e instanceof RelayHttpError && !e.permanent && !PERMANENT_QUERY_STATUSES.has(e.status)) {
        throw new TransientQueryError(e.message, { cause: e })
      }
      throw e
    }
  }

  async screenshot(sessionId: string, signal?: AbortSignal): Promise<Buffer> {
    let res: Response
    try {
      res = await fetch(new URL(`/api/v1/sessions/${sessionId}/screenshot`, this.httpBase()).toString(), {
        headers: this.token ? { Authorization: `Bearer ${this.token}` } : undefined,
        signal,
      })
    } catch (e) {
      const failure = this.failed(sessionId, `screenshot failed: ${(e as Error).message}`)
      throw new RelayHttpError(failure.message, 0, { cause: e })
    }
    // Through `failed()` like every other session-scoped failure here. A screenshot is taken to explain a
    // step that already failed, so arriving with no cause is the worst moment for it.
    if (!res.ok) {
      const failure = this.failed(sessionId, `screenshot failed: ${res.status}`)
      throw new RelayHttpError(failure.message, res.status, { cause: failure })
    }
    return Buffer.from(await res.arrayBuffer())
  }
}
