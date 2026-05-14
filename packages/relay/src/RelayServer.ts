import http from 'http'
import fs from 'fs'
import path from 'path'
import { WebSocketServer, WebSocket } from 'ws'
import { SessionManager } from './SessionManager.js'
import type { RelayMessage } from './types.js'
import { Router } from './router.js'
import { getDb } from './db.js'
import { handleLogin, handleLogout, handleMe, handleChangePassword } from './api/auth.js'
import { handleVerify, handleAccept } from './api/invitations.js'
import { handleVerifyReset, handleDoReset, handleSendMemberReset } from './api/passwordReset.js'
import { handleListBuilds, handleGetBuild, handleUpdateBuild, handleUploadBuild } from './api/builds.js'
import { handleListApps, handleCreateApp, handleUpdateApp, handleDeleteApp } from './api/apps.js'
import { handleListComments, handleCreateComment, handleDeleteComment } from './api/comments.js'
import { handleListMembers, handleInvite, handleUpdateMember, handleDeleteMember } from './api/team.js'
import { handleListTokens, handleCreateToken, handleRevokeToken } from './api/tokens.js'
import { handleGetSettings, handleUpdateSettings } from './api/settings.js'
import { handleUpdateProfile } from './api/profile.js'
import { handleUploadRecording, handleListRecordings, handleDownloadRecording, purgeExpiredRecordings } from './api/recordings.js'

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

  constructor(private readonly options: { port: number; publicDir?: string; uploadsDir?: string; idleTimeoutMs?: number }) {
    this.sessions = new SessionManager({ idleTimeoutMs: options.idleTimeoutMs })
    this.publicDir = options.publicDir ?? path.join(import.meta.dirname, '../public')
    this.uploadsDir = options.uploadsDir ?? path.join(import.meta.dirname, '../uploads')
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
    this.router.post('/api/v1/auth/change-password', handleChangePassword)
    this.router.get('/api/v1/auth/reset-password/verify', handleVerifyReset)
    this.router.post('/api/v1/auth/reset-password', handleDoReset)

    // invitations
    this.router.get('/api/v1/invitations/verify', handleVerify)
    this.router.post('/api/v1/invitations/accept', (req, res) => handleAccept(req, res, u))

    // apps
    this.router.get('/api/v1/apps', handleListApps)
    this.router.post('/api/v1/apps', handleCreateApp)
    this.router.patch('/api/v1/apps/:id', handleUpdateApp)
    this.router.delete('/api/v1/apps/:id', handleDeleteApp)

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
    this.router.post('/api/v1/team/members/:id/send-reset', handleSendMemberReset)

    // tokens
    this.router.get('/api/v1/tokens', handleListTokens)
    this.router.post('/api/v1/tokens', handleCreateToken)
    this.router.delete('/api/v1/tokens/:id', handleRevokeToken)

    // settings
    this.router.get('/api/v1/settings', handleGetSettings)
    this.router.patch('/api/v1/settings', (req, res) => handleUpdateSettings(req, res, u))
    this.router.patch('/api/v1/profile', (req, res) => handleUpdateProfile(req, res, u))

    // recordings
    const recordingsDir = path.join(u, '../recordings')
    purgeExpiredRecordings(recordingsDir)
    setInterval(() => purgeExpiredRecordings(recordingsDir), 24 * 60 * 60 * 1000).unref()
    this.router.post('/api/v1/recordings/upload', (req, res) => handleUploadRecording(req, res, recordingsDir))
    this.router.get('/api/v1/recordings', (req, res) => handleListRecordings(req, res))
    this.router.get('/api/v1/recordings/:filename', (req, res) => handleDownloadRecording(req, res, recordingsDir))
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
        // Binary frames arrive on the dedicated stream WS, route to the session's browser
        const session = this.sessions.getByStreamSocket(ws)
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
      // Agent main socket disconnected → remove all device sessions for this agent
      const agentSessions = this.sessions.getAllByAgentSocket(ws)
      if (agentSessions.length > 0) {
        for (const s of agentSessions) this.sessions.remove(s.id)
        this.sessions.removeResources(ws)
        return
      }

      // Stream socket disconnected → clear the streamSocket reference
      const streamSession = this.sessions.getByStreamSocket(ws)
      if (streamSession) {
        streamSession.streamSocket = null
        return
      }

      // Browser socket disconnected → clear browserSocket, start idle timer
      const browserSession = this.sessions.getByBrowserSocket(ws)
      if (browserSession) {
        this.sessions.clearBrowser(browserSession.id, () => {
          const session = this.sessions.get(browserSession.id)
          if (session?.agentSocket.readyState === WebSocket.OPEN) {
            session.agentSocket.send(JSON.stringify({
              type: 'device:shutdown',
              sessionId: session.id,
              payload: { deviceId: session.deviceId },
            }))
          }
        })
      }
    })
  }

  private route(ws: WebSocket, msg: RelayMessage): void {
    switch (msg.type) {
      case 'agent:resources': {
        if (msg.resources) this.sessions.setResources(ws, msg.resources)
        break
      }

      case 'agent:register': {
        const sessionIds = this.sessions.create(ws, msg.devices ?? [], msg.agentName, msg.platform)
        const registeredSessions = (msg.devices ?? []).map((d, i) => ({
          deviceId: d.id,
          sessionId: sessionIds[i],
        }))
        ws.send(JSON.stringify({ type: 'agent:registered', registeredSessions }))
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
        try {
          this.sessions.join(msg.sessionId!, ws)
        } catch {
          ws.send(JSON.stringify({ type: 'error', message: 'Session busy' }))
          return
        }
        ws.send(JSON.stringify({ type: 'session:joined', sessionId: msg.sessionId }))
        if (session.chromeData) {
          ws.send(JSON.stringify({ type: 'session:chrome', payload: session.chromeData }))
        }
        if (session.deviceInfo) {
          ws.send(JSON.stringify({ type: 'session:deviceInfo', payload: session.deviceInfo }))
        }
        // Replay device:ready if the device is already booted (browser WS blip reconnect)
        if (session.deviceStatus === 'booted') {
          ws.send(JSON.stringify({ type: 'device:ready', payload: { deviceId: session.deviceId } }))
        }
        break
      }

      case 'session:chrome': {
        const session = this.sessions.get(msg.sessionId!)
        if (!session) break
        this.sessions.setChromeData(session.id, msg.payload)
        if (session.browserSocket?.readyState === WebSocket.OPEN) {
          session.browserSocket.send(JSON.stringify(msg))
        }
        break
      }

      case 'session:deviceInfo': {
        const session = this.sessions.get(msg.sessionId!)
        if (!session) break
        this.sessions.setDeviceInfo(session.id, msg.payload as { deviceName: string; osVersion: string })
        if (session.browserSocket?.readyState === WebSocket.OPEN) {
          session.browserSocket.send(JSON.stringify(msg))
        }
        break
      }

      case 'session:end': {
        if (msg.sessionId) this.sessions.remove(msg.sessionId)
        break
      }

      case 'stream:register': {
        // Dedicated stream WS from agent: register it and ack so agent knows it's safe to send frames
        const session = this.sessions.get(msg.sessionId!)
        if (session) {
          this.sessions.setStreamSocket(session.id, ws)
          ws.send(JSON.stringify({ type: 'stream:registered' }))
        }
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
        // agent → browser; clear cached device data so reconnecting browser doesn't get stale chrome
        const session = this.sessions.get(msg.sessionId!)
        if (!session) break
        this.sessions.clearDeviceCache(session.id)
        if (session.browserSocket?.readyState === WebSocket.OPEN) {
          session.browserSocket.send(JSON.stringify(msg))
        }
        break
      }

      case 'device:boot-error': {
        // agent → browser
        const session = this.sessions.get(msg.sessionId!)
        if (session?.browserSocket?.readyState === WebSocket.OPEN) {
          session.browserSocket.send(JSON.stringify(msg))
        }
        break
      }

      case 'device:shutdown-done': {
        // agent → browser + persist shutdown status
        const session = this.sessions.get(msg.sessionId!)
        if (!session) break
        this.sessions.updateDeviceStatus(session.id, 'shutdown')
        if (session.browserSocket?.readyState === WebSocket.OPEN) {
          session.browserSocket.send(JSON.stringify(msg))
        }
        break
      }

      case 'device:ready': {
        // agent → browser + persist booted status
        const session = this.sessions.get(msg.sessionId!)
        if (!session) break
        this.sessions.updateDeviceStatus(session.id, 'booted')
        if (session.browserSocket?.readyState === WebSocket.OPEN) {
          session.browserSocket.send(JSON.stringify(msg))
        }
        break
      }

      case 'device:rotate': {
        // agent → browser
        const session = this.sessions.get(msg.sessionId!)
        if (session?.browserSocket?.readyState === WebSocket.OPEN) {
          session.browserSocket.send(JSON.stringify(msg))
        }
        break
      }

      case 'app:install': {
        // browser → agent: relay looks up file_path from DB and enriches; includes sessionId for response routing
        const session = this.sessions.get(msg.sessionId!)
        if (!session) {
          ws.send(JSON.stringify({ type: 'error', message: 'Session not found' }))
          break
        }
        const build = getDb()
          .prepare('SELECT file_path, bundle_id FROM builds WHERE id = ?')
          .get(msg.buildId!) as { file_path: string; bundle_id: string | null } | undefined
        if (!build) {
          ws.send(JSON.stringify({ type: 'app:install-error', message: 'Build not found' }))
          break
        }
        if (session.agentSocket.readyState === WebSocket.OPEN) {
          session.agentSocket.send(JSON.stringify({
            type: 'app:install',
            sessionId: msg.sessionId,
            payload: { filePath: build.file_path, bundleId: build.bundle_id },
          }))
        }
        break
      }

      case 'app:install-done':
      case 'app:install-error': {
        // agent → browser
        const session = this.sessions.get(msg.sessionId!)
        if (session?.browserSocket?.readyState === WebSocket.OPEN) {
          session.browserSocket.send(JSON.stringify(msg))
        }
        break
      }

      case 'app:launch': {
        // browser → agent: relay looks up bundle_id from DB; includes sessionId for response routing
        const session = this.sessions.get(msg.sessionId!)
        if (!session) {
          ws.send(JSON.stringify({ type: 'error', message: 'Session not found' }))
          break
        }
        const build = getDb()
          .prepare('SELECT bundle_id FROM builds WHERE id = ?')
          .get(msg.buildId!) as { bundle_id: string | null } | undefined
        if (!build?.bundle_id) {
          ws.send(JSON.stringify({ type: 'app:launch-error', message: 'Bundle ID not available for this build' }))
          break
        }
        if (session.agentSocket.readyState === WebSocket.OPEN) {
          session.agentSocket.send(JSON.stringify({
            type: 'app:launch',
            sessionId: msg.sessionId,
            payload: { bundleId: build.bundle_id },
          }))
        }
        break
      }

      case 'app:launch-done':
      case 'app:launch-error': {
        // agent → browser
        const session = this.sessions.get(msg.sessionId!)
        if (session?.browserSocket?.readyState === WebSocket.OPEN) {
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
      case 'input:key':
      case 'input:type':
      case 'input:button':
      case 'input:rotate':
      case 'input:keyboard:toggle': {
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

    if (url.startsWith('/api/')) {
      res.setHeader('Cache-Control', 'no-store')
    }
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
