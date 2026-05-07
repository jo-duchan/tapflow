import { randomUUID } from 'crypto'
import type { WebSocket } from 'ws'

export interface Session {
  id: string
  agentSocket: WebSocket
  browserSocket: WebSocket | null
}

export class SessionManager {
  private sessions = new Map<string, Session>()

  create(agentSocket: WebSocket): string {
    const id = randomUUID()
    this.sessions.set(id, { id, agentSocket, browserSocket: null })
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

  getBySocket(socket: WebSocket): Session | undefined {
    for (const session of this.sessions.values()) {
      if (session.agentSocket === socket || session.browserSocket === socket) {
        return session
      }
    }
    return undefined
  }
}
