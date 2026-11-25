import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { rmSync } from 'node:fs'
import { WebSocketServer, type WebSocket } from 'ws'
import { describe, expect, it, vi } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { EnvironmentStepError, TransientQueryError } from '@tapflowio/flow-runner'
import type { SessionAgentAway, SessionRebound, SessionTerminated } from '@tapflowio/protocol'
import { TapflowClient } from '../client.js'
import { registerTools } from '../tools.js'

const sessionId = 'screenshot-session'
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=', 'base64')
type Lifecycle = SessionAgentAway | SessionRebound | SessionTerminated

async function fixture(mode: 'image' | '503' | 'pending' = 'image') {
  let requestArrived: () => void = () => {}
  let pendingResponse: ServerResponse | undefined
  const requested = new Promise<void>((resolve) => { requestArrived = resolve })
  const http = createServer((_req, res) => {
    requestArrived()
    if (mode === 'pending') {
      pendingResponse = res
      return
    }
    res.writeHead(mode === '503' ? 503 : 200, { 'Content-Type': mode === '503' ? 'application/json' : 'image/png' })
    res.end(mode === '503' ? JSON.stringify({ error: 'Screenshot temporarily unavailable' }) : png)
  })
  const sockets = new WebSocketServer({ server: http })
  let peer: WebSocket | undefined
  let leftSession: string | undefined
  sockets.on('connection', (ws) => {
    peer = ws
    ws.on('message', (data) => {
      const message = JSON.parse(String(data)) as { type: string; sessionId?: string }
      if (message.type === 'agents:list') ws.send(JSON.stringify({ type: 'agents:listed', sessions: [] }))
      if (message.type === 'session:start') ws.send(JSON.stringify({ type: 'session:joined', sessionId: message.sessionId, capabilities: [] }))
      if (message.type === 'session:leave') leftSession = message.sessionId
    })
  })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  const port = (http.address() as AddressInfo).port
  const client = new TapflowClient(`ws://127.0.0.1:${port}`, 'tflw_pat_test')
  await client.connect()
  const server = new McpServer({ name: 'screenshot-regression', version: '1.0.0' })
  registerTools(server, client)
  const caller = new Client({ name: 'screenshot-caller', version: '1.0.0' })
  const [callerTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), caller.connect(callerTransport)])
  let closedHttp: Promise<void> | undefined
  const stopHttp = () => {
    closedHttp ??= new Promise<void>((resolve) => http.close(() => resolve()))
    http.closeAllConnections()
  }
  return {
    client, requested, stopHttp,
    dropRequest() {
      if (!pendingResponse) throw new Error('Missing pending screenshot request')
      pendingResponse.destroy()
    },
    stopSocket() { peer?.terminate() },
    async lifecycle(message: Lifecycle) {
      if (!peer) throw new Error('Missing fixture WebSocket')
      peer.send(JSON.stringify(message))
      expect(await client.listDevices()).toEqual([])
    },
    async screenshotTool() {
      return await caller.callTool({ name: 'screenshot', arguments: { sessionId } }) as CallToolResult
    },
    async joinDevice() {
      const result = await caller.callTool({ name: 'connect_device', arguments: { sessionId } }) as CallToolResult
      expect(JSON.parse(textOf(result))).toMatchObject({ connected: true, sessionId })
    },
    async leaveDevice() {
      const result = await caller.callTool({ name: 'disconnect_device', arguments: { sessionId } }) as CallToolResult
      expect(JSON.parse(textOf(result))).toMatchObject({ disconnected: true, sessionId })
      expect(await client.listDevices()).toEqual([])
      expect(leftSession).toBe(sessionId)
    },
    async listDevicesTool() {
      return await caller.callTool({ name: 'list_devices' }) as CallToolResult
    },
    async close() {
      await Promise.allSettled([caller.close(), server.close()])
      client.disconnect()
      for (const socket of sockets.clients) socket.terminate()
      await new Promise<void>((resolve) => sockets.close(() => resolve()))
      stopHttp()
      await closedHttp
    },
  }
}

