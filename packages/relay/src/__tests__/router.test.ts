import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'events'
import type http from 'http'
import { Router, json, readBody, readJson } from '../router.js'

// --- 헬퍼 ---

function makeReq(method: string, url: string, body?: string): http.IncomingMessage {
  const em = new EventEmitter() as http.IncomingMessage
  em.method = method
  em.url = url
  em.headers = {}

  if (body !== undefined) {
    process.nextTick(() => {
      em.emit('data', Buffer.from(body))
      em.emit('end')
    })
  }
  return em
}

function makeRes() {
  const written: { status: number; headers: Record<string, string>; body: string }[] = []
  const res = {
    writeHead: vi.fn((status: number, headers: Record<string, string>) => {
      written.push({ status, headers, body: '' })
    }),
    end: vi.fn((body: string) => {
      if (written.length > 0) written[written.length - 1].body = body
    }),
    _written: written,
  }
  return res as unknown as http.ServerResponse & { _written: typeof written }
}

// --- Router ---

describe('Router', () => {
  describe('경로 매칭', () => {
    it('정확히 일치하는 경로를 처리하고 true 반환', async () => {
      const router = new Router()
      const handler = vi.fn()
      router.get('/api/ping', handler)
      const res = makeRes()
      const matched = await router.handle(makeReq('GET', '/api/ping'), res)
      expect(matched).toBe(true)
      expect(handler).toHaveBeenCalledOnce()
    })

    it('등록되지 않은 경로는 false 반환', async () => {
      const router = new Router()
      router.get('/api/ping', vi.fn())
      const matched = await router.handle(makeReq('GET', '/api/unknown'), makeRes())
      expect(matched).toBe(false)
    })

    it('메서드 불일치 시 false 반환', async () => {
      const router = new Router()
      const handler = vi.fn()
      router.post('/api/data', handler)
      const matched = await router.handle(makeReq('GET', '/api/data'), makeRes())
      expect(matched).toBe(false)
      expect(handler).not.toHaveBeenCalled()
    })
  })

  describe('path param 추출', () => {
    it(':id 하나 추출', async () => {
      const router = new Router()
      let captured: Record<string, string> = {}
      router.get('/builds/:id', (_req, _res, params) => { captured = params })
      await router.handle(makeReq('GET', '/builds/42'), makeRes())
      expect(captured).toEqual({ id: '42' })
    })

    it('복수 param 추출', async () => {
      const router = new Router()
      let captured: Record<string, string> = {}
      router.get('/orgs/:org/repos/:repo', (_req, _res, params) => { captured = params })
      await router.handle(makeReq('GET', '/orgs/tapflow/repos/core'), makeRes())
      expect(captured).toEqual({ org: 'tapflow', repo: 'core' })
    })

    it('query string은 매칭에서 제외', async () => {
      const router = new Router()
      const handler = vi.fn()
      router.get('/api/users', handler)
      const matched = await router.handle(makeReq('GET', '/api/users?page=2'), makeRes())
      expect(matched).toBe(true)
      expect(handler).toHaveBeenCalledOnce()
    })
  })

  describe('HTTP 메서드 shortcuts', () => {
    it.each([
      ['GET', 'get'],
      ['POST', 'post'],
      ['PATCH', 'patch'],
      ['DELETE', 'delete'],
    ] as const)('%s %s로 등록한 경로 처리', async (method, shortcut) => {
      const router = new Router()
      const handler = vi.fn()
      router[shortcut]('/path', handler)
      const matched = await router.handle(makeReq(method, '/path'), makeRes())
      expect(matched).toBe(true)
      expect(handler).toHaveBeenCalledOnce()
    })
  })

  describe('핸들러 예외 처리', () => {
    it('핸들러가 throw하면 500 응답 후 true 반환', async () => {
      const router = new Router()
      router.get('/boom', () => { throw new Error('boom') })
      const res = makeRes()
      const matched = await router.handle(makeReq('GET', '/boom'), res)
      expect(matched).toBe(true)
      expect(res._written[0]?.status).toBe(500)
      const body = JSON.parse(res._written[0]?.body ?? '{}')
      expect(body.error).toBe('Internal server error')
    })

    it('async 핸들러가 reject해도 500 응답', async () => {
      const router = new Router()
      router.get('/async-boom', async () => { throw new Error('async') })
      const res = makeRes()
      await router.handle(makeReq('GET', '/async-boom'), res)
      expect(res._written[0]?.status).toBe(500)
    })
  })
})

// --- json 헬퍼 ---

describe('json', () => {
  it('지정한 status와 JSON body를 전송한다', () => {
    const res = makeRes()
    json(res, 200, { ok: true })
    expect(res._written[0]?.status).toBe(200)
    expect(JSON.parse(res._written[0]?.body ?? '{}')).toEqual({ ok: true })
  })

  it('Content-Type: application/json 헤더 포함', () => {
    const res = makeRes()
    json(res, 404, { error: 'Not found' })
    expect(res._written[0]?.headers['Content-Type']).toBe('application/json')
  })
})

// --- readBody / readJson ---

describe('readBody', () => {
  it('요청 바디를 Buffer로 수집한다', async () => {
    const req = makeReq('POST', '/', 'hello world')
    const buf = await readBody(req)
    expect(buf.toString()).toBe('hello world')
  })

  it('에러 이벤트 발생 시 reject', async () => {
    const req = makeReq('POST', '/')
    const promise = readBody(req)
    process.nextTick(() => req.emit('error', new Error('read error')))
    await expect(promise).rejects.toThrow('read error')
  })
})

describe('readJson', () => {
  it('JSON 바디를 파싱해 객체로 반환', async () => {
    const req = makeReq('POST', '/', JSON.stringify({ key: 'value' }))
    const data = await readJson<{ key: string }>(req)
    expect(data).toEqual({ key: 'value' })
  })

  it('잘못된 JSON이면 SyntaxError throw', async () => {
    const req = makeReq('POST', '/', 'not json')
    await expect(readJson(req)).rejects.toThrow(SyntaxError)
  })
})

// #11 — 라우터가 핸들러 예외 스택을 삼키지 않고 기록 (응답엔 상세 비노출, PAT 마스킹)
describe('핸들러 예외 관측성', () => {
  it('핸들러 throw → 500 + 본문엔 상세 없음 + logger.error 기록 + PAT 마스킹', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const router = new Router()
    router.get('/boom', () => { throw new Error('failure leaking tflw_pat_secret123') })
    const req = makeReq('GET', '/boom')
    const res = makeRes()

    const handled = await router.handle(req, res)
    expect(handled).toBe(true)
    expect(res._written[0]?.status).toBe(500)
    expect(JSON.parse(res._written[0]?.body)).toEqual({ error: 'Internal server error' })

    expect(errorSpy).toHaveBeenCalled()
    const logged = errorSpy.mock.calls.flat().map(String).join(' ')
    expect(logged).toContain('GET /boom')
    expect(logged).not.toContain('tflw_pat_secret123') // 마스킹됨
    expect(logged).toContain('tflw_pat_***')
    errorSpy.mockRestore()
  })

  it('async 핸들러 reject도 500 + 로깅', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const router = new Router()
    router.post('/boom', () => Promise.reject(new Error('async boom')))
    const req = makeReq('POST', '/boom')
    const res = makeRes()

    await router.handle(req, res)
    expect(res._written[0]?.status).toBe(500)
    expect(errorSpy).toHaveBeenCalled()
    errorSpy.mockRestore()
  })
})
