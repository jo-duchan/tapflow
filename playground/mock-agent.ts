import os from 'node:os'
import { deflateSync } from 'node:zlib'
import { WebSocket } from 'ws'

const RESOURCES_INTERVAL_MS = 5000
const SLOTS_TOTAL = 3

const RELAY = process.env['RELAY_URL'] ?? 'ws://localhost:4000'
const AGENT_NAME = process.env['MOCK_AGENT_NAME'] ?? `mock-${os.hostname()}`
const DEVICE_COUNT = Math.max(1, parseInt(process.env['DEVICE_COUNT'] ?? '2'))
const FPS = Math.max(1, parseInt(process.env['MOCK_FPS'] ?? '5'))
const FRAME_MS = Math.floor(1000 / FPS)

// agent 이름별 고유 색상 — 대시보드에서 어느 Mock Mac의 스트림인지 구분
const PALETTE: [number, number, number][] = [
  [30, 30, 120],
  [30, 100, 30],
  [120, 30, 30],
  [80, 30, 120],
  [120, 80, 30],
  [30, 100, 100],
]

function djb2(s: string): number {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i)
  return h >>> 0
}

const [frameR, frameG, frameB] = PALETTE[djb2(AGENT_NAME) % PALETTE.length]!

// ── PNG 생성 (순수 Node.js) ──────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[i] = c
  }
  return t
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crcBuf])
}

function solidPNG(w: number, h: number, r: number, g: number, b: number): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

  const ihdrData = Buffer.alloc(13)
  ihdrData.writeUInt32BE(w, 0)
  ihdrData.writeUInt32BE(h, 4)
  ihdrData[8] = 8 // bit depth
  ihdrData[9] = 2 // color type: RGB

  const scanlineLen = 1 + w * 3
  const raw = Buffer.alloc(h * scanlineLen) // filter byte per row = 0 (already)
  for (let y = 0; y < h; y++) {
    const base = y * scanlineLen + 1
    for (let x = 0; x < w; x++) {
      raw[base + x * 3] = r
      raw[base + x * 3 + 1] = g
      raw[base + x * 3 + 2] = b
    }
  }

  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdrData),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

// 390×844 — iPhone 15 Pro 논리 해상도 (단색, 한 번만 생성)
const FRAME = solidPNG(390, 844, frameR, frameG, frameB)

// ── Mock devices ─────────────────────────────────────────────────────────────

const mockDevices = Array.from({ length: DEVICE_COUNT }, (_, i) => ({
  id: `mock-${AGENT_NAME}-dev-${i}`,
  name: `Mock iPhone ${15 + i} Pro`,
  platform: 'ios' as const,
  status: 'shutdown' as const,
  osVersion: 'iOS 18.0',
}))

interface DeviceState {
  sessionId: string
  deviceId: string
  streamWs: WebSocket | null
  streamTimer: ReturnType<typeof setInterval> | null
}

const deviceStates = new Map<string, DeviceState>()
let mainWs: WebSocket | null = null
let resourcesTimer: ReturnType<typeof setInterval> | null = null

function reportResources(): void {
  if (!mainWs || mainWs.readyState !== WebSocket.OPEN) return
  const cpus = os.cpus().length
  const load = os.loadavg()[0]!
  const memTotal = os.totalmem()
  const memUsed = memTotal - os.freemem()
  const bootedCount = Array.from(deviceStates.values()).filter((s) => s.streamTimer !== null).length
  mainWs.send(JSON.stringify({
    type: 'agent:resources',
    resources: {
      cpuPercent: Math.min(100, Math.round((load / cpus) * 1000) / 10),
      memUsedMB: Math.round(memUsed / 1024 / 1024),
      memTotalMB: Math.round(memTotal / 1024 / 1024),
      slotsAvailable: Math.max(0, SLOTS_TOTAL - bootedCount),
      slotsTotal: SLOTS_TOTAL,
      reportedAt: Date.now(),
    },
  }))
}

// ── Stream helpers ────────────────────────────────────────────────────────────

