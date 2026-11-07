import { randomUUID } from 'node:crypto'
import type {
  AdmissionRefusal, BootRefusalReason, BrowserToRelay, RunResetRequest, ServiceTier, DeviceSummary, SessionStartFailure,
} from '@tapflowio/protocol'
import { WebSocket } from 'ws'
import type { UIElement } from '@tapflowio/agent-core'
import { PlatformError } from '@tapflowio/agent-core/errors'
import { TransientQueryError } from './errors.js'
import { interfaceTurnOf, type InterfaceTurn } from '@tapflowio/protocol/screen'
import { authHeader, fetchWithToken, fixedToken, tokenRefusal, type TokenSource } from './credentials.js'
import { SessionChannel, type RelayMsg } from './sessionChannel.js'
import { RelayHttpError, RelayUnavailableError, SessionUnavailableError } from './sessionErrors.js'

export {
  ENVIRONMENTAL_INPUT_REASONS, InputRefusedError, InputUnconfirmedError, RelayClosedError, RelayHttpError,
  RelayUnavailableError, RequestTimeoutError, SessionEndedError, SessionLeftError, SessionUnavailableError,
} from './sessionErrors.js'

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
  if (record.placeholder !== undefined && typeof record.placeholder !== 'string') return false
  if (record.secure !== undefined && typeof record.secure !== 'boolean') return false
  if (record.focused !== undefined && typeof record.focused !== 'boolean') return false
  const x = rect.x
  const y = rect.y
  const width = rect.width
  const height = rect.height
  if (![x, y, width, height].every((n) => typeof n === 'number' && Number.isFinite(n))) return false
  return (x as number) >= 0 && (y as number) >= 0 && (width as number) >= 0 && (height as number) >= 0
    && (x as number) + (width as number) <= 1 && (y as number) + (height as number) <= 1
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

/** Runtime mirror of `BootRefusalReason`, for the reason given on `SESSION_START_FAILURES`. */
const BOOT_REFUSALS: Record<BootRefusalReason, true> = {
  'host-booting': true,
  'host-memory-critical': true,
  'host-at-capacity': true,
}

/**
 * A refusal this client knows by name, or `unrecognised-refusal` for one a newer relay added. Only the relay's
 * admission gate puts a `reason` on a refused boot, and it refuses only a Mac that is busy, so a reason this build
 * has never heard of is waited out like the others rather than failing the run as broken. `all-held` is a lease's:
 * every fitting device is in use, which also passes.
 */
export type AdmissionReason = AdmissionRefusal | 'all-held' | 'unrecognised-refusal'

/**
 * A boot the relay refused before it reached an agent, because another boot on the same Mac has not settled
 * (`relay/src/admission/`). The Mac is busy, not broken, and the refusal says nothing about this session — so
 * the class is the cause and no session note is added. `retryAdmission` waits these out.
 */
export class AdmissionRefusedError extends PlatformError {
  constructor(message: string, readonly reason: AdmissionReason, options?: ErrorOptions) {
    super(message, options)
  }
}

/**
 * A lease the relay cannot serve however long this client waits: no device of the platform (`no-device`), or no
 * platform it could read (`bad-request`). A lease refused for a busy Mac throws `AdmissionRefusedError` instead.
 */
export class LeaseRefusedError extends PlatformError {
  constructor(message: string, readonly reason: 'no-device' | 'bad-request' | 'unrecognised', options?: ErrorOptions) {
    super(message, options)
  }
}

/** The session a failed lease had been given, by the error it failed with. A WeakMap, so the error keeps its own type. */
const leasedSessions = new WeakMap<object, string>()

/**
 * The session a lease was given before its join or boot failed, which `lease()` has already left. A caller sharing
 * devices across workers needs it to keep that device out of its later leases; the error alone does not say which
 * device it was. `undefined` for any other error, including a lease refused before a device was chosen.
 */
export function leasedSessionOf(e: unknown): string | undefined {
  return typeof e === 'object' && e !== null ? leasedSessions.get(e) : undefined
}

