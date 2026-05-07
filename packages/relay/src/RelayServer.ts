import http from 'http'
import fs from 'fs'
import path from 'path'
import { WebSocketServer, WebSocket } from 'ws'
import { SessionManager } from './SessionManager'
import type { RelayMessage } from './types'

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
}

export class RelayServer {
  private httpServer: http.Server
  private wss: WebSocketServer
  private sessions: SessionManager
  private publicDir: string

  constructor(private readonly options: { port: number; publicDir?: string }) {
    this.sessions = new SessionManager()
    this.publicDir = options.publicDir ?? path.join(__dirname, '../public')
    this.httpServer = http.createServer((req, res) => this.serveStatic(req, res))
    this.wss = new WebSocketServer({ server: this.httpServer })
    this.wss.on('connection', (ws) => this.handleConnection(ws))
  }

  start(): Promise<void> {
    return new Promise((resolve) => this.httpServer.listen(this.options.port, resolve))
  }

  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.wss.clients.forEach((ws) => ws.terminate())
      this.wss.close(() => {
        this.httpServer.close((err) => (err ? reject(err) : resolve()))
      })
    })
  }

  address() {
    return this.httpServer.address()
  }

  private handleConnection(ws: WebSocket): void {
    ws.on('message', (data) => {
      try {
        const msg: RelayMessage = JSON.parse(data.toString())
        this.route(ws, msg)
      } catch {
        // ignore malformed messages
      }
    })

    ws.on('close', () => {
      const session = this.sessions.getBySocket(ws)
      if (session) this.sessions.remove(session.id)
    })
  }

  private route(ws: WebSocket, msg: RelayMessage): void {
    switch (msg.type) {
      case 'agent:register': {
        const sessionId = this.sessions.create(ws)
        ws.send(JSON.stringify({ type: 'agent:registered', sessionId }))
        break
      }

      case 'session:start': {
        const session = this.sessions.get(msg.sessionId!)
        if (!session) {
          ws.send(JSON.stringify({ type: 'error', message: 'Session not found' }))
          return
        }
        this.sessions.join(msg.sessionId!, ws)
        ws.send(JSON.stringify({ type: 'session:joined', sessionId: msg.sessionId }))
        break
      }

      case 'session:end': {
        const session = this.sessions.getBySocket(ws)
        if (session) this.sessions.remove(session.id)
        break
      }

      case 'stream:frame': {
        // agent → browser
        const session = this.sessions.getBySocket(ws)
        if (session?.browserSocket?.readyState === WebSocket.OPEN) {
          session.browserSocket.send(JSON.stringify(msg))
        }
        break
      }

      case 'input:tap':
      case 'input:swipe':
      case 'input:type': {
        // browser → agent
        const session = this.sessions.get(msg.sessionId!)
        if (session?.agentSocket.readyState === WebSocket.OPEN) {
          session.agentSocket.send(JSON.stringify(msg))
        }
        break
      }
    }
  }

  private serveStatic(req: http.IncomingMessage, res: http.ServerResponse): void {
    const urlPath = req.url === '/' ? '/index.html' : (req.url ?? '/')
    const filePath = path.join(this.publicDir, urlPath)

    if (!fs.existsSync(filePath)) {
      res.writeHead(404)
      res.end('Not found')
      return
    }

    const contentType = MIME_TYPES[path.extname(filePath)] ?? 'application/octet-stream'
    res.writeHead(200, { 'Content-Type': contentType })
    fs.createReadStream(filePath).pipe(res)
  }
}
