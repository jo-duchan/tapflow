import type {
  BrowserToRelay, ChromePayload, InputErrorReason, LaunchApplied, LaunchOptions, PosturesPayload, SessionTerminatedReason,
} from '@tapflowio/protocol'
import { PlatformError } from '@tapflowio/agent-core/errors'
import { chromeOrientation } from '@tapflowio/protocol/screen'
import type { PinchFingers } from './engine.js'
import { DeviceLacksError, markEnvironmentFailure } from './errors.js'
import { keyModifierBits, type KeyModifier } from './schema.js'
import {
  InputRefusedError, InputUnconfirmedError, RelayClosedError, RequestTimeoutError, SessionEndedError, SessionLeftError,
  SessionUnavailableError,
} from './sessionErrors.js'

// An input ack is a local round trip — the agent answers from its own dispatch, not from the device, which
// HID is fire-and-forget about. Generous next to `typeText`'s 15s because that one drives a paste handshake
// on the device; this one only has to cross the relay.
const INPUT_ACK_TIMEOUT_MS = 10_000

/**
 * What the relay has told us about a session, for the three messages this client used to drop.
 *
 * **Only `terminated` settles waiters here.** `agent-away` and `rebound` are held as state, and
 * that asymmetry is the whole reason this is state rather than a handler that settles waiters:
 *
 * - `agent-away` means the relay is *holding* the session for `TAPFLOW_AGENT_GRACE_MS` (15s by default),
 *   precisely so a reconnecting agent keeps it. Rejecting here would kill the case the grace exists for.
 * - `rebound` settles nothing client-side (#885). The relay answers the boots the rebind stranded
 *   with a correlated `device:boot-error` itself — it is the only layer that knows which agent
 *   socket each boot went to — while every other request type keeps waiting: both agents reconnect
 *   without restarting the process, so the request is still executing and its reply closure goes
 *   out through `sendMsg`, which reads `this.ws` at *completion* time. Finish after the reconnect
 *   and the reply lands on the new socket, the relay forwards it to the same session, and the
 *   waiter below matches it on `requestId` and resolves. Finish during the backoff and `this.ws`
 *   is null, so `?.` swallows it. So for a non-boot request a rebound is not evidence that no
 *   answer can come, and rejecting on it would fail requests that succeed today (#573 stays
 *   separate). Settling a boot here instead would fail a recovery boot the new agent was already
 *   handling, which is the defect #885 removes.
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

/** What arrives **from** the relay. Deliberately still loose, and that is a deferral rather than a decision —
 *  see #512. Narrowing it to `BrowserInbound` would check the reply predicates below (and would reject a live
 *  one: `error` is matched on a `sessionId` that member does not have), but it also makes `message: string`,
 *  which turns this file's `?? 'failed'` fallbacks into unreachable code. Deleting those while nothing
 *  validates inbound JSON removes a real defence, so the validators (#444) come first.
 *
 *  Outbound is `BrowserToRelay` — see `send` below. */
export type RelayMsg = Record<string, unknown>

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
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function isPostures(v: unknown): v is PosturesPayload {
  return typeof v === 'object' && v !== null && Array.isArray((v as PosturesPayload).postures)
}

/** A gesture this client has begun and not ended — what a leave closes on the device's behalf. */
type OpenGesture = { kind: 'touch'; at: { x: number; y: number } } | { kind: 'pinch' }

/** The relay's cap on a `session:activity` label; a longer one is dropped whole, so it is cut here first. */
const ACTIVITY_MAX = 200

/**
 * A request's correlator. **Not `crypto.randomUUID`**, which is secure-context only: a dashboard served over LAN http
 * has none (`dashboard/lib/requestId.ts` for the same reason). `getRandomValues` has no such restriction.
 */
export function newRequestId(): string {
  const b = new Uint8Array(16)
  crypto.getRandomValues(b)
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}

