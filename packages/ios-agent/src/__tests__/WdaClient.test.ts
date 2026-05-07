import { describe, it, expect, vi, beforeEach } from 'vitest'
import { WdaClient } from '../WdaClient'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function okResponse(body: unknown = {}) {
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))
}

describe('WdaClient', () => {
  beforeEach(() => {
    mockFetch.mockReset()
  })

  describe('getSessionId', () => {
    it('fetches session from WDA and returns sessionId', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ sessionId: 'abc-123', value: {} }), { status: 200 })
      )
      const client = new WdaClient()
      const id = await client.getSessionId()
      expect(id).toBe('abc-123')
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8100/session',
        expect.objectContaining({ method: 'POST' })
      )
    })

    it('throws when WDA is not running', async () => {
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'))
      const client = new WdaClient()
      await expect(client.getSessionId()).rejects.toThrow('WDA is not running')
    })
  })

  describe('tap', () => {
    it('posts pointer action to WDA session', async () => {
      mockFetch
        .mockResolvedValueOnce(new Response(JSON.stringify({ sessionId: 'sid-1' }), { status: 200 }))
        .mockResolvedValueOnce(okResponse())
      const client = new WdaClient()
      await client.tap(100, 200)
      const [url, init] = mockFetch.mock.calls[1]
      expect(url).toBe('http://localhost:8100/session/sid-1/actions')
      const body = JSON.parse(init.body)
      const action = body.actions[0].actions
      expect(action).toContainEqual(expect.objectContaining({ type: 'pointerMove', x: 100, y: 200 }))
      expect(action).toContainEqual(expect.objectContaining({ type: 'pointerDown' }))
      expect(action).toContainEqual(expect.objectContaining({ type: 'pointerUp' }))
    })
  })

  describe('swipe', () => {
    it('posts swipe pointer action to WDA session', async () => {
      mockFetch
        .mockResolvedValueOnce(new Response(JSON.stringify({ sessionId: 'sid-1' }), { status: 200 }))
        .mockResolvedValueOnce(okResponse())
      const client = new WdaClient()
      await client.swipe({ x: 100, y: 500 }, { x: 100, y: 200 })
      const [, init] = mockFetch.mock.calls[1]
      const body = JSON.parse(init.body)
      const action = body.actions[0].actions
      expect(action[0]).toMatchObject({ type: 'pointerMove', x: 100, y: 500 })
      expect(action[action.length - 1]).toMatchObject({ type: 'pointerUp' })
    })
  })

  describe('type', () => {
    it('posts keyboard actions to WDA session', async () => {
      mockFetch
        .mockResolvedValueOnce(new Response(JSON.stringify({ sessionId: 'sid-1' }), { status: 200 }))
        .mockResolvedValueOnce(okResponse())
      const client = new WdaClient()
      await client.type('hi')
      const [url, init] = mockFetch.mock.calls[1]
      expect(url).toBe('http://localhost:8100/session/sid-1/actions')
      const body = JSON.parse(init.body)
      expect(body.actions[0].type).toBe('key')
    })
  })

  it('reuses cached sessionId across calls', async () => {
    mockFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ sessionId: 'cached' }), { status: 200 }))
      .mockResolvedValue(okResponse())
    const client = new WdaClient()
    await client.tap(0, 0)
    await client.tap(0, 0)
    // session fetch called only once
    expect(mockFetch).toHaveBeenCalledTimes(3)
  })
})
