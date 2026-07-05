import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { WebSocketServer, WebSocket } from 'ws'
import { TapflowClient } from '../client.js'

function createMockRelay(): {
  wss: WebSocketServer
  port: number
  lastClient: () => WebSocket
  send: (msg: Record<string, unknown>) => void
  sentMessages: () => Record<string, unknown>[]
  close: () => Promise<void>
} {
  const wss = new WebSocketServer({ port: 0 })
  const received: Record<string, unknown>[] = []
  let conn: WebSocket | null = null

  wss.on('connection', (ws) => {
    conn = ws
    ws.on('message', (data) => {
      try { received.push(JSON.parse(data.toString()) as Record<string, unknown>) } catch { /* ignore */ }
    })
  })

  const port = (wss.address() as { port: number }).port

  return {
    wss,
    port,
    lastClient: () => conn!,
    send: (msg) => conn?.send(JSON.stringify(msg)),
    sentMessages: () => received,
    close: () => new Promise((resolve) => wss.close(() => resolve())),
  }
}

function waitForMessage(relay: ReturnType<typeof createMockRelay>, type: string, timeoutMs = 2000) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const check = setInterval(() => {
      const found = relay.sentMessages().find((m) => m['type'] === type)
      if (found) { clearInterval(check); clearTimeout(timer); resolve(found) }
    }, 10)
    const timer = setTimeout(() => {
      clearInterval(check)
      reject(new Error(`waitForMessage: timed out waiting for type "${type}"`))
    }, timeoutMs)
  })
}