function stopStream(state: DeviceState): void {
  if (state.streamTimer) { clearInterval(state.streamTimer); state.streamTimer = null }
  state.streamWs?.close()
  state.streamWs = null
}

function openStreamWs(sessionId: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const sw = new WebSocket(RELAY)
    sw.once('open', () => sw.send(JSON.stringify({ type: 'stream:register', sessionId })))
    const onMsg = (data: Buffer) => {
      const msg = JSON.parse(data.toString())
      if (msg.type === 'stream:registered') { sw.off('message', onMsg); resolve(sw) }
    }
    sw.on('message', onMsg)
    sw.once('error', reject)
  })
}

// ── Relay message handlers ────────────────────────────────────────────────────

async function handleBoot(sessionId: string): Promise<void> {
  const state = deviceStates.get(sessionId)
  if (!state || !mainWs) return
  stopStream(state)
  mainWs.send(JSON.stringify({ type: 'device:booting', sessionId }))
  mainWs.send(JSON.stringify({
    type: 'session:deviceInfo',
    sessionId,
    payload: { deviceName: `Mock iPhone (${AGENT_NAME})`, osVersion: 'iOS 18.0' },
  }))
  try {
    const sw = await openStreamWs(sessionId)
    state.streamWs = sw
    state.streamTimer = setInterval(() => {
      if (sw.readyState === WebSocket.OPEN) sw.send(FRAME)
    }, FRAME_MS)
    mainWs.send(JSON.stringify({ type: 'device:ready', sessionId, payload: { deviceId: state.deviceId } }))
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    mainWs.send(JSON.stringify({ type: 'device:boot-error', sessionId, message }))
  }
}

function handleShutdown(sessionId: string): void {
  const state = deviceStates.get(sessionId)
  if (!state || !mainWs) return
  stopStream(state)
  mainWs.send(JSON.stringify({ type: 'device:shutdown-done', sessionId, payload: { deviceId: state.deviceId } }))
}

function onRelayMessage(msg: { type: string; sessionId?: string }): void {
  if (msg.type === 'device:boot' && msg.sessionId) {
    handleBoot(msg.sessionId).catch(console.error)
  } else if (msg.type === 'device:shutdown' && msg.sessionId) {
    handleShutdown(msg.sessionId)
  }
}

// ── Connect ───────────────────────────────────────────────────────────────────

async function connect(): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(RELAY)
    sock.once('open', () => {
      sock.send(JSON.stringify({
        type: 'agent:register',
        platform: 'ios',
        agentName: AGENT_NAME,
        devices: mockDevices,
      }))
    })
    sock.once('message', (data) => {
      const msg = JSON.parse(data.toString())
      if (msg.type !== 'agent:registered') {
        reject(new Error(`unexpected: ${msg.type}`))
        return
      }
      mainWs = sock
      for (const { deviceId, sessionId } of msg.registeredSessions as Array<{ deviceId: string; sessionId: string }>) {
        deviceStates.set(sessionId, { sessionId, deviceId, streamWs: null, streamTimer: null })
      }
      sock.on('message', (d) => {
        try { onRelayMessage(JSON.parse(d.toString())) } catch { }
      })
      reportResources()
      resourcesTimer = setInterval(reportResources, RESOURCES_INTERVAL_MS)
      resolve()
    })
    sock.once('error', reject)
  })
}

const MAX_RETRIES = 10
const RETRY_MS = 2000
for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
  try {
    await connect()
    break
  } catch {
    if (attempt === MAX_RETRIES) { console.error(`[${AGENT_NAME}] relay 연결 실패`); process.exit(1) }
    console.log(`[${AGENT_NAME}] relay 준비 안 됨, 재시도 ${attempt}/${MAX_RETRIES}…`)
    await new Promise((r) => setTimeout(r, RETRY_MS))
  }
}

console.log(`[${AGENT_NAME}] connected — ${DEVICE_COUNT} mock devices, ${FPS}fps (rgb: ${frameR},${frameG},${frameB})`)

process.on('SIGINT', () => {
  if (resourcesTimer) clearInterval(resourcesTimer)
  for (const state of deviceStates.values()) stopStream(state)
  mainWs?.close()
  process.exit(0)
})
