import { randomUUID } from 'crypto'
import type { WebSocket } from 'ws'
import type { DeviceInfo, SessionInfo } from './types'

export interface Session {
  id: string
  agentName?: string
  agentSocket: WebSocket
  browserSocket: WebSocket | null
  devices: DeviceInfo[]
  chromeData?: unknown
  deviceInfo?: { deviceName: string; osVersion: string }
}

export class SessionManager {
  private sessions = new Map<string, Session>()

  create(agentSocket: WebSocket, devices: DeviceInfo[] = [], agentName?: string): string {
    const id = randomUUID()
    this.sessions.set(id, { id, agentName, agentSocket, browserSocket: null, devices })
    return id
  }

  get(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId)
  }

  join(sessionId: string, browserSocket: WebSocket): void {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Session not found: ${sessionId}`)
    session.browserSocket = browserSocket
  }

  remove(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  clearBrowser(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.browserSocket = null
    // Keep chromeData / deviceInfo / device status — cleared in clearDeviceCache (device:booting).
    // Preserving them lets a reconnecting browser (e.g. React StrictMode WS blip) pick up
    // the cached state from session:start without waiting for a new device:boot cycle.
  }

  clearDeviceCache(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.chromeData = undefined
    session.deviceInfo = undefined
    session.devices = session.devices.map((d) => ({ ...d, status: 'shutdown' as const }))
  }

  setChromeData(sessionId: string, data: unknown): void {
    const session = this.sessions.get(sessionId)
    if (session) session.chromeData = data
  }

  setDeviceInfo(sessionId: string, info: { deviceName: string; osVersion: string }): void {
    const session = this.sessions.get(sessionId)
    if (session) session.deviceInfo = info
  }

  getBySocket(socket: WebSocket): Session | undefined {
    for (const session of this.sessions.values()) {
      if (session.agentSocket === socket || session.browserSocket === socket) {
        return session
      }
    }
    return undefined
  }

  updateDeviceStatus(sessionId: string, deviceId: string, status: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.devices = session.devices.map((d) =>
      d.id === deviceId ? { ...d, status: status as DeviceInfo['status'] } : d
    )
  }

  list(): SessionInfo[] {
    return Array.from(this.sessions.values()).map((s) => ({
      sessionId: s.id,
      agentName: s.agentName,
      busy: s.browserSocket !== null,
      devices: s.devices,
    }))
  }
}
