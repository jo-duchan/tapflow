import http from 'http'
import fs from 'fs'
import path from 'path'
import { WebSocketServer, WebSocket } from 'ws'
import { SessionManager } from './SessionManager'
import type { RelayMessage } from './types'
import { Router } from './router'
import { handleLogin, handleLogout, handleMe } from './api/auth'
import { handleVerify, handleAccept } from './api/invitations'
import { handleListBuilds, handleGetBuild, handleUpdateBuild, handleUploadBuild } from './api/builds'
import { handleListComments, handleCreateComment, handleDeleteComment } from './api/comments'
import { handleListMembers, handleInvite, handleUpdateMember, handleDeleteMember } from './api/team'
import { handleListTokens, handleCreateToken, handleRevokeToken } from './api/tokens'
import { handleGetSettings, handleUpdateSettings } from './api/settings'

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
}

export class RelayServer {
  private httpServer: http.Server
  private wss: WebSocketServer
  private sessions: SessionManager
  private publicDir: string
  private uploadsDir: string
  private router: Router

  constructor(private readonly options: { port: number; publicDir?: string; uploadsDir?: string }) {
    this.sessions = new SessionManager()
    this.publicDir = options.publicDir ?? path.join(__dirname, '../public')
    this.uploadsDir = options.uploadsDir ?? path.join(__dirname, '../uploads')
    this.router = new Router()
    this.registerRoutes()
    this.httpServer = http.createServer((req, res) => this.handleRequest(req, res))
    this.wss = new WebSocketServer({ server: this.httpServer })
    this.wss.on('connection', (ws) => this.handleConnection(ws))
    this.wss.on('error', () => { /* propagated from httpServer */ })
  }

  private registerRoutes(): void {
    const u = this.uploadsDir

    // auth
    this.router.get('/api/v1/auth/me', handleMe)
    this.router.post('/api/v1/auth/login', handleLogin)
    this.router.post('/api/v1/auth/logout', handleLogout)

    // invitations
    this.router.get('/api/v1/invitations/verify', handleVerify)
    this.router.post('/api/v1/invitations/accept', handleAccept)

    // builds
    this.router.get('/api/v1/builds', handleListBuilds)
    this.router.get('/api/v1/builds/:id', handleGetBuild)
    this.router.patch('/api/v1/builds/:id', handleUpdateBuild)
    this.router.post('/api/v1/builds', (req, res) => handleUploadBuild(req, res, u))

    // comments
    this.router.get('/api/v1/comments', handleListComments)
    this.router.post('/api/v1/comments', (req, res) => handleCreateComment(req, res, u))
    this.router.delete('/api/v1/comments/:id', handleDeleteComment)

    // team
    this.router.get('/api/v1/team/members', handleListMembers)
    this.router.post('/api/v1/team/invite', handleInvite)
    this.router.patch('/api/v1/team/members/:id', handleUpdateMember)
    this.router.delete('/api/v1/team/members/:id', handleDeleteMember)

    // tokens
    this.router.get('/api/v1/tokens', handleListTokens)
    this.router.post('/api/v1/tokens', handleCreateToken)
    this.router.delete('/api/v1/tokens/:id', handleRevokeToken)

    // settings
    this.router.get('/api/v1/settings', handleGetSettings)
    this.router.patch('/api/v1/settings', (req, res) => handleUpdateSettings(req, res, u))
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.httpServer.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          reject(new Error(`Port ${this.options.port} is already in use. Stop the existing process and try again.`))
        } else {
          reject(err)
        }
      })
      this.httpServer.listen(this.options.port, resolve)
    })
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

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    // uploads — serve uploaded files
    const url = req.url ?? '/'
    if (url.startsWith('/uploads/')) {
      this.serveUpload(req, res)
      return
    }

    // API routes
    const handled = await this.router.handle(req, res)
    if (handled) return

    // SPA static fallback
    this.serveStatic(req, res)
  }

  private serveUpload(req: http.IncomingMessage, res: http.ServerResponse): void {
    const urlPath = (req.url ?? '/').split('?')[0]
    const filePath = path.join(this.uploadsDir, urlPath.replace('/uploads/', ''))
    if (!fs.existsSync(filePath)) {
      res.writeHead(404); res.end('Not found'); return
    }
    const contentType = MIME_TYPES[path.extname(filePath)] ?? 'application/octet-stream'
    res.writeHead(200, { 'Content-Type': contentType })
    fs.createReadStream(filePath).pipe(res)
  }

  private serveStatic(req: http.IncomingMessage, res: http.ServerResponse): void {
    const urlPath = (req.url ?? '/').split('?')[0]
    let filePath = path.join(this.publicDir, urlPath === '/' ? '/index.html' : urlPath)

    // Next.js static export: try exact path, then path/index.html (trailingSlash)
    if (!fs.existsSync(filePath)) {
      const withIndex = path.join(filePath, 'index.html')
      if (fs.existsSync(withIndex)) {
        filePath = withIndex
      } else {
        // SPA fallback → index.html
        filePath = path.join(this.publicDir, 'index.html')
      }
    }

    if (!fs.existsSync(filePath)) {
      res.writeHead(404); res.end('Not found'); return
    }

    const contentType = MIME_TYPES[path.extname(filePath)] ?? 'text/html'
    res.writeHead(200, { 'Content-Type': contentType })
    fs.createReadStream(filePath).pipe(res)
  }
}
