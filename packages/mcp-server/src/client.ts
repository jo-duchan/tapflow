import { WebSocket } from 'ws'

export interface DeviceInfo {
  id: string
  name: string
  platform: string
  status: string
  osVersion?: string
  sessionId: string
  busy: boolean
}

export interface AgentSession {
  agentName?: string
  platform?: string
  devices: DeviceInfo[]
}

export interface BuildInfo {
  id: number
  versionName: string
  buildNumber: string
  platform: string
  statusLabel: string | null
  createdAt: string
}

export interface AppInfo {
  id: number
  name: string
  bundleId: string
  platform: string
  builds: BuildInfo[]
}

// Unified element schema produced agent-side (mirrors @tapflowio/agent-core UIElement).
// Frames are normalized 0-1 in the same coordinate space the tap path consumes.
export interface UIElement {
  role: 'button' | 'text' | 'input' | 'image' | 'checkbox' | 'switch' | 'slider' | 'list' | 'cell' | 'tab' | 'other'
  label: string
  identifier?: string
  frame: { x: number; y: number; width: number; height: number }
  enabled: boolean
  rawRole?: string
}

type RelayMsg = Record<string, unknown>

interface Waiter {
  predicate: (msg: RelayMsg) => boolean
  resolve: (msg: RelayMsg) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export class TapflowClient {
  private ws: WebSocket | null = null
  private waiters: Waiter[] = []

  constructor(
    private readonly relayUrl: string,
    readonly token: string,
  ) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.relayUrl)
      ws.once('open', () => {
        this.ws = ws
        resolve()
      })
      ws.once('error', reject)
      ws.on('message', (data, isBinary) => {
        if (isBinary) return
        try {
          const msg = JSON.parse((data as Buffer).toString()) as RelayMsg
          this.dispatch(msg)
        } catch { /* ignore malformed */ }
      })
      ws.on('close', () => {
        this.ws = null
        const pending = this.waiters.splice(0)
        for (const w of pending) {
          clearTimeout(w.timer)
          w.reject(new Error('WebSocket closed'))
        }
      })
    })
  }

  disconnect(): void {
    this.ws?.close()
    this.ws = null
  }

  private dispatch(msg: RelayMsg): void {
    for (let i = 0; i < this.waiters.length; i++) {
      if (this.waiters[i].predicate(msg)) {
        const [w] = this.waiters.splice(i, 1)
        clearTimeout(w.timer)
        w.resolve(msg)
        return
      }
    }
  }

  private send(msg: RelayMsg): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected to relay')
    }
    this.ws.send(JSON.stringify(msg))
  }

  private waitFor(predicate: (msg: RelayMsg) => boolean, timeoutMs: number): Promise<RelayMsg> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.resolve === resolve)
        if (idx !== -1) this.waiters.splice(idx, 1)
        reject(new Error('Request timed out'))
      }, timeoutMs)
      this.waiters.push({ predicate, resolve, reject, timer })
    })
  }

  async listDevices(): Promise<AgentSession[]> {
    this.send({ type: 'agents:list' })
    const msg = await this.waitFor((m) => m['type'] === 'agents:listed', 5_000)
    return (msg['sessions'] as AgentSession[]) ?? []
  }

  async connectDevice(sessionId: string): Promise<void> {
    this.send({ type: 'session:start', sessionId })
    const msg = await this.waitFor(
      (m) =>
        (m['type'] === 'session:joined' && m['sessionId'] === sessionId) ||
        (m['type'] === 'error' && (m['sessionId'] === undefined || m['sessionId'] === sessionId)),
      5_000,
    )
    if (msg['type'] === 'error') throw new Error((msg['message'] as string) ?? 'Connect failed')
  }

  disconnectDevice(sessionId: string): void {
    this.send({ type: 'session:leave', sessionId })
  }

  async bootDevice(sessionId: string, deviceId: string): Promise<void> {
    this.send({ type: 'device:boot', sessionId, payload: { deviceId } })
    const msg = await this.waitFor(
      (m) =>
        (m['type'] === 'device:ready' || m['type'] === 'device:boot-error') &&
        m['sessionId'] === sessionId,
      30_000,
    )
    if (msg['type'] === 'device:boot-error') {
      throw new Error((msg['message'] as string) ?? 'Boot failed')
    }
  }

  tap(sessionId: string, x: number, y: number): void {
    const payload = { x, y }
    this.send({ type: 'input:touch:start', sessionId, payload })
    this.send({ type: 'input:touch:end', sessionId, payload })
  }

  async swipe(
    sessionId: string,
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    durationMs = 300,
  ): Promise<void> {
    const STEPS = 8
    const interval = durationMs / STEPS

    this.send({ type: 'input:touch:start', sessionId, payload: { x: startX, y: startY } })
    for (let i = 1; i < STEPS; i++) {
      await delay(interval)
      const t = i / STEPS
      this.send({
        type: 'input:touch:move',
        sessionId,
        payload: {
          x: Math.round(startX + (endX - startX) * t),
          y: Math.round(startY + (endY - startY) * t),
        },
      })
    }
    await delay(interval)
    this.send({ type: 'input:touch:end', sessionId, payload: { x: endX, y: endY } })
  }

  typeText(sessionId: string, text: string): void {
    this.send({ type: 'input:type', sessionId, payload: { text } })
  }

  pressKey(sessionId: string, key: string): void {
    this.send({ type: 'input:key', sessionId, payload: { key } })
  }

  pressButton(sessionId: string, button: string): void {
    this.send({ type: 'input:button', sessionId, payload: { button } })
  }

  async installApp(sessionId: string, buildId: number): Promise<void> {
    this.send({ type: 'app:install', sessionId, buildId })
    const msg = await this.waitFor(
      (m) =>
        (m['type'] === 'app:install-done' || m['type'] === 'app:install-error') &&
        m['sessionId'] === sessionId,
      60_000,
    )
    if (msg['type'] === 'app:install-error') {
      throw new Error((msg['message'] as string) ?? 'Install failed')
    }
  }

  async launchApp(sessionId: string, buildId: number): Promise<void> {
    this.send({ type: 'app:launch', sessionId, buildId })
    const msg = await this.waitFor(
      (m) =>
        (m['type'] === 'app:launch-done' || m['type'] === 'app:launch-error') &&
        m['sessionId'] === sessionId,
      15_000,
    )
    if (msg['type'] === 'app:launch-error') {
      throw new Error((msg['message'] as string) ?? 'Launch failed')
    }
  }

  async screenshot(sessionId: string, format: 'png' | 'jpeg' = 'png'): Promise<Buffer> {
    const httpBase = this.relayUrl.replace(/^wss?/, (p) => (p === 'wss' ? 'https' : 'http'))
    const url = new URL(`/api/v1/sessions/${sessionId}/screenshot`, httpBase)
    if (format === 'jpeg') url.searchParams.set('format', 'jpeg')
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${this.token}` },
    })
    if (!res.ok) {
      let message: string
      try {
        const body = (await res.json()) as { error?: string }
        message = body.error ?? `Screenshot failed: ${res.status}`
      } catch {
        message = (await res.text().catch(() => '')) || `Screenshot failed: ${res.status}`
      }
      throw new Error(message)
    }
    return Buffer.from(await res.arrayBuffer())
  }

  async queryUITree(sessionId: string): Promise<UIElement[]> {
    const httpBase = this.relayUrl.replace(/^wss?/, (p) => (p === 'wss' ? 'https' : 'http'))
    const url = new URL(`/api/v1/sessions/${sessionId}/ui-tree`, httpBase)
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${this.token}` },
    })
    if (!res.ok) {
      let message: string
      try {
        const body = (await res.json()) as { error?: string }
        message = body.error ?? `UI tree query failed: ${res.status}`
      } catch {
        message = (await res.text().catch(() => '')) || `UI tree query failed: ${res.status}`
      }
      throw new Error(message)
    }
    const body = (await res.json()) as { elements?: UIElement[] }
    return body.elements ?? []
  }

  async listBuilds(): Promise<AppInfo[]> {
    const httpBase = this.relayUrl.replace(/^wss?/, (p) => (p === 'wss' ? 'https' : 'http'))
    const headers = { Authorization: `Bearer ${this.token}` }

    const [appsRes, buildsRes] = await Promise.all([
      fetch(new URL('/api/v1/apps', httpBase).toString(), { headers }),
      fetch(new URL('/api/v1/builds', httpBase).toString(), { headers }),
    ])

    if (!appsRes.ok) throw new Error(`Failed to fetch apps: ${appsRes.status}`)
    if (!buildsRes.ok) throw new Error(`Failed to fetch builds: ${buildsRes.status}`)

    const apps = (await appsRes.json()) as Array<{ id: number; name: string; bundle_id: string; platform: string }>
    const builds = (await buildsRes.json()) as Array<{
      id: number
      app_id: number
      version_name: string
      build_number: string
      platform: string
      status_label: string | null
      created_at: string
    }>

    return apps.map((app) => ({
      id: app.id,
      name: app.name,
      bundleId: app.bundle_id,
      platform: app.platform,
      builds: builds
        .filter((b) => b.app_id === app.id)
        .map((b) => ({
          id: b.id,
          versionName: b.version_name,
          buildNumber: b.build_number,
          platform: b.platform,
          statusLabel: b.status_label,
          createdAt: b.created_at,
        })),
    }))
  }
}