describe('TapflowClient', () => {
  let relay: ReturnType<typeof createMockRelay>
  let client: TapflowClient

  beforeEach(async () => {
    relay = createMockRelay()
    client = new TapflowClient(`ws://localhost:${relay.port}`, 'tflw_pat_test')
    await client.connect()
  })

  afterEach(async () => {
    client.disconnect()
    await relay.close()
  })

  describe('listDevices', () => {
    it('sends agents:list and returns sessions from agents:listed', async () => {
      const sessions = [{ agentName: 'MyMac', devices: [{ id: 'dev-1', name: 'iPhone', sessionId: 'sess-1', platform: 'ios', status: 'shutdown', busy: false }] }]
      setTimeout(() => relay.send({ type: 'agents:listed', sessions }), 10)

      const [result, msg] = await Promise.all([
        client.listDevices(),
        waitForMessage(relay, 'agents:list'),
      ])

      expect(result).toEqual(sessions)
      expect(msg).toMatchObject({ type: 'agents:list' })
    })

    it('returns empty array when sessions is missing', async () => {
      setTimeout(() => relay.send({ type: 'agents:listed' }), 10)
      const result = await client.listDevices()
      expect(result).toEqual([])
    })
  })

  describe('connectDevice', () => {
    it('sends session:start and resolves on session:joined', async () => {
      setTimeout(() => relay.send({ type: 'session:joined', sessionId: 'sess-1' }), 10)
      const [, msg] = await Promise.all([
        client.connectDevice('sess-1'),
        waitForMessage(relay, 'session:start'),
      ])
      expect(msg).toMatchObject({ type: 'session:start', sessionId: 'sess-1' })
    })

    it('throws on session busy error', async () => {
      setTimeout(() => relay.send({ type: 'error', message: 'Session busy' }), 10)
      await expect(client.connectDevice('sess-1')).rejects.toThrow('Session busy')
    })

    it('throws on session not found error', async () => {
      setTimeout(() => relay.send({ type: 'error', message: 'Session not found' }), 10)
      await expect(client.connectDevice('sess-1')).rejects.toThrow('Session not found')
    })
  })

  describe('disconnectDevice', () => {
    it('sends session:leave', async () => {
      client.disconnectDevice('sess-1')
      const msg = await waitForMessage(relay, 'session:leave')
      expect(msg).toMatchObject({ type: 'session:leave', sessionId: 'sess-1' })
    })
  })

  describe('bootDevice', () => {
    it('sends device:boot and resolves on device:ready', async () => {
      setTimeout(() => relay.send({ type: 'device:ready', sessionId: 'sess-1' }), 10)
      await expect(client.bootDevice('sess-1', 'dev-1')).resolves.toBeUndefined()
      // Await outbound device:boot arrival; device:ready resolving doesn't guarantee it was recorded (CI race).
      const bootMsg = await waitForMessage(relay, 'device:boot')
      expect(bootMsg).toMatchObject({
        type: 'device:boot',
        sessionId: 'sess-1',
        payload: { deviceId: 'dev-1' },
      })
    })

    it('throws on device:boot-error', async () => {
      setTimeout(() => relay.send({ type: 'device:boot-error', sessionId: 'sess-1', message: 'Boot failed' }), 10)
      await expect(client.bootDevice('sess-1', 'dev-1')).rejects.toThrow('Boot failed')
    })

    it('ignores device:ready for a different sessionId and resolves on the correct one', async () => {
      setTimeout(() => {
        relay.send({ type: 'device:ready', sessionId: 'OTHER' })
        relay.send({ type: 'device:ready', sessionId: 'sess-1' })
      }, 10)
      await expect(client.bootDevice('sess-1', 'dev-1')).resolves.toBeUndefined()
    })
  })

  describe('tap', () => {
    it('sends touch:start then touch:end with coordinates', async () => {
      client.tap('sess-1', 100, 200)
      await waitForMessage(relay, 'input:touch:end')
      const msgs = relay.sentMessages()
      expect(msgs[0]).toMatchObject({ type: 'input:touch:start', sessionId: 'sess-1', payload: { x: 100, y: 200 } })
      expect(msgs[1]).toMatchObject({ type: 'input:touch:end', sessionId: 'sess-1', payload: { x: 100, y: 200 } })
    })
  })

  describe('swipe', () => {
    it('sends touch:start, multiple touch:move, and touch:end', async () => {
      await client.swipe('sess-1', 0, 0, 100, 100, 80)
      await waitForMessage(relay, 'input:touch:end')
      const msgs = relay.sentMessages()
      expect(msgs[0]).toMatchObject({ type: 'input:touch:start', payload: { x: 0, y: 0 } })
      expect(msgs[msgs.length - 1]).toMatchObject({ type: 'input:touch:end', payload: { x: 100, y: 100 } })
      const moves = msgs.filter((m) => m['type'] === 'input:touch:move')
      expect(moves.length).toBe(7) // STEPS - 1
    })
  })

  describe('typeText', () => {
    it('sends input:type with text', async () => {
      client.typeText('sess-1', 'hello')
      const msg = await waitForMessage(relay, 'input:type')
      expect(msg).toMatchObject({ type: 'input:type', sessionId: 'sess-1', payload: { text: 'hello' } })
    })
  })

  describe('pressKey', () => {
    it('sends input:key with key name', async () => {
      client.pressKey('sess-1', 'Return')
      const msg = await waitForMessage(relay, 'input:key')
      expect(msg).toMatchObject({ type: 'input:key', sessionId: 'sess-1', payload: { key: 'Return' } })
    })
  })

  describe('pressButton', () => {
    it('sends input:button with button name', async () => {
      client.pressButton('sess-1', 'home')
      const msg = await waitForMessage(relay, 'input:button')
      expect(msg).toMatchObject({ type: 'input:button', sessionId: 'sess-1', payload: { button: 'home' } })
    })
  })

  describe('installApp', () => {
    it('sends app:install and resolves on app:install-done', async () => {
      setTimeout(() => relay.send({ type: 'app:install-done', sessionId: 'sess-1' }), 10)
      await expect(client.installApp('sess-1', 42)).resolves.toBeUndefined()
      // Await the outbound message's arrival (same ws race as bootDevice above).
      expect(await waitForMessage(relay, 'app:install')).toMatchObject({ type: 'app:install', sessionId: 'sess-1', buildId: 42 })
    })

    it('throws on app:install-error', async () => {
      setTimeout(() => relay.send({ type: 'app:install-error', sessionId: 'sess-1', message: 'Build not found' }), 10)
      await expect(client.installApp('sess-1', 99)).rejects.toThrow('Build not found')
    })
  })

  describe('launchApp', () => {
    it('sends app:launch and resolves on app:launch-done', async () => {
      setTimeout(() => relay.send({ type: 'app:launch-done', sessionId: 'sess-1' }), 10)
      await expect(client.launchApp('sess-1', 42)).resolves.toBeUndefined()
    })

    it('throws on app:launch-error', async () => {
      setTimeout(() => relay.send({ type: 'app:launch-error', sessionId: 'sess-1', message: 'Bundle ID not available' }), 10)
      await expect(client.launchApp('sess-1', 99)).rejects.toThrow('Bundle ID not available')
    })
  })

  describe('screenshot', () => {
    it('calls REST endpoint with PAT and returns buffer', async () => {
      const fakePng = Buffer.from([0x89, 0x50, 0x4e, 0x47])
      const origFetch = globalThis.fetch

      globalThis.fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
        expect(String(url)).toContain('/api/v1/sessions/sess-1/screenshot')
        expect((init?.headers as Record<string, string>)['Authorization']).toBe('Bearer tflw_pat_test')
        return new Response(fakePng, { status: 200, headers: { 'Content-Type': 'image/png' } })
      }

      try {
        const buf = await client.screenshot('sess-1')
        expect(buf).toEqual(fakePng)
      } finally {
        globalThis.fetch = origFetch
      }
    })

    it('uses jpeg format query param when requested', async () => {
      const origFetch = globalThis.fetch
      globalThis.fetch = async (url: RequestInfo | URL) => {
        expect(String(url)).toContain('format=jpeg')
        return new Response(Buffer.from([0xff, 0xd8]), { status: 200, headers: { 'Content-Type': 'image/jpeg' } })
      }
      try {
        await client.screenshot('sess-1', 'jpeg')
      } finally {
        globalThis.fetch = origFetch
      }
    })

    it('throws on 401', async () => {
      const origFetch = globalThis.fetch
      globalThis.fetch = async () =>
        new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } })
      try {
        await expect(client.screenshot('sess-1')).rejects.toThrow('Unauthorized')
      } finally {
        globalThis.fetch = origFetch
      }
    })
  })

  describe('queryUITree', () => {
    const ELEMENTS = [
      {
        role: 'button',
        label: 'Login',
        identifier: 'com.example.app:id/login',
        frame: { x: 0.25, y: 0.5, width: 0.5, height: 0.0625 },
        enabled: true,
        rawRole: 'android.widget.Button',
      },
    ]

    it('calls the ui-tree REST endpoint with PAT and returns elements', async () => {
      const origFetch = globalThis.fetch
      globalThis.fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
        expect(String(url)).toContain('/api/v1/sessions/sess-1/ui-tree')
        expect((init?.headers as Record<string, string>)['Authorization']).toBe('Bearer tflw_pat_test')
        return new Response(JSON.stringify({ elements: ELEMENTS }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      try {
        const elements = await client.queryUITree('sess-1')
        expect(elements).toEqual(ELEMENTS)
      } finally {
        globalThis.fetch = origFetch
      }
    })

    it('falls back to the response text when the error body is not JSON', async () => {
      const origFetch = globalThis.fetch
      globalThis.fetch = async () =>
        new Response('Bad Gateway', { status: 502, headers: { 'Content-Type': 'text/plain' } })
      try {
        await expect(client.queryUITree('sess-1')).rejects.toThrow('Bad Gateway')
      } finally {
        globalThis.fetch = origFetch
      }
    })

    it('surfaces the relay error body (e.g. 502 dump failure) as an exception', async () => {
      const origFetch = globalThis.fetch
      globalThis.fetch = async () =>
        new Response(JSON.stringify({ error: 'uiautomator dump produced no XML within 10s' }), {
          status: 502,
          headers: { 'Content-Type': 'application/json' },
        })
      try {
        await expect(client.queryUITree('sess-1')).rejects.toThrow('uiautomator dump produced no XML')
      } finally {
        globalThis.fetch = origFetch
      }
    })
  })

  describe('WebSocket lifecycle', () => {
    it('rejects pending waiters when WS closes', async () => {
      const promise = client.listDevices()
      relay.lastClient().close()
      await expect(promise).rejects.toThrow('WebSocket closed')
    })
  })
})
