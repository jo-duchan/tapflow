import http from 'http'
import https from 'https'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { randomUUID } from 'crypto'
import { WebSocketServer, WebSocket } from 'ws'
import { SessionManager } from './SessionManager.js'
import type { RelayMessage, UIElement } from './types.js'
import { Router, json } from './router.js'
import { requireViewAuth, requireAuth, getAuth, verifyPat } from './middleware/auth.js'
import { classifyConnection } from './lib/connectionAuth.js'
import { resolveClientAddress } from './lib/clientAddress.js'
import { resolveCorsHeaders } from './lib/cors.js'
import { isCsrfBlocked } from './lib/csrf.js'
import { pickLanAddress } from './lib/lanAddress.js'
import { getDb } from './db.js'
import { handleLogin, handleLogout, handleMe, handleChangePassword, handleInit, handleAuthStatus } from './api/auth.js'
import { handleVerify, handleAccept } from './api/invitations.js'
import { createLogger } from '@tapflowio/agent-core'
import {
  createKeyframeAwareSender,
  createRateLimitedDropWarn,
  sendAudioYieldingToVideo,
  DEFAULT_BACKPRESSURE_BYTES,
  hasEnvelope,
  patchRelayedAt,
  readEnvelopeFlags,
  CODEC_JPEG,
  CODEC_AUDIO,
} from '@tapflowio/agent-core/utils'
import type { KeyframeAwareSender } from '@tapflowio/agent-core/utils'

const logger = createLogger('relay')

// True when a remote IP is public — i.e. not loopback, private LAN, or link-local. Used to pick the
// downscale tier (external viewers are bandwidth-constrained). Behind a reverse proxy the relay sees
// the proxy's address, so set TAPFLOW_MAX_SIZE_EXTERNAL=0 / a global override for those deployments.
export function isExternalAddress(addr: string): boolean {
  if (!addr) return false
  const a = addr.replace(/^::ffff:/, '') // unwrap IPv4-mapped IPv6
  if (a === '127.0.0.1' || a === '::1' || a === 'localhost') return false
  if (/^10\./.test(a) || /^192\.168\./.test(a) || /^169\.254\./.test(a)) return false
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(a)) return false
  if (/^(f[cd]|fe80)/i.test(a)) return false // IPv6 ULA / link-local
  return true
}
// Min gap between IDR requests per session — one IDR resyncs the stream, so avoid
// spamming the agent in the frames between request and the IDR arriving.
const IDR_REQUEST_THROTTLE_MS = 500
// Ping every socket each interval; a missed pong window (~2× this) terminates the dead socket.
const HEARTBEAT_MS = 30_000
import { handleVerifyReset, handleDoReset, handleSendMemberReset } from './api/passwordReset.js'
import { handleListBuilds, handleGetBuild, handleUpdateBuild, handleUploadBuild, handleScheduleBuildDeletion, handleCancelBuildDeletion, purgeExpiredBuilds } from './api/builds.js'
import { handleListApps, handleCreateApp, handleUpdateApp, handleDeleteApp } from './api/apps.js'
import { handleListWebhooks, handleCreateWebhook, handleUpdateWebhook, handleDeleteWebhook } from './api/webhooks.js'
import { handleListComments, handleCreateComment, handleDeleteComment } from './api/comments.js'
import { handleListMembers, handleInvite, handleUpdateMember, handleDeleteMember } from './api/team.js'
import { handleListTokens, handleCreateToken, handleRevokeToken } from './api/tokens.js'
import { handleGetSettings, handleUpdateSettings } from './api/settings.js'
import { handleUpdateProfile } from './api/profile.js'
import { handleUploadRecording, handleListRecordings, handleDownloadRecording, purgeExpiredRecordings } from './api/recordings.js'
import { handleListAgents, handleGetAgentResources } from './api/agents.js'

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

const _parsedThreshold = parseInt(process.env['TAPFLOW_RESOURCE_THRESHOLD_PERCENT'] ?? '80', 10)
const RESOURCE_THRESHOLD = Number.isFinite(_parsedThreshold) ? _parsedThreshold : 80

// Messages that only agents are allowed to send. Authenticated browser sockets
// that send any of these are disconnected immediately.
const AGENT_MSG_TYPES = new Set([
  'agent:register', 'agent:resources', 'screenshot:done', 'screenshot:error',
  'ui:tree:response', 'ui:tree:error',
  'app:clear-state-done', 'app:clear-state-error',
  'device:booting', 'device:boot-error', 'device:shutdown-done', 'device:ready',
  'session:chrome', 'session:deviceInfo',
  'app:install-done', 'app:install-error', 'app:launch-done', 'app:launch-error',
  'open-url:done', 'open-url:error', 'keyboard:toggled',
  // stream:register binds a session's stream socket — agent-only, or a browser
  // (view PAT / cookie) could hijack an existing session's video feed.
  'stream:register',
])