/** What the relay chose for a lease, and what the boot it sent said. */
export interface Lease {
  sessionId: string
  deviceId: string
  deviceName: string
  platform: 'ios' | 'android'
  /** `pool`: a device automation had left up. `boot`: one started for this lease. */
  source: 'pool' | 'boot'
  watchUrl: string
  boot: BootOutcome
}

export interface LeaseRequest {
  platform?: 'ios' | 'android'
  buildId?: number
  acceptH264?: boolean
  serviceTier?: ServiceTier
  runReset?: RunResetRequest
  exclude?: string[]
}

// Protocol owns the wire shape. The name stays `DeviceInfo` because it is exported from this
// package's public entry and `@tapflowio/cli` imports it — renaming would be a breaking change.
export type { DeviceSummary as DeviceInfo } from '@tapflowio/protocol'

/** Reads the stream of the session this client holds. */
export interface StreamListener {
  frame(data: Buffer): void
  event(type: 'chrome' | 'deviceInfo', payload: unknown): void
}

export interface AgentSession {
  agentName?: string
  platform?: string
  devices: DeviceSummary[]
}

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
/**
 * What a boot's `device:ready` said about the device. Each field absent when the agent did not say: `cold` from an
 * agent that predates it, `runReset` whenever the reset did not reach an agent that does it (an older relay drops the
 * request, an older agent ignores it). Items are the agent's words, unchecked here; the relay checks what it records.
 */
export interface BootOutcome {
  cold?: boolean
  runReset?: { done: string[]; failed: string[] }
}

function readyOutcome(payload: unknown): BootOutcome {
  if (typeof payload !== 'object' || payload === null) return {}
  const { cold, runReset } = payload as Record<string, unknown>
  const strings = (v: unknown): string[] | undefined => (Array.isArray(v) && v.every((i) => typeof i === 'string') ? v : undefined)
  const report = typeof runReset === 'object' && runReset !== null ? runReset as Record<string, unknown> : undefined
  const done = strings(report?.['done'])
  const failed = strings(report?.['failed'])
  return {
    ...(typeof cold === 'boolean' ? { cold } : {}),
    ...(done && failed ? { runReset: { done, failed } } : {}),
  }
}

