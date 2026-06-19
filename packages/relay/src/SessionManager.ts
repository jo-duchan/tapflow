import { randomUUID } from 'crypto'
import { WebSocket } from 'ws'
import type { DeviceStatus } from '@tapflowio/agent-core'
import { ValidationError } from '@tapflowio/agent-core'
import type { AgentResources, SessionInfo } from './types.js'

export interface Session {
  id: string
  agentId?: string
  agentName?: string
  agentPlatform?: string
  agentSocket: WebSocket
  browserSocket: WebSocket | null
  streamSocket: WebSocket | null
  deviceId: string
  deviceName: string
  devicePlatform: string
  deviceStatus: DeviceStatus
  deviceOsVersion?: string
  chromeData?: unknown
  deviceInfo?: { deviceName: string; osVersion: string }
  idleTimer: ReturnType<typeof setTimeout> | null
}

type RawDevice = { id: string; name: string; platform: string; status: string; osVersion?: string }

const DEFAULT_IDLE_TIMEOUT_MS = parseInt(process.env['IDLE_TIMEOUT_MS'] ?? String(5 * 60 * 1000))

export class SessionManager {
  private sessions = new Map<string, Session>()
  private agentResources = new Map<WebSocket, AgentResources>()
  private agentSocketIndex = new Map<WebSocket, Set<string>>()
  private streamSocketIndex = new Map<WebSocket, Session>()
  private browserSocketIndex = new Map<WebSocket, Session>()
  private readonly idleTimeoutMs: number

  constructor(options: { idleTimeoutMs?: number } = {}) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
  }

  create(agentSocket: WebSocket, devices: RawDevice[] = [], agentName?: string, agentPlatform?: string, agentId?: string): string[] {
    const agentIds = this.agentSocketIndex.get(agentSocket) ?? new Set<string>()
    return devices.map((d) => {
      const id = randomUUID()
      this.sessions.set(id, {
        id,
        agentId,
        agentName,
        agentPlatform,
        agentSocket,
        browserSocket: null,
        streamSocket: null,
        deviceId: d.id,
        deviceName: d.name,
        devicePlatform: d.platform,
        deviceStatus: d.status as DeviceStatus,
        deviceOsVersion: d.osVersion,
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

  getByStreamSocket(ws: WebSocket): Session | undefined {
    return this.streamSocketIndex.get(ws)
  }

  getByBrowserSocket(ws: WebSocket): Session | undefined {
    return this.browserSocketIndex.get(ws)
  }

  join(sessionId: string, browserSocket: WebSocket): void {
    const session = this.sessions.get(sessionId)
    if (!session) throw new ValidationError(`Session not found: ${sessionId}`)
    if (session.browserSocket?.readyState === WebSocket.OPEN) {
      throw new ValidationError(`Session busy: ${sessionId}`)
    }
    if (session.idleTimer) { clearTimeout(session.idleTimer); session.idleTimer = null }
    if (session.browserSocket) this.browserSocketIndex.delete(session.browserSocket)
    session.browserSocket = browserSocket
    this.browserSocketIndex.set(browserSocket, session)
  }

  remove(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    if (session.idleTimer) { clearTimeout(session.idleTimer); session.idleTimer = null }
    if (session.streamSocket) this.streamSocketIndex.delete(session.streamSocket)
    if (session.browserSocket) this.browserSocketIndex.delete(session.browserSocket)
    const agentIds = this.agentSocketIndex.get(session.agentSocket)
    agentIds?.delete(sessionId)
    if (agentIds?.size === 0) this.agentSocketIndex.delete(session.agentSocket)
    this.sessions.delete(sessionId)
  }

  clearBrowser(sessionId: string, onTimeout?: () => void): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    if (session.browserSocket) {
      this.browserSocketIndex.delete(session.browserSocket)
      session.browserSocket = null
    }
    if (session.idleTimer) { clearTimeout(session.idleTimer); session.idleTimer = null }
    if (onTimeout) {
      session.idleTimer = setTimeout(() => {
        session.idleTimer = null
        onTimeout()
      }, this.idleTimeoutMs)
    }
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
    session.deviceInfo = undefined
    session.deviceStatus = 'shutdown'
  }

  setStreamSocket(sessionId: string, ws: WebSocket): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    if (session.streamSocket) this.streamSocketIndex.delete(session.streamSocket)
    session.streamSocket = ws
    this.streamSocketIndex.set(ws, session)
  }

  clearStreamSocket(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session?.streamSocket) return
    this.streamSocketIndex.delete(session.streamSocket)
    session.streamSocket = null
  }

  setChromeData(sessionId: string, data: unknown): void {
    const session = this.sessions.get(sessionId)
    if (session) session.chromeData = data
  }

  setDeviceInfo(sessionId: string, info: { deviceName: string; osVersion: string }): void {
    const session = this.sessions.get(sessionId)
    if (session) session.deviceInfo = info
  }

  updateDeviceStatus(sessionId: string, status: DeviceStatus): void {
    const session = this.sessions.get(sessionId)
    if (session) session.deviceStatus = status
  }

  list(): SessionInfo[] {
    // Group sessions by agentSocket
    const agentMap = new Map<WebSocket, Session[]>()
    for (const session of this.sessions.values()) {
      const group = agentMap.get(session.agentSocket) ?? []
      group.push(session)
      agentMap.set(session.agentSocket, group)
    }

    return Array.from(agentMap.values()).map((group) => ({
      agentName: group[0].agentName,
      platform: group[0].agentPlatform,
      resources: this.agentResources.get(group[0].agentSocket),
      devices: group.map((s) => ({
        id: s.deviceId,
        name: s.deviceName,
        platform: s.devicePlatform,
        status: s.deviceStatus,
        osVersion: s.deviceOsVersion,
        sessionId: s.id,
        busy: s.browserSocket !== null,
      })),
    }))
  }
}