/**
 * One relay socket's sessions, as a browser-role client sees them: what a request is waiting for, what the relay has
 * said about each session, and what an input means on the wire — a swipe's eight moves, the gesture a leave closes,
 * the ack an input waits for. **No transport**: a host supplies `send` and feeds every inbound message to `dispatch`,
 * so the same semantics run over `ws` in Node (`RelayClient`) and over the dashboard's socket in a browser. Nothing
 * here may reach Node; `scripts/__tests__/flowRunnerBrowserGraph.test.mjs` holds that.
 */
export abstract class SessionChannel {
  /** Serialize `msg` onto the socket, or throw when there is none. */
  protected abstract send(msg: BrowserToRelay): void

  /** `send` for a host's first requests; `RelayClient` lets one through while its socket is still closing. */
  protected sendFirstRequest(msg: BrowserToRelay): void {
    this.send(msg)
  }

  protected waiters: Waiter[] = []

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
  protected readonly lifecycle = new Map<string, SessionLifecycle>()
  /** The latest chrome the relay sent for each session — the device's buttons, which a `pressButton` is checked
   *  against before a flow runs. Same lifetime as `lifecycle`. */
  private readonly chromes = new Map<string, ChromePayload>()
  /** The latest postures the relay sent for each session — what `setPosture` picks an id from. Same lifetime. */
  private readonly postures = new Map<string, PosturesPayload>()
  /** A gesture this client opened and has not ended, per session — what `leaveSession` closes before it goes. */
  private readonly openGestures = new Map<string, OpenGesture>()

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
  protected failed(sessionId: string, message: string): PlatformError {
    const note = this.sessionNote(sessionId)
    return note ? new SessionUnavailableError(`${message} — ${note}`) : new PlatformError(message)
  }

