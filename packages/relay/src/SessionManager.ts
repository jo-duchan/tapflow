import { randomUUID } from 'crypto'
import { WebSocket } from 'ws'
import type { DeviceStatus } from '@tapflowio/agent-core'
import type { AgentResources, SessionInfo } from './types.js'
import type { BooterClass } from './admission/HostBootGate.js'
import type { AiClientKind, ChromePayload, DeviceSummary, MacAdmission, ServiceTier, ClientKind, DeviceDetails, DeviceReport, FormFactor, Point, PosturesPayload, WatchEndReason } from '@tapflowio/protocol'

export interface Session {
  id: string
  agentId?: string
  agentName?: string
  agentPlatform?: string
  agentCapabilities?: string[]
  agentSocket: WebSocket
  browserSocket: WebSocket | null
  /**
   * Who may command this session — `<userId>:<clientId>`, not a socket.
   *
   * Split from `browserSocket` because that one field was answering two questions: *who may command* and
   * *where do replies go*. Only the first moves. A browser tab holds up to three sockets (`DeviceViewer`,
   * `useAgentSession`, `MacResources`) and the one that holds the session is not the one
   * that sends the teardown, which is why a socket-shaped answer could not be given to #527.
   *
   * Cleared with `browserSocket`, in `clearBrowser` and `remove`. Keeping it past the release would let a
   * client that has left go on driving the device, and would let input through in the reconnect grace —
   * a window `ownsSession` deliberately fails fast in, because the alternative is applying it to a device
   * nobody is watching.
   */
  owner: string | null
  /** Whether that owner is an identity the relay minted because the connection claimed none, and the
   *  principal behind it. Recorded as facts rather than recovered from `owner`'s text: the client half of
   *  that string comes off the handshake query unvalidated, so a caller could otherwise hand itself the
   *  legacy exemption by claiming an id that looked minted. */
  ownerMinted: boolean
  ownerUser: string | null
  /** What the holder declared on `session:start`, and a label for the person behind it. Cleared with
   *  `owner`: a session nobody holds is nobody's kind. Only an AI kind makes the session watchable. */
  holderKind: ClientKind | null
  holderLabel: string | null
  /** What to call a person holder (#1087): display name, else the email's local part. */
  holderName?: string | null
  /** False when the holder said on `session:start` it does not read the stream (`stream: false`): the relay sends
   *  it no frames. Kept with the holder rather than on its socket, so it resets with every change of holder. */
  holderStream: boolean
  /** Where the holder's current touch began and last was, so its end can be told to watchers as a tap or a swipe
   *  (A2). Kept whether or not anyone watches: a watcher can arrive mid-gesture. Cleared at the end and with the holder. */
  gesture: { start: Point; last: Point } | null
  streamSocket: WebSocket | null
  deviceId: string
  deviceName: string
  devicePlatform: string
  /** What simctl/adb reported about the device. Drives the device list and the REST guards —
   *  "is this device up", which is a different question from the one below. */
  /** The service tier the device boots with now: from the agent's register, then from each `device:ready`, since
   *  the register is a snapshot. Absent from an agent that predates tiers. */
  deviceServiceTier?: ServiceTier | 'unsupported'
  deviceStatus: DeviceStatus
  /** Whether the relay has told a browser this session is streaming, and has not since taken it
   *  back. This is what the `device:ready` replay keys off. `deviceStatus` cannot answer it: it
   *  starts from the agent's `simctl list` snapshot, so a simulator that was already running has a
   *  session marked `booted` before the agent has done anything for it (#440). */
  readySent: boolean
  deviceOsVersion?: string
  /** From the agent's register, like `deviceOsVersion`; the viewer reads it off `agents:listed`. */
  deviceFormFactor?: FormFactor
  chromeData?: ChromePayload
  /** Cached like `chromeData`, and replayed to a re-joining viewer for the same reason. */
  postures?: PosturesPayload
  deviceInfo?: DeviceDetails
  idleTimer: ReturnType<typeof setTimeout> | null
  /** Whether the last holder to let go was an AI client holding the device for itself. Read with `idleTimer`: a device whose idle countdown is
   *  running for a person is theirs to come back to, and a lease must not take it and wipe it. `lastBoot` cannot
   *  say so — it names whoever cold-booted the device, and a person picks up automation's devices warm. */
  lastHolderWasAi?: boolean
  /** Who cold-booted the device this session drives, and when — kept after the holder leaves, since that is when
   *  it matters: it is what the per-Mac automation cap counts and shuts down (`admission/capacity.ts`). Set when
   *  the relay forwards a cold boot, undone if that boot fails or turns out warm, cleared on `shutdown-done`.
   *  Absent after a relay restart, which counts nothing rather than guess. */
  lastBoot?: { booterClass: BooterClass; at: number }
  /** The boot `lastBoot` was set for, and what it held before, so a failure or a warm ready can put it back. */
  lastBootPending?: { requestId: string; prev: Session['lastBoot'] }
  /** A boot whose record expired unanswered, kept so a ready that arrives after all is recorded as the boot it was —
   *  by then the automation client that asked has usually left, and the holder no longer says who started it. */
  lastBootExpired?: { requestId: string; booterClass: BooterClass }
  /** The relay shut this device down to make room. Until the agent confirms, it is neither counted nor offered. */
  evictingAt?: number
  /** An automation client joined while the idle timer was running and stopped it: its leave starts it again, so a
   *  device a person left is not kept up for good by a run that borrowed it. */
  idleResumeOnLeave: boolean
  /**
   * The build the relay last saw installed on this device, so an install with `keepIfInstalled` can be answered
   * without wiping the app (#1087). Identified by id **and** stored path, because `builds.id` has no AUTOINCREMENT and
   * deleting the newest build hands its id to the next upload. Cleared wherever the app may have gone without the
   * relay installing over it: a shutdown, a cold boot, an erase or a run reset.
   *
   * What the relay cannot see, it cannot clear: an app deleted on the device by hand, or a simulator erased and booted
   * again outside tapflow before tapflow's next boot (which then reads as warm), stays recorded until the next shutdown
   * or cold boot, and a `keepIfInstalled` install is answered as done. Picking the device again installs it.
   */
  installed?: InstalledBuild
  /** The install last sent to the agent, and the `keepIfInstalled` requests of the same build waiting on it. Only the
   *  latest: a reply to an older one says nothing about what is on the device now. */
  pendingInstall?: InstalledBuild & { requestId: string; waiters: string[] }
  /**
   * The person this device is waiting for: a human holder whose socket went while the idle countdown runs (#1087).
   * The owner fields above are cleared on release, so without this the same person coming back from another browser
   * reads as anyone. Tied to the countdown the relay already keeps — set where a person's countdown starts, kept (not
   * cleared) while an AI client borrows the device, restored in full when it hands the countdown back.
   */
  waitingOwner?: { user: string; label: string; name: string; since: number; deadline: number }
  /**
   * The device has left its agent's list (`agent:devices`, #1085) while the session was in use, so it was kept rather
   * than removed under someone. Kept sessions are not listed or leased, and the heartbeat removes one once nobody
   * holds it (`goneAndVacant`). Cleared if the device comes back first.
   */
  deviceGone?: true
  /** Someone else took or shut down the device while it waited for `ownerUser`. Expires with the idle window; a read
   *  does not clear it, because every open tab of that person polls the listing. */
  endedBy?: { ownerUser: string; byLabel: string; byName: string; at: number }
  /** A boot went to the agent after the last shutdown did. Then that shutdown's done describes a device someone has
   *  since picked up again, and the wait and countdown it would clear are newer than it. Undefined: no shutdown out. */
  bootAfterShutdown?: boolean
  /** The wait and notice a forwarded shutdown replaced, put back if the agent reports it failed: the device is still up
   *  and its countdown still runs, so the person is still waited for. */
  shutdownUndo?: { waitingOwner: NonNullable<Session['waitingOwner']>; endedBy: Session['endedBy'] }
}