const heldScenarios = [
  { label: 'away', event: { type: 'session:agent-away', sessionId } satisfies Lifecycle, errorType: TransientQueryError, advice: 'nothing is reaching the device' },
  { label: 'rebound', event: { type: 'session:rebound', sessionId, capabilities: [] } satisfies Lifecycle, errorType: EnvironmentStepError, advice: 'needs boot_device again' },
]

const scenarios: Array<{ label: string; event?: Lifecycle; errorType: typeof TransientQueryError | typeof EnvironmentStepError; advice?: string }> = [
  { label: 'ordinary', errorType: TransientQueryError },
  ...heldScenarios,
  { label: 'terminated', event: { type: 'session:terminated', sessionId, reason: 'agent-disconnected' }, errorType: EnvironmentStepError, advice: 'call list_devices and connect_device' },
]

const textOf = (result: CallToolResult) => result.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n')

describe('screenshot transport failures', () => {
  it.each(scenarios.flatMap((scenario) => [1, 2, 3].map((iteration) => ({ ...scenario, iteration }))))(
    'preserves the native cause and $label session advice, run $iteration', async ({ event, errorType, advice }) => {
      const relay = await fixture()
      try {
        if (event) {
          await relay.joinDevice()
          await relay.lifecycle(event)
        }
        relay.stopHttp()
        const error: unknown = await relay.client.screenshot(sessionId).catch((cause: unknown) => cause)
        expect(error).toBeInstanceOf(errorType)
        expect(error).toMatchObject({
          message: expect.stringContaining('ECONNREFUSED'),
          cause: { name: 'TypeError', cause: { code: 'ECONNREFUSED' } },
        })
        const result = await relay.screenshotTool()
        expect(result.isError).toBe(true)
        expect(textOf(result)).toContain('ECONNREFUSED')
        if (advice) {
          expect((error as Error).message).toContain(advice)
          expect(textOf(result)).toContain(advice)
        }
      } finally {
        await relay.close()
      }
    },
  )

  it('reports the relay close detail when the screenshot fetch fails after the relay socket closed', async () => {
    const relay = await fixture()
    try {
      relay.stopHttp()
      relay.stopSocket()
      await expect.poll(() => relay.client.lastCloseCode).toBe(1006)
      const result = await relay.screenshotTool()
      expect(result.isError).toBe(true)
      const text = textOf(result)
      expect(text).toContain('ECONNREFUSED')
      expect(text).toContain('relay closed 1006')
      expect(text).toContain('reconnecting failed')
    } finally {
      await relay.close()
    }
  })

  it('advises rejoining a held rebound session when the relay reconnect fails', async () => {
    const relay = await fixture()
    try {
      await relay.joinDevice()
      await relay.lifecycle({ type: 'session:rebound', sessionId, capabilities: [] })
      relay.stopHttp()
      relay.stopSocket()
      await expect.poll(() => relay.client.lastCloseCode).toBe(1006)
      const result = await relay.screenshotTool()
      expect(result.isError).toBe(true)
      expect(textOf(result)).toContain('ECONNREFUSED')
      expect(textOf(result)).toContain('reconnecting failed')
      expect(textOf(result)).toContain('call connect_device again')
      expect(textOf(result)).not.toContain('boot_device')
      await expect(relay.client.screenshot(sessionId)).rejects.toBeInstanceOf(EnvironmentStepError)
    } finally {
      await relay.close()
    }
  })

  it('advises rejoining when another tool reconnects during a failed screenshot fetch', async () => {
    const relay = await fixture('pending')
    try {
      await relay.joinDevice()
      await relay.lifecycle({ type: 'session:rebound', sessionId, capabilities: [] })
      const pending = relay.screenshotTool()
      await relay.requested
      relay.stopSocket()
      await expect.poll(() => relay.client.lastCloseCode).toBe(1006)
      const list = await relay.listDevicesTool()
      expect(list.isError).not.toBe(true)
      expect(relay.client.lastCloseCode).toBeNull()
      relay.dropRequest()
      const result = await pending
      expect(result.isError).toBe(true)
      expect(textOf(result)).toContain('reconnected to the relay')
      expect(textOf(result)).toContain('call connect_device again')
      expect(textOf(result)).not.toContain('boot_device')
    } finally {
      await relay.close()
    }
  })

  it('preserves the terminated session advice when the relay reconnect fails', async () => {
    const relay = await fixture()
    try {
      await relay.joinDevice()
      await relay.lifecycle({ type: 'session:terminated', sessionId, reason: 'agent-disconnected' })
      relay.stopHttp()
      relay.stopSocket()
      await expect.poll(() => relay.client.lastCloseCode).toBe(1006)
      const result = await relay.screenshotTool()
      expect(result.isError).toBe(true)
      expect(textOf(result)).toContain('reconnecting failed')
      expect(textOf(result)).toContain('the relay ended this session (agent-disconnected)')
      expect(textOf(result)).toContain('call list_devices and connect_device')
    } finally {
      await relay.close()
    }
  })

  it.each(heldScenarios)(
    'drops stale $label advice if the caller leaves while a screenshot is pending', async ({ event, advice }) => {
      const relay = await fixture('pending')
      try {
        await relay.joinDevice()
        await relay.lifecycle(event)
        const pending = relay.screenshotTool()
        await relay.requested
        await relay.leaveDevice()
        relay.dropRequest()
        const result = await pending
        expect(result.isError).toBe(true)
        expect(textOf(result)).toMatch(/^screenshot failed: Screenshot request failed: \S/)
        expect(textOf(result)).not.toContain(advice)
        relay.stopHttp()
        const error: unknown = await relay.client.screenshot(sessionId).catch((cause: unknown) => cause)
        expect(error).toBeInstanceOf(TransientQueryError)
        expect(error).toMatchObject({
          message: expect.stringContaining('ECONNREFUSED'),
          cause: { name: 'TypeError', cause: { code: 'ECONNREFUSED' } },
        })
      } finally {
        await relay.close()
      }
    },
  )

  it('reports the native code when fetch carries an AggregateError with an empty message', async () => {
    const relay = await fixture()
    const cause = Object.assign(new AggregateError([new Error('connect ECONNREFUSED ::1')], ''), { code: 'ECONNREFUSED' })
    const original = new TypeError('fetch failed', { cause })
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(original)
    try {
      const failure: unknown = await relay.client.screenshot(sessionId).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(TransientQueryError)
      expect(failure).toMatchObject({ message: expect.stringContaining('ECONNREFUSED') })
      expect((failure as Error).cause).toBe(original)
    } finally {
      fetch.mockRestore()
      await relay.close()
    }
  })

  it('preserves caller cancellation while a real HTTP request is pending', async () => {
    const relay = await fixture('pending')
    try {
      const controller = new AbortController()
      const reason = new Error('Cancelled by the screenshot caller')
      const pending = relay.client.screenshot(sessionId, 'png', controller.signal)
      const rejected = expect(pending).rejects.toBe(reason)
      await relay.requested
      controller.abort(reason)
      await rejected
    } finally {
      await relay.close()
    }
  })

  it('retains session advice on an HTTP 503 response after rebound', async () => {
    const relay = await fixture('503')
    try {
      await relay.joinDevice()
      await relay.lifecycle({ type: 'session:rebound', sessionId, capabilities: [] })
      await expect(relay.client.screenshot(sessionId)).rejects.toThrow('needs boot_device again')
      const result = await relay.screenshotTool()
      expect(result.isError).toBe(true)
      expect(textOf(result)).toContain('Screenshot temporarily unavailable')
      expect(textOf(result)).toContain('needs boot_device again')
    } finally {
      await relay.close()
    }
  })

  it('still returns image bytes and an MCP image when HTTP succeeds', async () => {
    const relay = await fixture()
    try {
      expect(await relay.client.screenshot(sessionId)).toEqual(png)
      const result = await relay.screenshotTool()
      expect(result.content.find((block) => block.type === 'image')).toMatchObject({ mimeType: 'image/png', data: png.toString('base64') })
      const saved = /Screenshot saved: (.+?) \(/.exec(textOf(result))?.[1]
      expect(saved).toBeTypeOf('string')
      if (saved) rmSync(saved)
    } finally {
      await relay.close()
    }
  })
})
