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
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const session = this.sessions.getBySocket(ws)
        if (session?.browserSocket?.readyState === WebSocket.OPEN) {
          session.browserSocket.send(data, { binary: true })
        }
        return
      }
      try {
        const msg: RelayMessage = JSON.parse(data.toString())
        this.route(ws, msg)
      } catch {
        // ignore malformed messages
      }
    })

    ws.on('close', () => {
      const session = this.sessions.getBySocket(ws)
      if (!session) return
      if (session.agentSocket === ws) {
        this.sessions.remove(session.id)
      } else {
        this.sessions.clearBrowser(session.id)
      }
    })
  }

  private route(ws: WebSocket, msg: RelayMessage): void {
    switch (msg.type) {
      case 'agent:register': {
        const sessionId = this.sessions.create(ws, msg.devices ?? [], msg.agentName)
        ws.send(JSON.stringify({ type: 'agent:registered', sessionId }))
        break
      }

      case 'agents:list': {
        const sessions = this.sessions.list()
        ws.send(JSON.stringify({ type: 'agents:listed', sessions }))
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
        if (session.chromeData) {
          ws.send(JSON.stringify({ type: 'session:chrome', payload: session.chromeData }))
        }
        if (session.deviceInfo) {
          ws.send(JSON.stringify({ type: 'session:deviceInfo', payload: session.deviceInfo }))
        }
        // If a device is already booted (e.g. browser reconnected after a brief WS blip),
        // replay device:ready so deviceReadyRef is set and frames start drawing immediately.
        const bootedDevice = session.devices.find((d) => d.status === 'booted')
        if (bootedDevice) {
          ws.send(JSON.stringify({ type: 'device:ready', payload: { deviceId: bootedDevice.id } }))
        }
        break
      }

      case 'session:chrome': {
        const session = this.sessions.getBySocket(ws)
        if (!session) break
        this.sessions.setChromeData(session.id, msg.payload)
        if (session.browserSocket?.readyState === WebSocket.OPEN) {
          session.browserSocket.send(JSON.stringify(msg))
        }
        break
      }

      case 'session:deviceInfo': {
        const session = this.sessions.getBySocket(ws)
        if (!session) break
        this.sessions.setDeviceInfo(session.id, msg.payload as { deviceName: string; osVersion: string })
        if (session.browserSocket?.readyState === WebSocket.OPEN) {
          session.browserSocket.send(JSON.stringify(msg))
        }
        break
      }

      case 'session:end': {
        const session = this.sessions.getBySocket(ws)
        if (session) this.sessions.remove(session.id)
        break
      }

      case 'device:boot':
      case 'device:shutdown': {
        // browser → agent
        const session = this.sessions.get(msg.sessionId!)
        if (session?.agentSocket.readyState === WebSocket.OPEN) {
          session.agentSocket.send(JSON.stringify(msg))
        }
        break
      }

      case 'device:booting': {
        // agent → browser; clear cached device data so the next session:start
        // doesn't replay stale chrome/deviceInfo/device:ready from the old device.
        const session = this.sessions.getBySocket(ws)
        if (!session) break
        this.sessions.clearDeviceCache(session.id)
        if (session.browserSocket?.readyState === WebSocket.OPEN) {
          session.browserSocket.send(JSON.stringify(msg))
        }
        break
      }

      case 'device:boot-error': {
        // agent → browser
        const session = this.sessions.getBySocket(ws)
        if (session?.browserSocket?.readyState === WebSocket.OPEN) {
          session.browserSocket.send(JSON.stringify(msg))
        }
        break
      }

      case 'device:shutdown-done': {
        // agent → browser + persist status so agents:list reflects shutdown state
        const session = this.sessions.getBySocket(ws)
        if (!session) break
        const { deviceId } = (msg as { type: string; payload: { deviceId: string } }).payload
        this.sessions.updateDeviceStatus(session.id, deviceId, 'shutdown')
        if (session.browserSocket?.readyState === WebSocket.OPEN) {
          session.browserSocket.send(JSON.stringify(msg))
        }
        break
      }

      case 'device:ready': {
        // agent → browser + persist status so agents:list reflects booted state
        const session = this.sessions.getBySocket(ws)
        if (!session) break
        const { deviceId } = (msg as { type: string; payload: { deviceId: string } }).payload
        this.sessions.updateDeviceStatus(session.id, deviceId, 'booted')
        if (session.browserSocket?.readyState === WebSocket.OPEN) {
          session.browserSocket.send(JSON.stringify(msg))
        }
        break
      }

      case 'input:touch:start':
      case 'input:touch:move':
      case 'input:touch:end':
      case 'input:pinch:start':
      case 'input:pinch:move':
      case 'input:pinch:end':
      case 'input:type':
      case 'input:button':
      case 'input:rotate': {
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