function correlatesWith(msg: RelayMsg, requestId: string): boolean {
  const id = msg['requestId']
  if (id === undefined) {
    console.error(`[tapflow] ${String(msg['type'])} carried no requestId — matched on sessionId instead`)
    return true
  }
  return id === requestId
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
 * actually covers is a request no live relay will ever answer — whatever is not yet known. A boot
 * stranded by a rebind used to be that request (a new agent never saw the boot, #583), but the relay
 * now answers it with a correlated `device:boot-error` instead of leaving it to burn this deadline
 * (#885). Against a relay older than that, the client-side settle is gone and the boot waits out
 * the deadline again, as it did before #865 — a slow answer, not a wrong one.
 *
 * **The cost is real and belongs here rather than in a changelog.** A wedged relay now blocks a caller for
 * three minutes where it used to fail in 30 seconds, and an MCP host with its own 60s tool timeout will cut
 * in first with a message that says nothing about tapflow. That trade is deliberate — the alternative is
 * the one #549 is about, where a boot that is simply slow reports a failure that never happened — but a
 * host timeout below this number turns the diagnosis back into silence.
 */
// 240 s, not the 180 s it was: this client's boot can carry a run reset, which runs before `device:ready` for up to
// agent-core's `RUN_RESET_BUDGET_MS` after the slowest boot poll. `bootDeadlineOutlivesAgent.test.mjs` holds the sum.
const BOOT_DEADLINE_MS = 240_000

// Minimal relay client for the deterministic runner: WebSocket for session and
// input control, REST for ui-tree and screenshots. Mirrors the message shapes
// the dashboard and mcp-server already use.
export class RelayClient extends SessionChannel {
  private ws: WebSocket | null = null
  /**
   * How the relay last closed the socket. A relay that refuses a token (wrong scope, owner no longer an
   * Admin) accepts the upgrade and closes 1008 right after, so `connect()` has already resolved and the
   * first thing to fail is the next send — which, without this, could only say "not connected".
   */
  private lastClose: { code: number; reason: string } | null = null
  /** One identity per process, so a reconnect re-joins its own sessions instead of contending with the
   *  socket it replaces. Minted here rather than supplied: nothing outside this process shares it.
   *
   *  Readable so a run record can name its runner (`POST /api/v1/runs`): the relay keeps a run live while a
   *  socket with this id is open. It goes to the relay only, which never serves it back — a local socket
   *  that learned it could claim this client's sessions. */
  readonly clientId: string
  /** Who is reading the stream this runner holds — the run's video (A4). None by default: frames are dropped. */
  private streamListener: StreamListener | null = null
  /** Set by a join that asked the relay for no stream; a listener set after it would wait for frames that never come. */
  private joinedWithoutStream = false

  /** Where the token comes from. A string is used as given; a `TokenSource` (`resolveToken`) is re-read on a 401. */
  private readonly tokens: TokenSource

  /** `clientId`: share one between clients that hold devices for the same run, so the relay sees one holder — a run
   *  stays open while any of their sockets does. Such clients must never join by id (`joinSession`): one owner may
   *  re-join any session it holds, so a worker joining by id could take a sibling's device. They lease instead. */
  constructor(
    private readonly relayUrl: string,
    token: string | TokenSource,
    opts: { clientId?: string } = {},
  ) {
    super()
    this.tokens = typeof token === 'string' ? fixedToken(token, relayUrl) : token
    this.clientId = opts.clientId ?? randomUUID()
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const auth = authHeader(this.tokens)
      const headers = auth.Authorization ? auth : undefined
      // One identity for the run — see `mcp-server`'s twin.
      const url = new URL(this.relayUrl)
      url.searchParams.set('client', this.clientId)
      const ws = new WebSocket(url.toString(), { headers })
      ws.once('open', () => {
        this.ws = ws
        this.lastClose = null
        resolve()
      })
      ws.once('error', (e) => reject(new RelayUnavailableError(`relay connection failed: ${(e as Error).message}`)))
      ws.on('message', (data, isBinary) => {
        if (isBinary) {
          // A listener's failure is its own: it must never take this socket's handler, and with it every reply.
          try { this.streamListener?.frame(data as Buffer) } catch { /* the video loses a frame */ }
          return
        }
        let msg: RelayMsg
        try {
          msg = JSON.parse((data as Buffer).toString()) as RelayMsg
        } catch { return /* ignore malformed */ }
        if (this.streamListener && (msg['type'] === 'session:chrome' || msg['type'] === 'session:deviceInfo')) {
          try {
            this.streamListener.event(msg['type'] === 'session:chrome' ? 'chrome' : 'deviceInfo', msg['payload'])
          } catch { /* as for a frame: the video's loss, not the run's */ }
        }
        try {
          this.dispatch(msg)
        } catch { /* ignore malformed */ }
      })
      ws.on('close', (code: number, reason: Buffer) => {
        // Recorded only when the relay closed the socket in use; `disconnect()` lets go of it first, so a
        // close this client asked for is not reported as the relay's.
        if (this.ws === ws) this.lastClose = { code, reason: reason.toString() }
        this.ws = null
        this.connectionLost(`relay connection closed${this.closeDetail()}`)
      })
    })
  }

  /** ` (relay closed 1008: <reason>)`, or nothing when the relay has not closed this client's socket. */
  private closeDetail(): string {
    const c = this.lastClose
    if (!c) return ''
    return c.reason ? ` (relay closed ${c.code}: ${c.reason})` : ` (relay closed ${c.code})`
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

  /** Typed against the wire contract, so every literal below is checked. It used to take `RelayMsg`, which is
   *  `Record<string, unknown>` — the shape that let #489 and #490 happen on the agent side, and the reason
   *  `mcp-server`'s equivalent was typed in `7637be3`. */
  protected send(msg: BrowserToRelay): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new RelayUnavailableError(`not connected to relay${this.closeDetail()}`)
    }
    this.ws.send(JSON.stringify(msg))
  }

  /**
   * `send` for the first requests after `connect()`, which are the ones that meet a relay refusing the
   * token: it accepts the upgrade and closes 1008 at once, so the socket can still be CLOSING here. Its
   * `close` event carries the code and reason and settles the waiter the caller registers next, which
   * says more than the "not connected" `send` would throw now. Only while CLOSING; a closed or missing
   * socket still throws.
   */
  protected override sendFirstRequest(msg: BrowserToRelay): void {
    if (this.ws?.readyState === WebSocket.CLOSING) return
    this.send(msg)
  }

  async listDevices(): Promise<AgentSession[]> {
    this.sendFirstRequest({ type: 'agents:list' })
    const msg = await this.waitFor((m) => m['type'] === 'agents:listed', 5_000, 'agents:list')
    return (msg['sessions'] as AgentSession[]) ?? []
  }

  /** @returns where a person can watch this run in the dashboard — see `watchUrlFor`. */
  async joinSession(sessionId: string): Promise<{ watchUrl: string }> {
    // No listener, no frames: a runner that is not recording discards every one, and the relay need not send them.
    this.joinedWithoutStream = !this.streamListener
    this.sendFirstRequest({ type: 'session:start', sessionId, clientKind: 'flow-runner', ...(this.streamListener ? {} : { stream: false }) })
    return this.joinReply(sessionId, await this.waitFor(this.joinAnswers(sessionId), 5_000, 'session join', sessionId))
  }

  private joinAnswers(sessionId: string): (m: RelayMsg) => boolean {
    return (m) =>
        (m['type'] === 'session:joined' && m['sessionId'] === sessionId) ||
        // No `=== undefined` escape — see the twin in `mcp-server`. `error` carries an address as of L5d, and
        // the escape *was* #512's first finding: with no such key the left half was always true, so any
        // refusal resolved any pending join. The cost is version skew — a client newer than its relay sees
        // unaddressed refusals, which match nothing, so the join burns its deadline instead of reporting why
        // it was refused. Taken deliberately: there is no version handshake in this protocol, and the
        // alternative is a fallback, which is the ambiguity this work removes. Logged once per **client**,
        // not per session — a relay is per client, and the frame carries no session to key on anyway.
        (m['type'] === 'error' && m['sessionId'] === sessionId)
  }

  private joinReply(sessionId: string, msg: RelayMsg): { watchUrl: string } {
    if (msg['type'] !== 'error') return { watchUrl: this.watchUrlFor(sessionId, msg['watchUrl']) }
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
   * Hands every frame of the held session, and its chrome and device info, to `listener` — or stops, with null.
   * **Set it before `joinSession`**: a join with no listener asks the relay for no frames (`stream: false`), so a
   * listener set after that receives the chrome and device info but no frame.
   */
  setStreamListener(listener: StreamListener | null): void {
    if (listener && this.joinedWithoutStream) {
      throw new Error('setStreamListener after joining without a listener: the relay was asked for no stream, so set the listener before joinSession')
    }
    this.streamListener = listener
  }

  /**
   * `acceptH264` asks an iOS agent for H.264 rather than JPEG, as a dashboard that can decode it does. The video
   * (A4) needs it: JPEG is several times the size and cannot be kept. The agent still decides, and may send JPEG.
   * `serviceTier` asks for the services the device boots with; absent, it gets the agent's own setting.
   */
  async bootDevice(sessionId: string, deviceId: string, opts: { acceptH264?: boolean; serviceTier?: ServiceTier; runReset?: RunResetRequest } = {}): Promise<BootOutcome> {
    const requestId = randomUUID()
    this.send({ type: 'device:boot', sessionId, requestId, payload: { deviceId, ...(opts.acceptH264 ? { acceptH264: true } : {}), ...(opts.serviceTier ? { serviceTier: opts.serviceTier } : {}), ...(opts.runReset ? { runReset: opts.runReset } : {}) } })
    return this.bootReply(sessionId, await this.waitFor(this.bootAnswers(sessionId, requestId), BOOT_DEADLINE_MS, 'device boot', sessionId))
  }

  private bootAnswers(sessionId: string, requestId: string): (m: RelayMsg) => boolean {
    return (m) => (m['type'] === 'device:ready' || m['type'] === 'device:boot-error') && m['sessionId'] === sessionId && correlatesWith(m, requestId)
  }

  private bootReply(sessionId: string, msg: RelayMsg): BootOutcome {
    // A stranded boot arrives here as the relay's correlated `device:boot-error` (#885), after the
    // `session:rebound` that set `needsReboot` — so `failed()` carries the rebound cause and the
    // driver reads it as environmental. Against an older relay nothing answers it and the deadline
    // runs, which is slow rather than wrong.
    if (msg['type'] === 'device:boot-error') {
      const reason = msg['reason']
      if (typeof reason === 'string') {
        const known = Object.hasOwn(BOOT_REFUSALS, reason) ? reason as BootRefusalReason : 'unrecognised-refusal'
        throw new AdmissionRefusedError(`boot refused (${reason}): ${(msg['message'] as string) ?? 'no detail'}`, known)
      }
      throw this.failed(sessionId, (msg['message'] as string) ?? 'boot failed')
    }
    // The one thing that clears `needsReboot`, because it is the one thing that answers it: a rebound session
    // is missing the agent-side binding a boot creates. Clearing it anywhere else would let the note go quiet
    // while the condition it describes is still true.
    const s = this.lifecycle.get(sessionId)
    if (s) s.needsReboot = false
    return readyOutcome(msg['payload'])
  }

  /** Whether the relay serves `device:lease`. An older one drops the message without a word, so ask first. */
  async canLease(): Promise<boolean> {
    return (await this.relayFeatures()).includes('device-lease')
  }

  /**
   * Ask the relay for a device of a platform (or a build's): it chooses one, makes this client its holder and boots
   * it. Resolves once the boot is ready. A busy Mac or every device in use throws `AdmissionRefusedError`, which
   * `retryAdmission` waits out; a lease that can never be served throws `LeaseRefusedError`. A join or boot failure
   * after the device was chosen throws as `joinSession` and `bootDevice` would, after leaving the session.
   *
   * The join's and the boot's waiters are armed **inside** the predicate that sees `device:leased`, not after the
   * await. The relay sends the lease, the join and often the boot's refusal in one burst, and `ws` delivers frames of
   * one read back to back, so a waiter registered by the continuation would miss them.
   */
  async lease(req: LeaseRequest): Promise<Lease> {
    const requestId = randomUUID()
    this.joinedWithoutStream = !this.streamListener
    let joined: Promise<RelayMsg> | undefined
    let booted: Promise<RelayMsg> | undefined
    this.sendFirstRequest({
      type: 'device:lease', requestId,
      payload: {
        ...(req.platform ? { platform: req.platform } : {}),
        ...(req.buildId !== undefined ? { buildId: req.buildId } : {}),
        ...(req.acceptH264 ? { acceptH264: true } : {}),
        ...(req.serviceTier ? { serviceTier: req.serviceTier } : {}),
        ...(req.runReset ? { runReset: req.runReset } : {}),
        ...(req.exclude?.length ? { exclude: req.exclude } : {}),
        ...(this.streamListener ? {} : { stream: false }),
      },
    })
    const answer = await this.waitFor((m) => {
      if (m['requestId'] !== requestId) return false
      if (m['type'] === 'device:lease-refused') return true
      if (m['type'] !== 'device:leased' || typeof m['sessionId'] !== 'string') return false
      const sessionId = m['sessionId']
      joined = this.waitFor(this.joinAnswers(sessionId), 5_000, 'session join', sessionId)
      booted = this.waitFor(this.bootAnswers(sessionId, requestId), BOOT_DEADLINE_MS, 'device boot', sessionId)
      // Settled by `settleSessionWaiters` when the join fails; nothing else reads it then.
      booted.catch(() => {})
      return true
    }, 10_000, 'device lease')

    if (answer['type'] === 'device:lease-refused') {
      const reason = String(answer['reason'])
      const message = `lease refused (${reason}): ${(answer['message'] as string) ?? 'no detail'}`
      if (reason === 'no-device' || reason === 'bad-request') throw new LeaseRefusedError(message, reason)
      if (answer['retryable'] === false) throw new LeaseRefusedError(message, 'unrecognised')
      const known: AdmissionReason = Object.hasOwn(BOOT_REFUSALS, reason) || reason === 'agent-resources-exhausted' || reason === 'all-held'
        ? reason as AdmissionReason : 'unrecognised-refusal'
      throw new AdmissionRefusedError(message, known)
    }
    const sessionId = answer['sessionId'] as string
    try {
      let watchUrl: string
      try {
        watchUrl = this.joinReply(sessionId, await joined!).watchUrl
      } catch (e) {
        this.settleSessionWaiters(sessionId, () => e as Error)
        throw e
      }
      return {
        sessionId,
        deviceId: answer['deviceId'] as string,
        deviceName: answer['deviceName'] as string,
        platform: answer['platform'] as 'ios' | 'android',
        source: answer['source'] === 'pool' ? 'pool' : 'boot',
        watchUrl,
        boot: this.bootReply(sessionId, await booted!),
      }
    } catch (e) {
      // The caller never learns this session's id, so it could not leave it; held, it would stay this run's until the
      // run's last socket closed, and a retry would be handed another device. Not connected: the close let it go.
      try { this.leaveSession(sessionId) } catch { /* not connected */ }
      if (typeof e === 'object' && e !== null) leasedSessions.set(e, sessionId)
      throw e
    }
  }

  /**
   * The dashboard page that watches this run. **The relay's link when it gives one** — it does only when it
   * knows an address teammates can open — **else one built from the address this client dialled**, which
   * the person reading this run's output can open. Mirrors `mcp-server`'s, deliberately not shared: each
   * client owns its own transport, as `inboundDisposition.ts` already records.
   */
  private watchUrlFor(sessionId: string, fromRelay: unknown): string {
    if (typeof fromRelay === 'string' && fromRelay.length > 0) return fromRelay
    return new URL(`/automation/sessions/${encodeURIComponent(sessionId)}`, this.httpBase()).toString()
  }

  private httpBase(): string {
    return this.relayUrl.replace(/^wss?/, (p) => (p === 'wss' ? 'https' : 'http'))
  }

  private async getJson<T>(path: string, what: string, signal?: AbortSignal): Promise<T> {
    let res: Response
    try {
      res = await fetchWithToken(this.tokens, new URL(path, this.httpBase()).toString(), { ...(signal ? { signal } : {}) })
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
      // "Unauthorized" names neither the relay nor the fix; this does, whichever step met it.
      if (res.status === 401) message = `${what} failed: ${tokenRefusal(this.tokens)}`
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
    return (await this.queryUITreeWithTurn(sessionId, signal)).elements
  }

  /** The tree with the app's interface turn beside it, when the agent sent one (`UiTreeResponse.interfaceTurn`). */
  async queryUITreeWithTurn(sessionId: string, signal?: AbortSignal): Promise<{ elements: UIElement[]; interfaceTurn?: InterfaceTurn }> {
    try {
      const body = await this.getJson<unknown>(`/api/v1/sessions/${sessionId}/ui-tree`, 'ui-tree query', signal)
      if (typeof body !== 'object' || body === null || Array.isArray(body) || !('elements' in body) || !Array.isArray(body.elements) || !body.elements.every(isUIElement)) {
        throw new RelayHttpError('ui-tree query returned an invalid response shape', 200, undefined, true)
      }
      const interfaceTurn = interfaceTurnOf((body as { interfaceTurn?: unknown }).interfaceTurn)
      return interfaceTurn === undefined ? { elements: body.elements } : { elements: body.elements, interfaceTurn }
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
      res = await fetchWithToken(this.tokens, new URL(`/api/v1/sessions/${sessionId}/screenshot`, this.httpBase()).toString(), { ...(signal ? { signal } : {}) })
    } catch (e) {
      const failure = this.failed(sessionId, `screenshot failed: ${(e as Error).message}`)
      throw new RelayHttpError(failure.message, 0, { cause: e })
    }
    // Through `failed()` like every other session-scoped failure here. A screenshot is taken to explain a
    // step that already failed, so arriving with no cause is the worst moment for it.
    if (!res.ok) {
      const failure = this.failed(sessionId, res.status === 401 ? `screenshot failed: ${tokenRefusal(this.tokens)}` : `screenshot failed: ${res.status}`)
      throw new RelayHttpError(failure.message, res.status, { cause: failure })
    }
    return Buffer.from(await res.arrayBuffer())
  }
}