export type InstalledBuild = { buildId: number; filePath: string }

/**
 * Why a `session:start` could not bind, or that it did.
 *
 * The two failures are the ones a caller can be told about truthfully, and they are values rather than
 * exceptions for that reason — see `join()`. Anything else that goes wrong in there is a bug and still
 * throws, which keeps the two apart at the call site instead of at a `catch`.
 */
export type JoinResult = { ok: true } | { ok: false; failure: 'not-found' | 'held-by-another' }

type AgentField = 'agentId' | 'agentName' | 'agentPlatform' | 'agentCapabilities'
type DeviceField = 'deviceName' | 'devicePlatform' | 'deviceStatus' | 'deviceOsVersion' | 'deviceFormFactor' | 'deviceServiceTier'

/** The device fields `refreshDevice` writes. A test holds it against `deviceFields`, so a field added there is a
 *  decision for this path too rather than one it misses in silence. */
export const REFRESHED_FIELDS = ['deviceName', 'deviceFormFactor', 'deviceOsVersion'] as const satisfies readonly DeviceField[]

/** What an `agent:register` says about the agent itself, as opposed to its devices. */
export type AgentIdentity = {
  agentId?: string
  agentName?: string
  agentPlatform?: string
  agentCapabilities?: string[]
}

const DEFAULT_IDLE_TIMEOUT_MS = parseInt(process.env['IDLE_TIMEOUT_MS'] ?? String(5 * 60 * 1000))

/** How many sockets may watch one session. Usually one person watches the agent they instructed; the
 *  rest is headroom. Each iOS watcher costs about 34 Mbit/s of JPEG egress (measured 2026-10-09), so the
 *  cap is what bounds a session's fan-out. */
export const MAX_WATCHERS_PER_SESSION = 4

export function isAiClientKind(kind: ClientKind | null | undefined): kind is AiClientKind {
  return kind === 'mcp' || kind === 'flow-runner'
}

/** Told which watchers a session lost and why, so the server can say so before the sockets are forgotten. */
export type WatchersEvicted = (sessionId: string, sockets: WebSocket[], reason: WatchEndReason) => void

