import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'events'
import type { WebSocket as WsType } from 'ws'
import { registerStreamWs } from '../utils/stream'

function makeMockWs(): WsType & EventEmitter {
  const emitter = new EventEmitter() as WsType & EventEmitter
  emitter.send = vi.fn()
  return emitter
}

describe('registerStreamWs', () => {
  let ws: ReturnType<typeof makeMockWs>

  beforeEach(() => {
    ws = makeMockWs()
  })

  it('open 이벤트 발생 시 stream:register 메시지를 전송한다', async () => {
    const promise = registerStreamWs(ws, 'sess-1')
    ws.emit('open')
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'stream:registered' })))
    await promise
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'stream:register', sessionId: 'sess-1' }))
  })

  it('stream:registered 수신 후 resolve된다', async () => {
    const promise = registerStreamWs(ws, 'sess-abc')
    ws.emit('open')
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'stream:registered' })))
    await expect(promise).resolves.toBeUndefined()
  })

  it('stream:registered 이전의 무관한 메시지는 무시한다', async () => {
    const promise = registerStreamWs(ws, 'sess-2')
    ws.emit('open')
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'other:message', data: 'ignored' })))
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'still:ignored' })))
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'stream:registered' })))
    await expect(promise).resolves.toBeUndefined()
    expect(ws.send).toHaveBeenCalledTimes(1)
  })

  it('stream:registered 수신 후 message 리스너를 해제한다', async () => {
    const promise = registerStreamWs(ws, 'sess-3')
    ws.emit('open')
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'stream:registered' })))
    await promise
    // Listener removed — emitting again should not throw or affect anything
    expect(() => ws.emit('message', Buffer.from(JSON.stringify({ type: 'stream:registered' })))).not.toThrow()
    expect(ws.listenerCount('message')).toBe(0)
  })

  it('error 이벤트 발생 시 reject된다', async () => {
    const promise = registerStreamWs(ws, 'sess-err')
    const testError = new Error('connection refused')
    ws.emit('error', testError)
    await expect(promise).rejects.toThrow('connection refused')
  })

  it('open 전에 error가 발생해도 reject된다', async () => {
    const promise = registerStreamWs(ws, 'sess-err2')
    ws.emit('error', new Error('early error'))
    await expect(promise).rejects.toThrow('early error')
  })
})
