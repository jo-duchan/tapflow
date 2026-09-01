import http from 'http'
import https from 'https'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { randomUUID } from 'crypto'
import { WebSocketServer, WebSocket } from 'ws'
import { SessionManager } from './SessionManager.js'
import type { Session } from './SessionManager.js'
import type { DeviceDetails, UIElement } from './types.js'
import type { ChromePayload, InputErrorReason, RelayOutbound } from '@tapflowio/protocol'
import { directionOf, parseInbound } from '@tapflowio/protocol/validate'
import type { ParsedInbound, ParseFailure, ParseResult } from '@tapflowio/protocol/validate'
import { Router, json } from './router.js'
import { requireViewAuth, requireAuth, getAuth, verifyPat } from './middleware/auth.js'
import { classifyConnection } from './lib/connectionAuth.js'
import { resolveClientAddress } from './lib/clientAddress.js'
import { resolveCorsHeaders } from './lib/cors.js'
import { isCsrfBlocked } from './lib/csrf.js'
import { pickLanAddress } from './lib/lanAddress.js'
import { createTrailingRequester, systemTimerScheduler, type TrailingRequester } from './lib/trailingRequester.js'
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
/** Exported for the re-join test, which pins both edges of this window rather than hardcoding 500 —
 *  a test carrying its own copy of the number passes when the constant moves, which is the drift the
 *  wire-contract work keeps finding. Not re-exported from the package index. */
export const IDR_REQUEST_THROTTLE_MS = 500
/** The same window for `network:request-state`, and a **separate constant on purpose**: the two share
 *  a number today and not a policy. IDR drops inside the window; this one coalesces onto its trailing
 *  edge (see `networkStateRequester`). Sharing the constant would mean tuning one tunes the other. */
export const NETWORK_STATE_REQUEST_THROTTLE_MS = 500

// Ping every socket each interval; a missed pong window (~2× this) terminates the dead socket.
const HEARTBEAT_MS = 30_000
// How long a session outlives its agent's socket, waiting for that agent to come back (#426).
// An agent registers ~1s after its process starts, so this covers an automatic respawn several
// times over and about half of a hand-typed restart. What bounds it is the other direction: the
// device stays claimed by a session nobody can use until the window closes.
const DEFAULT_AGENT_GRACE_MS = 15_000

/**
 * What a buffer actually is, from its magic bytes, or `null` for anything else.
 *
 * Duplicated in `mcp-server` rather than shared: `protocol`'s entry must erase under `import type`
 * so it cannot hold a runtime value, and `mcp-server` does not depend on `agent-core`. The same
 * situation as `correlatesWith` across the two clients, and the same answer — each copy has tests.
 * These two signatures have not changed since 1992 and 1996, so there is little for them to drift to.
 */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function sniffImageFormat(buf: Buffer): 'png' | 'jpeg' | null {
  // All eight signature bytes — see the note on the `mcp-server` copy for why the trailing four earn
  // their place. Here a false `png` would report a mismatch that is not one.
  if (buf.length >= PNG_SIGNATURE.length && PNG_SIGNATURE.every((b, i) => buf[i] === b)) return 'png'
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xd8) return 'jpeg'
  return null
}
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
// Terminal input messages the MCP client awaits an ack for — if the agent is offline
// the relay replies input:error so the client fails truthfully (non-terminal moves/starts
// expect no ack and are dropped silently).
/** Why a session is not this socket's to command. One reason, two prose strings — the treatment `#492`
 *  settled for `agent offline` / `Session not found`: telling a caller the session is in use when it is
 *  idle steers it off a device it could have had. Shared so the two never drift. */
function ownershipRefusal(session: Session): string {
  return session.browserSocket ? 'session held by another client' : 'session not joined'
}

/**
 * The owner key a connection speaks for, from the authenticated user and the client id it claimed.
 *
 * **Both halves, and a pure function so both can be tested.** The user id is what keeps a leaked client id
 * useless to anyone else — without it this would be the relay's first ownership claim a caller can forge,
 * where socket identity could not be. It comes from the cookie *or* the PAT: reading only the cookie would
 * have made every agent and every non-browser client `anon:`, which is the population most likely to have
 * its handshake URL end up in a reverse proxy's access log. The mint is what removes the fallback branch: a connection that
 * claims nothing gets an identity of its own, which is per-socket, which is the behaviour ownership had
 * before it moved off the socket.
 *
 * Exported for the test that holds the pairing. Inline in the handler it was unreachable without standing
 * up an authenticated handshake, and a mutation dropping the user id survived the whole suite.
 */
export function ownerKeyFor(
  userId: number | string | undefined,
  claimed: string | null,
): { key: string; user: string; minted: boolean } {
  const user = String(userId ?? 'anon')
  // **Mintedness is a separate field, not a marker inside the key.** A first version prefixed the mint
  // with `minted-` and had `mayShutDown` recover the fact with `includes(':minted-')` — which the client
  // controls, because `claimed` comes straight off the handshake query and is never validated. Connecting
  // as `?client=minted-1` produced `anon:minted-1` and silently disabled the shutdown gate for that
  // holder; `?client=x:minted-y` did it while keeping a real user id, so a *different* user could then
  // power the device off. Encoding a security-relevant fact in a caller-supplied string is the forgery
  // this whole key was introduced to avoid, reintroduced one layer down.
  return { key: `${user}:${claimed || randomUUID()}`, user, minted: !claimed }
}

/** One line per rejecting socket per second, at most. See `RelayServer.logInboundRejection`. */
const REJECT_LOG_INTERVAL_MS = 1_000

/** What the door refused, as one line. The throttling that decides whether to write it is the
 *  caller's, because it is per socket and this function has no state. */
function describeRejection(failure: ParseFailure, suppressed: number): string | null {
  if (failure.reason === 'not-an-object') return null
  const also = suppressed > 0 ? ` (+${suppressed} more from this socket in the last second)` : ''
  if (failure.reason === 'unknown-type') {
    return `[tapflow] inbound frame of unknown type ${failure.type} — dropped${also}`
  }
  const outcome = failure.reason === 'bad-payload' ? 'refused, and the sender told' : 'dropped'
  return `[tapflow] inbound ${failure.type} does not match the contract — ${outcome}${also}:\n${failure.detail}`
}
/** One member of the parse product, by literal. `route` narrows to these; a handler that takes one
 *  gets exactly what the door proved for that type and nothing else. */
type Inbound<T extends ParsedInbound['type']> = Extract<ParsedInbound, { type: T }>

/** The five inputs an ack answers, and the six it does not. Written as unions of `Inbound<…>` rather
 *  than as `& { requestId: string }` intersections: the correlator is now declared on the members
 *  themselves, so an intersection would re-state a fact the union already carries — and would keep
 *  compiling if one of them lost the field. */
type Acked = Inbound<'input:touch:end' | 'input:pinch:end' | 'input:key' | 'input:button' | 'input:type'>
type Unacked = Inbound<
  'input:touch:start' | 'input:touch:move' | 'input:pinch:start' | 'input:pinch:move'
  | 'input:rotate' | 'input:keyboard:toggle'