export class SessionManager {
  private sessions = new Map<string, Session>()
  private agentResources = new Map<WebSocket, AgentResources>()
  private agentSocketIndex = new Map<WebSocket, Set<string>>()
  private streamSocketIndex = new Map<WebSocket, Session>()
  /**
   * Which sessions a browser socket holds. **A set, because the relation is one-to-many** — and it was a
   * single `Session` until #507 was diagnosed, which is the whole of that defect.
   *
   * `mcp-server` opens exactly one socket (`client.ts`, one `new WebSocket`) and sends a `session:start`
   * per device, because an LLM can hold several sessions at once and its waiters are keyed per session.
   * With one slot per socket, the second join silently overwrote the first — `A.browserSocket` still
   * pointed at the socket, so *commands* kept working, and only the reverse lookup lost A. The close
   * handler resolves through that lookup, so **A was never released**: `busy: true` for the life of the
   * relay, no idle timer, and a device left booted with nobody watching it.
   *
   * That is also why the obvious reading of #507 — "release the previous session when a socket joins
   * another" — is a regression rather than a fix. Two independent design reviews reached it separately.
   */
  private browserSocketIndex = new Map<WebSocket, Set<Session>>()
  /**
   * Read-only sockets per session, each with the owner key it was admitted under.
   *
   * **A watch follows the holder, not the session.** It is admitted against one client's session, so when
   * a *different* client binds the session — a tester picking the device after the agent left — every
   * watcher admitted under the previous owner is evicted in `join()`. Without that a person's manual
   * session would be watched by whoever was watching the agent before them. The same client re-joining
   * (an MCP socket blip) keeps its watchers, which is why the comparison is against the admitted key
   * rather than against whether `owner` changed at all: `clearBrowser` nulls it in between.
   *
   * Kept here rather than in the server so `remove()` clears it on every path — it is called from five
   * places, and each would otherwise have to remember.
   */
  private watchers = new Map<string, Map<WebSocket, string>>()
  private watcherSocketIndex = new Map<WebSocket, Set<string>>()
  private readonly idleTimeoutMs: number
  private readonly onWatchersEvicted: WatchersEvicted