  /** Settle every waiter tagged with this session, backwards so the splice cannot skip one.
   *
   *  `make` takes the **waiter**, not just the id: the terminate message below names the request
   *  (`${w.what} failed: …`) and that field lives nowhere else. A version of this taking only `sessionId`
   *  would have quietly dropped the request's name from every terminate rejection, which is the whole of
   *  what `runFlow` puts in front of an operator. */
  protected settleSessionWaiters(sessionId: string, make: (w: Waiter) => Error): void {
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      const w = this.waiters[i]
      if (w.sessionId !== sessionId) continue
      this.waiters.splice(i, 1)
      clearTimeout(w.timer)
      w.reject(make(w))
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

  protected dispatch(msg: RelayMsg): void {
    // Read before the waiter loop, and read whether or not anything is waiting. `terminated` settles every
    // waiter for its session; `rebound` settles nothing — the relay answers the stranded boots itself
    // (#885) — and the frame that arrives with nothing pending is exactly the one that has to be
    // remembered, because it is the next request that will be confused without it.
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
          // Records the binding loss and nothing else (#885). The boots this rebind stranded are
          // answered by the relay with a correlated `device:boot-error` — settling them here as
          // well would fail a boot the new agent was already handling. `needsReboot` stays: it is
          // what the next failure carries as its cause, until a boot answers it.
          const s = this.lifecycleOf(sessionId)
          s.away = false
          s.needsReboot = true
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
    // Kept whether or not anything waits: the relay sends a session's chrome once, at join or boot, and the flow that
    // needs it — a `pressButton` checked against the device — asks afterwards.
    if (msg['type'] === 'session:chrome' && typeof msg['sessionId'] === 'string' && typeof msg['payload'] === 'object' && msg['payload'] !== null) {
      this.chromes.set(msg['sessionId'], msg['payload'] as ChromePayload)
    }
    if (msg['type'] === 'device:postures' && typeof msg['sessionId'] === 'string' && isPostures(msg['payload'])) {
      this.postures.set(msg['sessionId'], msg['payload'])
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

  /**
   * The connection under this channel is gone: every waiter is settled, since no reply can reach it now. The other
   * place a waiter is settled without an answer, so the other place the note belongs. A relay that dropped while its
   * agent was already away has two things to say and only one of them is about the relay.
   */
  protected connectionLost(closed: string): void {
    for (const w of this.waiters.splice(0)) {
      clearTimeout(w.timer)
      const note = w.sessionId ? this.sessionNote(w.sessionId) : undefined
      w.reject(new RelayClosedError(note ? `${closed} — ${note}` : closed))
    }
  }

  protected waitFor(
    predicate: (msg: RelayMsg) => boolean,
    timeoutMs: number,
    what: string,
    sessionId?: string,
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
      this.waiters.push({ predicate, resolve, reject, timer, sessionId, what })
    })
  }

  /**
   * Tells the session's watchers what this client is about to do (A2) — a step's `activityLabel`, never anything
   * typed. Fire and forget: unanswered by any relay, dropped by an older one, and never worth failing a run over.
   */
  activity(sessionId: string, label: string): void {
    const cut = [...label.trim()].slice(0, ACTIVITY_MAX).join('')
    if (!cut) return
    try { this.send({ type: 'session:activity', sessionId, label: cut }) } catch { /* not connected: nothing to tell */ }
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
    // A gesture still open would stay pressed on the device: nothing on the relay or the agent lifts a pointer its
    // client left down, and a long press or a pinch is open for its whole length — a cancel lands inside one. Closed
    // first, unanswered: the leave below settles whatever was waiting on it.
    //
    // **A touch is cancelled, then ended** (#1115). The cancel lifts it without completing it, so the app sees no tap
    // and no long press; an agent that knows the cancel then has nothing for the end to complete. The end is for one
    // that does not, or a relay that drops the cancel: it completes the gesture as before, which beats a pointer left
    // down. No pairing is worse than today, so this needs no capability check. A pinch is only ended: its moves have
    // already applied it, and the wire has no pinch cancel.
    const open = this.openGestures.get(sessionId)
    if (open) {
      this.openGestures.delete(sessionId)
      const requestId = newRequestId()
      if (open.kind === 'touch') {
        this.send({ type: 'input:touch:cancel', sessionId })
        this.send({ type: 'input:touch:end', sessionId, requestId, payload: open.at })
      } else this.send({ type: 'input:pinch:end', sessionId, requestId })
    }
    this.send({ type: 'session:leave', sessionId })
    this.settleSessionWaiters(sessionId, (w) => new SessionLeftError(
      `${w.what} failed: this client left session ${sessionId} while the request was in flight. Whether it ` +
      'reached the device is unknown, so do not repeat it blindly — re-join the session if you still want it',
    ))
  }

  /** What the relay says it understands beyond the base protocol. An older relay omits the list. */
  protected async relayFeatures(): Promise<string[]> {
    this.sendFirstRequest({ type: 'agents:list' })
    const msg = await this.waitFor((m) => m['type'] === 'agents:listed', 5_000, 'agents:list')
    const features = msg['features']
    return Array.isArray(features) ? features.filter((f): f is string => typeof f === 'string') : []
  }

  async installApp(sessionId: string, buildId: number): Promise<void> {
    const requestId = newRequestId()
    this.send({ type: 'app:install', sessionId, requestId, buildId })
    const msg = await this.waitFor(
      (m) => (m['type'] === 'app:install-done' || m['type'] === 'app:install-error') && m['requestId'] === requestId,
      120_000,
      'app install',
      sessionId,
    )
    if (msg['type'] === 'app:install-error') throw this.failed(sessionId, (msg['message'] as string) ?? 'install failed')
  }

  /** The names the agent applied, which can include the relay's per-app defaults; undefined from an older agent. */
  async launchApp(sessionId: string, buildId: number, options?: LaunchOptions): Promise<LaunchApplied | undefined> {
    // An older relay's validator strips both fields and the launch still answers done, so a flow that asked for
    // arguments would pass having launched without them.
    if (options && !(await this.relayFeatures()).includes('launch-options')) {
      throw markEnvironmentFailure(this.failed(sessionId, 'This tapflow relay is too old to pass launch arguments — update the relay'))
    }
    const requestId = newRequestId()
    this.send({ type: 'app:launch', sessionId, requestId, buildId, ...options })
    const msg = await this.waitFor(
      (m) => (m['type'] === 'app:launch-done' || m['type'] === 'app:launch-error') && m['requestId'] === requestId,
      30_000,
      'app launch',
      sessionId,
    )
    if (msg['type'] === 'app:launch-error') {
      const err = this.failed(sessionId, (msg['message'] as string) ?? 'launch failed')
      // A version mismatch, not the app failing: exit 2, like the two checks around it.
      throw msg['reason'] === 'agent-outdated' ? markEnvironmentFailure(err) : err
    }
    // The agent names the keys it applied. Sent with keys and answered without them means something on the way
    // dropped them, which the feature check above cannot see past the relay.
    if (options && msg['applied'] === undefined) {
      throw markEnvironmentFailure(this.failed(sessionId, 'The device\'s tapflow agent launched the app without the launch arguments — update tapflow on that Mac'))
    }
    const applied = msg['applied']
    if (applied === undefined) return undefined
    // Read off an agent's reply, which nothing on the way validates; a malformed one would throw later, after the
    // app is up, and be counted as the app failing.
    if (!isLaunchApplied(applied)) {
      throw markEnvironmentFailure(this.failed(sessionId, 'The device\'s tapflow agent answered the launch with a malformed list of applied options — update tapflow on that Mac'))
    }
    return applied
  }

  async clearState(sessionId: string, bundleId: string): Promise<void> {
    const requestId = newRequestId()
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
    const requestId = newRequestId()
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
    const requestId = newRequestId()
    this.send({ type: 'input:touch:start', sessionId, payload: { x: from[0], y: from[1] } })
    const gesture: OpenGesture = { kind: 'touch', at: { x: from[0], y: from[1] } }
    this.openGestures.set(sessionId, gesture)
    for (let i = 1; i < STEPS; i++) {
      await delay(interval)
      if (this.openGestures.get(sessionId) !== gesture) return this.leftMidGesture(sessionId, 'swipe')
      const t = i / STEPS
      this.send({
        type: 'input:touch:move',
        sessionId,
        payload: { x: from[0] + (to[0] - from[0]) * t, y: from[1] + (to[1] - from[1]) * t },
      })
    }
    await delay(interval)
    if (!this.closeGesture(sessionId, gesture)) return this.leftMidGesture(sessionId, 'swipe')
    this.send({ type: 'input:touch:end', sessionId, requestId, payload: { x: to[0], y: to[1] } })
    // A swipe that stays put is a hold to Android's adb path, which replays it after the end arrives — as a long press.
    await this.awaitInputAck(sessionId, requestId, 'swipe', durationMs)
  }

  async typeText(sessionId: string, text: string): Promise<void> {
    const requestId = newRequestId()
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

  async pressKey(sessionId: string, code: string, modifiers?: readonly KeyModifier[]): Promise<void> {
    const requestId = newRequestId()
    this.send({ type: 'input:key', sessionId, requestId, payload: { code, modifiers: keyModifierBits(modifiers) } })
    await this.awaitInputAck(sessionId, requestId, `pressKey ${code}`)
  }

  async pressButton(sessionId: string, name: string): Promise<void> {
    const requestId = newRequestId()
    this.send({ type: 'input:button', sessionId, requestId, payload: { name } })
    await this.awaitInputAck(sessionId, requestId, `pressButton ${name}`)
  }

  /**
   * A touch held still for `durationMs`. No move frames: a long press is recognised by the app's own timer, so a
   * pointer that stays down is the whole gesture on every backend. The ack may come up to `durationMs` later than a
   * tap's, because Android's adb path replays the hold after the end arrives.
   */
  async longPress(sessionId: string, x: number, y: number, durationMs: number): Promise<void> {
    const payload = { x, y }
    const requestId = newRequestId()
    this.send({ type: 'input:touch:start', sessionId, payload })
    const gesture: OpenGesture = { kind: 'touch', at: payload }
    this.openGestures.set(sessionId, gesture)
    await delay(durationMs)
    if (!this.closeGesture(sessionId, gesture)) return this.leftMidGesture(sessionId, 'longPress')
    this.send({ type: 'input:touch:end', sessionId, requestId, payload })
    await this.awaitInputAck(sessionId, requestId, 'longPress', durationMs)
  }

  /**
   * Two fingers from `start` to `end` over `durationMs`. Both agents inject each move the moment it arrives, so the
   * pace is set here: the moves are spread over the duration as `swipe`'s are, and sent at once a recogniser would
   * read them as a jump. The last move is the end position — `input:pinch:end` carries none.
   */
  async pinch(sessionId: string, start: PinchFingers, end: PinchFingers, durationMs: number): Promise<void> {
    const STEPS = 8
    const interval = durationMs / STEPS
    const at = (t: number) => ({
      f0: { x: start[0][0] + (end[0][0] - start[0][0]) * t, y: start[0][1] + (end[0][1] - start[0][1]) * t },
      f1: { x: start[1][0] + (end[1][0] - start[1][0]) * t, y: start[1][1] + (end[1][1] - start[1][1]) * t },
    })
    this.send({ type: 'input:pinch:start', sessionId, payload: at(0) })
    const gesture: OpenGesture = { kind: 'pinch' }
    this.openGestures.set(sessionId, gesture)
    for (let i = 1; i <= STEPS; i++) {
      await delay(interval)
      if (this.openGestures.get(sessionId) !== gesture) return this.leftMidGesture(sessionId, 'pinch')
      this.send({ type: 'input:pinch:move', sessionId, payload: at(i / STEPS) })
    }
    this.closeGesture(sessionId, gesture)
    const requestId = newRequestId()
    this.send({ type: 'input:pinch:end', sessionId, requestId })
    await this.awaitInputAck(sessionId, requestId, 'pinch')
  }

  /** Whether `gesture` was still this session's open one, forgetting it if so. Compared by identity, not by session:
   *  a gesture opened after a leave and a re-join must not be closed, or moved, by one the leave already ended. */
  private closeGesture(sessionId: string, gesture: OpenGesture): boolean {
    if (this.openGestures.get(sessionId) !== gesture) return false
    this.openGestures.delete(sessionId)
    return true
  }

  /**
   * Turn the device to `orientation`, resolving once a chrome says it is held that way. Sends nothing when the latest
   * chrome already does. Waits for **the chrome that names the target**, not the first one: an Android body coming
   * upright sends two to four on the way (measured). The waiter is registered before the turn is sent, so a fast
   * answer is not missed. Not the app's orientation — a portrait-locked app stays portrait, and that is right: the
   * step turns the device, as the dashboard's Rotate does.
   */
  async setOrientation(sessionId: string, orientation: 'portrait' | 'landscape', timeoutMs: number): Promise<void> {
    const chrome = await this.chrome(sessionId, timeoutMs)
    if (!chrome) throw markEnvironmentFailure(this.failed(sessionId, `setOrientation: the device sent no chrome within ${timeoutMs / 1000}s, so which way it is held is unknown`))
    const now = chromeOrientation(chrome)
    if (now === undefined) {
      const which = 'framePng' in chrome ? 'a multi-panel iOS device, whose turn includes its panel\'s own (#1116)' : 'an Android backend without a body turn (scrcpy)'
      throw new DeviceLacksError(this.failed(sessionId, `setOrientation: this is ${which}, which does not report which way it is held, so a turn could not be confirmed`).message)
    }
    if (now === orientation) return
    const turned = this.waitFor(
      (m) => m['type'] === 'session:chrome' && m['sessionId'] === sessionId && typeof m['payload'] === 'object' && m['payload'] !== null
        && chromeOrientation(m['payload'] as ChromePayload) === orientation,
      timeoutMs, `turn to ${orientation}`, sessionId,
    )
    this.send({ type: 'input:rotate', sessionId, payload: { orientation } })
    try {
      await turned
    } catch (e) {
      if (e instanceof RequestTimeoutError) throw markEnvironmentFailure(this.failed(sessionId, `setOrientation: the device did not report ${orientation} within ${timeoutMs / 1000}s`))
      throw e
    }
  }

  /**
   * Put the device in its most closed (`folded`) or most open (`unfolded`) posture, resolving once it reports that
   * posture as current. **An empty list is not an answer**: iOS sends one before the device is ready and one in the
   * middle of a fold (measured), so this waits for a list with postures in it, and only a deadline with none says the
   * device does not fold. A list of other than two refuses: which end is "open" is then not certain (protocol
   * `DevicePosture`; a rear-display posture would sort last).
   */
  async setPosture(sessionId: string, posture: 'folded' | 'unfolded', timeoutMs: number): Promise<void> {
    let list = this.postures.get(sessionId)
    if (!list || list.postures.length === 0) {
      try {
        const msg = await this.waitFor(
          (m) => m['type'] === 'device:postures' && m['sessionId'] === sessionId && isPostures(m['payload']) && m['payload'].postures.length > 0,
          timeoutMs, 'device postures', sessionId,
        )
        list = msg['payload'] as PosturesPayload
      } catch (e) {
        if (e instanceof RequestTimeoutError) {
          throw new DeviceLacksError(this.failed(sessionId, `setPosture: this device reported no postures within ${timeoutMs / 1000}s — it does not fold`).message)
        }
        throw e
      }
    }
    if (list.postures.length !== 2) {
      throw markEnvironmentFailure(this.failed(sessionId, `setPosture: the device offers ${list.postures.length} postures, so which is ${posture} is not certain (expected two)`))
    }
    const target = (posture === 'folded' ? list.postures[0] : list.postures[1])!.id
    if (list.currentId === target) return
    const arrived = this.waitFor(
      (m) => m['type'] === 'device:postures' && m['sessionId'] === sessionId && isPostures(m['payload']) && m['payload'].currentId === target,
      timeoutMs, `posture ${posture}`, sessionId,
    )
    this.send({ type: 'input:posture', sessionId, payload: { postureId: target } })
    try {
      await arrived
    } catch (e) {
      if (e instanceof RequestTimeoutError) throw markEnvironmentFailure(this.failed(sessionId, `setPosture: the device did not report ${posture} within ${timeoutMs / 1000}s`))
      throw e
    }
  }

  /** A gesture `leaveSession` closed while its sender was still pacing it: the leave is why, and it says so. */
  private leftMidGesture(sessionId: string, what: string): never {
    throw new SessionLeftError(`${what} failed: this client left session ${sessionId} while the gesture was in progress — it was ended where it was`)
  }

  /**
   * The session's chrome, or the next one to arrive within `timeoutMs`; `null` when none did. The relay sends it at
   * join and boot, so by the time a flow starts it is normally here already.
   */
  async chrome(sessionId: string, timeoutMs: number): Promise<ChromePayload | null> {
    const known = this.chromes.get(sessionId)
    if (known) return known
    try {
      const msg = await this.waitFor((m) => m['type'] === 'session:chrome' && m['sessionId'] === sessionId, timeoutMs, 'device chrome', sessionId)
      return msg['payload'] as ChromePayload
    } catch (e) {
      if (e instanceof RequestTimeoutError) return null
      throw e
    }
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
  private async awaitInputAck(sessionId: string, requestId: string, what: string, extraMs = 0): Promise<void> {
    let msg: RelayMsg
    try {
      msg = await this.waitFor(
        (m) => (m['type'] === 'input:done' || m['type'] === 'input:error')
          && m['sessionId'] === sessionId && m['requestId'] === requestId,
        INPUT_ACK_TIMEOUT_MS + extraMs,
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
    const requestId = newRequestId()
    this.send({ type: 'open-url', sessionId, requestId, payload: { url } })
    const msg = await this.waitFor(
      (m) => (m['type'] === 'open-url:done' || m['type'] === 'open-url:error') && m['requestId'] === requestId,
      15_000,
      'open url',
      sessionId,
    )
    if (msg['type'] === 'open-url:error') throw this.failed(sessionId, (msg['message'] as string) ?? 'open url failed')
  }
}

function isLaunchApplied(v: unknown): v is LaunchApplied {
  const names = (x: unknown) => Array.isArray(x) && x.every((s) => typeof s === 'string')
  return typeof v === 'object' && v !== null && names((v as Record<string, unknown>)['arguments']) && names((v as Record<string, unknown>)['env'])
}