export class RelayServer {
  private httpServer: http.Server | https.Server
  private wss: WebSocketServer
  private sessions: SessionManager
  private publicDir: string
  private uploadsDir: string
  private router: Router
  private resourceBuffers = new Map<string, { cpu: number[]; mem: number[] }>()
  private logBuffer: string[] = []
  private recordingsDir: string = ''
  private purgeRecordingsTimer: ReturnType<typeof setInterval> | null = null
  private purgeOldResourcesTimer: ReturnType<typeof setInterval> | null = null
  private purgeBuildsTimer: ReturnType<typeof setInterval> | null = null
  private flushResourcesTimer: ReturnType<typeof setInterval> | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  // Liveness per socket for the heartbeat sweep. WeakMap → no manual cleanup on close (GC handles it).
  private wsAlive = new WeakMap<WebSocket, boolean>()
  private dropHandlers = new Map<string, () => void>()
  // Per-session throttled drop-warn for audio (kept separate so audio drops don't mask video drops in logs).
  private audioDropHandlers = new Map<string, () => void>()
  // Per-session keyframe-aware sender: drops to the next keyframe under backpressure (no H.264 P-frame tearing).
  private droppers = new Map<string, KeyframeAwareSender>()
  // Per-session throttled "request an IDR from the agent" callbacks (drop recovery).
  private idrRequesters = new Map<string, () => void>()
  private wsRoles = new Map<WebSocket, 'agent' | 'browser' | 'stream'>()
  // True when the connection's remote IP is public (not loopback / private LAN) — the agent uses
  // this to downscale harder for bandwidth on external viewers.
  private wsExternal = new Map<WebSocket, boolean>()
  private readonly backpressureBytes: number
  private readonly screenshotTimeoutMs: number
  private readonly corsAllowed: Set<string>
  // One-shot warning when XFF arrives on a loopback socket but TAPFLOW_TRUSTED_PROXIES is unset.
  private warnedProxyMisconfig = false
  private pendingScreenshots = new Map<string, {
    sessionId: string
    resolve: (buf: Buffer, format: 'png' | 'jpeg') => void
    reject: (err: Error) => void
    timer: ReturnType<typeof setTimeout>
  }>()
  private readonly uiTreeTimeoutMs: number
  private pendingUITrees = new Map<string, {
    sessionId: string
    resolve: (elements: UIElement[]) => void
    reject: (err: Error) => void
    timer: ReturnType<typeof setTimeout>
  }>()

  constructor(private readonly options: { port: number; publicDir?: string; uploadsDir?: string; idleTimeoutMs?: number; wsBackpressureBytes?: number; screenshotTimeoutMs?: number; uiTreeTimeoutMs?: number; trustedProxies?: string[]; corsOrigins?: string[]; tls?: { cert: string; key: string } }) {
    this.backpressureBytes = options.wsBackpressureBytes ?? DEFAULT_BACKPRESSURE_BYTES
    this.screenshotTimeoutMs = options.screenshotTimeoutMs ?? 10_000
    // Longer than the screenshot default: the Android agent's device-side dump
    // itself may take up to 10s before it errors out.
    this.uiTreeTimeoutMs = options.uiTreeTimeoutMs ?? 15_000
    this.corsAllowed = new Set(options.corsOrigins ?? [])
    this.sessions = new SessionManager({ idleTimeoutMs: options.idleTimeoutMs })
    this.publicDir = options.publicDir ?? path.join(import.meta.dirname, '../public')
    this.uploadsDir = options.uploadsDir ?? path.join(import.meta.dirname, '../uploads')
    this.router = new Router()
    this.registerRoutes()
    // WebCodecs는 secure context(HTTPS)에서만 동작 — tls가 주어지면 https로 종단하고 WSS가 자동 승계한다.
    const handler = (req: http.IncomingMessage, res: http.ServerResponse) => this.handleRequest(req, res)
    this.httpServer = options.tls
      ? https.createServer({ cert: options.tls.cert, key: options.tls.key }, handler)
      : http.createServer(handler)
    // Disable Nagle on every accepted socket (browsers + agents): small writes (touch, frame tails)
    // must not be held waiting for an ACK. Negligible on localhost, but ~40ms stalls on LAN.
    this.httpServer.on('connection', (socket) => socket.setNoDelay(true))
    this.wss = new WebSocketServer({ server: this.httpServer })
    this.wss.on('connection', (ws, request) => this.handleConnection(ws, request))
    this.wss.on('error', () => { /* propagated from httpServer */ })
  }