  constructor(options: { idleTimeoutMs?: number; onWatchersEvicted?: WatchersEvicted } = {}) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
    this.onWatchersEvicted = options.onWatchersEvicted ?? (() => {})
  }

  /**
   * The single place a session's fields are computed from an `agent:register`. `create()` spreads
   * it and `rebind()` assigns it, so neither one names these fields itself — a field added here
   * reaches both paths, and `rebind` is the one that would otherwise be forgotten.
   *
   * What is left out is what a register cannot change: the session's own id and sockets, and
   * `deviceId`, which is the key the rebind matched on in the first place.
   */
  private static agentFields(agent: AgentIdentity, device: DeviceReport): Pick<Session, AgentField | DeviceField> {
    return {
      agentId: agent.agentId,
      agentName: agent.agentName,
      agentPlatform: agent.agentPlatform,
      agentCapabilities: agent.agentCapabilities,
      ...SessionManager.deviceFields(device),
    }
  }

  /** The device half of `agentFields`. `refreshDevice` takes a subset of it, held there by `REFRESHED_FIELDS`. */
  static deviceFields(device: DeviceReport): Pick<Session, DeviceField> {
    return {
      deviceName: device.name,
      devicePlatform: device.platform,
      deviceStatus: device.status as DeviceStatus,
      deviceOsVersion: device.osVersion,
      deviceFormFactor: device.formFactor,
      deviceServiceTier: device.serviceTier,
    }
  }

  /**
   * What a later list (`agent:devices`) may change about a device the relay already has a session for. Narrower than
   * a register on purpose: `deviceStatus` and `deviceServiceTier` are tracked from `device:ready` and shutdowns and
   * read by the lease, so a list read in between must not overwrite them. A version the list no longer carries is
   * kept — an Android emulator that was shut down outside tapflow reports none, and it has not changed.
   */
  refreshDevice(sessionId: string, device: DeviceReport): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.deviceName = device.name
    session.deviceFormFactor = device.formFactor
    session.deviceOsVersion = device.osVersion ?? session.deviceOsVersion
    delete session.deviceGone
  }

  /** A session kept for a device that has left, with nothing left holding it: nobody's tab, no countdown for a
   *  dropped person, no watcher, no boot in flight. */
  goneAndVacant(s: Session): boolean {
    return s.deviceGone === true && s.owner === null && s.browserSocket === null && s.idleTimer === null &&
      s.lastBootPending === undefined && this.watchersOf(s.id).length === 0
  }

  create(agentSocket: WebSocket, devices: DeviceReport[] = [], agentName?: string, agentPlatform?: string, agentId?: string, agentCapabilities?: string[]): string[] {
    const agentIds = this.agentSocketIndex.get(agentSocket) ?? new Set<string>()
    const agent: AgentIdentity = { agentId, agentName, agentPlatform, agentCapabilities }
    return devices.map((d) => {
      const id = randomUUID()
      this.sessions.set(id, {
        id,
        ...SessionManager.agentFields(agent, d),
        agentSocket,
        browserSocket: null,
        owner: null,
        ownerMinted: false,
        ownerUser: null,
        holderKind: null,
        holderLabel: null,
        holderStream: true,
        gesture: null,
        streamSocket: null,
        deviceId: d.id,
        readySent: false,
        idleTimer: null,
        idleResumeOnLeave: false,
      })
      agentIds.add(id)
      this.agentSocketIndex.set(agentSocket, agentIds)
      return id
    })
  }

  get(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId)
  }

  getAllByAgentSocket(ws: WebSocket): Session[] {
    const ids = this.agentSocketIndex.get(ws)
    if (!ids) return []
    return Array.from(ids).map((id) => this.sessions.get(id)).filter((s): s is Session => s !== undefined)
  }

  /**
   * Agent sockets currently registered under the same identity (machine id + platform). Identity
   * is `agentId ?? agentName`: agentId (macOS IOPlatformUUID) is unique per Mac, while agentName
   * (os.hostname()) can collide across hosts — so older agents without an agentId fall back to the
   * hostname. Platform disambiguates an iOS and Android agent on the same Mac (same agentId). Used
   * on re-register to evict an agent's stale socket (the old connection whose close hasn't fired
   * yet after an unclean drop) before it shows as a duplicate "Stale" card. Heartbeat backstop for
   * never-reconnecting agents is tracked in #313.
   */
  getAgentSocketsByIdentity(identity: string, platform: string | undefined): WebSocket[] {
    const sockets = new Set<WebSocket>()
    for (const s of this.sessions.values()) {
      if ((s.agentId ?? s.agentName) === identity && s.agentPlatform === platform) sockets.add(s.agentSocket)
    }
    return Array.from(sockets)
  }

  all(): Session[] {
    return Array.from(this.sessions.values())
  }

  /** Every session whose agent runs on the Mac `hostKey` names, across that Mac's agents. */
  getAllOnHost(hostKey: string, keyOf: (s: Session) => string): Session[] {
    return Array.from(this.sessions.values()).filter((s) => keyOf(s) === hostKey)
  }

  /** Sessions currently claiming a device id. More than one only while a held session (#426) has
   *  not yet been reclaimed or given up on. */
  getAllByDeviceId(deviceId: string): Session[] {
    return Array.from(this.sessions.values()).filter((s) => s.deviceId === deviceId)
  }

  getByStreamSocket(ws: WebSocket): Session | undefined {
    return this.streamSocketIndex.get(ws)
  }

  /** Every session this socket holds. **Plural**, and the caller must treat it as such — the close
   *  handler releasing only the first is the defect the index comment above describes. */
  getByBrowserSocket(ws: WebSocket): Session[] {
    return [...(this.browserSocketIndex.get(ws) ?? [])]
  }

  /** Drop `session` from its browser socket's set, and the key with it when the set empties. Leaving an
   *  empty `Set` behind would keep a closed socket referenced for the life of the relay. */
  private unindexBrowser(session: Session): void {
    const ws = session.browserSocket
    if (!ws) return
    const held = this.browserSocketIndex.get(ws)
    if (!held) return
    held.delete(session)
    if (held.size === 0) this.browserSocketIndex.delete(ws)
  }

  /**
   * @returns `not-found` and `held-by-another` rather than throwing them, **so an unexpected failure and
   *          an expected one stop sharing a channel.** `session:start` answered both from one `catch`, and
   *          the comment there said reaching it meant something the handler did not anticipate — while the
   *          most common way to reach it was a socket re-joining the session it already holds (#515). An
   *          expected failure that travels as an exception is indistinguishable from a bug by the time it
   *          is caught, and the handler then has to guess a `reason`.
   */
  join(
    sessionId: string,
    browserSocket: WebSocket,
    owner: { key: string; user: string; minted: boolean },
    isAlive: (ws: WebSocket) => boolean,
    /** What the joining client declared itself to be, and who to show behind it. */
    holder: { kind?: ClientKind; label: string; name?: string; stream?: boolean } = { label: owner.user },
  ): JoinResult {
    const session = this.sessions.get(sessionId)
    if (!session) return { ok: false, failure: 'not-found' }
    // A device that has left its Mac is kept only for whoever was on it (#1085): the same client coming back, or the
    // person a dropped session is waiting for. Anyone else — a stale link, an MCP client holding the id — would boot
    // a device that is no longer there, and as its new holder keep the session from ever being swept.
    if (session.deviceGone && session.owner !== owner.key && session.waitingOwner?.user !== owner.user) {
      return { ok: false, failure: 'not-found' }
    }
    // **Three conditions, and each one is an issue.** A session is occupied only when someone *else* holds
    // it, on a socket that is open, and that socket is answering.
    //
    // - `owner !== owner` is #527 and #515: a re-join by the same client is idempotent whether or not the
    //   socket is the same one, which is what makes a tab's three sockets one holder and an automatic
    //   reconnect a takeover rather than a refusal.
    // - `readyState === OPEN` was the whole test, and it is not a liveness signal. A laptop that went to
    //   sleep leaves it OPEN until TCP or the heartbeat notices.
    // - `isAlive` is that signal, passed in because liveness lives on the server rather than here — as a
    //   predicate over the socket rather than a thunk, so it is applied to *this* session's holder and
    //   cannot be closed over a stale one. `list()` below takes the same shape for the same reason.
    //   #579 is the gap between `readyState` and this.
    if (
      session.browserSocket &&
      session.owner !== null &&
      session.owner !== owner.key &&
      session.browserSocket.readyState === WebSocket.OPEN &&
      isAlive(session.browserSocket)
    ) {
      return { ok: false, failure: 'held-by-another' }
    }
    // Decided by the join that stops a countdown. A later re-join by the same client (MCP's `connect_device` again)
    // finds no timer and must not forget it; a person taking the device over makes it theirs to leave.
    if (session.idleTimer !== null) session.idleResumeOnLeave = isAiClientKind(holder.kind)
    else if (!isAiClientKind(holder.kind)) session.idleResumeOnLeave = false
    if (session.idleTimer) { clearTimeout(session.idleTimer); session.idleTimer = null }
    // Unconditional, and **the order is what makes it safe**: this releases the session from whichever
    // socket held it, which on a re-join is the socket joining. Removing and re-adding the same entry is a
    // no-op; doing it *after* the add below would delete the entry this join just made, leaving the
    // session bound for commands and invisible to the close handler — #507 rebuilt one method over.
    //
    // A guard reading `!== browserSocket` stood here with that reasoning written as its justification. It
    // was dead: mutation testing removed the guard and every test still passed, because the add follows.
    this.unindexBrowser(session)
    session.browserSocket = browserSocket
    session.owner = owner.key
    session.ownerMinted = owner.minted
    session.ownerUser = owner.user
    session.holderKind = holder.kind ?? null
    session.holderLabel = holder.label
    session.holderName = holder.name ?? holder.label
    session.holderStream = holder.stream !== false
    // A touch the previous holder began is not this one's to end.
    session.gesture = null
    // A person taking the device ends the wait, and if it was not theirs, the one waiting is told who. An AI client
    // only borrows it: the wait is kept and comes back when the client leaves.
    if (!isAiClientKind(holder.kind)) {
      const waited = session.waitingOwner
      if (waited && waited.user !== owner.user) {
        session.endedBy = { ownerUser: waited.user, byLabel: holder.label, byName: holder.name ?? holder.label, at: Date.now() }
      }
      if (session.endedBy?.ownerUser === owner.user) session.endedBy = undefined
      session.waitingOwner = undefined
    }
    // Also when the same client re-joins as something that is not an AI client: a watch is admitted to an
    // AI client's session, and only that kind may be watched.
    this.evictWatchers(sessionId, 'holder-changed', (admitted) => admitted !== owner.key || !isAiClientKind(holder.kind))
    let held = this.browserSocketIndex.get(browserSocket)
    if (!held) { held = new Set(); this.browserSocketIndex.set(browserSocket, held) }
    held.add(session)
    return { ok: true }
  }

  remove(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    this.evictWatchers(sessionId, 'session-ended', () => true)
    if (session.idleTimer) { clearTimeout(session.idleTimer); session.idleTimer = null }
    if (session.streamSocket) this.streamSocketIndex.delete(session.streamSocket)
    this.unindexBrowser(session)
    const agentIds = this.agentSocketIndex.get(session.agentSocket)
    agentIds?.delete(sessionId)
    if (agentIds?.size === 0) this.agentSocketIndex.delete(session.agentSocket)
    this.sessions.delete(sessionId)
  }

  clearBrowser(sessionId: string, onTimeout?: () => void): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    if (session.browserSocket) {
      this.unindexBrowser(session)
      session.browserSocket = null
    }
    // An AI client that joined during a countdown hands it back when it goes (`idleResumeOnLeave`), so the countdown
    // stays whoever's it was: a person's stays a person's, and one an AI client left stays leasable.
    if (session.owner !== null) {
      session.lastHolderWasAi = isAiClientKind(session.holderKind) && (!session.idleResumeOnLeave || session.lastHolderWasAi === true)
    }
    const leavingPerson = session.owner !== null && session.ownerUser !== null && !isAiClientKind(session.holderKind)
      ? { user: session.ownerUser, label: session.holderLabel ?? session.ownerUser, name: session.holderName ?? session.holderLabel ?? session.ownerUser }
      : null
    session.owner = null
    session.ownerMinted = false
    session.ownerUser = null
    session.holderKind = null
    session.holderLabel = null
    session.holderName = null
    session.holderStream = true
    session.gesture = null
    if (session.idleTimer) { clearTimeout(session.idleTimer); session.idleTimer = null }
    if (onTimeout) {
      session.idleTimer = setTimeout(() => {
        session.idleTimer = null
        session.waitingOwner = undefined
        onTimeout()
      }, this.idleTimeoutMs)
      // The countdown that just started is a person's either way: this one's, or the one an AI client borrowed and is
      // now handing back (`lastHolderWasAi` stays false then). Restored in full, as the timer is.
      const now = Date.now()
      if (leavingPerson) session.waitingOwner = { ...leavingPerson, since: now, deadline: now + this.idleTimeoutMs }
      else if (session.waitingOwner && !session.lastHolderWasAi) {
        session.waitingOwner = { ...session.waitingOwner, since: now, deadline: now + this.idleTimeoutMs }
      } else session.waitingOwner = undefined
    }
    // A release with no countdown cannot find a wait to end: a wait exists only after a person's countdown started, and
    // every way out of it (a person joining, the timer, a shutdown) clears it before such a release could happen.
  }

  /**
   * A `device:shutdown` from `by` is on its way to the agent. It ends the wait, and tells the person waited for who
   * ended it if it was not them. Called when the shutdown is forwarded, not when it is asked for: a refused one ends
   * nothing. The countdown is left running until `settleShutdown`, so a shutdown that fails still has it behind it.
   */
  noteShutdown(sessionId: string, by: { user: string; label: string; name: string }): void {
    const session = this.sessions.get(sessionId)
    if (session) session.bootAfterShutdown = false
    if (session) session.shutdownUndo = undefined
    const waited = session?.waitingOwner
    if (!session || !waited) return
    session.shutdownUndo = { waitingOwner: waited, endedBy: session.endedBy }
    if (waited.user !== by.user) session.endedBy = { ownerUser: waited.user, byLabel: by.label, byName: by.name, at: Date.now() }
    session.waitingOwner = undefined
  }

  /** The agent could not shut the device down. Only while nothing has happened since: no boot went out, and the
   *  countdown the wait is tied to still runs (a join stops it, and a person leaving again leaves a wait of their own). */
  undoShutdown(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    const undo = session.shutdownUndo
    const untouched = session.bootAfterShutdown === false && session.idleTimer !== null
    session.shutdownUndo = undefined
    session.bootAfterShutdown = undefined
    if (!undo || !untouched || session.waitingOwner) return
    session.waitingOwner = undo.waitingOwner
    session.endedBy = undo.endedBy
  }

  /** A shutdown the relay sent on its own (idle, capacity): only so a later boot can be told apart. */
  noteShutdownSent(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (session) session.bootAfterShutdown = false
  }

  noteBootSent(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (session && session.bootAfterShutdown === false) session.bootAfterShutdown = true
  }

  /** The device is down: nothing is left to count down to, and nobody to wait for — unless a boot went out after the
   *  shutdown this answers, in which case the wait and countdown on the session now belong to that later pick-up. */
  settleShutdown(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    const stale = session.bootAfterShutdown === true
    session.bootAfterShutdown = undefined
    if (stale) return
    if (session.idleTimer) { clearTimeout(session.idleTimer); session.idleTimer = null }
    session.waitingOwner = undefined
  }

  /**
   * Re-point an existing session at the socket of an agent that just restarted, keeping its id.
   *
   * Everything a rebind touches lives here rather than at the call site, and that is deliberate:
   * the index move below has an order requirement that is invisible where it is used, and the
   * field refresh has to stay in step with `create()`. Written inline in `RelayServer`, the next
   * field added to `create()` would be missed on this path alone, and silently.
   */
  rebind(sessionId: string, agentSocket: WebSocket, device: DeviceReport, agent: AgentIdentity): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    const old = session.agentSocket

    // Drop from the old socket's set BEFORE reassigning. `remove()` dereferences the index through
    // `session.agentSocket`, and following that idiom here would delete the id from the *new* set
    // and leave the old one holding it — so the old socket's close, which fires late after an
    // unclean drop, would evict the session that was just re-pointed.
    const oldIds = this.agentSocketIndex.get(old)
    oldIds?.delete(sessionId)
    if (oldIds?.size === 0) this.agentSocketIndex.delete(old)

    session.agentSocket = agentSocket
    const ids = this.agentSocketIndex.get(agentSocket) ?? new Set<string>()
    ids.add(sessionId)
    this.agentSocketIndex.set(agentSocket, ids)

    // The stream died with the old process. `old.terminate()` only closes the control socket, so
    // nothing else would clear this.
    this.clearStreamSocket(sessionId)
    // `clearStreamSocket` returns early when there is no stream socket, and a session that was
    // never streamed has none — so this cannot be left to it.
    session.readySent = false
    // Same argument as `readySent`, two fields over: `handleSessionStart` replays both to a browser
    // that joins now, and both were measured by the process that just died. A viewer's own
    // `device:boot` would clear them a moment later via `device:booting`, but an MCP-attached
    // session never boots on its own and would keep them for as long as it lives.
    session.chromeData = undefined
    session.postures = undefined
    session.deviceInfo = undefined

    Object.assign(session, SessionManager.agentFields(agent, device))
    // The device is in the new register's list, so it is present again. Kept marked, it would stay out of the listing
    // and be swept once vacant, and the new agent, whose baseline already has it, would never send it again.
    delete session.deviceGone

    // Not a carry-over guard — resources are keyed by socket, so re-pointing the session at a new
    // one already leaves the old reading behind, and every reader goes through
    // `session.agentSocket`. This is the leak: `evictAgentSocket` drops the entry, but it returns
    // early when the socket has no sessions left, which is precisely the case where every one of
    // them was rebound. Without this line the map keeps a dead socket per restart, forever.
    this.agentResources.delete(old)
  }

  /**
   * Admit `ws` as a read-only watcher of the session, bound to `admittedOwner` — the holder's key at this
   * moment. Whether the session may be watched at all, and whether this socket may watch, are the
   * server's questions; this only keeps the set and its cap. Watching twice is one watch.
   */
  addWatcher(sessionId: string, ws: WebSocket, admittedOwner: string): 'ok' | 'not-found' | 'full' {
    if (!this.sessions.has(sessionId)) return 'not-found'
    let set = this.watchers.get(sessionId)
    if (set?.has(ws)) { set.set(ws, admittedOwner); return 'ok' }
    if ((set?.size ?? 0) >= MAX_WATCHERS_PER_SESSION) return 'full'
    if (!set) { set = new Map(); this.watchers.set(sessionId, set) }
    set.set(ws, admittedOwner)
    let ids = this.watcherSocketIndex.get(ws)
    if (!ids) { ids = new Set(); this.watcherSocketIndex.set(ws, ids) }
    ids.add(sessionId)
    return 'ok'
  }

  /** @returns whether `ws` was watching the session. */
  removeWatcher(sessionId: string, ws: WebSocket): boolean {
    const set = this.watchers.get(sessionId)
    if (!set?.delete(ws)) return false
    if (set.size === 0) this.watchers.delete(sessionId)
    const ids = this.watcherSocketIndex.get(ws)
    ids?.delete(sessionId)
    if (ids?.size === 0) this.watcherSocketIndex.delete(ws)
    return true
  }

  /** Stop every watch this socket holds — its close. @returns the sessions it was watching. */
  removeWatcherSocket(ws: WebSocket): string[] {
    const ids = [...(this.watcherSocketIndex.get(ws) ?? [])]
    for (const id of ids) this.removeWatcher(id, ws)
    return ids
  }

  watchersOf(sessionId: string): WebSocket[] {
    return [...(this.watchers.get(sessionId)?.keys() ?? [])]
  }

  isWatching(ws: WebSocket, sessionId: string): boolean {
    return this.watchers.get(sessionId)?.has(ws) ?? false
  }

  /** End every watch of a session that still exists — its holder left it on purpose. */
  endWatches(sessionId: string, reason: WatchEndReason): void {
    this.evictWatchers(sessionId, reason, () => true)
  }

  /** Evict the watchers `which` selects by their admitted owner, telling the server first. */
  private evictWatchers(sessionId: string, reason: WatchEndReason, which: (admittedOwner: string) => boolean): void {
    const set = this.watchers.get(sessionId)
    if (!set) return
    const evicted = [...set].filter(([, admitted]) => which(admitted)).map(([ws]) => ws)
    if (evicted.length === 0) return
    for (const ws of evicted) this.removeWatcher(sessionId, ws)
    this.onWatchersEvicted(sessionId, evicted, reason)
  }

  setResources(agentSocket: WebSocket, resources: AgentResources): void {
    this.agentResources.set(agentSocket, resources)
  }

  getResources(agentSocket: WebSocket): AgentResources | undefined {
    return this.agentResources.get(agentSocket)
  }

  removeResources(agentSocket: WebSocket): void {
    this.agentResources.delete(agentSocket)
  }

  clearDeviceCache(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.chromeData = undefined
    session.postures = undefined
    session.deviceInfo = undefined
    session.deviceStatus = 'shutdown'
    // Called on `device:booting`: whatever we announced before is no longer true, and replaying it
    // to a browser that joins mid-boot would promise a stream that is being torn down.
    session.readySent = false
  }

  setStreamSocket(sessionId: string, ws: WebSocket): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    if (session.streamSocket) this.streamSocketIndex.delete(session.streamSocket)
    session.streamSocket = ws
    this.streamSocketIndex.set(ws, session)
  }

  /** The stream socket is the stream. Losing it means whatever we announced is no longer true —
   *  and this is the only signal for it on the paths where the agent never reports back, such as a
   *  `simctl shutdown` that throws after the streamer has already been torn down. */
  clearStreamSocket(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session?.streamSocket) return
    this.streamSocketIndex.delete(session.streamSocket)
    session.streamSocket = null
    session.readySent = false
  }

  setChromeData(sessionId: string, data: ChromePayload): void {
    const session = this.sessions.get(sessionId)
    if (session) session.chromeData = data
  }

  setPostures(sessionId: string, postures: PosturesPayload): void {
    const session = this.sessions.get(sessionId)
    if (session) session.postures = postures
  }

  setDeviceInfo(sessionId: string, info: DeviceDetails): void {
    const session = this.sessions.get(sessionId)
    if (session) session.deviceInfo = info
  }

  setReadySent(sessionId: string, value: boolean): void {
    const session = this.sessions.get(sessionId)
    if (session) session.readySent = value
  }

  /** A `device:ready` said which tier the device came up with; `undefined` once it is off or starting again, until
   *  the next ready says. */
  setDeviceServiceTier(sessionId: string, tier: ServiceTier | 'unsupported' | undefined): void {
    const session = this.sessions.get(sessionId)
    if (session) session.deviceServiceTier = tier
  }

  updateDeviceStatus(sessionId: string, status: DeviceStatus): void {
    const session = this.sessions.get(sessionId)
    if (session) session.deviceStatus = status
  }

  /**
   * @param asker      the owner key of the socket that asked, so `busy` can mean *busy for you*.
   * @param isAlive    whether a holder's socket is answering — the same predicate occupancy uses.
   *
   * **`busy` has to agree with the occupancy test or the UI locks a tester out of their own session.**
   * `browserSocket !== null` said "someone holds it", which is a different question from "you cannot have
   * it": `QASession` renders `disabled={isBusy}`, so a tester whose socket reconnected automatically found
   * their own device greyed out with no way to reach the takeover that would have worked. And a holder
   * that has stopped answering keeps the card locked for everyone until the sweep notices.
   *
   * Passing the same `isAlive` rather than a second liveness rule is the point — two predicates that
   * disagree would flash a device as free while a join for it is still refused.
   */
  /** An AI client holds this session on a socket that is answering — the same liveness `busy` reads. */
  /** What the listing says about whose this device is to come back to — see the fields on `DeviceSummary`. */
  private ownership(
    s: Session, asker: string, askerUser: string | undefined, isAlive: (ws: WebSocket) => boolean, now: number,
  ): Pick<DeviceSummary, 'waiting' | 'resumable' | 'releasedAgoMs' | 'heldBySelf' | 'endedBy'> {
    const live = s.owner !== null && s.browserSocket !== null && s.browserSocket.readyState === WebSocket.OPEN && isAlive(s.browserSocket)
    const waited = s.waitingOwner
    const mine = askerUser !== undefined
    const out: ReturnType<SessionManager['ownership']> = {}
    // While a person holds it there is no wait: a person's join ends it. So a live holder here is an AI client.
    if (waited) {
      const yours = mine && waited.user === askerUser
      out.waiting = {
        user: waited.label,
        name: waited.name,
        ...(live ? { aiHolding: true as const } : { remainingMs: Math.max(0, waited.deadline - now) }),
        ...(yours ? { yours: true as const, ...(s.installed ? { buildId: s.installed.buildId } : {}) } : {}),
      }
      if (!live && yours) {
        out.resumable = true
        out.releasedAgoMs = now - waited.since
      }
    }
    if (live && mine && !isAiClientKind(s.holderKind) && s.owner !== asker && s.ownerUser === askerUser) out.heldBySelf = true
    const ended = s.endedBy
    if (ended && mine && ended.ownerUser === askerUser && now - ended.at < this.idleTimeoutMs) out.endedBy = { by: ended.byLabel, name: ended.byName, at: ended.at }
    return out
  }

  private liveAiHolder(s: Session, isAlive: (ws: WebSocket) => boolean): boolean {
    return isAiClientKind(s.holderKind) &&
      s.owner !== null &&
      s.browserSocket !== null &&
      s.browserSocket.readyState === WebSocket.OPEN &&
      isAlive(s.browserSocket)
  }

  /**
   * `admissionOf` is asked once per agent, with that agent's sessions. `askerUser` is the signed-in user behind
   * `asker`: the fields about a person's own sessions (`resumable`, `heldBySelf`, `endedBy`) match on it, since a
   * person comes back from another browser as another client. Without it those fields are left out.
   */
  list(asker: string, isAlive: (ws: WebSocket) => boolean, admissionOf: (sessions: Session[]) => MacAdmission, askerUser?: string): SessionInfo[] {
    const now = Date.now()
    // Group sessions by agentSocket
    const agentMap = new Map<WebSocket, Session[]>()
    for (const session of this.sessions.values()) {
      // A session whose agent socket is closed is being held for a returning agent (#426). It is
      // not something anyone can pick right now, and listing it is worse than leaving it out: the
      // card would render with the dead agent's last CPU/RAM reading and no warning — the `Stale`
      // badge keys off a 30s-old resource sample, far longer than the window. Worse, if the agent
      // comes back under a different identity (adding an agentId is a common reason to upgrade,
      // and upgrading is a common reason to restart) nothing rebinds, and the dashboard groups by
      // `agentName` — two groups, a duplicate React key, and the lookup picking the dead one.
      if (session.agentSocket.readyState !== WebSocket.OPEN) continue
      // Its device has left the Mac; the session lives on only for whoever is still on it.
      if (session.deviceGone) continue
      const group = agentMap.get(session.agentSocket) ?? []
      group.push(session)
      agentMap.set(session.agentSocket, group)
    }

    return Array.from(agentMap.values()).map((group) => ({
      agentName: group[0].agentName,
      ...(group[0].agentId || group[0].agentName ? { agentKey: group[0].agentId || group[0].agentName } : {}),
      platform: group[0].agentPlatform,
      resources: this.agentResources.get(group[0].agentSocket),
      // `?? []` rather than passing the absence through: an agent that predates the field means
      // "advertises nothing", and the viewer gates on membership. Leaving it undefined would make
      // every consumer repeat the same fallback, and one of them would forget.
      capabilities: group[0].agentCapabilities ?? [],
      admission: admissionOf(group),
      devices: group.map((s) => ({
        id: s.deviceId,
        name: s.deviceName,
        platform: s.devicePlatform,
        status: s.deviceStatus,
        osVersion: s.deviceOsVersion,
        formFactor: s.deviceFormFactor,
        ...(s.deviceServiceTier !== undefined ? { serviceTier: s.deviceServiceTier } : {}),
        sessionId: s.id,
        ...(this.liveAiHolder(s, isAlive) ? { holder: { kind: s.holderKind as AiClientKind, user: s.holderLabel ?? 'unknown' } } : {}),
        ...this.ownership(s, asker, askerUser, isAlive, now),
        busy:
          s.owner !== null &&
          s.owner !== asker &&
          s.browserSocket !== null &&
          // The clause that was missing, and its absence was the mirror of the failure the docstring warns
          // about: a socket in CLOSING has not fired `close` yet, so `isAlive` is still true — the card
          // read `busy` while a join for it would have succeeded, locking every other tester out of a
          // device the relay was ready to hand them.
          s.browserSocket.readyState === WebSocket.OPEN &&
          isAlive(s.browserSocket),
      })),
    }))
  }
}
