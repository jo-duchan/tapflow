import { randomUUID } from 'crypto'
import type { WebSocket } from 'ws'
import type { AgentResources, SessionInfo } from './types.js'

export interface Session {
  id: string
  agentName?: string
  agentPlatform?: string
  agentSocket: WebSocket
  browserSocket: WebSocket | null
  streamSocket: WebSocket | null
  deviceId: string
  deviceName: string
  devicePlatform: string
  deviceStatus: string
  deviceOsVersion?: string
  chromeData?: unknown
  deviceInfo?: { deviceName: string; osVersion: string }
}

type RawDevice = { id: string; name: string; platform: string; status: string; osVersion?: string }

export class SessionManager {
  private sessions = new Map<string, Session>()
  private agentResources = new Map<WebSocket, AgentResources>()

  create(agentSocket: WebSocket, devices: RawDevice[] = [], agentName?: string, agentPlatform?: string): string[] {
    return devices.map((d) => {
      const id = randomUUID()
      this.sessions.set(id, {
        id,
        agentName,
        agentPlatform,
        agentSocket,
        browserSocket: null,
        streamSocket: null,
        deviceId: d.id,
        deviceName: d.name,
        devicePlatform: d.platform,
        deviceStatus: d.status,
        deviceOsVersion: d.osVersion,
      })
      return id
    })
  }

  get(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId)
  }

  getAllByAgentSocket(ws: WebSocket): Session[] {
    return Array.from(this.sessions.values()).filter((s) => s.agentSocket === ws)
  }

  getByStreamSocket(ws: WebSocket): Session | undefined {
    for (const session of this.sessions.values()) {
      if (session.streamSocket === ws) return session
    }
    return undefined
  }

  getByBrowserSocket(ws: WebSocket): Session | undefined {
    for (const session of this.sessions.values()) {
      if (session.browserSocket === ws) return session
    }
    return undefined
  }

  join(sessionId: string, browserSocket: WebSocket): void {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Session not found: ${sessionId}`)
    if (session.browserSocket?.readyState === 1 /* OPEN */) {
      throw new Error(`Session busy: ${sessionId}`)
    }
    session.browserSocket = browserSocket
  }

  remove(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  clearBrowser(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.browserSocket = null
  }

  setResources(agentSocket: WebSocket, resources: AgentResources): void {
    this.agentResources.set(agentSocket, resources)
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
    if (session) session.streamSocket = ws
  }

  setChromeData(sessionId: string, data: unknown): void {
    const session = this.sessions.get(sessionId)
    if (session) session.chromeData = data
  }

  setDeviceInfo(sessionId: string, info: { deviceName: string; osVersion: string }): void {
    const session = this.sessions.get(sessionId)
    if (session) session.deviceInfo = info
  }

  updateDeviceStatus(sessionId: string, status: string): void {
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
