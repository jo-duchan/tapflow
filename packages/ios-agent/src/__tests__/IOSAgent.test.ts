import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { WebSocket } from 'ws'
import { RelayServer } from '@tapflow/relay'
import { IOSAgent } from '../IOSAgent'
import { SimctlWrapper } from '../SimctlWrapper'

const waitForOpen = (ws: WebSocket) =>
  new Promise<void>((r) => ws.once('open', r))

const waitForMessage = (ws: WebSocket) =>
  new Promise<Record<string, unknown>>((r) =>
    ws.once('message', (d) => r(JSON.parse(d.toString())))
  )

function mockSimctl(): SimctlWrapper {
  return {
    listDevices: vi.fn().mockResolvedValue([
      { id: 'dev-1', name: 'iPhone 15', platform: 'ios', status: 'shutdown' },
    ]),
    boot: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
    installApp: vi.fn().mockResolvedValue(undefined),
    launchApp: vi.fn().mockResolvedValue(undefined),
    screenshot: vi.fn().mockResolvedValue(Buffer.from('png')),
  } as unknown as SimctlWrapper
}

describe('IOSAgent', () => {
  let relay: RelayServer
  let port: number

  beforeEach(async () => {
    relay = new RelayServer({ port: 0 })
    await relay.start()
    port = (relay.address() as { port: number }).port
  })

  afterEach(async () => {
    await relay.stop()
  })

  describe('DeviceAgent delegation', () => {
    it('listDevices delegates to SimctlWrapper', async () => {
      const simctl = mockSimctl()
      const agent = new IOSAgent({}, simctl)
      const devices = await agent.listDevices()
      expect(simctl.listDevices).toHaveBeenCalled()
      expect(devices[0].platform).toBe('ios')
    })

    it('boot delegates to SimctlWrapper', async () => {
      const simctl = mockSimctl()
      const agent = new IOSAgent({}, simctl)
      await agent.boot('dev-1')
      expect(simctl.boot).toHaveBeenCalledWith('dev-1')
    })

    it('shutdown delegates to SimctlWrapper', async () => {
      const simctl = mockSimctl()
      const agent = new IOSAgent({}, simctl)
      await agent.shutdown('dev-1')
      expect(simctl.shutdown).toHaveBeenCalledWith('dev-1')
    })

    it('installApp delegates to SimctlWrapper', async () => {
      const simctl = mockSimctl()
      const agent = new IOSAgent({}, simctl)
      await agent.installApp('/path/App.ipa')
      expect(simctl.installApp).toHaveBeenCalledWith('/path/App.ipa')
    })

    it('launchApp delegates to SimctlWrapper', async () => {
      const simctl = mockSimctl()
      const agent = new IOSAgent({}, simctl)
      await agent.launchApp('com.example.app')
      expect(simctl.launchApp).toHaveBeenCalledWith('com.example.app')
    })
  })

  describe('relay connection', () => {
    it('connects to relay and receives a sessionId', async () => {
      const agent = new IOSAgent({}, mockSimctl())
      await agent.connect(`ws://localhost:${port}`)
      expect(agent.sessionId).toBeDefined()
      agent.disconnect()
    })

    it('sends stream:frame to relay after connecting', async () => {
      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)

      const agent = new IOSAgent({ intervalMs: 50 }, mockSimctl())
      await agent.connect(`ws://localhost:${port}`)

      // browser joins the agent's session
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForMessage(browser) // session:joined

      const frame = await waitForMessage(browser)
      expect(frame.type).toBe('stream:frame')
      expect(typeof frame.payload).toBe('string') // base64

      agent.disconnect()
      browser.close()
    })
  })
})
