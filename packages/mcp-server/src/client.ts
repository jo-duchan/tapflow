import { randomUUID } from 'node:crypto'
import type {
  BrowserToRelay, DeviceSummary, InputErrorReason, SessionTerminatedReason, UIElement,
} from '@tapflowio/protocol'
import { EnvironmentStepError, TransientQueryError } from '@tapflowio/flow-runner'

// Protocol owns the wire shape; this file used to declare an identical copy under a name the
// relay uses for a *different* shape. Kept exported as `DeviceInfo` because that is this
// package's public name for it.
export type { DeviceSummary as DeviceInfo }
import { WebSocket } from 'ws'

export interface AgentSession {
  agentName?: string
  platform?: string
  devices: DeviceSummary[]
}

export interface BuildInfo {
  id: number
  versionName: string
  buildNumber: string
  platform: string
  statusLabel: string | null
  createdAt: string
}

export interface AppInfo {
  id: number
  name: string
  bundleId: string
  platform: string
  builds: BuildInfo[]
}

// One node of `ui:tree:response`. This used to be a hand-written mirror of `agent-core`'s `UIElement`,
// with a comment saying so — the drift `@tapflowio/protocol` exists to remove. L4a moved the type into
// protocol (a leaf both this package and the agents can reach) and this re-export is what is left.
export type { UIElement } from '@tapflowio/protocol'

type RelayMsg = Record<string, unknown>
const UI_ROLES = new Set(['button', 'text', 'input', 'image', 'checkbox', 'switch', 'slider', 'list', 'cell', 'tab', 'other'])
const PERMANENT_QUERY_STATUSES = new Set([400, 401, 403, 404, 409])
const MAX_TIMER_MS = 2_147_483_647

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

/**
 * Matches a reply whose correlator is **optional** — the lifecycle pair only. An absent `requestId` means
 * "this frame answers no request", and the two ways that reaches *this* client are worth telling apart:
 * `device:boot-error` has a producer that never has a request behind it (Android reporting a stream that
 * died mid-session), so that half is permanent; an id-less `device:ready` here can only be an agent
 * predating the echo, so that half is compatibility slack. Both are accepted and logged rather than
 * dropped. What does **not** arrive here is the relay's replayed `device:ready`: it carries no `sessionId`,
 * so the comparison ahead of this call excludes it — see the "not satisfied by the replay" test. A present
 * one must match, and what that buys is narrower than it looks — worth stating exactly, because the
 * obvious claim ("it tells two concurrent boots apart") used to be false. The agents answered a
 * **superseded** boot not at all: `bootSeq` made every checkpoint after a newer boot return silently, so of
 * two overlapping boots only the winner ever replied and one waiter timed out either way — what the
 * correlator changed was *which*. Since #526 both agents answer the abandoned boot as well, addressed to its
 * own request, so the claim is now true and the loser fails with a reason instead of running to its
 * deadline. The correlator is what makes that reply reach the waiter it belongs to.
 * `dispatch` resolves the first waiter whose predicate matches and stops, so on `sessionId` + type alone
 * that single reply went to the boot registered **first** — the superseded one — and the boot that
 * actually happened timed out. The correlator sends it to the request it answers.
 *
 * Deliberately **not** used for the app commands or clipboard. Their correlator is required, and
 * lending them this fallback would restore the ambiguity that work removed — see
 * 「No fallback, and one policy at the door」 in protocol/AGENTS.md.
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
  /** Which session this waiter belongs to, so a `session:terminated` settles **that** session's waiters and
   *  no others. This class is a long-lived stdio process and an LLM can hold several sessions at once, so
   *  rejecting the whole array would fail commands on devices that are perfectly healthy — which is the
   *  cross-session confusion #512's first finding removed from the join. Absent on `agents:list`, which
   *  carries no session on the wire.
   *
   *  The field is new, and the reason it had to be is recorded a few lines down on `addressSkewLogged`: the
   *  session id lives inside `predicate` as a closure variable and cannot be read back out. That note says
   *  keying per session "is not available"; it is available now, by putting the id on the record rather than
   *  by guessing it. */
  sessionId?: string
  /** Set only by `bootDevice`. Lets `session:rebound` settle the one request type a rebind provably
   *  invalidates, by metadata rather than by matching message prose (#583). */
  isBoot: boolean
}

/**
 * The caller left this session while a request was still in flight (#514).
 *
 * **Not `SessionEndedError`, and not a subclass of it.** That one's content is *the relay ended this and
 * that much is certain*, carried in a `reason` this case has no value for — nobody terminated anything,
 * the caller walked away from a session that is still there. The next move differs too: that one says
 * call `list_devices` and `connect_device` for a live session, this one says re-join if you still want
 * this one.
 *
 * **The prose carries the uncertainty itself**, and that is load-bearing rather than stylistic.
 * `awaitInputAck` branches on class: a class it does not know falls through `if (!timedOut &&
 * !disconnected) throw e` and its `Could not confirm … do not repeat` wording never runs. Wrapping this
 * error instead would bury the cause. Both are needed, so the message states both — the same shape
 * `SessionEndedError` has, and the reason its guard is a bare rethrow.
 */
export class SessionLeftError extends Error {}

/**
 * The relay said this session ended while a request was still in flight (#512, finding 4).
 *
 * Its own class because it carries a certainty a timeout does not. `Request timed out` says no reply
 * arrived in time; this says the session a reply would have been addressed to **no longer exists** — the
 * relay removes it in the same breath as sending the message. What stays unknown is what every
 * unconfirmed reply leaves unknown, and the prose keeps the two apart rather than reporting a clean
 * failure the caller could act on as if the device were untouched.
 */
export class SessionEndedError extends Error {
  constructor(message: string, readonly reason: SessionTerminatedReason | 'unknown') {
    super(message)
  }
}

/**
 * A waiter that reached its deadline, and one that lost the socket.
 *
 * Classes rather than the two sentinel strings `awaitInputAck` used to compare against
 * (`e.message === 'Request timed out'`, `=== 'WebSocket closed'`). The comparison was exact, and the
 * moment a deadline started carrying *why* it expired, both branches would have silently stopped
 * matching — including the one that decides whether an unanswered input is reported at all. A message is
 * prose for whoever reads it; the kind is what the code is allowed to branch on.
 */
class RequestTimeoutError extends Error {}
class RelayClosedError extends Error {}