>

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
  /**
   * When each socket last answered a ping. WeakMap → no manual cleanup on close (GC handles it).
   *
   * **A timestamp, not the swept boolean it replaced.** That flag was set `false` for *every* socket at the
   * start of each sweep and back to `true` only when the pong returned, so a perfectly healthy socket read
   * as dead for the whole round trip — a normal state on a 30s cycle rather than an edge case. And the
   * window is longest for exactly the socket that matters: video goes out on `browserSocket`, and the ping
   * is written behind whatever is already queued there, so an external viewer's pong can take a second or
   * two.
   *
   * That was invisible while the flag only decided termination, because a sweep that finds `false` has by
   * definition already waited a full interval. Reading it to answer *"is this holder alive right now"* is
   * what exposes it: occupancy would hand a live tester's session away, and `busy` would flash a device as
   * free every 30 seconds — the dashboard polls every 5s and `disabled={isBusy}`, so the UI would open the
   * button rather than a race being needed.
   */
  private lastPongAt = new WeakMap<WebSocket, number>()
  /**
   * Who each socket speaks for — `<userId>:<clientId>`, the key a session's ownership is compared against.
   *
   * **Two parts, and both are load-bearing.** The client id is supplied by the caller (`?client=`), so on
   * its own it is the relay's first *forgeable* ownership claim: today's ownership is socket identity,
   * which nothing can spoof. Binding it to the authenticated user — which `getAuth` already resolves at
   * the handshake — keeps a leaked id useless to anyone else's account.
   *
   * **A connection that supplies no client id is given one**, rather than falling back to socket identity.
   * There is deliberately no fallback branch: one model, and a client that does not identify itself gets an
   * identity that happens to be per-socket, which is exactly today's behaviour.
   */
  private ownerKey = new WeakMap<WebSocket, { key: string; user: string; minted: boolean }>()
  private dropHandlers = new Map<string, () => void>()
  // Per-session throttled drop-warn for audio (kept separate so audio drops don't mask video drops in logs).
  private audioDropHandlers = new Map<string, () => void>()
  // Per-session keyframe-aware sender: drops to the next keyframe under backpressure (no H.264 P-frame tearing).
  private droppers = new Map<string, KeyframeAwareSender>()
  // Per-session throttled "request an IDR from the agent" callbacks (drop recovery).
  private idrRequesters = new Map<string, () => void>()
  /** Unlike `idrRequesters` these hold a timer, which is why the value is not a bare closure — see
   *  `forgetSessionState`. */
  private networkStateRequesters = new Map<string, TrailingRequester>()
  private wsRoles = new Map<WebSocket, 'agent' | 'browser' | 'stream'>()
  /** Per-socket throttle state for `logInboundRejection`. A `WeakMap` so a closed socket's entry goes
   *  with the socket — there is no cleanup to forget, unlike the maps keyed by session id nearby. */
  private readonly rejectionLog = new WeakMap<WebSocket, { at: number; suppressed: number }>()
  // Agent sockets whose sessions are being held open, and the timer that gives up on each.
  // Keyed by the dead socket, never by session id: a rebind moves sessions off that socket, so an
  // expiry that fires late has nothing left to evict. That is the invariant — releasing the hold
  // on the way back is hygiene on top of it, not a second thing holding the property up. The late
  // expiry is not a complete no-op either: it still drops the socket's resource entry.
  private agentHolds = new Map<WebSocket, ReturnType<typeof setTimeout>>()
  // Set by `stop()`. Its own `terminate()` loop fires a close for every socket, and a hold armed
  // from there would outlive the server it belongs to — the exact hazard the clearing above it is
  // for, arriving a few lines later.
  private stopping = false
  // True when the connection's remote IP is public (not loopback / private LAN) — the agent uses
  // this to downscale harder for bandwidth on external viewers.
  private wsExternal = new Map<WebSocket, boolean>()
  private readonly backpressureBytes: number
  private readonly screenshotTimeoutMs: number
  private readonly agentGraceMs: number
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

  constructor(private readonly options: { port: number; publicDir?: string; uploadsDir?: string; idleTimeoutMs?: number; wsBackpressureBytes?: number; screenshotTimeoutMs?: number; uiTreeTimeoutMs?: number; trustedProxies?: string[]; corsOrigins?: string[]; tls?: { cert: string; key: string }; agentGraceMs?: number }) {
    this.backpressureBytes = options.wsBackpressureBytes ?? DEFAULT_BACKPRESSURE_BYTES
    this.screenshotTimeoutMs = options.screenshotTimeoutMs ?? 10_000
    // Longer than the screenshot default: the Android agent's device-side dump
    // itself may take up to 10s before it errors out.
    this.uiTreeTimeoutMs = options.uiTreeTimeoutMs ?? 15_000
    this.corsAllowed = new Set(options.corsOrigins ?? [])
    // Constructor option first, then env. It cannot be env-only: `IDLE_TIMEOUT_MS` is read at module
    // load, which is why no test can set it, and the tests that need a different window here run in
    // the same process as the default.
    // Validated, not just parsed, and blank treated as unset rather than as a number. Three ways
    // this silently switches the feature off if read naively: `parseInt('15s')` is 15 — and the
    // documented default reads "15000 (15 s)", so that is the typo the docs invite; a non-numeric
    // value is NaN, which `setTimeout` rounds to ~1ms; and `Number('')` is 0, not NaN, so an empty
    // `.env` line would pass a `>= 0` check and give a zero-length window.
    const graceRaw = process.env['TAPFLOW_AGENT_GRACE_MS']?.trim()
    const graceEnv = graceRaw ? Number(graceRaw) : NaN
    const graceUsable = Number.isFinite(graceEnv) && graceEnv >= 0
    this.agentGraceMs = options.agentGraceMs ?? (graceUsable ? graceEnv : DEFAULT_AGENT_GRACE_MS)
    // Say so rather than only documenting it. Both times this parsing was wrong the symptom was
    // the same — the hold switched off and nothing mentioned it — and somebody who types `15s` is
    // reading their terminal, not the configuration table.
    if (options.agentGraceMs === undefined && graceRaw && !graceUsable) {
      logger.warn(`TAPFLOW_AGENT_GRACE_MS="${graceRaw}" is not a usable number of milliseconds — using ${DEFAULT_AGENT_GRACE_MS}`)
    }
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
    // `unref()` would not do: the test runner's process outlives the server, so an un-cleared hold
    // still fires — against a server that has already stopped.
    this.stopping = true
    for (const timer of this.agentHolds.values()) clearTimeout(timer)
    this.agentHolds.clear()
    // Same argument one line up. **Not** because the send would land — `sendTo` drops a socket that is
    // not OPEN, which is why `fire` carries no check of its own — but because `unref()` only excuses a
    // timer from keeping the process alive, and the test runner's process outlives the server anyway.
    // An armed edge therefore still runs, holding a closure over the session map of a relay that has
    // already stopped.
    for (const requester of this.networkStateRequesters.values()) requester.dispose()
    this.networkStateRequesters.clear()
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
      if (!this.isAlive(ws)) { ws.terminate(); continue }
      if (ws.readyState === WebSocket.OPEN) ws.ping()
    }
  }

  /**
   * Has this socket answered recently enough to be treated as present?
   *
   * `1.5` intervals rather than one: a pong that arrives *during* a sweep must not be read as late, and a
   * socket pinged at the end of one interval has until halfway through the next. The cost is that a
   * genuinely dead socket is recognised in up to 45s instead of 30 — **and 45 seconds with no false
   * negative beats 30 with one every cycle**, because a false negative here does not merely delay: it
   * hands a live tester's session to whoever asked next.
   */
  private isAlive(ws: WebSocket): boolean {
    const at = this.lastPongAt.get(ws)
    // **No entry means just connected, not dead.** `handleConnection` seeds one, but a socket is in
    // `wss.clients` from the upgrade, so there is a tick where a sweep could see it first — and the flag
    // this replaced was explicitly safe there ("alive until proven otherwise"). Reading absence as dead
    // would terminate a connection that had done nothing wrong, and occupancy would read the same absence
    // as a free session.
    if (at === undefined) return true
    return Date.now() - at <= HEARTBEAT_MS * 1.5
  }

  // 갱신된 cert를 재시작 없이 핫스왑한다(https 종단일 때만 의미 있음).
  updateTlsContext(material: { cert: string; key: string }): void {
    if (this.httpServer instanceof https.Server) {
      this.httpServer.setSecureContext({ cert: material.cert, key: material.key })
    }
  }

  /**
   * Drop every per-session stream record keyed by this id.
   *
   * **Four maps that have to move together, called from four places that did not.** They were deleted
   * inline in `session:end` and `session:leave` and nowhere else, so a session ending any other way —
   * the agent going away, the idle timer, a device disappearing from a re-register — left all four
   * behind for the life of the process.
   *
   * Pre-existing, and this slice is what makes it worth fixing here rather than filing: `idrRequesters`
   * used to be populated only by the binary drop path, i.e. only under backpressure, and a re-join now
   * creates an entry for any streaming session (#515). The leak went from rare to ordinary.
   *
   * **Now five maps, and the fifth is not dropped the same way.** `networkStateRequesters` holds a
   * *coalescing* requester, so its closure owns a pending `setTimeout` — and deleting a map entry does
   * not cancel a timer. Leaving it armed is not a leak but a double send: `session:leave` followed by a
   * re-join inside the window fires the orphaned trailing edge *and* the new requester's leading edge,
   * which is the second budget for one session that this map exists to prevent. Hence `dispose()`
   * rather than `delete` alone. It was named `forgetSessionStreamState` while all four were stream
   * records; the network requester is not one, so the name lost the word rather than the entry
   * lost the function.
   */
  private forgetSessionState(sessionId: string): void {
    this.dropHandlers.delete(sessionId)
    this.audioDropHandlers.delete(sessionId)
    this.droppers.delete(sessionId)
    this.idrRequesters.delete(sessionId)
    this.networkStateRequesters.get(sessionId)?.dispose()
    this.networkStateRequesters.delete(sessionId)
  }

  /**
   * Throttled callback asking the session's agent for an on-demand IDR (fast drop recovery); ignored by
   * agents that don't support it.
   *
   * **One per session, and the construction is folded in here on purpose.** The throttle is `lastAt` in
   * the closure, so a second requester for the same session is a second budget — which is what the
   * `idrRequesters` map exists to prevent, and it prevented it only as long as every caller remembered
   * to look the session up first. There are two callers now (the drop path and the re-join in
   * `handleSessionStart`), and a separate `makeIdrRequester` was a factory either of them could reach
   * past the map. Measured: calling it directly from one caller left every test green.
   */
  private idrRequester(sessionId: string): () => void {
    const existing = this.idrRequesters.get(sessionId)
    if (existing) return existing
    let lastAt = 0
    const requester = () => {
      const now = Date.now()
      if (now - lastAt < IDR_REQUEST_THROTTLE_MS) return
      lastAt = now
      const session = this.sessions.get(sessionId)
      if (session?.agentSocket.readyState === WebSocket.OPEN) {
        this.sendTo(session.agentSocket, { type: 'stream:request-idr', sessionId })
      }
    }
    this.idrRequesters.set(sessionId, requester)
    return requester
  }

  /**
   * Throttled callback asking the session's agent to re-read and report the device's network
   * condition (#614); ignored by agents that don't support it.
   *
   * **Coalescing, where `idrRequester` above drops — and the difference is not a preference.** A
   * dropped IDR request costs nothing: the next periodic keyframe repairs it. Nothing re-produces a
   * `network:state`, so a request dropped inside the window leaves that viewer rendering "unknown"
   * for the life of the session. The trailing edge fires after the last join in a burst, and the
   * relay addresses the reply to whichever socket holds the session *when it arrives* — so the
   * viewer that ends up watching is the one served, which a leading edge cannot promise.
   *
   * The burst this is for is the dirty blip, not two people: `join()` refuses a live holder, and a
   * clean `session:leave` runs `forgetSessionState` and builds a fresh requester. A browser socket
   * that dies in its close handler does neither, so `lastAt` survives into the re-join — which is
   * the very path this slice exists to serve.
   *
   * One per session, constructed here, for the reason written on `idrRequester`: the throttle lives
   * in the closure, so a second requester is a second budget.
   */
  private networkStateRequester(sessionId: string): TrailingRequester {
    const existing = this.networkStateRequesters.get(sessionId)
    if (existing) return existing
    const requester = createTrailingRequester({
      scheduler: systemTimerScheduler,
      windowMs: NETWORK_STATE_REQUEST_THROTTLE_MS,
      fire: () => {
        const session = this.sessions.get(sessionId)
        // `sendTo` already drops a socket that is not OPEN, so a closed agent needs no check here —
        // an earlier draft duplicated it and no mutation could tell the copy from the original.
        //
        // The lookup is the guard that remains, and it should be unreachable: **every path that removes
        // a session runs `forgetSessionState`, which disposes this timer.** It is kept as the cheap half
        // of that pair rather than as a live case — a trailing edge is the one call here that outlives
        // the statement scheduling it, so the invariant holding is worth not assuming.
        if (session) this.sendTo(session.agentSocket, { type: 'network:request-state', sessionId })
      },
    })
    this.networkStateRequesters.set(sessionId, requester)
    return requester
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
    // Read from the upgrade URL because a browser cannot set WebSocket headers, and because it has to be
    // known **per connection** rather than per join: the dashboard socket that sends the unmount teardown
    // never joins anything. `new URL` against a dummy base — `request.url` is path-relative.
    const claimed = new URL(request.url ?? '/', 'http://relay').searchParams.get('client')
    // **The PAT counts as a principal, and a first version dropped it.** `getAuth` reads the cookie only,
    // so every agent, `mcp-server` and `flow-runner` connection would have been `anon:` — and the whole
    // point of pairing the claim with a user is that a leaked client id is useless to anyone else. Two
    // processes on the same PAT are the same principal, which is right; two on different PATs are not,
    // which is what this restores. `pat` is already resolved above and was being discarded.
    this.ownerKey.set(ws, ownerKeyFor(getAuth(request)?.userId ?? pat?.userId, claimed))

    // Heartbeat liveness: a fresh socket counts as having just answered, and each pong renews it.
    this.lastPongAt.set(ws, Date.now())
    ws.on('pong', () => this.lastPongAt.set(ws, Date.now()))
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
          const requestIdr = this.idrRequester(session.id)
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
      let parsed: unknown
      try {
        parsed = JSON.parse(data.toString())
      } catch {
        return // genuinely malformed — there is no type to answer on
      }
      // **The frame becomes a union here, and not by a cast.** `#550` asked for `RelayMessage` — a flat
      // interface where `type` is the only required member — to become a discriminated union, and doing
      // that with an `as` at this line would have been a downgrade: the visible cast at the
      // `session:chrome` handler would have turned into an invisible `msg.payload`, with the compiler
      // vouching for JSON that arrived over a socket. So the union is the *product* of a parse (#444),
      // and what the parse could not prove is not in the type. Non-objects, unknown types and shape
      // failures are all refused in there — including the bare `null` / number / string that
      // `JSON.parse` returns without throwing.
      const inbound = parseInbound(parsed)
      // **Role and direction are settled before the shape is, and the order is load-bearing.** A first
      // draft rejected a malformed frame and returned, which silently dropped an agent-only type a
      // browser socket had spoofed *badly* — the 1008 that closes such a socket never fired, so the
      // spoofer kept its connection. The direction is a fact about the `type` alone, and the type is
      // known on a shape failure too, so nothing about that check needs the payload to be valid.
      // **Logged before the gate, not after it.** A first draft called `settleRole` first and logged in
      // the `!ok` branch below it — which never ran for two of the three failure reasons, because
      // `settleRole` returns `false` for them. The case that mattered was a malformed handshake on a
      // role-less socket: dropped in silence, which is precisely the agent-registration skew this log
      // exists to make visible.
      if (!inbound.ok) this.logInboundRejection(ws, inbound)
      if (!this.settleRole(ws, inbound)) return
      if (!inbound.ok) {
        // **After the role gate, never before it**, so a browser spoofing an agent-only type gets 1008
        // and no reply. That is the whole of the claim: an agent- or stream-role socket sending a
        // malformed browser request passes the gate and *is* answered, because the gate only refuses a
        // `browser` role sending a non-browser type. Harmless, and worth stating rather than implying
        // otherwise — such a socket already gets an answer on the well-formed path (`refuseInput` tells
        // it `not-session-owner`), and this reply says strictly less than that one.
        if (inbound.reason === 'bad-payload') this.refuseMalformed(ws, inbound)
        return
      }
      try {
        this.route(ws, inbound.msg, inbound.raw)
      } catch (e) {
        // A throw inside a handler used to land in the same catch as a parse failure and vanish.
        // Anything reaching here is a bug in routing, not a bad message, and the caller is left
        // waiting either way — so at least say so once instead of dropping it silently.
        logger.error(`route failed for ${inbound.msg.type}:`, e)
      }
    })

    ws.on('close', () => {
      this.wsRoles.delete(ws)
      this.wsExternal.delete(ws)
      // Agent main socket disconnected → hold its sessions open for a moment in case the agent is
      // coming back (#426), rather than ending them where they stand.
      if (this.holdAgentSocket(ws)) return

      // Stream socket disconnected → clear the streamSocket reference.
      //
      // **No `return`.** One socket can be both: the role gate refuses a `browser`-role socket sending a
      // non-browser type, and says nothing about a `stream`-role one sending `session:start` — so a
      // socket that registered a stream first can go on to hold sessions. Returning here skipped the
      // release below for exactly those, which is the state the loop exists to end.
      const streamSession = this.sessions.getByStreamSocket(ws)
      if (streamSession) this.sessions.clearStreamSocket(streamSession.id)

      // Browser socket disconnected → release **every** session it held, each with its own idle timer.
      //
      // `getByBrowserSocket` used to answer with one session because the index held one, and a socket
      // holding several is not exotic: `mcp-server` runs one socket for the whole process and joins a
      // session per device. So closing it released the last join and left the rest bound to a dead
      // socket — `busy: true` forever, no timer, and their devices booted with nobody watching (#507).
      //
      // The `stopping` guard is `holdAgentSocket`'s, for its stated reason: `stop()` terminates every
      // client, and a timer armed on the way out survives the promise `stop()` resolves. That was one
      // stray timer per relay before this loop and is one per held session after it.
      if (this.stopping) return
      for (const held of this.sessions.getByBrowserSocket(ws)) {
        this.sessions.clearBrowser(held.id, () => this.idleShutdown(held.id))
      }
    })
  }

  /**
   * @param msg  what the door proved — see `parseInbound`. An Envelope-tier member arrives carrying
   *             `type` and its correlators and nothing else, so a payload the parser did not check
   *             cannot be read off it.
   * @param raw  the frame as it arrived. Agent-origin messages are **forwarded as this**, so a field
   *             a newer agent added survives a relay that does not know it — `z.object` strips, and
   *             stripping is wrong in the one direction where the sender is the more recently
   *             updated side. Browser-origin messages are forwarded as `msg` instead, so a key an attacker
   *             appended does not survive. It is also where the two stored Envelope payloads come
   *             from, which is the point: a value read off `raw` is one the parser did not vouch for.
   */
  /**
   * Assign this socket's role if it does not have one, then refuse a message its role may not send.
   *
   * @returns `false` when the caller must stop — the socket was closed, or the frame is a failed
   *          handshake that must not confer a role.
   */
  private settleRole(ws: WebSocket, inbound: ParseResult): boolean {
    // Every reason that carries a type, which is all of them but the two that have none to carry.
    // Missing `bad-payload` here returned `false` before the caller could answer, so the thirteen
    // answerable requests were classified correctly and then dropped anyway — the regression this
    // whole path exists to prevent, reintroduced one line above it.
    const type = inbound.ok ? inbound.msg.type
      : inbound.reason === 'bad-shape' || inbound.reason === 'bad-payload' ? inbound.type
      : undefined
    if (type === undefined) return false

    // **The role comes from the two handshake literals, deliberately not from `directionOf`.** Reading
    // it from the message's own direction is the obvious simplification now that one exists, and it
    // inverts the check below: a socket whose first frame is `screenshot:done` would be handed the
    // `agent` role and then waved through the gate that exists to refuse exactly that.
    const handshake = type === 'agent:register' || type === 'stream:register'
    if (!this.wsRoles.has(ws)) {
      // A handshake that did not parse confers nothing. Returning here rather than falling through to
      // `browser` is what keeps an agent whose register is malformed from being closed with
      // `Forbidden` — the caller has already logged it, and the next frame still gets to introduce it.
      if (handshake && !inbound.ok) return false
      if (type === 'agent:register') this.wsRoles.set(ws, 'agent')
      else if (type === 'stream:register') this.wsRoles.set(ws, 'stream')
      // Local connection whose first message is not an agent/stream handshake — treat it as a browser
      // (e.g. dashboard opened on the same machine). This fallback is what puts such a socket under
      // the gate below.
      else this.wsRoles.set(ws, 'browser')
    }

    // Browser sockets must not spoof agent control messages.
    //
    // This was a hand-copied array of 29 literals with two type assertions holding it against the
    // protocol. `directionOf` derives the same set from the schema map — verified member for member
    // against the array it replaces, no literal added and none lost.
    if (this.wsRoles.get(ws) === 'browser' && directionOf(type) !== 'browser') {
      ws.close(1008, 'Forbidden')
      return false
    }
    return true
  }

  /**
   * What the door refused, said once and in a form an operator can act on.
   *
   * This is where `isAddressed` and `isCorrelated` ended up. Both were predicates whose whole
   * observable output was a `console.warn` — an id-less request resolved no session and was dropped by
   * the miss anyway — and the schemas now reject the same frames earlier, including the empty-string
   * case a bare `z.string()` would have let through. What is new is that the log names the *field*:
   * "requestId: Too small" instead of "dropped, cannot correlate a reply".
   *
   * Worth logging at all for the reason `isCorrelated` gave: the three places a bad frame can be
   * dropped are otherwise silent, and an operator who upgrades the relay but not an independently
   * installed `mcp-server` would watch commands do nothing with no trace.
   *
   * **Throttled per socket, and the "per socket" is the whole design.** A first draft wrote one line
   * per rejected frame, on the direction a viewer with devtools controls and at the rate a gesture
   * produces — the unbounded, attacker-driven log volume this file already refuses at
   * `forwardUnacked`, with the reason written beside it. A single module-level timestamp would fix the
   * volume and break the diagnostic: one noisy socket would silence the *other* socket's first bad
   * frame, which is the skewed-client case the log exists for. So the state is keyed by socket, in a
   * `WeakMap` that needs no cleanup, and **the first rejection from any socket is always written** —
   * the one that names the skew is never the hundredth. What is dropped is only repetition, and the
   * next line says how much.
   *
   * `unknown-type` stays at debug: eleven relay-produced literals land here whenever a client echoes
   * one back, and none of them is a defect. It shares the throttle so turning debug on cannot
   * reintroduce the volume.
   */
  private logInboundRejection(ws: WebSocket, failure: ParseFailure): void {
    const now = Date.now()
    const state = this.rejectionLog.get(ws)
    if (state && now - state.at < REJECT_LOG_INTERVAL_MS) {
      state.suppressed++
      return
    }
    const line = describeRejection(failure, state?.suppressed ?? 0)
    // Recorded even when there is nothing to write, so a burst of `not-an-object` frames cannot reset
    // the window for the reasons that do write.
    this.rejectionLog.set(ws, { at: now, suppressed: 0 })
    if (line === null) return
    if (failure.reason === 'unknown-type') logger.debug(line)
    else logger.warn(line)
  }

  private route(ws: WebSocket, msg: ParsedInbound, raw: Readonly<Record<string, unknown>>): void {

    switch (msg.type) {
      // ── Agent → Relay ─────────────────────────────────────────────────────
      case 'agent:resources':    this.handleAgentResources(ws, msg); break
      case 'agent:register':     this.handleAgentRegister(ws, msg); break
      case 'screenshot:done':    this.handleScreenshotDone(msg); break
      case 'screenshot:error':   this.handleScreenshotError(msg); break
      case 'ui:tree:response':   this.handleUITreeResponse(msg); break
      case 'ui:tree:error':      this.handleUITreeError(msg); break
      case 'agents:list': {
        this.sendTo(ws, {
          type: 'agents:listed',
          sessions: this.sessions.list(this.ownerOf(ws), (holder) => this.isAlive(holder)),
        })
        break
      }

      // ── Session / Stream lifecycle ─────────────────────────────────────────
      case 'session:start':    this.handleSessionStart(ws, msg); break
      // ── the two session commands, gated but not answered ───────────────────────────────────────
      //
      // Both destroy state a viewer depends on, and until L5c both acted on the strength of the session
      // existing. `session:leave` is the sharper of the two: it nulls `browserSocket`, so an unguarded one
      // strips ownership out from under a mounted viewer — and then that tester's own input is refused,
      // which is why `not-session-owner` needed real copy in the dashboard rather than the `null` a first
      // draft gave it.
      //
      // No address check here at all any more: the schema declares `sessionId` with `.min(1)`, so an absent
      // id, an empty one and a non-string are all refused before this case is reached. It used to be a bare
      // `msg.sessionId &&` rather than the `isAddressed` predicate, because a falsy check already covered
      // both halves and the predicate would have added only its log.
      //
      // **Dropped rather than refused, and that is the contract**: neither has a reply, so there is no
      // waiter to tell. The same asymmetry as the input frames nothing acks. Inventing a
      // `session:leave-error` would grow the wire for a message no consumer reads — and `session:end` has
      // no in-repo sender at all, so it would be a reply to nobody.
      case 'session:end': {
        if (this.ownsSession(ws, this.sessions.get(msg.sessionId))) {
          this.sessions.remove(msg.sessionId)
          this.forgetSessionState(msg.sessionId)
        }
        break
      }
      case 'session:leave': {
        if (this.ownsSession(ws, this.sessions.get(msg.sessionId))) {
          this.sessions.clearBrowser(msg.sessionId)
          this.forgetSessionState(msg.sessionId)
        }
        break
      }
      case 'stream:register': {
        const session = this.sessions.get(msg.sessionId)
        if (session) {
          this.sessions.setStreamSocket(session.id, ws)
          this.sendTo(ws, { type: 'stream:registered' })
        }
        break
      }

      // ── Agent → Browser ────────────────────────────────────────────────────
      case 'session:chrome': {
        const session = this.sessions.get(msg.sessionId)
        if (!session) break
        // **Off `raw`, and still a cast — deliberately both.**
        //
        // `session:chrome` is Envelope tier, so the parser proved `type` and `sessionId` and nothing
        // about this value; reading it from `raw` is what makes that visible at the line rather than
        // in a header. The old comment here promised a validator would replace the cast. It did not,
        // and the reason is worth having instead of the promise: `ChromePayload` is a **closed
        // two-member union** while `AgentRegister.platform` is `string`, open so that a third-party
        // platform can register through `AgentRegistry.register()` (root AGENTS.md, OCP). Validating
        // this would refuse a platform the repo promises to support — and refusing costs more than a
        // dropped frame, because the message arrives once per boot and skipping `setChromeData` also
        // empties what the re-join replay reads. The relay never looks inside; the viewer does, and it
        // is where the variants are already told apart.
        this.sessions.setChromeData(session.id, raw['payload'] as ChromePayload)
        if (session.browserSocket?.readyState === WebSocket.OPEN) {
          session.browserSocket.send(JSON.stringify(raw))
        }
        break
      }
      case 'session:deviceInfo': {
        const session = this.sessions.get(msg.sessionId)
        if (!session) break
        // See `session:chrome` above for why this one is a cast off `raw` too.
        this.sessions.setDeviceInfo(session.id, raw['payload'] as DeviceDetails)
        if (session.browserSocket?.readyState === WebSocket.OPEN) {
          session.browserSocket.send(JSON.stringify(raw))
        }
        break
      }
      case 'device:booting': {
        // clear cached device data so reconnecting browser doesn't get stale chrome
        const session = this.sessions.get(msg.sessionId)
        if (!session) break
        this.sessions.clearDeviceCache(session.id)
        if (session.browserSocket?.readyState === WebSocket.OPEN) {
          session.browserSocket.send(JSON.stringify(raw))
        }
        break
      }
      case 'device:boot-error': {
        const session = this.sessions.get(msg.sessionId)
        if (session?.browserSocket?.readyState === WebSocket.OPEN) {
          session.browserSocket.send(JSON.stringify(raw))
        }
        break
      }
      case 'device:shutdown-done': {
        const session = this.sessions.get(msg.sessionId)
        if (!session) break
        this.sessions.updateDeviceStatus(session.id, 'shutdown')
        this.sessions.setReadySent(session.id, false)
        if (session.browserSocket?.readyState === WebSocket.OPEN) {
          session.browserSocket.send(JSON.stringify(raw))
        }
        break
      }
      case 'device:ready': {
        // The one inbound member whose `sessionId` is declared optional, and it is a reasoned deferral
        // rather than an oversight — see `DeviceReady`. So this is a real guard, not a dropped `!`:
        // an agent that omits it resolves no session here, exactly as before.
        if (msg.sessionId === undefined) break
        const session = this.sessions.get(msg.sessionId)
        if (!session) break
        this.sessions.updateDeviceStatus(session.id, 'booted')
        this.sessions.setReadySent(session.id, true)
        if (session.browserSocket?.readyState === WebSocket.OPEN) {
          session.browserSocket.send(JSON.stringify(raw))
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
      case 'input:type-done':
      case 'input:type-error':
      case 'input:done':
      case 'input:error':
      case 'keyboard:toggled': {
        const session = this.sessions.get(msg.sessionId)
        if (session?.browserSocket?.readyState === WebSocket.OPEN) {
          session.browserSocket.send(JSON.stringify(raw))
        }
        break
      }
      // Bound to the session's own agent socket, unlike the replies above: this payload
      // lands on the viewer's host OS clipboard, so a second agent (another Mac on the
      // same relay) must not be able to address someone else's session.
      // Bound to the session's own agent socket for the same reason clipboard is: this reply says
      // whether a **specific tester's** device is on the network, and a second agent must not be
      // able to tell that tester's viewer something about it.
      case 'network:state':
      case 'network:error':
      case 'clipboard:data':
      case 'clipboard:write-done':
      case 'clipboard:error': {
        const session = this.sessions.get(msg.sessionId)
        if (session?.agentSocket !== ws) break
        if (session.browserSocket?.readyState === WebSocket.OPEN) {
          session.browserSocket.send(JSON.stringify(raw))
        }
        break
      }

      // ── Browser → Agent ────────────────────────────────────────────────────
      //
      // These two shared one fall-through clause. Separated because the sharing is the trap for
      // whoever adds the door gate: a correlator check written into a shared body would gate
      // `device:shutdown` too, and the relay originates that message with no id — so the dashboard's
      // four senders and the relay's own idle timer would stop reaching the agent, silently, in the
      // one direction no reply reports. That gate is a schema now and cannot be written into a case at
      // all, which is what makes the trap unreachable rather than merely avoided.
      case 'device:boot': {
        // The door gate that stood here is now the schema: `device:boot` declares `sessionId` and
        // `requestId` required, and the parser rejects an absent **or empty** one before this case is
        // reached. The policy it enforced is unchanged and its reason still holds — both things the
        // relay could do with an id-less boot are downstream of here (forward it, or answer it with a
        // `device:boot-error`), so gating only one of them would leave the guarantee resting on
        // whichever branch was not gated.
        //
        // A boot the agent never receives leaves the viewer on "Waiting for first frame…" with nothing
        // said, and the reasons it might not arrive are worth telling apart: `bootDevice` is the first
        // call an MCP caller makes, so reporting a stale session id as a dead Mac sends the reader after
        // the wrong problem. `dispatchTarget` decides which of the four it is.
        //
        // **The relay is a producer of this reply, so it echoes the correlator itself.** An MCP caller
        // that receives this diagnosis uncorrelated reads it as unsolicited and waits out its deadline —
        // the diagnosis arrives and is discarded. That defect shipped twice from agent code
        // (`open-url:error`, then `clipboard:error`); here the producer is the relay, where
        // `correlatedRequestsGated` cannot see it because the field is optional.
        const boot = this.dispatchTarget(ws, msg.sessionId)
        if (!boot.ok) {
          this.sendTo(ws, {
            type: 'device:boot-error',
            sessionId: msg.sessionId,
            requestId: msg.requestId,
            message: boot.message,
          })
          break
        }
        // Tag the boot with whether the viewer is external (public IP) so the agent can pick the
        // downscale tier. The browser already reports secureContext in the payload.
        //
        // **Mutating the parse product, not the frame that arrived**, which is what makes this safe as
        // well as correct: `payload` is a fresh object the parser built, so `raw` is untouched. The
        // presence check the old line carried is gone because the schema requires the payload — and
        // `external` is deliberately not declared on `DeviceBoot`, since the browser never sends it.
        (msg.payload as Record<string, unknown>)['external'] = this.wsExternal.get(ws) ?? false
        // The parse product, so a key a viewer appended from devtools is gone before the agent sees it.
        boot.session.agentSocket.send(JSON.stringify(msg))
        break
      }
      case 'device:shutdown': {
        // Deliberately **un**correlated: the relay sends this itself from the idle timer, with no browser and
        // no id behind it, so a correlator cannot be required and an absent one is not an error.
        //
        // Addressing used to have no gate either, on the grounds that an unaddressed shutdown resolves no
        // session and is dropped by the miss, so a gate would buy only its log. That reasoning is now moot
        // rather than wrong: the schema declares `sessionId` required, so the parser refuses the frame and
        // the log it would have bought is the one `logInboundRejection` writes.
        //
        // **`reachableTargetWithoutOwnership`, not `dispatchTarget`** — that clause is #527, and its blocker is in
        // the dashboard, not here. What this fixes is the other half: until #542 this case resolved the
        // session inline and dropped the frame when it could not, making it the only browser-originated
        // command the relay never answers. `mcp-server`'s `shutdownDevice` waits 30s on `device:shutdown-done`
        // and then reports `Request timed out` with no cause, which is the silence, not a diagnosis.
        const session = this.sessions.get(msg.sessionId)
        if (session && !this.mayShutDown(ws, session)) {
          this.sendTo(ws, {
            type: 'device:shutdown-error',
            sessionId: msg.sessionId,
            ...(msg.requestId === undefined ? {} : { requestId: msg.requestId }),
            message: ownershipRefusal(session),
          })
          break
        }
        const target = this.reachableTargetWithoutOwnership(msg.sessionId)
        if (!target.ok) {
          // Echoed, and the relay is the producer — the same obligation `device:boot-error` carries and for
          // the same reason: an MCP caller that receives a diagnosis uncorrelated reads it as unsolicited
          // and waits out the deadline anyway, so the answer arrives and is discarded. `requestId` is
          // optional on both sides here, so an absent one stays absent rather than being invented.
          this.sendTo(ws, {
            type: 'device:shutdown-error',
            sessionId: msg.sessionId,
            ...(msg.requestId === undefined ? {} : { requestId: msg.requestId }),
            message: target.message,
          })
          break
        }
        target.session.agentSocket.send(JSON.stringify(msg))
        break
      }
      // Door checks, one policy per request: an uncorrelatable request is not forwarded, not rebuilt and
      // not answered, because every reply these produce declares `requestId` as required.
      case 'app:install': this.handleBrowserAppInstall(ws, msg); break
      case 'app:launch':  this.handleBrowserAppLaunch(ws, msg); break
      case 'open-url': {
        // **At the door, before either branch.** A correlator is required on this request, and the
        // relay has two things it could do with one that lacks it — forward it, or answer it — so
        // putting the check inside one branch means having two policies. A first draft did exactly
        // that: it refused to *answer* without an id while still *forwarding* without one, which
        // leaves the whole guarantee resting on the receiving agent. Both in-repo agents drop it, but
        // an agent that predates this field would execute the request and reply uncorrelated, and
        // then nothing downstream can attribute the reply.
        //
        // **The check is the validator now**, and the argument for it is unchanged. It read "here rather
        // than in a validator because this is one required field on one message"; #444 built the
        // validator, and the schema for `open-url` demands the correlator before this case is reached.
        //
        // Dropping is still the only honest answer: `open-url:error` requires the correlator too, so
        // answering would mean shipping a frame that violates its own declaration — `JSON.stringify`
        // erases the absent key, every correlating consumer discards the result, and "agent offline"
        // becomes a caller waiting out its full deadline. That was the first draft's other half,
        // `requestId: msg.requestId!` — an assertion in an *outbound* frame, unlike the inbound
        // `sessionId!` this file used to carry, which fed a read whose miss still produced a visible
        // error. Neither exists any more.
        const target = this.dispatchTarget(ws, msg.sessionId)
        if (target.ok) {
          target.session.agentSocket.send(JSON.stringify(msg))
        } else {
          this.sendTo(ws, {
            type: 'open-url:error',
            sessionId: msg.sessionId,
            requestId: msg.requestId,
            message: target.message,
          })
        }
        break
      }
      case 'app:clear-state': {
        // Verbatim forward like `open-url`, so the correlator rides for free; the door check and the echo
        // are the same two lines.
        const target = this.dispatchTarget(ws, msg.sessionId)
        if (target.ok) {
          target.session.agentSocket.send(JSON.stringify(msg))
        } else {
          this.sendTo(ws, {
            type: 'app:clear-state-error',
            sessionId: msg.sessionId,
            requestId: msg.requestId,
            message: target.message,
          })
        }
        break
      }
      // ── input, split by whether an ack answers it ──────────────────────────────────────────────
      //
      // These eleven shared one clause until L5c, and the sharing was the trap. Only five of them are
      // answered — the four terminal frames plus `input:type` — so only those five carry a
      // required `requestId`, and a gate written into a shared body would have dropped every opening
      // and move frame with it: no swipe, no pinch, no rotation, and nothing said. Splitting the clause
      // is what makes the gate unable to reach them. `correlatedRequestsGated` resolves fall-through by
      // sharing the next non-empty body, so it would have read one gate as covering all eleven.
      case 'input:touch:start':
      case 'input:touch:move':
      case 'input:pinch:start':
      case 'input:pinch:move':
      case 'input:rotate':
      case 'input:keyboard:toggle': {
        // No ack, so no correlator to check and nothing to answer. An unowned frame is dropped rather
        // than refused for the same reason: there is no waiter to tell.
        //
        // These carry no correlator by declaration, so nothing was ever gated on one here — and the
        // address is now the schema's business rather than this clause's. What the split still buys is
        // unchanged and is the reason it exists: a correlator gate written into a shared body would have
        // reached these six as well, dropping every opening and move frame with the answered five.
        this.forwardUnacked(ws, msg)
        break
      }
      case 'input:touch:end':
      case 'input:pinch:end':
      case 'input:key':
      case 'input:button':
      case 'input:type': {
        // One policy at the door, as for the app commands: an uncorrelatable request is not forwarded and
        // not answered, because every reply it could produce declares `requestId` required.
        this.handleAckedInput(ws, msg)
        break
      }
      // Kept out of the input:* chain above: these need their own error type, and the caller
      // is waiting on a bounded deadline, so an undeliverable request fails now rather than
      // hanging until the browser gives up.
      case 'clipboard:read':
      case 'clipboard:write': {
        // Not part of this layer's pair set — clipboard has carried a required `requestId` since it was
        // written — but it had the identical defect, and leaving it would make this layer's claim of one
        // policy at the door false the moment it landed. It answered with `requestId: msg.requestId!`,
        // which is a **write into an outbound frame**: `JSON.stringify` erases the absent key and ships a
        // `clipboard:error` whose required correlator is missing, which `useClipboardBridge` discards on
        // `if (!msg.requestId) return` — so "agent offline" became the caller waiting out its budget.
        // Removed once already in `e98abd4`, for `open-url`, and still here.
        // Ownership matters most here of all of them: a `clipboard:write` from a socket that does not hold
        // the session pastes its text into someone else's device, and a `clipboard:read` presses the copy
        // or cut chord on it — and the reply routes to the session's own browser, so the payload lands on
        // **that** tester's host OS clipboard. The agent-side mirror of this check has been here since the
        // bridge was written, with the reason beside it; the browser side had none.
        const clip = this.dispatchTarget(ws, msg.sessionId)
        if (clip.ok) {
          clip.session.agentSocket.send(JSON.stringify(msg))
        } else if (ws.readyState === WebSocket.OPEN) {
          this.sendTo(ws, {
            type: 'clipboard:error', sessionId: msg.sessionId, requestId: msg.requestId, message: clip.message,
          })
        }
        break
      }
      // Ownership is not decoration here: taking a device off the network is the most disruptive
      // thing a non-holder could do to someone else's session short of shutting it down, and unlike
      // a shutdown it leaves the device *looking* fine. `dispatchTarget` rather than the weaker
      // `reachableTarget` `device:shutdown` uses — there is no teardown race to accommodate.
      case 'network:set': {
        const net = this.dispatchTarget(ws, msg.sessionId)
        if (net.ok) {
          net.session.agentSocket.send(JSON.stringify(msg))
        } else if (ws.readyState === WebSocket.OPEN) {
          this.sendTo(ws, {
            type: 'network:error', sessionId: msg.sessionId, requestId: msg.requestId, message: net.message,
          })
        }
        break
      }
    }
  }

  private handleAgentResources(ws: WebSocket, msg: Inbound<'agent:resources'>): void {
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
  /**
   * Every message the relay *originates* goes through here. The union checks the shape where the
   * literal is written — a mistyped `type`, a missing field or one that does not belong are all
   * compile errors — and the readyState guard replaces the check that was repeated (and sometimes
   * omitted) at each call site.
   *
   * Messages the relay merely *forwards* do not use this: they are re-serialised unchanged, so
   * they keep their inbound type and there is nothing new to check.
   */
  private sendTo(socket: WebSocket, msg: RelayOutbound): void {
    if (socket.readyState !== WebSocket.OPEN) return
    socket.send(JSON.stringify(msg))
  }

  /**
   * Settle every in-flight screenshot / UI-tree request belonging to these sessions. Both callers
   * are moments where the agent that was going to answer them no longer exists — it disconnected,
   * or it restarted and its session moved to the new process. Left alone these reject on their own
   * timeout, minutes later, having told the caller nothing in between.
   */
  private rejectPending(sessionIds: Set<string>, reason: string): void {
    for (const pendings of [this.pendingScreenshots, this.pendingUITrees]) {
      for (const [reqId, pending] of pendings.entries()) {
        if (!sessionIds.has(pending.sessionId)) continue
        clearTimeout(pending.timer)
        pendings.delete(reqId)
        pending.reject(new Error(reason))
      }
    }
  }

  /**
   * The agent's socket went away. Keep its sessions and wait for that agent to come back, instead
   * of ending them here — a restarting agent registers about a second later, and until #426 stage 3
   * the close always won that race, so a restart cost the tester their place.
   *
   * The sessions stay exactly where they are. They are NOT moved to a holding structure of their
   * own: `getAgentSocketsByIdentity` finds the returning agent's previous socket by walking
   * `sessions` and reading `agentSocket`, so a session parked anywhere else is a session that can
   * never be reclaimed.
   *
   * @returns whether this was an agent socket, matching `evictAgentSocket`'s contract — the close
   *   handler uses it to decide whether to keep looking.
   */
  private holdAgentSocket(ws: WebSocket): boolean {
    // Shutting down: nothing is coming back, and arming a timer here would leave it running after
    // `stop()` resolved.
    if (this.stopping) return this.evictAgentSocket(ws)
    const sessions = this.sessions.getAllByAgentSocket(ws)
    if (sessions.length === 0) {
      // No sessions to hold, but the socket may still own a resource entry — `evictAgentSocket`
      // returns before dropping it in exactly this case.
      this.sessions.removeResources(ws)
      return false
    }
    // Not held for the window: these were addressed to a process that is gone, and a returning
    // agent is a new one that never saw them. Waiting would only delay the same failure.
    this.rejectPending(new Set(sessions.map((s) => s.id)), 'Agent disconnected')

    for (const s of sessions) {
      if (s.browserSocket) this.sendTo(s.browserSocket, { type: 'session:agent-away', sessionId: s.id })
    }
    const timer = setTimeout(() => {
      this.agentHolds.delete(ws)
      // Whatever is still on this socket never got reclaimed. A rebind moves sessions off it, so
      // after a successful one this evicts nothing.
      if (this.evictAgentSocket(ws)) logger.info(`agent did not come back within ${this.agentGraceMs}ms — session(s) ended`)
      // Not inside that branch: `evictAgentSocket` returns before dropping resources when the
      // socket has no sessions left, and the sessions can leave by routes other than a rebind —
      // `session:end` among them. This is the last moment anything holds a reference to the dead
      // socket, so it is the last chance to drop its entry.
      this.sessions.removeResources(ws)
    }, this.agentGraceMs)
    this.agentHolds.set(ws, timer)
    logger.info(`agent socket lost — holding ${sessions.length} session(s) for ${this.agentGraceMs}ms`)
    return true
  }

  /** Stop waiting on a socket, whether or not anything was reclaimed from it. */
  private releaseHold(ws: WebSocket): void {
    const timer = this.agentHolds.get(ws)
    if (!timer) return
    clearTimeout(timer)
    this.agentHolds.delete(ws)
  }

  /**
   * @param cause  `'disconnect'` — the socket closed. `'replaced'` — the same agent re-registered
   *   and this is its previous socket. Only affects the log line: a restart otherwise reads as a
   *   crash followed by a recovery, which is not what happened.
   */
  private evictAgentSocket(ws: WebSocket, cause: 'disconnect' | 'replaced' = 'disconnect'): boolean {
    const agentSessions = this.sessions.getAllByAgentSocket(ws)
    if (agentSessions.length === 0) return false
    this.rejectPending(new Set(agentSessions.map((s) => s.id)), 'Agent disconnected')
    // Tell whoever is attached before the session stops existing — after `remove()` the socket
    // reference is gone. Without this the browser keeps a live socket addressed to a sessionId the
    // relay no longer knows, so everything it sends is dropped as unknown and nothing streams back:
    // the tab sits on "Waiting for first frame..." with no explanation (#426).
    //
    // `sendTo` skips a socket that is not OPEN, and a session nobody has joined has no
    // `browserSocket` at all. An attached MCP client does have one and will receive this — and as of
    // #512 it **acts** on it, settling that session's pending requests instead of waiting them out. The
    // clause here used to say the client drops it as unmatched, which was true and was the problem.
    for (const s of agentSessions) {
      if (s.browserSocket) {
        this.sendTo(s.browserSocket, {
          type: 'session:terminated', sessionId: s.id, reason: 'agent-disconnected',
        })
      }
    }
    for (const s of agentSessions) {
      this.sessions.remove(s.id)
      this.forgetSessionState(s.id)
    }
    this.sessions.removeResources(ws)
    logger.info(cause === 'replaced'
      ? `agent re-registered — ${agentSessions.length} previous session(s) replaced`
      : `agent disconnected — ${agentSessions.length} session(s) ended`)
    return true
  }

  private handleAgentRegister(ws: WebSocket, msg: Inbound<'agent:register'>): void {
    // Re-register from the same Mac (machine id + platform): the old socket's close may not have
    // fired yet after an unclean drop (Wi-Fi loss, sleep) — its TCP teardown lags — which would
    // leave a duplicate, eventually-"Stale" card. Evict the stale agent's sessions and terminate
    // its socket before creating the new ones. Identity is agentId (unique per Mac) when present,
    // else agentName. (Heartbeat backstop for never-reconnecting agents: #313.)
    const identity = msg.agentId ?? msg.agentName
    // Deduplicate first. Everything below is keyed by device id, so a payload naming one device
    // twice would collapse to a single entry in `registeredSessions` while `create()` had already
    // made two sessions — leaving one the agent is never told about. That is the same orphan the
    // rebind exists to prevent, arriving by a different door.
    const devices = [...new Map((msg.devices ?? []).map((d) => [d.id, d])).values()]
    const agent = {
      agentId: msg.agentId, agentName: msg.agentName,
      agentPlatform: msg.platform, agentCapabilities: msg.capabilities,
    }
    // deviceId → the session id kept across the restart. Also the guard that a device is rebound at
    // most once (#426): before rebinding existed, `create()` ran after every old session had been
    // evicted, so one device could not be behind two sessions. It can now, and `list()` does not
    // deduplicate — the second card would name a session the agent has never heard of, which is the
    // symptom this whole change is fixing.
    const rebound = new Map<string, string>()
    if (identity) {
      for (const old of this.sessions.getAgentSocketsByIdentity(identity, msg.platform)) {
        if (old === ws) continue
        // Before any decision about what to rebind: the eviction below settles this socket either
        // way, so the timer has nothing left to do. Releasing here rather than after a successful
        // rebind also covers the case where nothing is rebound at all — a restart that reports a
        // completely different device list still leaves a timer keyed to a dead socket.
        this.releaseHold(old)
        for (const s of this.sessions.getAllByAgentSocket(old)) {
          if (rebound.has(s.deviceId)) continue
          const device = devices.find((d) => d.id === s.deviceId)
          // The device is gone from this agent's list — unplugged, deleted, renamed away. Leave it
          // for the eviction below, which tells the browser the session ended.
          if (!device) continue
          this.sessions.rebind(s.id, ws, device, agent)
          rebound.set(s.deviceId, s.id)
        }
        // Evict before terminate: the old socket's close fires async, by which point its sessions are
        // gone and its in-flight screenshots would be undiscoverable — reject them here instead.
        // The rebound sessions have already moved off `old`, so this no longer covers them.
        this.evictAgentSocket(old, 'replaced')
        old.terminate()
      }
    }
    // Their in-flight requests are addressed to a process that is gone, and the eviction above can
    // no longer see them. Nothing else would ever settle these.
    if (rebound.size > 0) this.rejectPending(new Set(rebound.values()), 'Agent restarted')

    // A device can be back under an agent this session cannot be rebound to — identity is
    // `agentId ?? agentName`, and the upgrade that prompted the restart is often the one that
    // starts sending an agentId. The device is demonstrably present, so holding its old session
    // any longer strands that viewer while someone else picks the very same simulator. End it now
    // and say so, which is what would have happened before the hold existed.
    for (const d of devices) {
      if (rebound.has(d.id)) continue
      for (const s of this.sessions.getAllByDeviceId(d.id)) {
        if (s.agentSocket.readyState === WebSocket.OPEN) continue
        if (s.browserSocket) {
          this.sendTo(s.browserSocket, { type: 'session:terminated', sessionId: s.id, reason: 'agent-disconnected' })
        }
        this.sessions.remove(s.id)
        this.forgetSessionState(s.id)
      }
    }

    // Only devices without a surviving session get a new one. Passing all of them here is what
    // would produce the duplicate card described above.
    const fresh = devices.filter((d) => !rebound.has(d.id))
    const freshIds = this.sessions.create(ws, fresh, msg.agentName, msg.platform, msg.agentId, msg.capabilities)
    const byDeviceId = new Map(rebound)
    fresh.forEach((d, i) => byDeviceId.set(d.id, freshIds[i]!))
    // Keyed by deviceId, not by position. The old form paired `msg.devices[i]` with `sessionIds[i]`,
    // which only held while every device got a session — now that some are rebound, the arrays have
    // different lengths and index alignment would hand the agent someone else's session id.
    const registeredSessions = devices.map((d) => ({ deviceId: d.id, sessionId: byDeviceId.get(d.id)! }))
    this.sendTo(ws, { type: 'agent:registered', registeredSessions })

    // After the state is final: the browser answers this with `device:boot` on the same session id.
    for (const sessionId of rebound.values()) {
      const s = this.sessions.get(sessionId)
      if (s?.browserSocket) {
        this.sendTo(s.browserSocket, { type: 'session:rebound', sessionId, capabilities: msg.capabilities ?? [] })
      }
    }
    if (rebound.size > 0) logger.info(`agent restarted — ${rebound.size} session(s) kept across the restart`)
    // The startup banner prints "Waiting for agents..." once and then the relay says nothing either
    // way, so a terminal gives no signal about whether an agent is attached. One line per
    // transition, matching the disconnect line in evictAgentSocket.
    // `||`, not `??`: the schema defaults both of these to `''` for an agent that omits them, so `??`
    // would print an empty name and an empty platform where this used to print `unknown`.
    logger.info(`agent connected: ${msg.agentName || msg.agentId || 'unknown'} (${msg.platform || 'unknown'}) — ${registeredSessions.length} device(s)`)
  }

  /** The only producer of `error` — all five exits below, and nothing else in the repo sends that message.
   *
   *  That is what makes the address possible rather than aspirational: `msg.sessionId` is narrowed to a
   *  non-empty `string` by the door — the inbound schema, `isAddressed` before it — so every refusal can
   *  name the join it refuses. Before
   *  L5d they carried none, and the clients' join waiters matched `sessionId === undefined || sessionId ===
   *  mine` — with no such key the left half was always true, so any refusal resolved any pending join. */
  private handleSessionStart(ws: WebSocket, msg: Inbound<'session:start'>): void {
    const session = this.sessions.get(msg.sessionId)
    if (!session) {
      this.sendTo(ws, { type: 'error', sessionId: msg.sessionId, message: 'Session not found', reason: 'session-not-found' })
      return
    }
    // Occupancy first, because it is the more specific answer and both can be true at once. A tester
    // joining a device someone else has open on a loaded Mac was being told "this Mac is overloaded,
    // pick another" — advice for a problem they cannot act on, while the actual reason went unreported.
    // It is a map read the relay has already done, so ordering it first costs nothing.
    //
    // `!== ws` because a socket re-joining the session it already holds is not contending with anyone:
    // `SessionList` sends `session:start` before a shutdown, so pressing shutdown twice hit this.
    // The same three conditions `join()` applies, and they have to agree: this one answers the caller and
    // that one performs the bind, so a disagreement is a refusal for a session the bind would have allowed.
    if (
      session.browserSocket &&
      session.owner !== null &&
      session.owner !== this.ownerOf(ws) &&
      session.browserSocket.readyState === WebSocket.OPEN &&
      this.isAlive(session.browserSocket)
    ) {
      this.sendTo(ws, { type: 'error', sessionId: msg.sessionId, message: 'Session busy', reason: 'session-busy' })
      return
    }
    // Read before the resource gate, and answered before it too. The gate would otherwise read the
    // dead socket's last sample — and an overloaded Mac is a common reason to restart an agent, so
    // the tester would be told the Mac is exhausted at the exact moment it is recovering.
    const agentAway = session.agentSocket.readyState !== WebSocket.OPEN
    const resources = agentAway ? undefined : this.sessions.getResources(session.agentSocket)
    if (resources) {
      const memPercent = (resources.memUsedMB / resources.memTotalMB) * 100
      if (resources.cpuPercent > RESOURCE_THRESHOLD || memPercent > RESOURCE_THRESHOLD) {
        this.sendTo(ws, { type: 'error', sessionId: msg.sessionId, message: 'Agent resources exhausted', reason: 'agent-resources-exhausted' })
        return
      }
    }
    try {
      const joined = this.sessions.join(msg.sessionId, ws, this.ownerRecord(ws), (h) => this.isAlive(h))
      if (!joined.ok) {
        // Both of these are answered above, so arriving here means the state moved between that check and
        // this call. They are **values now rather than throws** (#515), and that is what fixes the defect:
        // the most common way into the old `catch` was a socket re-joining the session it already holds —
        // exempted by the `!== ws` check above, then refused by `join()`, then reported as
        // `session-not-found` for a live session the caller was holding.
        const reason = joined.failure === 'held-by-another' ? 'session-busy' : 'session-not-found'
        const message = joined.failure === 'held-by-another' ? 'Session busy' : 'Session not found'
        this.sendTo(ws, { type: 'error', sessionId: msg.sessionId, message, reason })
        return
      }
    } catch (e) {
      // Only a bug reaches here now — the two expected failures return above instead of throwing, which is
      // what stops this arm from having to guess. It still answers rather than dropping: both clients await
      // `session:joined | error` on this request, so silence costs them a full deadline.
      //
      // `session-not-found` is chosen for **the action it names**, not as a diagnosis. Its own declaration
      // says "nothing else is ever coming for it", and that half is true of any failed join — no
      // `session:joined` will follow. `session-busy` would be the wrong action: it tells a viewer the
      // session is alive and someone else has it. The prose carries what is actually known.
      logger.error(`session:start could not join ${msg.sessionId}:`, e)
      this.sendTo(ws, { type: 'error', sessionId: msg.sessionId, message: 'Session could not be joined', reason: 'session-not-found' })
      return
    }
    // Include the agent's capabilities so the viewer knows up front what is implemented on
    // the other end — an agent that predates a feature omits it, and the dashboard degrades
    // deliberately instead of inferring anything from a timeout.
    this.sendTo(ws, {
      type: 'session:joined', sessionId: msg.sessionId, capabilities: session.agentCapabilities ?? [],
    })
    if (agentAway) {
      // Joining into a held session. Refusing instead would be worse than it sounds: the viewer
      // sends `session:start` exactly once per reconnect and ignores a plain `error`, so a browser
      // blip inside the window would leave a tab that no later `session:rebound` can reach — it is
      // addressed to `browserSocket`, which the refusal never set. Saying what is happening keeps
      // the tab inside the contract instead.
      //
      // Everything below describes the agent that went away, so it stops here. The viewer will get
      // it all again from the boot it sends on `session:rebound`.
      this.sendTo(ws, { type: 'session:agent-away', sessionId: msg.sessionId })
      return
    }
    // These three replay a session's cached state to a re-joining viewer. They carry `sessionId`
    // because both agents stamp it on every copy they send, and the relay was the only producer that
    // did not — so the shared declaration had to be `sessionId?` to stay honest about the two of us.
    // Stamping it here is what let that be tightened to required.
    if (session.chromeData) {
      this.sendTo(ws, { type: 'session:chrome', sessionId: session.id, payload: session.chromeData })
    }
    if (session.deviceInfo) {
      this.sendTo(ws, { type: 'session:deviceInfo', sessionId: session.id, payload: session.deviceInfo })
    }
    // Replay device:ready only if this session actually announced one (browser WS blip reconnect).
    // Not `deviceStatus`: that starts from the agent's `simctl list` snapshot, so a session for a
    // simulator that was already running would fire this before the agent had done anything —
    // telling the viewer a stream exists when none does (#440).
    if (session.readySent) {
      this.sendTo(ws, { type: 'device:ready', payload: { deviceId: session.deviceId } })
      // (Re)joining a live stream: ask the agent for an IDR so this viewer gets a decodable
      // keyframe immediately, instead of waiting for the next periodic one — and so it isn't
      // left blank when the encoder is static-skipping an unchanged screen. Agents that don't
      // support on-demand IDR ignore the message.
      //
      // **Through the session's throttled requester, not a bare `sendTo`.** This was unreachable for a
      // socket that already held the session — `join()` threw and the handler answered above this line —
      // and #515 made a re-join run the whole body. A client re-sending `session:start` therefore drives
      // one forced keyframe per frame it sends, and a 1080p IDR is two orders of magnitude larger than
      // the P-frames around it, so the amplification lands on the tester who is actually watching. The
      // backpressure path already throttles this exact message per session; sharing that requester is
      // what keeps the two callers from having two policies.
      this.idrRequester(session.id)()
      // And ask what the device's network is doing (#614). `NetworkState` is agent-produced and is not
      // among the three replayed above, so without this a viewer that reconnects has no way to learn
      // whether the device is offline and its control renders in a guessed position.
      //
      // **Gated on the capability, unlike the IDR request beside it.** That one is safe to send blind
      // because an agent without it loses nothing — the next periodic keyframe arrives anyway. This one
      // has no such repair, so an agent that never answers is indistinguishable from one that failed to
      // read; a viewer arming a deadline would then render "could not read" on every re-join, for an
      // agent that already said it cannot do this at all. iOS is exactly that agent until #607's last
      // slice. Fifty lines up, `session:joined` carries these capabilities for the stated reason that a
      // consumer must not infer support from a timeout — asking anyway would make the relay do it.
      //
      // **Inside `readySent` too, and there as an optimisation rather than a correctness condition.**
      // `readySent` is the *stream's* readiness: `clearStreamSocket` lowers it while `deviceStatus`
      // stays `'booted'`, so a booted, genuinely offline device with a dead stream socket is not asked
      // about here — and the agent would have answered, since it still holds that serial. What makes
      // skipping safe is not the agent's silence but the viewer's: with `readySent` false the
      // `device:ready` above is not replayed either, so nothing is rendering a live device to be wrong
      // about. `deviceStatus` is not the fix — the comment on `device:ready` says why (#440).
      if (session.agentCapabilities?.includes('network-control')) this.networkStateRequester(session.id)()
    }
  }

  /** Shut the device down because nobody is watching it any more. The idle timer's payload, hoisted out
   *  of the close handler so the release loop there reads as one line per session. */
  private idleShutdown(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (session?.agentSocket.readyState !== WebSocket.OPEN) return
    this.sendTo(session.agentSocket, {
      type: 'device:shutdown',
      sessionId: session.id,
      payload: { deviceId: session.deviceId },
    })
  }

  /** Where a browser-role command can be dispatched, or what its sender needs to be told instead.
   *
   *  Three refusals used to be spread across seven `case` bodies as two conditions each, and the ownership
   *  one was in none of them. Collapsed here so the set is decided once: a command reaches an agent only if
   *  the session exists, **this socket holds it**, and the agent is connected. Anything else has prose the
   *  caller can act on, and each case wraps that prose in the reply type its own waiter reads.
   *
   *  The two ownership strings are one reason with different prose, the treatment `#492` settled: telling a
   *  caller the session is in use when it is idle steers it off a device it could have had.
   */
  private dispatchTarget(
    ws: WebSocket,
    sessionId: string,
  ): { ok: true; session: Session } | { ok: false; message: string } {
    // Ownership first and liveness second, which is the order the refusals were written in and worth
    // keeping: a non-owner is told it does not hold the session rather than being handed the agent's
    // state. Composed rather than inlined so `device:shutdown` can take the other two checks alone.
    const session = this.sessions.get(sessionId)
    if (session && !this.ownsSession(ws, session)) return { ok: false, message: ownershipRefusal(session) }
    return this.reachableTargetWithoutOwnership(sessionId)
  }

  /** `dispatchTarget` without the ownership clause: is there a session here, and is its agent listening?
   *
   *  **The name carries the omission because a doc block does not reach an autocomplete.** This is the
   *  resolver a future handler must not pick by accident — it is the general-looking one and the unsafe
   *  one at the same time, which is the pairing worth spelling out.
   *
   *  **Still here after #527, and this paragraph used to say it would not be.** It predicted that
   *  answering "who may shut a device down" would move `device:shutdown` up to `dispatchTarget`. The
   *  answer turned out to be a *different* gate rather than that one: `mayShutDown` refuses a session
   *  another client holds and permits an unheld one, because the dashboard's unmount teardown races its
   *  own viewer socket's close and an owns-it gate refuses the teardown whenever the close lands first —
   *  leaving the device booted until the idle timer, which is the cost #527 was filed to avoid.
   *
   *  So the two are ordered rather than merged: `mayShutDown` decides *who*, this decides *whether it can
   *  be delivered at all*, and without the second a shutdown addressed to a missing session or a closed
   *  agent socket is dropped in silence and `mcp-server`'s caller burns a 30s deadline (#542).
   *
   *  The disclosure it was written to record stands: a caller that is not the holder still learns whether
   *  a session id exists and whether its agent is up.
   */
  private reachableTargetWithoutOwnership(
    sessionId: string,
  ): { ok: true; session: Session } | { ok: false; message: string } {
    const session = this.sessions.get(sessionId)
    if (!session) return { ok: false, message: 'Session not found' }
    if (session.agentSocket.readyState !== WebSocket.OPEN) return { ok: false, message: 'agent offline' }
    return { ok: true, session }
  }

  /** Is `ws` the socket this session is bound to?
   *
   *  Until L5c the input path resolved the session and forwarded without asking. `clipboard:data` asks the
   *  mirror-image question one branch up (`session?.agentSocket !== ws`) with the reason written beside it —
   *  a second agent on the same relay must not address someone else's session — and the browser direction
   *  had no equivalent. So any authenticated client that knew a session id could drive a device another
   *  tester was looking at, and the agent's ack went to the session holder rather than to whoever asked.
   *
   *  An **unheld** session (no `browserSocket`, or one that has gone) is also not owned by the sender. That
   *  is deliberate rather than incidental: it makes an input arriving inside the reconnect grace fail fast
   *  instead of being applied to a device with nobody watching the result. */
  private ownsSession(ws: WebSocket, session: Session | undefined): boolean {
    return session?.owner !== null && session?.owner === this.ownerOf(ws)
  }

  /** Which owner this socket speaks for. Every connection has one — supplied or minted — so this never
   *  answers `undefined` and two anonymous sockets can never match by both lacking an identity. */
  private ownerOf(ws: WebSocket): string {
    return this.ownerRecord(ws).key
  }

  /** The principal behind a socket — a user id, or `anon` for a connection carrying no cookie and no PAT. */
  private userOf(ws: WebSocket): string {
    return this.ownerRecord(ws).user
  }

  /** Everything the bind needs to record about who is joining.
   *
   *  **A socket with no record gets one of its own rather than a shared sentinel.** `handleConnection`
   *  seeds every accepted connection before a message can arrive, so the fallback is unreachable today —
   *  but a literal would make any two unseeded sockets *equal*, and equal keys pass `ownsSession` while
   *  equal users pass `mayShutDown`'s same-principal exemption. That rests the whole ownership invariant
   *  on one call site staying total, which is the shape of dependency the sentinel is supposed to remove.
   *  Minting keeps the answer "this socket and no other"; storing it keeps repeat calls consistent, since
   *  a fresh value each time would fail to recognise the very socket that bound the session. `minted` is
   *  `false` deliberately — the legacy exemption exists for a client that identified itself with nothing,
   *  not for one the relay failed to record. */
  private ownerRecord(ws: WebSocket): { key: string; user: string; minted: boolean } {
    const known = this.ownerKey.get(ws)
    if (known) return known
    const unseeded = `unidentified:${randomUUID()}`
    const record = { key: unseeded, user: unseeded, minted: false }
    this.ownerKey.set(ws, record)
    return record
  }

  /**
   * May this socket shut the session's device down?
   *
   * **"Not someone else's" rather than "mine", and the difference is the reason #527 stayed open.** The
   * dashboard's unmount teardown sends `device:shutdown` from one socket while another socket's `close`
   * races it to the relay — two connections, no ordering — and if the close lands first the session is
   * unheld. An owns-it gate refuses the teardown there, and the device stays booted until the five-minute
   * idle timer: the path #527 named as the reason a gate could not be added at all.
   *
   * An unheld session therefore stays shutdownable by anyone authenticated, which is unchanged from today
   * — this command has never had a gate — and is written down rather than implied. What changes is the
   * case the issue is about: a device another tester is *holding* can no longer be powered off.
   */
  private mayShutDown(ws: WebSocket, session: Session | undefined): boolean {
    if (session?.owner == null) return true
    if (session.owner === this.ownerOf(ws)) return true
    // **A holder that never identified itself is not gated**, because it cannot pass a gate: every one of
    // its sockets was minted a separate identity, so its own teardown socket is a stranger to the socket
    // holding the session — deterministically, not as a race. An older dashboard bundle re-attaching to an
    // upgraded relay is exactly that, and refusing it would leave a device booted until the idle timer on
    // every Back press: the cost #527 was filed to avoid, reintroduced by #527's fix.
    //
    // **Scoped to the same principal, though.** The exemption exists so a legacy client's own teardown
    // works, and its own teardown is by definition the same signed-in user — so extending it across users
    // buys nothing and would leave one tester able to power off another's device for as long as anyone is
    // running an older build. That is unchanged from before this gate existed, but "unchanged" is not a
    // reason to carry it forward when the narrower rule costs one comparison.
    return session.ownerMinted && session.ownerUser === this.userOf(ws)
  }

  /** Input that no ack answers: opening and move frames, rotation, the keyboard-forwarding toggle.
   *
   *  Dropped rather than refused when unowned, and that asymmetry with `handleAckedInput` is the whole
   *  reason these have their own clause: refusing means answering, and there is no waiter here to answer.
   *  `clipboard:data`'s silent `break` is the precedent that fits — a frame nobody is waiting on. */
  private forwardUnacked(ws: WebSocket, msg: Unacked): void {
    const session = this.sessions.get(msg.sessionId)
    if (session && !this.ownsSession(ws, session)) {
      // **Deliberately silent.** A first draft logged here, which is one line per `input:touch:move` — the
      // dashboard sends those per `pointermove`, so ~60/s for as long as a finger is down, unbounded and
      // outside `logger`. It says nothing new either: a gesture's terminal frame goes through
      // `handleAckedInput`, which answers, so a non-owner attempting real input is already visible there.
      return
    }
    if (session?.agentSocket.readyState === WebSocket.OPEN) {
      session.agentSocket.send(JSON.stringify(msg))
    }
  }

  /** The five inputs an ack answers, so the five that carry a required correlator.
   *
   *  Every exit answers the sender. That is the rule this method exists to hold: a request with a waiter on
   *  a 2s deadline must not be dropped silently, because the caller's fallback reports silence from a
   *  session that has never acked as **success** (#457) — so a silent drop here would report an input that
   *  never left the relay as landed, which is worse than the misrouting it replaced. */
  private handleAckedInput(ws: WebSocket, msg: Acked): void {
    // No `!`: the parameter is narrowed by the door, which is the parse now rather than a predicate.
    const session = this.sessions.get(msg.sessionId)

    if (session && !this.ownsSession(ws, session)) {
      // `not-session-owner` rather than `channel-unavailable`, on that set's own rule — a reason exists per
      // thing a consumer must do differently. That one means reconnect or re-join *this* session; this one
      // means the caller does not hold it, so the move is to join first. It is also the only reason that can
      // promise nothing reached the device, because the refusal happens here, before any agent saw the frame.
      //
      // **Two situations, one reason, different prose** — the treatment `#492` settled for the pair below.
      // Someone else holding the session and nobody holding it want the same *action* (join, and if that is
      // refused pick another device), so splitting the reason would grow the vocabulary for nothing. But one
      // string cannot be true of both: telling a caller the session is in use when it is idle steers it off
      // a device it could have had.
      this.refuseInput(ws, msg, ownershipRefusal(session), 'not-session-owner')
      return
    }

    if (session?.agentSocket.readyState === WebSocket.OPEN) {
      session.agentSocket.send(JSON.stringify(msg))
      return
    }

    // A request that cannot be dispatched. Two situations reach here and only one is the agent's fault:
    // the session may be held with a socket that is no longer open, or there may be no such session —
    // evicted after the reconnect grace, or never valid. In the second the agent can be perfectly healthy,
    // so `agent offline` is a wrong diagnosis, and it is the same pair `device:boot` tells apart above for
    // the same reason. Same two strings as there.
    //
    // The reason is `channel-unavailable` either way, and that is the point rather than an approximation:
    // the set is derived from what a consumer must do differently, and both of these want a reconnect or a
    // re-join. The machine field was right for both while the prose was wrong for one (#492).
    this.refuseInput(ws, msg, session ? 'agent offline' : 'Session not found', 'channel-unavailable')
  }

  /**
   * Tells the sender its payload was refused, in the shape that request's own waiter reads.
   *
   * **This is what keeps the door from turning an answered failure into silence.** Before it, a
   * malformed `open-url` reached the agent and the agent's own guard answered `open-url:error`;
   * `IOSAgent.ts` says so beside that guard, and names this validation as what would take it over.
   * Taking the responsibility without taking the answer would have been a regression — worst on the
   * inputs, and not obviously: `awaitInputAck` reports silence from a session that has never acked as
   * **success** (#457), so a dropped `input:key` reads to an MCP caller as an input that landed.
   *
   * The address and the correlator come from the envelope, which `parseInbound` judges separately from
   * the payload for exactly this reason — a frame with a good envelope carries everything a reply
   * needs. `reason: 'malformed'` is not a new member; the input vocabulary already had it, and until
   * now only agents produced it.
   *
   * No ownership check, deliberately: the reply goes to the socket that sent the frame and says only
   * that its own message was malformed, so it discloses nothing about the session. Every other refusal
   * in this file answers a question about the session's state and is gated for that reason.
   */
  private refuseMalformed(ws: WebSocket, f: Extract<ParseFailure, { reason: 'bad-payload' }>): void {
    if (ws.readyState !== WebSocket.OPEN) return
    const { sessionId, requestId } = f
    const message = `malformed ${f.type} payload`
    switch (f.type) {
      case 'device:boot':     this.sendTo(ws, { type: 'device:boot-error', sessionId, requestId, message }); break
      case 'app:install':     this.sendTo(ws, { type: 'app:install-error', sessionId, requestId, message }); break
      case 'app:launch':      this.sendTo(ws, { type: 'app:launch-error', sessionId, requestId, message }); break
      case 'app:clear-state': this.sendTo(ws, { type: 'app:clear-state-error', sessionId, requestId, message }); break
      case 'open-url':        this.sendTo(ws, { type: 'open-url:error', sessionId, requestId, message }); break
      // Its waiters key on the `input:type-*` pair and ignore an `input:error` entirely — the same
      // reason `refuseInput` below splits these two.
      case 'input:type':
        this.sendTo(ws, { type: 'input:type-error', sessionId, requestId, message, reason: 'malformed' }); break
      case 'clipboard:read':
      case 'clipboard:write': this.sendTo(ws, { type: 'clipboard:error', sessionId, requestId, message }); break
      case 'network:set':     this.sendTo(ws, { type: 'network:error', sessionId, requestId, message }); break
      // The four remaining acked inputs. A `default` rather than four labels because the union is
      // closed and exhaustive: adding a fourteenth answerable request without a case here would land
      // it on `input:error`, which `answerableRequestsAnswered` is what stops.
      default:
        this.sendTo(ws, { type: 'input:error', sessionId, requestId, message, reason: 'malformed' })
    }
  }

  /** Answers the sender in the shape its waiter is keyed on.
   *
   *  `input:type` needs `input:type-error`, not `input:error` — its waiters in `mcp-server` and
   *  `flow-runner` match on the `input:type-*` pair and ignore an `input:error` entirely. That is why
   *  adding `input:type` to the terminal set was never the fix for it, and answering it properly here is
   *  closes the gap `relay/AGENTS.md` recorded: before L5c an `input:type` on an offline agent got nothing
   *  and burned its caller's full deadline. */
  private refuseInput(
    ws: WebSocket,
    msg: Acked,
    message: string,
    reason: InputErrorReason,
  ): void {
    if (ws.readyState !== WebSocket.OPEN) return
    const { sessionId, requestId } = { sessionId: msg.sessionId, requestId: msg.requestId }
    this.sendTo(ws, msg.type === 'input:type'
      ? { type: 'input:type-error', sessionId, requestId, message, reason }
      : { type: 'input:error', sessionId, requestId, message, reason })
  }

  /** Relay looks up file_path from DB and enriches it for the agent.
   *
   *  Every exit carries the request's `sessionId`, including the failures. A dashboard viewer holds
   *  one session per socket, so an uncorrelated error still lands somewhere sensible — but an MCP
   *  caller waits for the reply matching its own sessionId, so anything else is indistinguishable
   *  from silence and it waits out the deadline (#445). `Session not found` is app-specific for the
   *  same reason: a generic `error` cannot be correlated by construction. */
  private handleBrowserAppInstall(ws: WebSocket, msg: Inbound<'app:install'>): void {
    const sessionId = msg.sessionId
    const { requestId } = msg
    // Closing over the narrowed correlator covers all four failure exits at once. It does **not** cover a
    // fifth: a throw out of `getDb().prepare(…).get(…)` — SQLITE_BUSY, a closed db, I/O — unwinds to the
    // message-loop catch and answers nothing at all. Pre-existing and unchanged here, but "every exit
    // carries the request's id" would be false.
    const fail = (message: string) => this.sendTo(ws, { type: 'app:install-error', sessionId, requestId, message })

    const session = this.sessions.get(sessionId)
    if (!session) return fail('Session not found')
    // Ownership only, and **not** `dispatchTarget`: that resolver also decides agent liveness, and using it
    // here would move the `agent offline` check ahead of the build lookup below — changing which of two
    // simultaneous problems the caller is told about. Until L5c this branch asked whether the session
    // existed and not who was asking, so a socket that never joined could install a build onto a device
    // someone else was testing, with the reply going to that session's browser rather than to it.
    if (!this.ownsSession(ws, session)) return fail(ownershipRefusal(session))

    // The schema already refused a non-integer `buildId`, so this is now belt-and-braces rather than
    // the only guard. Kept because it is also the *answer*: the parser drops a bad frame silently and
    // No `Number.isInteger` guard here any more: `buildId` is `z.number().int()` at the door, and a bad
    // one is answered there by `refuseMalformed` with a diagnosis this branch could not give — "not
    // found" describes a lookup, and for a malformed id no lookup ran. The guard existed because
    // better-sqlite3 binds a missing value as NULL but **throws** on an object or array, and that
    // exception was swallowed by the message-loop catch; the door makes both unreachable.
    const build = getDb()
      .prepare('SELECT file_path, bundle_id FROM builds WHERE id = ?')
      .get(msg.buildId) as { file_path: string; bundle_id: string | null } | undefined
    if (!build) return fail('Build not found')

    // Answer now rather than letting the caller time out — the same shape as `open-url` above.
    if (session.agentSocket.readyState !== WebSocket.OPEN) return fail('agent offline')

    // The correlator rides across the rebuild. `open-url` got this for free — the relay re-serialises
    // that message whole — but this is a *different* message from the one the browser sent, and the
    // agent's reply is forwarded back generically without the relay looking at it. So if the id does not
    // reach the agent, nothing downstream can attribute the reply. Nothing type-checks that the value is
    // the *request's*: a brand cannot express provenance, so a test carries it.
    this.sendTo(session.agentSocket, {
      type: 'app:install',
      sessionId,
      requestId,
      payload: { filePath: build.file_path, bundleId: build.bundle_id },
    })
  }

  /** Relay looks up bundle_id from DB. Same correlation rules as `handleBrowserAppInstall`. */
  private handleBrowserAppLaunch(ws: WebSocket, msg: Inbound<'app:launch'>): void {
    const sessionId = msg.sessionId
    const { requestId } = msg
    // Closing over the narrowed correlator covers all four failure exits at once. It does **not** cover a
    // fifth: a throw out of `getDb().prepare(…).get(…)` — SQLITE_BUSY, a closed db, I/O — unwinds to the
    // message-loop catch and answers nothing at all. Pre-existing and unchanged here, but "every exit
    // carries the request's id" would be false.
    const fail = (message: string) => this.sendTo(ws, { type: 'app:launch-error', sessionId, requestId, message })

    const session = this.sessions.get(sessionId)
    if (!session) return fail('Session not found')
    // Ownership only, and **not** `dispatchTarget`: that resolver also decides agent liveness, and using it
    // here would move the `agent offline` check ahead of the build lookup below — changing which of two
    // simultaneous problems the caller is told about. Until L5c this branch asked whether the session
    // existed and not who was asking, so a socket that never joined could install a build onto a device
    // someone else was testing, with the reply going to that session's browser rather than to it.
    if (!this.ownsSession(ws, session)) return fail(ownershipRefusal(session))

    // See `handleBrowserAppInstall` — the door refuses a malformed id and answers it.
    const build = getDb()
      .prepare('SELECT bundle_id FROM builds WHERE id = ?')
      .get(msg.buildId) as { bundle_id: string | null } | undefined
    if (!build?.bundle_id) return fail('Bundle ID not available for this build')

    if (session.agentSocket.readyState !== WebSocket.OPEN) return fail('agent offline')

    // See `handleBrowserAppInstall` — the correlator rides across the rebuild, and only a test says the
    // value is the request's.
    this.sendTo(session.agentSocket, {
      type: 'app:launch',
      sessionId,
      requestId,
      payload: { bundleId: build.bundle_id },
    })
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

      this.sendTo(session.agentSocket, { type: 'screenshot:request', sessionId, requestId, format })
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

      this.sendTo(session.agentSocket, { type: 'ui:tree:request', sessionId, requestId })
    })
  }

  private handleUITreeResponse(msg: Inbound<'ui:tree:response'>): void {
    const pending = this.pendingUITrees.get(msg.requestId)
    if (!pending) return
    pending.resolve(msg.elements)
  }

  private handleUITreeError(msg: Inbound<'ui:tree:error'>): void {
    const pending = this.pendingUITrees.get(msg.requestId)
    if (!pending) return
    // `||`, not `??`: the schema defaults an absent message to `''` rather than leaving it undefined,
    // so the fallback has to treat empty as absent or an older agent's error would read as blank.
    pending.reject(new Error(msg.message || 'UI tree query failed'))
  }

  private handleScreenshotDone(msg: Inbound<'screenshot:done'>): void {
    const pending = this.pendingScreenshots.get(msg.requestId)
    if (!pending) return
    // The `?? ''` / `?? 'png'` these two used to carry are now `.default()`s in the schema, where a
    // reader can see that the tolerance is for an older agent rather than for any absent field.
    const buf = Buffer.from(msg.data, 'base64')
    const claimed = msg.format
    // Logged, **not** overwritten. The field means what the agent says it produced, and correcting it
    // here would make the relay the authority on something only the agent can know — a contract
    // change, where this is a drift detector. It costs four bytes of an already-decoded buffer.
    //
    // Worth having because the consumer-side fix for #508 sniffs the bytes and would otherwise hide a
    // lying agent forever: #508 was found by a person noticing, and nothing would have reported it.
    const actual = sniffImageFormat(buf)
    if (actual !== null && actual !== claimed) {
      logger.warn(
        `[relay] screenshot from session ${msg.sessionId ?? '?'} is ${actual} but the agent called it ` +
        `${claimed} — the Content-Type will be wrong. Upgrade the agent (#508).`,
      )
    }
    pending.resolve(buf, claimed)
  }

  private handleScreenshotError(msg: Inbound<'screenshot:error'>): void {
    const pending = this.pendingScreenshots.get(msg.requestId)
    if (!pending) return
    // `||` for the reason `handleUITreeError` gives.
    pending.reject(new Error(msg.message || 'Screenshot failed'))
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
    // HTML entry points must revalidate on every load so updates are picked up immediately.
    if (urlPath.startsWith('/assets/')) {
      headers['Cache-Control'] = 'public, max-age=31536000, immutable'
    } else if (filePath.endsWith('index.html')) {
      headers['Cache-Control'] = 'no-cache'
    }

    // Serve precompressed siblings (.br or .gz) when accepted (precompressed → no runtime CPU on the stream path).
    const acceptHeader = req.headers['accept-encoding']
    const accept = Array.isArray(acceptHeader) ? acceptHeader.join(',') : acceptHeader ?? ''

    const parseQuality = (codingName: string): number => {
      let quality = -1
      for (const token of accept.split(',')) {
        const [name, ...params] = token.trim().split(';')
        const coding = name.trim().toLowerCase()
        if (coding === codingName || coding === '*') {
          const qParam = params.map((p) => p.trim()).find((p) => p.startsWith('q='))
          const q = qParam ? Number(qParam.slice(2)) : 1
          if (!Number.isNaN(q) && q > quality) {
            quality = q
          }
        }
      }
      return quality
    }

    const brQ = parseQuality('br')
    const gzQ = Math.max(parseQuality('gzip'), parseQuality('x-gzip'))

    const hasBr = fs.existsSync(filePath + '.br')
    const hasGz = fs.existsSync(filePath + '.gz')

    // Vary whenever a compressed variant exists, even if raw is served, so caches don't cross-serve.
    if (hasBr || hasGz) headers['Vary'] = 'Accept-Encoding'

    let servePath = filePath
    if (brQ > 0 && hasBr && (gzQ <= 0 || !hasGz || brQ >= gzQ)) {
      servePath = filePath + '.br'
      headers['Content-Encoding'] = 'br'
    } else if (gzQ > 0 && hasGz) {
      servePath = filePath + '.gz'
      headers['Content-Encoding'] = 'gzip'
    }

    res.writeHead(200, headers)
    fs.createReadStream(servePath)
      .on('error', () => { res.destroy() })
      .pipe(res)
  }
}
