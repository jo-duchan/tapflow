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

  describe('pressButton', () => {
    it('calls wda pressButton endpoint with mapped button name', async () => {
      mockFetch
        .mockResolvedValueOnce(new Response(JSON.stringify({ sessionId: 'sid-1' }), { status: 200 }))
        .mockResolvedValueOnce(okResponse())
      const client = new WdaClient()
      await client.pressButton('leftButtonSideVolumeUp')
      const [url, init] = mockFetch.mock.calls[1]
      expect(url).toBe('http://localhost:8100/session/sid-1/wda/pressButton')
      expect(JSON.parse(init.body)).toEqual({ name: 'volumeUp' })
    })

    it('passes unknown button names through unchanged', async () => {
      mockFetch
        .mockResolvedValueOnce(new Response(JSON.stringify({ sessionId: 'sid-1' }), { status: 200 }))
        .mockResolvedValueOnce(okResponse())
      const client = new WdaClient()
      await client.pressButton('customButton')
      const [, init] = mockFetch.mock.calls[1]
      expect(JSON.parse(init.body)).toEqual({ name: 'customButton' })
    })
  })

  it('reuses cached sessionId across calls', async () => {
    mockFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ sessionId: 'cached' }), { status: 200 }))
      .mockResolvedValue(okResponse())
    const client = new WdaClient()
    await client.type('a')
    await client.type('b')
    // session fetch called only once across multiple calls
    expect(mockFetch).toHaveBeenCalledTimes(3)
  })
})