/**
 * What the relay has told us about a session, for the three messages this client used to drop.
 *
 * **`terminated` settles every waiter for the session, and `rebound` settles the boot waiters.**
 * `agent-away` settles nothing, and holding the other two as state is precisely why they do not
 * settle anything beyond that:
 *
 * - `agent-away` means the relay is *holding* the session for `TAPFLOW_AGENT_GRACE_MS` (15s by default) so
 *   a reconnecting agent keeps it. Rejecting here kills the case the grace exists for.
 * - `rebound` settles **boot waiters only** (#583). The binding a boot creates is exactly what the
 *   rebind loses, so a boot already in flight can never be answered — while every other request type
 *   keeps waiting. Both agents reconnect without restarting the process, so the request is still
 *   running and its reply goes out through `sendMsg`, which reads the socket at *completion* time:
 *   finish after the reconnect and the reply lands and matches on `requestId`; finish during the
 *   backoff and `this.ws` is null and `?.` swallows it. For a non-boot request a rebound is
 *   therefore not evidence that no answer can come (#573 stays separate).
 *
 * What they are good for is the **deadline**. Three of this file's ten waiters are shorter than the grace
 * — `awaitInputAck` is 2s against 15s — and three more sit exactly on it, so for those no outcome message
 * can arrive in time, and this state is the only thing that knows why the wait ended.
 */
interface SessionLifecycle {
  /** `session:agent-away` seen with no outcome yet. Cleared by either outcome. */
  away: boolean
  /** `session:rebound` seen. The agent is back, but `_scheduleReconnect` cleared its `deviceStates`, so the
   *  session's device binding is gone until something boots it again. The simulator and the app are **not**
   *  gone — the agent keeps `lastBundleIds` outside that map so the app keeps running — which is why the
   *  advice here is "boot again", never "the device reset". */
  needsReboot: boolean
  /** `session:terminated`'s reason, or `null` while the session is alive. Terminal: ids are not reused. */
  terminated: SessionTerminatedReason | 'unknown' | null
}

/** How long to wait for a boot before giving up on it.
 *
 * **Larger than either agent's own boot ceiling, and that is the whole point.** iOS polls for up to 90s
 * (`SimctlWrapper.BOOT_READY_TIMEOUT_MS`) and Android for up to 120s
 * (`EmulatorLauncher.BOOT_READY_TIMEOUT_MS`) before answering `device:boot-error` themselves. A client
 * that gives up first replaces a reason with a bare timeout — `mcp-server` sat at 30s, inside both (#549).
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

/**
 * How long to wait for an install to answer.
 *
 * **Raised from an inline 60_000 because installing now includes a download.** A relay on another
 * host hands the agent a ticket and the agent fetches the build over HTTP, so bytes on the wire sit
 * inside this budget where before it was a local extract. 29MB measured over a slow tunnel is most
 * of a minute on its own.
 *
 * Below the relay's 180s ticket TTL on purpose, so a ticket never expires under a request still
 * being awaited.
 *
 * **Nothing enforces that ordering.** `bootDeadlineOutlivesAgent.test.mjs` is the shape that would —
 * it reads named constants out of two packages and compares them — and naming this one is the first
 * of the three things such a guard would need. The other two are missing: `flow-runner`'s matching
 * deadline is still an inline `120_000` (`RelayClient.ts`), and no check reads `TICKET_TTL_MS` at
 * all. Said plainly rather than implied, because a comment that sounds like it describes a guard is
 * how a guard stops being written.
 */
