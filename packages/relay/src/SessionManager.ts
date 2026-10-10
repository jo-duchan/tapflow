import { randomUUID } from 'crypto'
import { WebSocket } from 'ws'
import type { DeviceStatus } from '@tapflowio/agent-core'
import type { AgentResources, SessionInfo } from './types.js'
import type { AiClientKind, ChromePayload, ClientKind, DeviceDetails, DeviceReport, FormFactor, PosturesPayload, WatchEndReason } from '@tapflowio/protocol'

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
  streamSocket: WebSocket | null
  deviceId: string
  deviceName: string
  devicePlatform: string
  /** What simctl/adb reported about the device. Drives the device list and the REST guards —
   *  "is this device up", which is a different question from the one below. */
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
}

/**
 * Why a `session:start` could not bind, or that it did.
 *
 * The two failures are the ones a caller can be told about truthfully, and they are values rather than
 * exceptions for that reason — see `join()`. Anything else that goes wrong in there is a bug and still
 * throws, which keeps the two apart at the call site instead of at a `catch`.
 */
export type JoinResult = { ok: true } | { ok: false; failure: 'not-found' | 'held-by-another' }

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
  private static agentFields(
    agent: AgentIdentity,
    device: DeviceReport,
  ): Pick<Session, 'agentId' | 'agentName' | 'agentPlatform' | 'agentCapabilities' | 'deviceName' | 'devicePlatform' | 'deviceStatus' | 'deviceOsVersion' | 'deviceFormFactor'> {
    return {
      agentId: agent.agentId,
      agentName: agent.agentName,
      agentPlatform: agent.agentPlatform,
      agentCapabilities: agent.agentCapabilities,
      deviceName: device.name,
      devicePlatform: device.platform,
      deviceStatus: device.status as DeviceStatus,
      deviceOsVersion: device.osVersion,
      deviceFormFactor: device.formFactor,
    }
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
        streamSocket: null,
        deviceId: d.id,
        readySent: false,
        idleTimer: null,
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
    holder: { kind?: ClientKind; label: string } = { label: owner.user },
  ): JoinResult {
    const session = this.sessions.get(sessionId)
    if (!session) return { ok: false, failure: 'not-found' }
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
    this.evictWatchers(sessionId, 'holder-changed', (admitted) => admitted !== owner.key)
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
    session.owner = null
    session.ownerMinted = false
    session.ownerUser = null
    session.holderKind = null
    session.holderLabel = null
    if (session.idleTimer) { clearTimeout(session.idleTimer); session.idleTimer = null }
    if (onTimeout) {
      session.idleTimer = setTimeout(() => {
        session.idleTimer = null
        onTimeout()
      }, this.idleTimeoutMs)
    }
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
  private liveAiHolder(s: Session, isAlive: (ws: WebSocket) => boolean): boolean {
    return isAiClientKind(s.holderKind) &&
      s.owner !== null &&
      s.browserSocket !== null &&
      s.browserSocket.readyState === WebSocket.OPEN &&
      isAlive(s.browserSocket)
  }

  list(asker: string, isAlive: (ws: WebSocket) => boolean): SessionInfo[] {
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
      const group = agentMap.get(session.agentSocket) ?? []
      group.push(session)
      agentMap.set(session.agentSocket, group)
    }

    return Array.from(agentMap.values()).map((group) => ({
      agentName: group[0].agentName,
      platform: group[0].agentPlatform,
      resources: this.agentResources.get(group[0].agentSocket),
      // `?? []` rather than passing the absence through: an agent that predates the field means
      // "advertises nothing", and the viewer gates on membership. Leaving it undefined would make
      // every consumer repeat the same fallback, and one of them would forget.
      capabilities: group[0].agentCapabilities ?? [],
      devices: group.map((s) => ({
        id: s.deviceId,
        name: s.deviceName,
        platform: s.devicePlatform,
        status: s.deviceStatus,
        osVersion: s.deviceOsVersion,
        formFactor: s.deviceFormFactor,
        sessionId: s.id,
        ...(this.liveAiHolder(s, isAlive) ? { holder: { kind: s.holderKind as AiClientKind, user: s.holderLabel ?? 'unknown' } } : {}),
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