  private registerRoutes(): void {
    const u = this.uploadsDir

    // auth
    this.router.get('/api/v1/auth/status', handleAuthStatus)
    this.router.post('/api/v1/auth/init', (req, res) => handleInit(req, res, this.options.trustedProxies ?? []))
    this.router.get('/api/v1/auth/me', handleMe)
    this.router.post('/api/v1/auth/login', (req, res) => handleLogin(req, res, this.options.trustedProxies ?? []))
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
    this.router.post('/api/v1/builds/:id/schedule-deletion', handleScheduleBuildDeletion)
    this.router.delete('/api/v1/builds/:id/schedule-deletion', handleCancelBuildDeletion)
    this.router.post('/api/v1/builds', (req, res) => handleUploadBuild(req, res, u))

    // webhooks (outbound build-status notifications)
    this.router.get('/api/v1/webhooks', handleListWebhooks)
    this.router.post('/api/v1/webhooks', handleCreateWebhook)
    this.router.patch('/api/v1/webhooks/:id', handleUpdateWebhook)
    this.router.delete('/api/v1/webhooks/:id', handleDeleteWebhook)

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
    this.recordingsDir = path.join(u, '../recordings')
    this.router.post('/api/v1/recordings/upload', (req, res) => handleUploadRecording(req, res, this.recordingsDir))
    this.router.get('/api/v1/recordings', (req, res) => handleListRecordings(req, res))
    this.router.get('/api/v1/recordings/:filename', (req, res) => handleDownloadRecording(req, res, this.recordingsDir))

    // logs
    this.router.get('/api/v1/logs', (req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost`)
      const lines = Math.min(Number(url.searchParams.get('lines') ?? 100), 500)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(this.logBuffer.slice(-lines)))
    })

    // relay host — 대시보드가 agent 실행 커맨드에 박을 LAN 주소 (뷰어가 localhost로 접속한 경우의 치환용, #271)
    this.router.get('/api/v1/relay/host', (req, res) => {
      if (!requireAuth(req, res)) return
      const addr = this.httpServer.address()
      const port = typeof addr === 'object' && addr !== null ? addr.port : this.options.port
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ lanHost: pickLanAddress(os.networkInterfaces()), port }))
    })

    // agent resources
    this.router.get('/api/v1/agents', handleListAgents)
    this.router.get('/api/v1/agents/:name/resources', handleGetAgentResources)

    // screenshot
    this.router.get('/api/v1/sessions/:sessionId/screenshot',
      (req, res, params) => this.handleGetScreenshot(req, res, params))
    this.router.get('/api/v1/sessions/:sessionId/ui-tree',
      (req, res, params) => this.handleGetUITree(req, res, params))
  }

  pushLog(msg: string): void {
    const line = `[${new Date().toISOString()}] ${msg}`
    this.logBuffer.push(line)
    if (this.logBuffer.length > 500) this.logBuffer.shift()
    logger.info(msg)
  }

  start(): Promise<void> {
    purgeExpiredRecordings(this.recordingsDir)
    this.purgeRecordingsTimer = setInterval(() => purgeExpiredRecordings(this.recordingsDir), 24 * 60 * 60 * 1000)
    this.purgeRecordingsTimer.unref()

    const purgeOldResources = () => {
      getDb().prepare(`DELETE FROM agent_resources WHERE recorded_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days')`).run()
    }
    purgeOldResources()
    this.purgeOldResourcesTimer = setInterval(purgeOldResources, 24 * 60 * 60 * 1000)
    this.purgeOldResourcesTimer.unref()

    purgeExpiredBuilds(this.recordingsDir)
    this.purgeBuildsTimer = setInterval(() => purgeExpiredBuilds(this.recordingsDir), 24 * 60 * 60 * 1000)
    this.purgeBuildsTimer.unref()

    this.flushResourcesTimer = setInterval(() => this.flushResourceBuffers(), 60_000)
    this.flushResourcesTimer.unref()

    this.heartbeatTimer = setInterval(() => this.runHeartbeat(), HEARTBEAT_MS)
    this.heartbeatTimer.unref()

    return new Promise((resolve, reject) => {
      this.httpServer.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          reject(new Error(`Port ${this.options.port} is already in use. Stop the existing process and try again.`))
        } else {
          reject(err)
        }
      })
      // Bind dual-stack (IPv4 + IPv6). A bare listen(port) binds IPv6-only on some
      // macOS/node setups, so LAN agents connecting over IPv4 (ws://<ipv4>:port) time out.
      this.httpServer.listen({ port: this.options.port, host: '::', ipv6Only: false }, resolve)
    })
  }

  stop(): Promise<void> {
    if (this.purgeRecordingsTimer) { clearInterval(this.purgeRecordingsTimer); this.purgeRecordingsTimer = null }
    if (this.purgeOldResourcesTimer) { clearInterval(this.purgeOldResourcesTimer); this.purgeOldResourcesTimer = null }
    if (this.purgeBuildsTimer) { clearInterval(this.purgeBuildsTimer); this.purgeBuildsTimer = null }
    if (this.flushResourcesTimer) { clearInterval(this.flushResourcesTimer); this.flushResourcesTimer = null }
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null }
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

  // Terminate sockets that missed the previous pong; ping the rest. Covers all roles via wss.clients.
  private runHeartbeat(clients: Iterable<WebSocket> = this.wss.clients): void {
    for (const ws of clients) {
      if (this.wsAlive.get(ws) === false) { ws.terminate(); continue }
      this.wsAlive.set(ws, false)
      if (ws.readyState === WebSocket.OPEN) ws.ping()
    }
  }

  // 갱신된 cert를 재시작 없이 핫스왑한다(https 종단일 때만 의미 있음).
  updateTlsContext(material: { cert: string; key: string }): void {
    if (this.httpServer instanceof https.Server) {
      this.httpServer.setSecureContext({ cert: material.cert, key: material.key })
    }
  }

  // Throttled callback asking the session's agent for an on-demand IDR (fast drop recovery); ignored by agents that don't support it.
  private makeIdrRequester(sessionId: string): () => void {
    let lastAt = 0
    return () => {
      const now = Date.now()
      if (now - lastAt < IDR_REQUEST_THROTTLE_MS) return
      lastAt = now
      const session = this.sessions.get(sessionId)
      if (session?.agentSocket.readyState === WebSocket.OPEN) {
        session.agentSocket.send(JSON.stringify({ type: 'stream:request-idr', sessionId }))
      }
    }
  }

  // Extracted so tests can simulate non-loopback origins (all test traffic is loopback).
  private remoteAddressOf(request: http.IncomingMessage): string {
    return request.socket.remoteAddress ?? ''
  }

  private warnProxyMisconfigOnce(socketAddr: string, forwardedFor: string | undefined): void {
    if (this.warnedProxyMisconfig) return
    if ((this.options.trustedProxies?.length ?? 0) > 0 || !forwardedFor) return
    const a = socketAddr.replace(/^::ffff:/, '')
    if (a === '::1' || a.startsWith('127.')) {
      logger.warn(
        'Received X-Forwarded-For from a loopback connection but TAPFLOW_TRUSTED_PROXIES is unset. ' +
        'If the relay runs behind a same-host reverse proxy, set TAPFLOW_TRUSTED_PROXIES so the real ' +
        'client IP is used — otherwise every proxied client is treated as localhost (unauthenticated).'
      )
      this.warnedProxyMisconfig = true
    }
  }

  private handleConnection(ws: WebSocket, request: http.IncomingMessage): void {
    const socketAddr = this.remoteAddressOf(request)
    const xff = request.headers['x-forwarded-for']
    const forwardedFor = Array.isArray(xff) ? xff[0] : xff
    this.warnProxyMisconfigOnce(socketAddr, forwardedFor)
    const { addr, isLocal } = resolveClientAddress({
      socketAddr,
      forwardedFor,
      trustedProxies: this.options.trustedProxies ?? [],
    })

    const hasCookieAuth = getAuth(request) !== null
    // DB lookup — only when the connection can't be classified without it (remote, no cookie).
    const pat = !isLocal && !hasCookieAuth ? verifyPat(request) : null
    const decision = classifyConnection({
      isLocal,
      hasCookieAuth,
      patScopes: pat ? pat.scope.split(',').map((s) => s.trim()) : null,
    })
    if (decision.action === 'reject') {
      this.pushLog(`WS connection rejected from ${addr} — no credentials (agents: PAT with 'agent' scope via --token)`)
      ws.close(1008, decision.reason)
      return
    }
    this.wsExternal.set(ws, isExternalAddress(addr))
    // Heartbeat liveness: alive until proven otherwise; each pong revives it (see runHeartbeat).
    this.wsAlive.set(ws, true)
    ws.on('pong', () => this.wsAlive.set(ws, true))
    if (decision.role === 'browser') this.wsRoles.set(ws, 'browser')
    // 'first-message' → role is determined by the first message (agent:register / stream:register)

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        // Binary frames arrive on the dedicated stream WS, route to the session's browser
        const session = this.sessions.getByStreamSocket(ws)
        if (session?.browserSocket) {
          const frameBuf = data as Buffer
          // Audio rides the same socket (codec-tagged). Route it through a sender that YIELDS to
          // video — it drops audio unless the socket is near-empty, so audio never inflates
          // bufferedAmount enough to trip the video backpressure path. Must branch before the
          // video dropper, which would (wrongly) treat audio as a droppable P-frame.
          if (hasEnvelope(frameBuf) && readEnvelopeFlags(frameBuf).codec === CODEC_AUDIO) {
            patchRelayedAt(frameBuf, Date.now())
            let onAudioDrop = this.audioDropHandlers.get(session.id)
            if (!onAudioDrop) {
              onAudioDrop = createRateLimitedDropWarn(logger, `${session.id} audio`)
              this.audioDropHandlers.set(session.id, onAudioDrop)
            }
            sendAudioYieldingToVideo(session.browserSocket, frameBuf, onAudioDrop)
            return
          }
          let onDrop = this.dropHandlers.get(session.id)
          if (!onDrop) {
            onDrop = createRateLimitedDropWarn(logger, session.id)
            this.dropHandlers.set(session.id, onDrop)
          }
          let dropper = this.droppers.get(session.id)
          if (!dropper) {
            dropper = createKeyframeAwareSender()
            this.droppers.set(session.id, dropper)
          }
          let requestIdr = this.idrRequesters.get(session.id)
          if (!requestIdr) {
            requestIdr = this.makeIdrRequester(session.id)
            this.idrRequesters.set(session.id, requestIdr)
          }
          // JPEG and H.264 IDRs are resync points; only P-frames must wait for a keyframe after a drop.
          let isKeyframe = true
          if (hasEnvelope(frameBuf)) {
            patchRelayedAt(frameBuf, Date.now())
            const flags = readEnvelopeFlags(frameBuf)
            isKeyframe = flags.codec === CODEC_JPEG || flags.keyframe
          }
          dropper.send(session.browserSocket, frameBuf, this.backpressureBytes, isKeyframe, onDrop, requestIdr)
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
      this.wsRoles.delete(ws)
      this.wsExternal.delete(ws)
      // Agent main socket disconnected → remove its sessions, reject in-flight screenshots, drop resources
      if (this.evictAgentSocket(ws)) return

      // Stream socket disconnected → clear the streamSocket reference
      const streamSession = this.sessions.getByStreamSocket(ws)
      if (streamSession) {
        this.sessions.clearStreamSocket(streamSession.id)
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
    // Assign role on the first message for local no-auth connections (agents / streams)
    if (!this.wsRoles.has(ws)) {
      if (msg.type === 'agent:register') {
        this.wsRoles.set(ws, 'agent')
      } else if (msg.type === 'stream:register') {
        this.wsRoles.set(ws, 'stream')
      } else {
        // Local connection whose first message is not an agent/stream handshake —
        // treat it as a browser (e.g. dashboard opened on the same machine).
        this.wsRoles.set(ws, 'browser')
      }
    }

    // Browser sockets must not spoof agent control messages
    if (this.wsRoles.get(ws) === 'browser' && AGENT_MSG_TYPES.has(msg.type)) {
      ws.close(1008, 'Forbidden')
      return
    }

    switch (msg.type) {
      // ── Agent → Relay ─────────────────────────────────────────────────────
      case 'agent:resources':    this.handleAgentResources(ws, msg); break
      case 'agent:register':     this.handleAgentRegister(ws, msg); break
      case 'screenshot:done':    this.handleScreenshotDone(msg); break
      case 'screenshot:error':   this.handleScreenshotError(msg); break
      case 'ui:tree:response':   this.handleUITreeResponse(msg); break
      case 'ui:tree:error':      this.handleUITreeError(msg); break
      case 'agents:list': {
        ws.send(JSON.stringify({ type: 'agents:listed', sessions: this.sessions.list() }))
        break
      }

      // ── Session / Stream lifecycle ─────────────────────────────────────────
      case 'session:start':    this.handleSessionStart(ws, msg); break
      case 'session:end': {
        if (msg.sessionId) {
          this.sessions.remove(msg.sessionId)
          this.dropHandlers.delete(msg.sessionId)
          this.audioDropHandlers.delete(msg.sessionId)
          this.droppers.delete(msg.sessionId)
          this.idrRequesters.delete(msg.sessionId)
        }
        break
      }
      case 'session:leave': {
        if (msg.sessionId) {
          this.sessions.clearBrowser(msg.sessionId)
          this.dropHandlers.delete(msg.sessionId)
          this.audioDropHandlers.delete(msg.sessionId)
          this.droppers.delete(msg.sessionId)
          this.idrRequesters.delete(msg.sessionId)
        }
        break
      }
      case 'stream:register': {
        const session = this.sessions.get(msg.sessionId!)
        if (session) {
          this.sessions.setStreamSocket(session.id, ws)
          ws.send(JSON.stringify({ type: 'stream:registered' }))
        }
        break
      }

      // ── Agent → Browser ────────────────────────────────────────────────────
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
      case 'device:booting': {
        // clear cached device data so reconnecting browser doesn't get stale chrome
        const session = this.sessions.get(msg.sessionId!)
        if (!session) break
        this.sessions.clearDeviceCache(session.id)
        if (session.browserSocket?.readyState === WebSocket.OPEN) {
          session.browserSocket.send(JSON.stringify(msg))
        }
        break
      }
      case 'device:boot-error': {
        const session = this.sessions.get(msg.sessionId!)
        if (session?.browserSocket?.readyState === WebSocket.OPEN) {
          session.browserSocket.send(JSON.stringify(msg))
        }
        break
      }
      case 'device:shutdown-done': {
        const session = this.sessions.get(msg.sessionId!)
        if (!session) break
        this.sessions.updateDeviceStatus(session.id, 'shutdown')
        if (session.browserSocket?.readyState === WebSocket.OPEN) {
          session.browserSocket.send(JSON.stringify(msg))
        }
        break
      }
      case 'device:ready': {
        const session = this.sessions.get(msg.sessionId!)
        if (!session) break
        this.sessions.updateDeviceStatus(session.id, 'booted')
        if (session.browserSocket?.readyState === WebSocket.OPEN) {
          session.browserSocket.send(JSON.stringify(msg))
        }
        break
      }
      case 'app:install-done':
      case 'app:install-error':
      case 'app:launch-done':
      case 'app:launch-error':
      case 'open-url:done':
      case 'open-url:error':
      case 'app:clear-state-done':
      case 'app:clear-state-error':
      case 'keyboard:toggled': {
        const session = this.sessions.get(msg.sessionId!)
        if (session?.browserSocket?.readyState === WebSocket.OPEN) {
          session.browserSocket.send(JSON.stringify(msg))
        }
        break
      }

      // ── Browser → Agent ────────────────────────────────────────────────────
      case 'device:boot':
      case 'device:shutdown': {
        const session = this.sessions.get(msg.sessionId!)
        if (session?.agentSocket.readyState === WebSocket.OPEN) {
          // Tag the boot with whether the viewer is external (public IP) so the agent can pick the
          // downscale tier. The browser already reports secureContext in the payload.
          if (msg.type === 'device:boot' && msg.payload && typeof msg.payload === 'object') {
            (msg.payload as Record<string, unknown>).external = this.wsExternal.get(ws) ?? false
          }
          session.agentSocket.send(JSON.stringify(msg))
        }
        break
      }
      case 'app:install': this.handleBrowserAppInstall(ws, msg); break
      case 'app:launch':  this.handleBrowserAppLaunch(ws, msg); break
      case 'open-url': {
        const session = this.sessions.get(msg.sessionId!)
        if (session?.agentSocket.readyState === WebSocket.OPEN) {
          session.agentSocket.send(JSON.stringify(msg))
        } else {
          ws.send(JSON.stringify({ type: 'open-url:error', sessionId: msg.sessionId, message: 'agent offline' }))
        }
        break
      }
      case 'app:clear-state': {
        const session = this.sessions.get(msg.sessionId!)
        if (session?.agentSocket.readyState === WebSocket.OPEN) {
          session.agentSocket.send(JSON.stringify(msg))
        } else {
          ws.send(JSON.stringify({ type: 'app:clear-state-error', sessionId: msg.sessionId, message: 'agent offline' }))
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
        const session = this.sessions.get(msg.sessionId!)
        if (session?.agentSocket.readyState === WebSocket.OPEN) {
          session.agentSocket.send(JSON.stringify(msg))
        }
        break
      }
    }
  }

  private handleAgentResources(ws: WebSocket, msg: RelayMessage): void {
    if (!msg.resources) return
    this.sessions.setResources(ws, msg.resources)
    const agentName = this.sessions.getAllByAgentSocket(ws)[0]?.agentName
    if (agentName) {
      const buf = this.resourceBuffers.get(agentName) ?? { cpu: [], mem: [] }
      buf.cpu.push(msg.resources.cpuPercent)
      buf.mem.push((msg.resources.memUsedMB / msg.resources.memTotalMB) * 100)
      this.resourceBuffers.set(agentName, buf)
    }
  }

  // Removes an agent socket's sessions + resources and rejects its in-flight
  // screenshot / ui-tree requests. Shared by socket close and re-register
  // eviction. Returns true if `ws` had agent sessions.
  private evictAgentSocket(ws: WebSocket): boolean {
    const agentSessions = this.sessions.getAllByAgentSocket(ws)
    if (agentSessions.length === 0) return false
    const agentSessionIds = new Set(agentSessions.map((s) => s.id))
    for (const [reqId, pending] of this.pendingScreenshots.entries()) {
      if (agentSessionIds.has(pending.sessionId)) {
        clearTimeout(pending.timer)
        this.pendingScreenshots.delete(reqId)
        pending.reject(new Error('Agent disconnected'))
      }
    }
    for (const [reqId, pending] of this.pendingUITrees.entries()) {
      if (agentSessionIds.has(pending.sessionId)) {
        clearTimeout(pending.timer)
        this.pendingUITrees.delete(reqId)
        pending.reject(new Error('Agent disconnected'))
      }
    }
    for (const s of agentSessions) this.sessions.remove(s.id)
    this.sessions.removeResources(ws)
    return true
  }

  private handleAgentRegister(ws: WebSocket, msg: RelayMessage): void {
    // Re-register from the same Mac (machine id + platform): the old socket's close may not have
    // fired yet after an unclean drop (Wi-Fi loss, sleep) — its TCP teardown lags — which would
    // leave a duplicate, eventually-"Stale" card. Evict the stale agent's sessions and terminate
    // its socket before creating the new ones. Identity is agentId (unique per Mac) when present,
    // else agentName. (Heartbeat backstop for never-reconnecting agents: #313.)
    const identity = msg.agentId ?? msg.agentName
    if (identity) {
      for (const old of this.sessions.getAgentSocketsByIdentity(identity, msg.platform)) {
        if (old === ws) continue
        // Evict before terminate: the old socket's close fires async, by which point its sessions are
        // gone and its in-flight screenshots would be undiscoverable — reject them here instead.
        this.evictAgentSocket(old)
        old.terminate()
      }
    }
    const sessionIds = this.sessions.create(ws, msg.devices ?? [], msg.agentName, msg.platform, msg.agentId)
    const registeredSessions = (msg.devices ?? []).map((d, i) => ({
      deviceId: d.id,
      sessionId: sessionIds[i],
    }))
    ws.send(JSON.stringify({ type: 'agent:registered', registeredSessions }))
  }

  private handleSessionStart(ws: WebSocket, msg: RelayMessage): void {
    const session = this.sessions.get(msg.sessionId!)
    if (!session) {
      ws.send(JSON.stringify({ type: 'error', message: 'Session not found' }))
      return
    }
    const resources = this.sessions.getResources(session.agentSocket)
    if (resources) {
      const memPercent = (resources.memUsedMB / resources.memTotalMB) * 100
      if (resources.cpuPercent > RESOURCE_THRESHOLD || memPercent > RESOURCE_THRESHOLD) {
        ws.send(JSON.stringify({ type: 'error', message: 'Agent resources exhausted' }))
        return
      }
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
      // (Re)joining a live stream: ask the agent for an IDR so this viewer gets a decodable
      // keyframe immediately, instead of waiting for the next periodic one — and so it isn't
      // left blank when the encoder is static-skipping an unchanged screen. Agents that don't
      // support on-demand IDR ignore the message.
      if (session.agentSocket.readyState === WebSocket.OPEN) {
        session.agentSocket.send(JSON.stringify({ type: 'stream:request-idr', sessionId: session.id }))
      }
    }
  }

  private handleBrowserAppInstall(ws: WebSocket, msg: RelayMessage): void {
    // Relay looks up file_path from DB and enriches; includes sessionId for response routing
    const session = this.sessions.get(msg.sessionId!)
    if (!session) {
      ws.send(JSON.stringify({ type: 'error', message: 'Session not found' }))
      return
    }
    const build = getDb()
      .prepare('SELECT file_path, bundle_id FROM builds WHERE id = ?')
      .get(msg.buildId!) as { file_path: string; bundle_id: string | null } | undefined
    if (!build) {
      ws.send(JSON.stringify({ type: 'app:install-error', message: 'Build not found' }))
      return
    }
    if (session.agentSocket.readyState === WebSocket.OPEN) {
      session.agentSocket.send(JSON.stringify({
        type: 'app:install',
        sessionId: msg.sessionId,
        payload: { filePath: build.file_path, bundleId: build.bundle_id },
      }))
    }
  }

  private handleBrowserAppLaunch(ws: WebSocket, msg: RelayMessage): void {
    // Relay looks up bundle_id from DB; includes sessionId for response routing
    const session = this.sessions.get(msg.sessionId!)
    if (!session) {
      ws.send(JSON.stringify({ type: 'error', message: 'Session not found' }))
      return
    }
    const build = getDb()
      .prepare('SELECT bundle_id FROM builds WHERE id = ?')
      .get(msg.buildId!) as { bundle_id: string | null } | undefined
    if (!build?.bundle_id) {
      ws.send(JSON.stringify({ type: 'app:launch-error', message: 'Bundle ID not available for this build' }))
      return
    }
    if (session.agentSocket.readyState === WebSocket.OPEN) {
      session.agentSocket.send(JSON.stringify({
        type: 'app:launch',
        sessionId: msg.sessionId,
        payload: { bundleId: build.bundle_id },
      }))
    }
  }

  private async handleGetScreenshot(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    if (!requireViewAuth(req, res)) return

    const { sessionId } = params
    const session = this.sessions.get(sessionId)
    if (!session) {
      json(res, 404, { error: 'Session not found' })
      return
    }
    if (session.deviceStatus === 'shutdown') {
      json(res, 409, { error: 'Device is not booted' })
      return
    }
    if (session.agentSocket.readyState !== WebSocket.OPEN) {
      json(res, 502, { error: 'Agent offline' })
      return
    }

    const urlObj = new URL(req.url ?? '/', 'http://x')
    const format: 'png' | 'jpeg' = urlObj.searchParams.get('format') === 'jpeg' ? 'jpeg' : 'png'
    const requestId = randomUUID()

    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingScreenshots.delete(requestId)
        json(res, 504, { error: 'Screenshot timed out' })
        resolve()
      }, this.screenshotTimeoutMs)

      this.pendingScreenshots.set(requestId, {
        sessionId,
        resolve: (buf, fmt) => {
          clearTimeout(timer)
          this.pendingScreenshots.delete(requestId)
          const contentType = fmt === 'jpeg' ? 'image/jpeg' : 'image/png'
          res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': String(buf.length) })
          res.end(buf)
          resolve()
        },
        reject: (err) => {
          clearTimeout(timer)
          this.pendingScreenshots.delete(requestId)
          json(res, 502, { error: err.message })
          resolve()
        },
        timer,
      })

      session.agentSocket.send(JSON.stringify({ type: 'screenshot:request', sessionId, requestId, format }))
    })
  }

  private async handleGetUITree(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    if (!requireViewAuth(req, res)) return

    const { sessionId } = params
    const session = this.sessions.get(sessionId)
    if (!session) {
      json(res, 404, { error: 'Session not found' })
      return
    }
    if (session.deviceStatus === 'shutdown') {
      json(res, 409, { error: 'Device is not booted' })
      return
    }
    if (session.agentSocket.readyState !== WebSocket.OPEN) {
      json(res, 502, { error: 'Agent offline' })
      return
    }

    const requestId = randomUUID()

    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingUITrees.delete(requestId)
        json(res, 504, { error: 'UI tree query timed out — the agent may not support ui:tree:request (update the agent), or the screen never went idle' })
        resolve()
      }, this.uiTreeTimeoutMs)

      this.pendingUITrees.set(requestId, {
        sessionId,
        resolve: (elements) => {
          clearTimeout(timer)
          this.pendingUITrees.delete(requestId)
          json(res, 200, { elements })
          resolve()
        },
        reject: (err) => {
          clearTimeout(timer)
          this.pendingUITrees.delete(requestId)
          json(res, 502, { error: err.message })
          resolve()
        },
        timer,
      })

      session.agentSocket.send(JSON.stringify({ type: 'ui:tree:request', sessionId, requestId }))
    })
  }

  private handleUITreeResponse(msg: RelayMessage): void {
    if (!msg.requestId) return
    const pending = this.pendingUITrees.get(msg.requestId)
    if (!pending) return
    pending.resolve(msg.elements ?? [])
  }

  private handleUITreeError(msg: RelayMessage): void {
    if (!msg.requestId) return
    const pending = this.pendingUITrees.get(msg.requestId)
    if (!pending) return
    pending.reject(new Error(msg.message ?? 'UI tree query failed'))
  }

  private handleScreenshotDone(msg: RelayMessage): void {
    if (!msg.requestId) return
    const pending = this.pendingScreenshots.get(msg.requestId)
    if (!pending) return
    const buf = Buffer.from(msg.data ?? '', 'base64')
    pending.resolve(buf, msg.format ?? 'png')
  }

  private handleScreenshotError(msg: RelayMessage): void {
    if (!msg.requestId) return
    const pending = this.pendingScreenshots.get(msg.requestId)
    if (!pending) return
    pending.reject(new Error(msg.message ?? 'Screenshot failed'))
  }

  private flushResourceBuffers(): void {
    if (this.resourceBuffers.size === 0) return
    const db = getDb()
    const insert = db.prepare('INSERT INTO agent_resources (agent_name, cpu_percent, mem_percent) VALUES (?, ?, ?)')
    db.transaction(() => {
      for (const [agentName, buf] of this.resourceBuffers.entries()) {
        if (buf.cpu.length === 0) continue
        const avgCpu = buf.cpu.reduce((a, b) => a + b, 0) / buf.cpu.length
        const avgMem = buf.mem.reduce((a, b) => a + b, 0) / buf.mem.length
        insert.run(agentName, avgCpu, avgMem)
      }
    })()
    this.resourceBuffers.clear()
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const corsHeaders = resolveCorsHeaders(req.headers.origin, this.corsAllowed)
    if (corsHeaders) {
      for (const [k, v] of Object.entries(corsHeaders)) res.setHeader(k, v)
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    // uploads — serve uploaded files
    const url = req.url ?? '/'

    if (url.startsWith('/api/')) {
      res.setHeader('Cache-Control', 'no-store')
      if (isCsrfBlocked(req.method, req.headers, this.corsAllowed)) {
        json(res, 403, { error: 'Cross-origin state-changing request blocked (CSRF protection)' })
        return
      }
    }
    if (url.startsWith('/uploads/')) {
      if (!requireViewAuth(req, res)) return
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
    const resolved = path.resolve(filePath)
    if (!resolved.startsWith(path.resolve(this.uploadsDir) + path.sep)) {
      res.writeHead(403); res.end('Forbidden'); return
    }
    if (!fs.existsSync(filePath)) {
      res.writeHead(404); res.end('Not found'); return
    }
    const contentType = MIME_TYPES[path.extname(filePath)] ?? 'application/octet-stream'
    res.writeHead(200, { 'Content-Type': contentType })
    fs.createReadStream(filePath)
      .on('error', () => { res.destroy() })
      .pipe(res)
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
    const headers: Record<string, string> = { 'Content-Type': contentType }

    // Content-hashed build assets never change → cache them forever.
    if (urlPath.startsWith('/assets/')) {
      headers['Cache-Control'] = 'public, max-age=31536000, immutable'
    }

    // Serve the build-time .br sibling when accepted (precompressed → no runtime CPU on the stream path).
    const acceptHeader = req.headers['accept-encoding']
    const accept = Array.isArray(acceptHeader) ? acceptHeader.join(',') : acceptHeader ?? ''
    const brAccepted = accept.split(',').some((token) => {
      const [name, ...params] = token.trim().split(';')
      const coding = name.trim().toLowerCase()
      if (coding !== 'br' && coding !== '*') return false
      const qParam = params.map((p) => p.trim()).find((p) => p.startsWith('q='))
      const q = qParam ? Number(qParam.slice(2)) : 1
      return !Number.isNaN(q) && q > 0
    })
    let servePath = filePath
    const hasBr = fs.existsSync(filePath + '.br')
    // Vary whenever a compressed variant exists, even if raw is served, so caches don't cross-serve.
    if (hasBr) headers['Vary'] = 'Accept-Encoding'
    if (brAccepted && hasBr) {
      servePath = filePath + '.br'
      headers['Content-Encoding'] = 'br'
    }

    res.writeHead(200, headers)
    fs.createReadStream(servePath)
      .on('error', () => { res.destroy() })
      .pipe(res)
  }
}