const INSTALL_DEADLINE_MS = 120_000

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * What the caller should do about a refused input, keyed by the wire reason.
 *
 * The caller here is a language model, so this is advice rather than a machine action — and that is
 * the decision, not a limitation. An automatic retry inside this client would hide a duplicate-input
 * hazard from the only party able to judge it: `no-gesture` in particular can mean either "nothing
 * reached the device" or "the opening frames already landed and only the last was refused", and the
 * wire cannot tell them apart (see the note on tapflow#491). A client that retried would sometimes
 * apply a drag twice with nobody able to see that it had. `TapflowClient` also drives `run_flow`, so
 * a retry here would make deterministic replay non-deterministic.
 */
export const REASON_ADVICE: Record<InputErrorReason, string> = {
  'not-booted': 'The device is not running. Call boot_device for this session before sending input.',
  'channel-unavailable': 'The input channel is gone. Reconnect the session before sending more input; repeating this input will not help.',
  'channel-starting': 'The input channel is still coming up. The same input is safe to send again in a moment.',
  // Deliberately stricter than the protocol table, which says "may retry once". The only producer is
  // Android's pointer dispatch, and `android-agent/AGENTS.md` records what the call deadline does and
  // does not buy: it cancels our call, not a request the emulator already applied, so the case it
  // actually fires in is a connected-but-unresponsive emulator where "did it land" is unknowable and
  // "a caller that retries on the error can double it". That analysis postdates and corrects the
  // source comment on `dispatchTo`, which still reads "safe to retry". Which of the two the protocol
  // table should follow is open (tapflow#491); until it is settled the advice a model acts on takes
  // the side that cannot double an input.
  'dispatch-failed': 'The device rejected the input, and whether it landed is not knowable. Do not repeat it.',
  unsupported: 'This input is not supported on the active connection to the device. Do not retry it.',
  malformed: 'The message did not carry what the input needs. This is a bug in tapflow rather than something to retry.',
  'no-gesture': 'The gesture this input was completing is gone. Part of it may already have been applied to the device, so repeating it may duplicate what landed.',
  // The only entry in this table that can promise nothing landed, and the promise is what makes it
  // actionable: the relay refused the frame at its door, before any agent saw it. Every other reason
  // leaves partial delivery open, which is why none of them says "retry" without a hedge.
  'not-session-owner': 'You do not hold this session, so the input was refused and nothing reached the device. Call connect_device for it first, then send the input again — the accompanying message says whether the session is idle or held by someone else. If the join is refused it is in use; pick another device.',
}

/** Advice for a reason, including the one this build cannot name.
 *
 *  **`undefined` stays in the signature although `reason` is required on the wire as of #491.** This client
 *  reads inbound as `Record<string, unknown>`, so the declaration obliges producers and proves nothing here;
 *  an agent outside this repo predating the field still sends none, and that population is what the required
 *  declaration exists to correct rather than something it can retroactively fix. */
export function reasonAdvice(reason: string | undefined): string {
  // Absent or unrecognised resolves to `channel-unavailable`, per the protocol's conservative rule.
  // `Object.hasOwn`, not `in`: a reason of `toString` would otherwise return a function.
  const key: InputErrorReason =
    reason !== undefined && Object.hasOwn(REASON_ADVICE, reason)
      ? (reason as InputErrorReason)
      : 'channel-unavailable'
  return REASON_ADVICE[key]
}

export class TapflowClient {
  private ws: WebSocket | null = null
  /** One identity per process, so a reconnect re-joins its own sessions instead of contending with the
   *  socket it replaces. Minted here rather than supplied: nothing outside this process shares it. */
  private readonly clientId = randomUUID()
  private waiters: Waiter[] = []
  /** Sessions that have answered at least one input **in a form this client's waiter can match**.
   *
   *  A correlated `input:done` only, and the qualifier is the whole content of the rule. `strict` licenses
   *  exactly one inference — *silence here is an anomaly, not an agent that does not ack* — and for an agent
   *  that never carries a correlator, silence at the waiter is **structural**: its acks can never match, so
   *  the inference is false for it and this set must not record it. It is not a provenance question; an
   *  id-less `input:done` is still the agent's word, since nothing else produces that message. What it
   *  lacks is attribution, and attribution is the waiter's question rather than this one's.
   *
   *  Deliberately **not** "an id this client issued". Recognising that after the fact needs a set of issued
   *  ids outliving their waiters — the late ack is precisely the one worth recording (see `dispatch`) and
   *  nothing ever says an id will not be answered, so the set would never shrink in a long-lived stdio
   *  process. And it would answer the wrong question: a correlated ack for someone else's input still
   *  demonstrates that this agent echoes correlators, which is what this set is for. */
  private ackedSessions = new Set<string>()

  /** Sessions seen answering with an **uncorrelated** ack, so an agent older than the correlator.
   *
   *  Kept apart from `ackedSessions` because it must carry no strictness: judging this session strictly is
   *  the thing the rule above rules out. It exists because there is **no protocol or agent version
   *  handshake anywhere** in this system — an id-less ack is the only skew signal there is, and dropping it
   *  silently returns the session to optimistic reporting, which from an operator's seat is
   *  indistinguishable from the defect #457 fixed. Logging is not matching, so this does not reintroduce a
   *  second correlation strategy. */
  private skewedSessions = new Set<string>()

  /** Whether an **unaddressed** `error` has been seen, so a relay older than L5d. Once per client.
   *
   *  Same reasoning as the ack skew set above and a **different cardinality**, which is the part worth
   *  stating: an agent is per session, so its skew is recorded per session — different devices answer from
   *  different agents, and one old agent says nothing about the next. A relay is per *client*. This class
   *  holds one socket to one relay for the life of the process, so "this relay predates addressed errors" is
   *  answered once and cannot change under us.
   *
   *  Keying it per session is still not available, and the reason narrowed when `Waiter` gained a
   *  `sessionId`. It **used** to be two reasons — the frame carries no session, and the join in flight was
   *  unreadable because the id lived only inside the predicate's closure. The second one is gone: the id is
   *  on the record now, put there so `session:terminated` can settle one session's waiters. The first one
   *  decides it on its own. A refusal that names no session cannot be attributed to one of several pending
   *  joins, so reaching for the record would mean naming a session on a guess — the defect this slice
   *  removes. The line names the relay, which is what the operator has to act on. */
  private addressSkewLogged = false

  private noteAddressSkew(): void {
    if (this.addressSkewLogged) return
    this.addressSkewLogged = true
    console.error(
      '[tapflow] a session:start refusal carried no sessionId — this relay predates addressed errors, so ' +
      'joins will time out rather than report why they were refused. Upgrade the relay.',
    )
  }

  private noteAckSkew(sessionId: string): void {
    if (this.skewedSessions.has(sessionId)) return
    this.skewedSessions.add(sessionId)
    console.error(
      `[tapflow] input:done for ${sessionId} carried no requestId — this agent predates input correlation, ` +
      'so an unanswered input on this session is reported optimistically rather than as a failure. ' +
      'Upgrade the agent to get truthful input acks.',
    )
  }

  constructor(
    private readonly relayUrl: string,
    readonly token: string,
  ) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      // One identity for the process, so a reconnect re-joins its own sessions rather than contending
      // with the socket it is replacing. The relay mints one per connection when this is absent, which is
      // the same behaviour a socket had before ownership moved off it.
      //
      // **This socket carries no `Authorization`** — the token is REST-only here — so the relay pairs the
      // claim with no user and the owner key is `anon:<clientId>`. The user half of its forgery protection
      // does not apply to this client; what protects the id is that it never leaves this process except in
      // its own handshake.
      const url = new URL(this.relayUrl)
      url.searchParams.set('client', this.clientId)
      const ws = new WebSocket(url.toString())
      ws.once('open', () => {
        this.ws = ws
        resolve()
      })
      ws.once('error', reject)
      ws.on('message', (data, isBinary) => {
        if (isBinary) return
        try {
          const msg = JSON.parse((data as Buffer).toString()) as RelayMsg
          this.dispatch(msg)
        } catch { /* ignore malformed */ }
      })
      ws.on('close', () => {
        this.ws = null
        const pending = this.waiters.splice(0)
        for (const w of pending) {
          clearTimeout(w.timer)
          // The other place a waiter is settled without an answer, so the other place the note belongs. A
          // relay that dropped while its agent was already away has two things to say and only one of them
          // is about the relay.
          const note = w.sessionId ? this.sessionNote(w.sessionId) : undefined
          w.reject(new RelayClosedError(note ? `WebSocket closed — ${note}` : 'WebSocket closed'))
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

  /** The relay's word on a session, keyed by id. One entry per session this process joins, which is one per
   *  device per agent registration — slow enough that this does not become the never-shrinking set the ack
   *  ledger above rules out, because that one would have grown per *request*. */
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
   * What is currently wrong with this session, as a clause to append to a failure — or `undefined` when the
   * answer is "nothing we were told about".
   *
   * Written for a model to act on, which is the one thing this file's prose diverges from `flow-runner`'s
   * for: same facts, and advice naming the tool to call next.
   *
   * Ordered by **what stops the caller first**, which is not the same as most recent. `needsReboot` is
   * cleared only by a successful boot, so a flapping agent — away, back, away again — has both it and
   * `away` set at once, and only `away` is current. Advising `boot_device` there names a call the relay
   * will refuse with `agent offline`.
   */
  private sessionNote(sessionId: string): string | undefined {
    const s = this.lifecycle.get(sessionId)
    if (!s) return undefined
    if (s.terminated) {
      return `the relay ended this session (${s.terminated}) — call list_devices and connect_device to get a ` +
        'live one before doing anything else'
    }
    if (s.away) {
      return "the agent's connection to the relay went away, so nothing is reaching the device right now"
    }
    if (s.needsReboot) {
      // **Not "the device reset".** The agent's reconnect clears its own `deviceStates`, so the session's
      // binding is gone — but the simulator stays booted and the app stays on screen. Telling a model the
      // device reset sends it to reinstall an app that is running, and a reinstall is not free.
      return 'the agent reconnected and cleared its device binding, so this session needs boot_device again ' +
        '(the app itself is still running, so it does not need reinstalling)'
    }
    return undefined
  }

  /**
   * A failure carrying whatever the relay has said about this session.
   *
   * The refusals this decorates already say *what* went wrong and give a model nowhere to go: an agent
   * answers a command on a rebound session with `No booted device`, which is true, and which a model will
   * try to fix by booting a device it believes is off. The note is what turns it into a cause — the binding
   * is gone because the agent reconnected — and names the tool that repairs it.
   */
  private failed(sessionId: string, message: string): Error {
    const note = this.sessionNote(sessionId)
    return new Error(note ? `${message} — ${note}` : message)
  }

  /** Settle every waiter tagged with this session, backwards so the splice cannot skip one.
   *
   *  `make` takes the **waiter** rather than just the id, which this package does not need today and its
   *  twin does: `flow-runner`'s rejection names the request from `Waiter.what`. One signature across both
   *  is what keeps a change to either from having to be made twice and remembered once. */
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
   * The binding a boot creates is exactly what the rebind loses — the reconnect clears the agent's
   * device state, so a boot already pending when the rebound arrives can never be answered. Every
   * other request type keeps waiting: the reply goes out through `sendMsg`, which reads the socket
   * at *completion* time, so a finish after the reconnect still answers and matches on `requestId`
   * (#573 stays separate, and a boot issued *after* the rebound is the recovery boot that restores
   * the binding, so it must remain untouched — settling here is synchronous, which is what keeps a
   * later boot out of it).
   *
   * Through `failed()` like every other session-scoped failure here, so the rejection carries the
   * rebound lifecycle note and `SESSION_NOTE_MARKERS` in `tools.ts` classifies it environmental.
   * No automatic re-boot: fail fast with the cause and leave recovery to the caller.
   */
  private rejectInvalidatedBoots(sessionId: string): void {
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      const w = this.waiters[i]
      if (w.sessionId !== sessionId || !w.isBoot) continue
      this.waiters.splice(i, 1)
      clearTimeout(w.timer)
      w.reject(this.failed(
        sessionId,
        `Boot failed: session ${sessionId} rebounded to a new agent while the request was in flight, ` +
        'and that agent never saw it',
      ))
    }
  }

  /** Settle the waiters of a session the relay has just removed. */
  private rejectSession(sessionId: string, reason: SessionTerminatedReason | 'unknown'): void {
    this.settleSessionWaiters(sessionId, () => (
      new SessionEndedError(
        `The relay ended session ${sessionId} (${reason}) while this request was in flight. That the session ` +
        'is gone is certain; whether the request reached the device is not, so check device state rather ' +
        'than assuming it did nothing. Call list_devices and connect_device to get a live session.',
        reason,
      )
    ))
  }

  private dispatch(msg: RelayMsg): void {
    // Read before the waiter loop, and read whether or not anything is waiting — the same rule the ack
    // ledger below is written to, for the same reason. `terminated` settles every waiter for its session
    // and `rebound` settles the boot waiters (#583); the copy that arrives with nothing pending is precisely
    // the one that has to be kept, because it is the *next* request that would otherwise be unexplainable.
    const lifecycleSession = msg['sessionId']
    if (typeof lifecycleSession === 'string') {
      switch (msg['type']) {
        case 'session:agent-away':
          this.lifecycleOf(lifecycleSession).away = true
          console.error(
            `[tapflow] the agent behind session ${lifecycleSession} went away. The relay holds the session ` +
            'briefly in case it comes back, so a request waiting on this socket is deliberately not ' +
            'cancelled — one that finishes after the reconnect still answers. An in-flight screenshot or ' +
            'ui-tree query is a different matter: the relay fails those itself when it starts holding.',
          )
          break
        case 'session:rebound': {
          const s = this.lifecycleOf(lifecycleSession)
          s.away = false
          s.needsReboot = true
          this.rejectInvalidatedBoots(lifecycleSession)
          break
        }
        case 'session:terminated': {
          // `SessionTerminatedReason` has one member today, so a value this build does not know means a
          // relay newer than this client rather than a malformed frame. Recorded as `unknown` rather than
          // coerced: a caller reads this to explain a failure, and inventing `agent-disconnected` for a
          // cause we cannot name is the specific-claim-on-an-unknown-cause the `reason` field exists to stop.
          const raw = msg['reason']
          const reason: SessionTerminatedReason | 'unknown' = raw === 'agent-disconnected' ? raw : 'unknown'
          const s = this.lifecycleOf(lifecycleSession)
          s.away = false
          s.terminated = reason
          this.rejectSession(lifecycleSession, reason)
          break
        }
        case 'session:joined': {
          // **`away` only.** A first draft deleted the whole entry, which silently undid `needsReboot` — and
          // `bootDevice` says a boot is the one thing that clears it, because a boot is the one thing that
          // answers it. A join is not a boot. `connect_device` is a tool a model calls freely, and the relay
          // lets a socket re-join the session it already holds, so the draft lost the reason for every later
          // failure on a rebound session: `No booted device` with nothing to say why.
          //
          // `away` does belong here. A socket that drops inside the hold window misses whichever outcome
          // arrives while it is gone, so a re-join starts from "not away" and lets the relay restate it —
          // which it does, sending `session:joined` and then `session:agent-away` for a held session.
          // `terminated` is left alone and is unreachable either way: the relay removes a terminated
          // session, so a join naming that id is refused rather than joined.
          const s = this.lifecycle.get(lifecycleSession)
          if (s) s.away = false
          break
        }
        default:
          break
      }
    }
    // `input:done` only, and that is load-bearing: the **relay** originates `input:error` to this very
    // socket for a terminal input it cannot dispatch (`RelayServer.ts`, `'agent offline'` /
    // `'Session not found'`, both `channel-unavailable`). Counting those would let one agent-offline
    // blip — or an input for a session this client never joined — mark a session as acking when its
    // agent may never have answered anything, and every later input would then be reported as
    // unconfirmed on the strength of evidence the agent did not produce. Nothing in the relay
    // originates an `input:done`, so that one is the agent's word and no one else's.
    //
    // Recorded here rather than where the ack is awaited, because the ack that teaches us the most is
    // the one that arrives *late*: it missed its window, was reported optimistically, and still proves
    // this agent acks — so the next input can be judged strictly. A ledger kept at the waiter would
    // never see it.
    // An unaddressed refusal matches no waiter now, so without this it is dropped in silence and the join
    // that it answers reports a timeout. Recorded here rather than at the waiter for the same reason the ack
    // ledger is: the frame arrives whether or not anything is still waiting for it — and the refusal that
    // arrives *after* its join gave up is the one an operator most needs explained, because that caller has
    // already been told "timed out" with no cause. A `waiters.length > 0` guard here would drop exactly that
    // one, which is why a test holds its absence.
    if (msg['type'] === 'error' && typeof msg['sessionId'] !== 'string') this.noteAddressSkew()
    if (msg['type'] === 'input:done') {
      const sid = msg['sessionId']
      const id = msg['requestId']
      if (typeof sid !== 'string') { /* nothing to key on */ }
      else if (typeof id === 'string' && id !== '') this.ackedSessions.add(sid)
      else this.noteAckSkew(sid)
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

  private send(msg: BrowserToRelay): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected to relay')
    }
    this.ws.send(JSON.stringify(msg))
  }

  private waitFor(
    predicate: (msg: RelayMsg) => boolean,
    timeoutMs: number,
    sessionId?: string,
    isBoot = false,
  ): Promise<RelayMsg> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.resolve === resolve)
        if (idx !== -1) this.waiters.splice(idx, 1)
        // Read **at the deadline**, not when the waiter was registered. That is what holding the lifecycle
        // as state buys: the waiters that cannot outlive the relay's 15s grace never hear the outcome
        // message, so this is the only moment anything can say why the wait ended.
        const note = sessionId ? this.sessionNote(sessionId) : undefined
        reject(new RequestTimeoutError(note ? `Request timed out — ${note}` : 'Request timed out'))
      }, timeoutMs)
      this.waiters.push({ predicate, resolve, reject, timer, sessionId, isBoot })
    })
  }

  async listDevices(): Promise<AgentSession[]> {
    this.send({ type: 'agents:list' })
    const msg = await this.waitFor((m) => m['type'] === 'agents:listed', 5_000)
    return (msg['sessions'] as AgentSession[]) ?? []
  }

  async connectDevice(sessionId: string): Promise<void> {
    this.send({ type: 'session:start', sessionId })
    const msg = await this.waitFor(
      (m) =>
        (m['type'] === 'session:joined' && m['sessionId'] === sessionId) ||
        // **No `=== undefined` escape.** `error` carries an address as of L5d, and the escape is what #512's
        // first finding was: with no such key the left half was always true, so *any* refusal resolved *any*
        // pending join. Two concurrent joins and the first refusal woke the wrong one — reported as a failure
        // the other session never had, while the one that did fail waited out its deadline, because
        // `dispatch` resolves only the first matching waiter.
        //
        // The cost is version skew, and it is taken deliberately rather than hedged: a client newer than its
        // relay sees unaddressed refusals, which now match nothing, so the join runs to its deadline instead
        // of throwing `'Session busy'` — advice the caller could have acted on. There is no version handshake
        // anywhere in this protocol, so the alternative was a fallback, and a fallback here is exactly the
        // ambiguity this work removes. `noteAddressSkew` logs it instead, once per client: the same shape as
        // the input-ack skew record, on the same reasoning that logging is not matching.
        (m['type'] === 'error' && m['sessionId'] === sessionId),
      5_000,
      sessionId,
    )
    if (msg['type'] === 'error') {
      // **The reason, not just the prose** — the same shape `typeText` uses below, and for the same reason:
      // `SessionStartFailure` is closed and says what to do, while `message` is the relay's wording. A
      // caller told only "Session busy" cannot tell it apart from a Mac over its resource ceiling.
      //
      // The note, but **only for a terminated session.** `sessionNote` is the one thing that can say *this
      // id was terminated in this process* — a cause the relay's reply cannot carry, since by the time it
      // answers the session is gone. Its other two answers must not be appended here: they can only be
      // reached on a re-join, and a re-join is refused precisely when this client no longer holds the
      // session, so `away` and `needsReboot` stopped being updated at the leave. Appending one produced
      // `Session busy (session-busy) — … needs boot_device again`: the relay saying another client has it,
      // and this client advising a call on a session it does not hold, from a record frozen minutes ago.
      const reason = msg['reason'] as string | undefined
      const prose = (msg['message'] as string) ?? 'Connect failed'
      const ended = this.lifecycle.get(sessionId)?.terminated
      const detail = reason ? `${prose} (${reason})` : prose
      throw new Error(ended ? `${detail} — the relay ended this session (${ended})` : detail)
    }
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
   * before it reaches the wire. Without this a `boot_device` in flight simply runs to its full deadline and
   * reports a timeout for a session the caller itself abandoned (#514). The MCP SDK dispatches each tool
   * call detached, so a model holding both calls open at once is ordinary rather than exotic.
   */
  disconnectDevice(sessionId: string): void {
    this.send({ type: 'session:leave', sessionId })
    this.settleSessionWaiters(sessionId, () => new SessionLeftError(
      `This client left session ${sessionId} while the request was in flight. Whether it reached the ` +
      'device is unknown, so check device state rather than assuming it did nothing, and do not repeat ' +
      'the request blindly. Call connect_device again if you still want this session.',
    ))
  }

  // Correlated by `requestId` when the reply carries one, and by `sessionId` + type when it does not.
  // The fallback is not compatibility slack, it is the contract: `device:ready` and `device:boot-error`
  // have producers that answer no request at all — the relay replays a cached ready to a re-joining
  // viewer, and an Android stream that dies mid-session reports it as a boot error. A strict match
  // would be the wrong shape for those, and dropping them is not free either: this waiter is the only
  // thing between `boot_device` and its full deadline. See 「Lifecycle correlation」 in protocol/AGENTS.md.
  async bootDevice(sessionId: string, deviceId: string): Promise<void> {
    const requestId = randomUUID()
    this.send({ type: 'device:boot', sessionId, requestId, payload: { deviceId } })
    const msg = await this.waitFor(
      (m) =>
        (m['type'] === 'device:ready' || m['type'] === 'device:boot-error') &&
        m['sessionId'] === sessionId &&
        correlatesWith(m, requestId),
      BOOT_DEADLINE_MS,
      sessionId,
      true,
    )
    if (msg['type'] === 'device:boot-error') {
      throw this.failed(sessionId, (msg['message'] as string) ?? 'Boot failed')
    }
    // The one thing that clears `needsReboot`, because it is the one thing that answers it: what a rebound
    // costs the session is the agent-side binding a boot creates. Clearing it anywhere else would let the
    // advice go quiet while the condition it describes is still true.
    const s = this.lifecycle.get(sessionId)
    if (s) s.needsReboot = false
  }

  // Powers the session's booted device down (agent runs simctl/adb shutdown, replies device:shutdown-done).
  // payload carries deviceId, matching the agent handler and the relay's own shutdown path. **The agent has
  // no failure reply**: Android replies done regardless, iOS surfaces a failed shutdown as a wait timeout.
  // `device:shutdown-error` is the relay's, and only the relay's — see its declaration.
  async shutdownDevice(sessionId: string, deviceId: string): Promise<void> {
    // Kept after #542, with a different job. The relay answers an undispatchable shutdown now, so this is no
    // longer the difference between a diagnosis and 30s of nothing — it saves a round trip and says more
    // than the relay can: the relay's answer for a session it has dropped is `Session not found`, while this
    // names *why* it was dropped. The sentence that used to justify it — that no `device:shutdown-error`
    // exists on the wire — is what this change made false.
    const terminated = this.lifecycle.get(sessionId)?.terminated
    if (terminated) {
      throw new SessionEndedError(
        `The relay ended session ${sessionId} (${terminated}), so a shutdown addressed to it cannot reach a ` +
        'device. Call list_devices to see which sessions are live.',
        terminated,
      )
    }
    const requestId = randomUUID()
    this.send({ type: 'device:shutdown', sessionId, requestId, payload: { deviceId } })
    // **Both members of the pair, or the fix does not reach this caller.** The relay gaining an error reply
    // changes nothing here on its own: this predicate would ignore it and the deadline would run exactly as
    // before. Nothing would report that either — inbound is `Record<string, unknown>` (#512), so no compiler
    // sees the omission, and the symptom is identical to the bug being fixed.
    const reply = await this.waitFor(
      (m) =>
        (m['type'] === 'device:shutdown-done' || m['type'] === 'device:shutdown-error') &&
        m['sessionId'] === sessionId &&
        correlatesWith(m, requestId),
      30_000,
      sessionId,
    )
    if (reply['type'] === 'device:shutdown-error') {
      throw this.failed(sessionId, (reply['message'] as string | undefined) ?? 'Shutdown failed')
    }
  }

  /**
   * Awaits the agent's terminal-input ack, sent on the gesture's last message.
   *
   * Silence used to be reported as **success**: the fallback existed for agents predating the ack
   * protocol, and it outlived them, so a tap that never reached the device was reported as landed to a
   * model that then moved on (#457).
   *
   * Two things make the fix honest.
   *
   * **Silence is answered with "could not confirm", never with "dropped".** `ackInput` awaits a
   * `simctl list` / `adb` device verify on the first input after a boot or reconnect, on the same Mac
   * the relay gates at 80% CPU — so an ack past the window can belong to an input that *did* land.
   * Calling that a drop invites a retry, and a retry of a landed input duplicates it.
   *
   * **Whether silence is fatal is decided by what this session has already done**, not by a
   * negotiated flag. If it has answered an input before, the agent demonstrably acks and later silence
   * is a real anomaly. If it never has, this is an agent that does not ack at all and the optimistic
   * path is correct for it. That degrades in the safe direction and needs nothing on the wire — where
   * a capability flag would have to be advertised, kept in step across both agents, and then live
   * forever as an inert field once every install has it.
   *
   * The residual gap is any session that has never had an answer — usually just its first input, but
   * **not bounded to one**: an agent whose acks never arrive at all keeps the optimistic path
   * indefinitely, and #457 is unchanged for it. What the gate buys is that the moment a session answers
   * once, silence after that is reported. Closing the rest needs something that distinguishes "does not
   * ack" from "did not ack this time", which per-input acks cannot express on their own.
   *
   * That gap is **closed** (#499), and this paragraph recorded it as open for a slice after it was not.
   * The ack carried no correlator, so this predicate matched any ack for the session and one arriving after
   * its own input had timed out was consumed by the next input's waiter — which then reported the previous
   * input's outcome. The predicate below now requires the id, with no fallback for an absent one.
   */
  private async awaitInputAck(sessionId: string, requestId: string): Promise<void> {
    const strict = this.ackedSessions.has(sessionId)
    let msg: RelayMsg
    try {
      msg = await this.waitFor(
        // **No fallback for an absent id.** #499 is what `sessionId` + type alone cost: an ack that missed
        // its own deadline was consumed by the next input's waiter, which then reported the previous input's
        // outcome — including reporting an unanswered input as landed. Accepting an id-less ack here would
        // keep exactly that. An old agent's acks therefore never match, and the ledger above is what makes
        // that degrade to the optimistic path instead of to a false failure.
        (m) =>
          (m['type'] === 'input:done' || m['type'] === 'input:error') &&
          m['sessionId'] === sessionId && m['requestId'] === requestId,
        2_000,
        sessionId,
      )
    } catch (e) {
      if (!(e instanceof Error)) throw e
      // Already the most specific thing anyone can say about this input, and it names the session. Wrapping
      // it in "could not confirm" would bury the certain half under the uncertain one.
      //
      // **`SessionLeftError` deliberately has no entry here**, and it was written with one until mutation
      // testing showed the line was dead: the fall-through below (`if (!timedOut && !disconnected) throw e`)
      // already rethrows an unknown class untouched, so adding this one changed nothing an assertion could
      // see. `flow-runner`'s twin is the opposite — it *wraps* everything that is not `SessionEndedError`,
      // so there the entry is load-bearing and it has one. The asymmetry is in the two methods, and mirroring
      // a no-op here to hide it would be a guard whose comment claims a protection it does not provide.
      //
      // What actually keeps the warning on a leave is the error's own prose, in both clients: it says the
      // request may have reached the device. That is why this rethrow is safe for either class, and it is
      // the thing a test can hold. If the fall-through below ever wraps instead of rethrowing, this line
      // becomes the protection and needs the entry back.
      if (e instanceof SessionEndedError) throw e
      const timedOut = e instanceof RequestTimeoutError
      // A dropped connection is *also* unconfirmed, not undispatched. Every caller sends its input
      // before awaiting the ack — `tap` sends both frames, `swipe` all ten — so by the time the socket
      // closes the input has left this process and the relay may already have forwarded it. This branch
      // used to claim the opposite, which is the same false certainty the rest of this method exists to
      // remove. It is unconfirmed regardless of the ledger: a close says nothing about whether the agent
      // acks, only that we stopped being able to hear it.
      const disconnected = e instanceof RelayClosedError
      // **The relay has already told us why this is silent, and the optimistic path must not run.**
      //
      // Without this clause the branch below returns *success* for an input whose agent the relay has
      // reported gone: `agent-away` is not sent until the agent's socket is closed, and the relay only
      // refuses inputs sent *after* that, so one already in flight gets nothing at all. That is #457's
      // defect exactly — a tap reported as landed to a model that then moves on — reached through a door
      // this client can now see through and was choosing not to look at.
      //
      // It is not a rare corner. The exemption below is for a session that has never acked, which is the
      // *first input after a boot*; `agent-away` is precisely when its ack cannot come. And this waiter is
      // 2s against the relay's 15s grace, so the outcome message that would settle the question is still
      // 13 seconds away when this decision gets made.
      const away = this.lifecycle.get(sessionId)?.away === true
      // The one case the optimistic path is still for: silence from a session that has never answered
      // an input at all is an agent that does not answer them.
      if (timedOut && !strict && !away) return
      if (!timedOut && !disconnected) throw e
      // The note first, when there is one. This branch rebuilds its own prose rather than wrapping
      // `e.message`, so it was the one path in either client where what the relay said about the session
      // did not reach the caller — a model whose input timed out on a rebound session was told the ack
      // went unanswered and not that the session needs booting again.
      const note = this.sessionNote(sessionId)
      const cause = note ?? (timedOut
        ? 'this session has acknowledged input before, and this one went unanswered'
        : 'the relay connection dropped before the acknowledgement arrived')
      throw new Error(
        `Could not confirm the input reached the device: ${cause}. Do not repeat the input — it may ` +
        'have landed. Check the device state (screenshot or ui_tree) before deciding what to do next.',
        // The prose is rebuilt, so this is the only thing carrying the original rejection's stack.
        { cause: e },
      )
    }
    if (msg['type'] === 'input:error') {
      const reason = msg['reason'] as string | undefined
      const prose = (msg['message'] as string) ?? 'Input failed'
      throw this.failed(sessionId, `${prose}${reason ? ` (${reason})` : ''} — ${reasonAdvice(reason)}`)
    }
  }

  async tap(sessionId: string, x: number, y: number): Promise<void> {
    const payload = { x, y }
    this.send({ type: 'input:touch:start', sessionId, payload })
    const requestId = randomUUID()
    this.send({ type: 'input:touch:end', sessionId, requestId, payload })
    await this.awaitInputAck(sessionId, requestId)
  }

  async swipe(
    sessionId: string,
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    durationMs = 300,
  ): Promise<void> {
    // Fractional durations (e.g. 250.5) stay valid for 0.23.0 compatibility;
    // routed through failed() so a session-scoped failure carries the session note.
    if (!Number.isFinite(durationMs) || !(durationMs > 0) || durationMs > MAX_TIMER_MS) {
      throw this.failed(sessionId, `swipe duration must be a positive finite number no greater than ${MAX_TIMER_MS}ms`)
    }
    const STEPS = 8
    const interval = durationMs / STEPS

    this.send({ type: 'input:touch:start', sessionId, payload: { x: startX, y: startY } })
    for (let i = 1; i < STEPS; i++) {
      await delay(interval)
      const t = i / STEPS
      // coordinates here are normalized 0-1 — rounding would snap every
      // intermediate move to a screen edge
      this.send({
        type: 'input:touch:move',
        sessionId,
        payload: {
          x: startX + (endX - startX) * t,
          y: startY + (endY - startY) * t,
        },
      })
    }
    await delay(interval)
    const requestId = randomUUID()
    this.send({ type: 'input:touch:end', sessionId, requestId, payload: { x: endX, y: endY } })
    await this.awaitInputAck(sessionId, requestId)
  }

  // Awaits the agent's ack so a following input (e.g. pressKey Enter) is sent
  // only after the text has landed — the paste/adb write runs async agent-side.
  async typeText(sessionId: string, text: string): Promise<void> {
    const requestId = randomUUID()
    this.send({ type: 'input:type', sessionId, requestId, payload: { text } })
    const msg = await this.waitFor(
      (m) =>
        (m['type'] === 'input:type-done' || m['type'] === 'input:type-error') &&
        m['sessionId'] === sessionId && m['requestId'] === requestId,
      15_000,
      sessionId,
    )
    if (msg['type'] === 'input:type-error') {
      // The reason is read here for the same purpose as on `input:error`: the prose is the producer's and
      // says what happened, the reason is the contract and says what to do. Agents send none — their
      // failures are a rejected `adb` or pasteboard write — so this stays prose-only for them. The relay
      // sets it, and without reading it here `not-session-owner` was unreachable for one of the five
      // requests it can refuse: the only reason that promises nothing reached the device, delivered as a
      // string the caller would have had to branch on (#492).
      const reason = msg['reason'] as string | undefined
      const prose = (msg['message'] as string) ?? 'Type text failed'
      throw this.failed(sessionId, reason ? `${prose} (${reason}) — ${reasonAdvice(reason)}` : prose)
    }
  }

  // Agents consume KeyboardEvent.code names ({ code, modifiers }) on input:key.
  // 'Return' is accepted as an alias — neither platform maps it, 'Enter' is the code.
  async pressKey(sessionId: string, key: string): Promise<void> {
    const code = key === 'Return' ? 'Enter' : key
    const requestId = randomUUID()
    this.send({ type: 'input:key', sessionId, requestId, payload: { code, modifiers: 0 } })
    await this.awaitInputAck(sessionId, requestId)
  }

  // Agents consume { name, phase? } on input:button; a phase-less message is a
  // single press on both platforms (iOS 'home' is legacy-pressed once, chrome
  // buttons and Android BUTTON_KEY_MAP names resolve by name).
  async pressButton(sessionId: string, button: string): Promise<void> {
    const requestId = randomUUID()
    this.send({ type: 'input:button', sessionId, requestId, payload: { name: button } })
    await this.awaitInputAck(sessionId, requestId)
  }

  async openUrl(sessionId: string, url: string): Promise<void> {
    // Correlated by `requestId`. The MCP SDK dispatches tool calls detached, so two `open_url`s can be
    // in flight on one session — and matching on `sessionId` + type hands the first waiter whichever
    // reply lands first, which is the class #499 is about.
    const requestId = randomUUID()
    this.send({ type: 'open-url', sessionId, requestId, payload: { url } })
    const msg = await this.waitFor(
      (m) =>
        (m['type'] === 'open-url:done' || m['type'] === 'open-url:error') &&
        m['requestId'] === requestId,
      15_000,
      sessionId,
    )
    if (msg['type'] === 'open-url:error') {
      throw this.failed(sessionId, (msg['message'] as string) ?? 'Open URL failed')
    }
  }

  async clearState(sessionId: string, bundleId: string): Promise<void> {
    const requestId = randomUUID()
    this.send({ type: 'app:clear-state', sessionId, requestId, payload: { bundleId } })
    const msg = await this.waitFor(
      (m) =>
        (m['type'] === 'app:clear-state-done' || m['type'] === 'app:clear-state-error') &&
        m['requestId'] === requestId,
      30_000,
      sessionId,
    )
    if (msg['type'] === 'app:clear-state-error') {
      throw this.failed(sessionId, (msg['message'] as string) ?? 'Clear state failed')
    }
  }

  async installApp(sessionId: string, buildId: number): Promise<void> {
    const requestId = randomUUID()
    this.send({ type: 'app:install', sessionId, requestId, buildId })
    const msg = await this.waitFor(
      (m) =>
        (m['type'] === 'app:install-done' || m['type'] === 'app:install-error') &&
        m['requestId'] === requestId,
      INSTALL_DEADLINE_MS,
      sessionId,
    )
    if (msg['type'] === 'app:install-error') {
      throw this.failed(sessionId, (msg['message'] as string) ?? 'Install failed')
    }
  }

  async launchApp(sessionId: string, buildId: number): Promise<void> {
    const requestId = randomUUID()
    this.send({ type: 'app:launch', sessionId, requestId, buildId })
    const msg = await this.waitFor(
      (m) =>
        (m['type'] === 'app:launch-done' || m['type'] === 'app:launch-error') &&
        m['requestId'] === requestId,
      15_000,
      sessionId,
    )
    if (msg['type'] === 'app:launch-error') {
      throw this.failed(sessionId, (msg['message'] as string) ?? 'Launch failed')
    }
  }

  async screenshot(sessionId: string, format: 'png' | 'jpeg' = 'png', signal?: AbortSignal): Promise<Buffer> {
    const httpBase = this.relayUrl.replace(/^wss?/, (p) => (p === 'wss' ? 'https' : 'http'))
    const url = new URL(`/api/v1/sessions/${sessionId}/screenshot`, httpBase)
    if (format === 'jpeg') url.searchParams.set('format', 'jpeg')
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${this.token}` },
      signal,
    })
    if (!res.ok) {
      // Read text first — res.json() consumes the body, so a later res.text()
      // fallback can never run after a failed JSON parse.
      const text = await res.text().catch(() => '')
      let message = text || `Screenshot failed: ${res.status}`
      try {
        const body = JSON.parse(text) as { error?: string }
        if (body.error) message = body.error
      } catch { /* keep the raw text */ }
      throw this.failed(sessionId, message)
    }
    return Buffer.from(await res.arrayBuffer())
  }

  async queryUITree(sessionId: string, signal?: AbortSignal): Promise<UIElement[]> {
    const httpBase = this.relayUrl.replace(/^wss?/, (p) => (p === 'wss' ? 'https' : 'http'))
    const url = new URL(`/api/v1/sessions/${sessionId}/ui-tree`, httpBase)
    let res: Response
    try {
      res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${this.token}` },
        signal,
      })
    } catch (e) {
      const session = this.lifecycle.get(sessionId)
      if (session?.terminated || session?.needsReboot) {
        const cause = this.failed(sessionId, `UI tree query failed: ${(e as Error).message}`)
        throw new EnvironmentStepError(`UI tree query failed: ${cause.message}`, { cause })
      }
      throw new TransientQueryError(`UI tree query failed: ${(e as Error).message}`, { cause: e })
    }
    if (!res.ok) {
      // Read text first — res.json() consumes the body, so a later res.text()
      // fallback can never run after a failed JSON parse.
      const text = await res.text().catch(() => '')
      let message = text || `UI tree query failed: ${res.status}`
      try {
        const body = JSON.parse(text) as { error?: string }
        if (body.error) message = body.error
      } catch { /* keep the raw text */ }
      const cause = this.failed(sessionId, message)
      const session = this.lifecycle.get(sessionId)
      if (session?.terminated || session?.needsReboot || PERMANENT_QUERY_STATUSES.has(res.status)) {
        throw new EnvironmentStepError(`UI tree query failed: ${cause.message}`, { cause })
      }
      throw new TransientQueryError(cause.message, { cause })
    }
    let body: unknown
    try {
      body = await res.json()
    } catch (e) {
      const cause = this.failed(sessionId, `UI tree query returned invalid JSON: ${(e as Error).message}`)
      throw new EnvironmentStepError(`UI tree query failed: ${cause.message}`, { cause })
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body) || !('elements' in body) || !Array.isArray(body.elements) || !body.elements.every(isUIElement)) {
      const cause = this.failed(sessionId, 'UI tree query returned an invalid response shape')
      throw new EnvironmentStepError(`UI tree query failed: ${cause.message}`, { cause })
    }
    return body.elements
  }

  async listBuilds(): Promise<AppInfo[]> {
    const httpBase = this.relayUrl.replace(/^wss?/, (p) => (p === 'wss' ? 'https' : 'http'))
    const headers = { Authorization: `Bearer ${this.token}` }

    const appsRes = await fetch(new URL('/api/v1/apps', httpBase).toString(), { headers })
    if (!appsRes.ok) throw new Error(`Failed to fetch apps: ${appsRes.status}`)
    // GET /apps → { items } (unpaginated); the bundle id column is bundle_id_key.
    const apps = ((await appsRes.json()) as { items?: Array<{ id: number; name: string; bundle_id_key: string; platform: string }> }).items ?? []

    // GET /builds is paginated (limit ≤ 100, default 20) — page through `total`
    // so list_builds returns every build, not just the newest page.
    type RawBuild = {
      id: number
      app_id: number
      version_name: string
      build_number: string
      platform: string
      status_label: string | null
      uploaded_at: string
    }
    const builds: RawBuild[] = []
    for (let page = 0; ; page++) {
      const url = new URL('/api/v1/builds', httpBase)
      url.searchParams.set('limit', '100')
      url.searchParams.set('page', String(page))
      const res = await fetch(url.toString(), { headers })
      if (!res.ok) throw new Error(`Failed to fetch builds: ${res.status}`)
      const body = (await res.json()) as { items?: RawBuild[]; total?: number }
      const items = body.items ?? []
      builds.push(...items)
      if (items.length === 0 || builds.length >= (body.total ?? builds.length)) break
    }

    return apps.map((app) => ({
      id: app.id,
      name: app.name,
      bundleId: app.bundle_id_key,
      platform: app.platform,
      builds: builds
        .filter((b) => b.app_id === app.id)
        .map((b) => ({
          id: b.id,
          versionName: b.version_name,
          buildNumber: b.build_number,
          platform: b.platform,
          statusLabel: b.status_label,
          createdAt: b.uploaded_at,
        })),
    }))
  }
}
