import { WebSocket } from 'ws'
import type { UIElement } from '@tapflowio/agent-core'
import { PlatformError } from '@tapflowio/agent-core'

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

type RelayMsg = Record<string, unknown>

interface Waiter {
  predicate: (msg: RelayMsg) => boolean
  resolve: (msg: RelayMsg) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// Minimal relay client for the deterministic runner: WebSocket for session and
// input control, REST for ui-tree and screenshots. Mirrors the message shapes
// the dashboard and mcp-server already use.
export class RelayClient {
  private ws: WebSocket | null = null
  private waiters: Waiter[] = []

  constructor(
    private readonly relayUrl: string,
    private readonly token: string,
  ) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const headers = this.token ? { Authorization: `Bearer ${this.token}` } : undefined
      const ws = new WebSocket(this.relayUrl, { headers })
      ws.once('open', () => {
        this.ws = ws
        resolve()
      })
      ws.once('error', reject)
      ws.on('message', (data, isBinary) => {
        if (isBinary) return
        try {
          this.dispatch(JSON.parse((data as Buffer).toString()) as RelayMsg)
        } catch { /* ignore malformed */ }
      })
      ws.on('close', () => {
        this.ws = null
        for (const w of this.waiters.splice(0)) {
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
      throw new PlatformError('not connected to relay')
    }
    this.ws.send(JSON.stringify(msg))
  }

  private waitFor(predicate: (msg: RelayMsg) => boolean, timeoutMs: number, what: string): Promise<RelayMsg> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.resolve === resolve)
        if (idx !== -1) this.waiters.splice(idx, 1)
        reject(new PlatformError(`${what} timed out`))
      }, timeoutMs)
      this.waiters.push({ predicate, resolve, reject, timer })
    })
  }

  async listDevices(): Promise<AgentSession[]> {
    this.send({ type: 'agents:list' })
    const msg = await this.waitFor((m) => m['type'] === 'agents:listed', 5_000, 'agents:list')
    return (msg['sessions'] as AgentSession[]) ?? []
  }

  async joinSession(sessionId: string): Promise<void> {
    this.send({ type: 'session:start', sessionId })
    const msg = await this.waitFor(
      (m) =>
        (m['type'] === 'session:joined' && m['sessionId'] === sessionId) ||
        (m['type'] === 'error' && (m['sessionId'] === undefined || m['sessionId'] === sessionId)),
      5_000,
      'session join',
    )
    if (msg['type'] === 'error') throw new PlatformError((msg['message'] as string) ?? 'session join failed')
  }

  leaveSession(sessionId: string): void {
    this.send({ type: 'session:leave', sessionId })
  }

  async bootDevice(sessionId: string, deviceId: string): Promise<void> {
    this.send({ type: 'device:boot', sessionId, payload: { deviceId } })
    const msg = await this.waitFor(
      (m) => (m['type'] === 'device:ready' || m['type'] === 'device:boot-error') && m['sessionId'] === sessionId,
      120_000,
      'device boot',
    )
    if (msg['type'] === 'device:boot-error') throw new PlatformError((msg['message'] as string) ?? 'boot failed')
  }

  async installApp(sessionId: string, buildId: number): Promise<void> {
    this.send({ type: 'app:install', sessionId, buildId })
    const msg = await this.waitFor(
      (m) => (m['type'] === 'app:install-done' || m['type'] === 'app:install-error') && m['sessionId'] === sessionId,
      120_000,
      'app install',
    )
    if (msg['type'] === 'app:install-error') throw new PlatformError((msg['message'] as string) ?? 'install failed')
  }

  async launchApp(sessionId: string, buildId: number): Promise<void> {
    this.send({ type: 'app:launch', sessionId, buildId })
    const msg = await this.waitFor(
      (m) => (m['type'] === 'app:launch-done' || m['type'] === 'app:launch-error') && m['sessionId'] === sessionId,
      30_000,
      'app launch',
    )
    if (msg['type'] === 'app:launch-error') throw new PlatformError((msg['message'] as string) ?? 'launch failed')
  }

  async clearState(sessionId: string, bundleId: string): Promise<void> {
    this.send({ type: 'app:clear-state', sessionId, payload: { bundleId } })
    const msg = await this.waitFor(
      (m) => (m['type'] === 'app:clear-state-done' || m['type'] === 'app:clear-state-error') && m['sessionId'] === sessionId,
      30_000,
      'clear state',
    )
    if (msg['type'] === 'app:clear-state-error') throw new PlatformError((msg['message'] as string) ?? 'clear state failed')
  }

  tap(sessionId: string, x: number, y: number): void {
    const payload = { x, y }
    this.send({ type: 'input:touch:start', sessionId, payload })
    this.send({ type: 'input:touch:end', sessionId, payload })
  }

  async swipe(sessionId: string, from: [number, number], to: [number, number], durationMs: number): Promise<void> {
    const STEPS = 8
    const interval = durationMs / STEPS
    this.send({ type: 'input:touch:start', sessionId, payload: { x: from[0], y: from[1] } })
    for (let i = 1; i < STEPS; i++) {
      await delay(interval)
      const t = i / STEPS
      this.send({
        type: 'input:touch:move',
        sessionId,
        payload: { x: from[0] + (to[0] - from[0]) * t, y: from[1] + (to[1] - from[1]) * t },
      })
    }
    await delay(interval)
    this.send({ type: 'input:touch:end', sessionId, payload: { x: to[0], y: to[1] } })
  }

  typeText(sessionId: string, text: string): void {
    this.send({ type: 'input:type', sessionId, payload: { text } })
  }

  pressKey(sessionId: string, code: string): void {
    this.send({ type: 'input:key', sessionId, payload: { code, modifiers: 0 } })
  }

  async openUrl(sessionId: string, url: string): Promise<void> {
    this.send({ type: 'open-url', sessionId, payload: { url } })
    const msg = await this.waitFor(
      (m) => (m['type'] === 'open-url:done' || m['type'] === 'open-url:error') && m['sessionId'] === sessionId,
      15_000,
      'open url',
    )
    if (msg['type'] === 'open-url:error') throw new PlatformError((msg['message'] as string) ?? 'open url failed')
  }

  private httpBase(): string {
    return this.relayUrl.replace(/^wss?/, (p) => (p === 'wss' ? 'https' : 'http'))
  }

  private async getJson<T>(path: string, what: string): Promise<T> {
    const res = await fetch(new URL(path, this.httpBase()).toString(), {
      headers: this.token ? { Authorization: `Bearer ${this.token}` } : undefined,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      let message = text || `${what} failed: ${res.status}`
      try {
        const body = JSON.parse(text) as { error?: string }
        if (body.error) message = body.error
      } catch { /* keep raw text */ }
      throw new PlatformError(message)
    }
    return (await res.json()) as T
  }

  async queryUITree(sessionId: string): Promise<UIElement[]> {
    const body = await this.getJson<{ elements?: UIElement[] }>(`/api/v1/sessions/${sessionId}/ui-tree`, 'ui-tree query')
    return body.elements ?? []
  }

  async screenshot(sessionId: string): Promise<Buffer> {
    const res = await fetch(new URL(`/api/v1/sessions/${sessionId}/screenshot`, this.httpBase()).toString(), {
      headers: this.token ? { Authorization: `Bearer ${this.token}` } : undefined,
    })
    if (!res.ok) throw new PlatformError(`screenshot failed: ${res.status}`)
    return Buffer.from(await res.arrayBuffer())
  }
}
