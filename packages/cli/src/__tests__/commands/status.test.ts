import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('ws')

import { WebSocket } from 'ws'
import { cmdStatus } from '../../commands/status.js'

type WsEventMap = {
  open: () => void
  message: (data: Buffer) => void
  error: (err: Error) => void
}

function createMockWs(behavior: (handlers: WsEventMap) => void) {
  const handlers: Partial<WsEventMap> = {}
  const instance = {
    on: vi.fn((event: string, cb: unknown) => { handlers[event as keyof WsEventMap] = cb as never }),
    send: vi.fn(),
    close: vi.fn(),
    terminate: vi.fn(),
  }
  vi.mocked(WebSocket).mockImplementation(() => {
    setTimeout(() => behavior(handlers as WsEventMap), 0)
    return instance as never
  })
  return instance
}

describe('cmdStatus', () => {
  let output: string[]
  let exitSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.resetAllMocks()
    output = []
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')))
    vi.spyOn(console, 'error').mockImplementation((...args) => output.push(args.join(' ')))
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit') })
  })

  afterEach(() => vi.restoreAllMocks())

  it('open 시 agents:list 전송', async () => {
    const ws = createMockWs((h) => {
      h.open()
      h.message(Buffer.from(JSON.stringify({ type: 'agents:listed', sessions: [] })))
    })

    await cmdStatus({})
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'agents:list' }))
  })

  it('에이전트 없으면 "No agents connected" 출력', async () => {
    createMockWs((h) => {
      h.open()
      h.message(Buffer.from(JSON.stringify({ type: 'agents:listed', sessions: [] })))
    })

    await cmdStatus({})
    expect(output.join('\n')).toContain('No agents connected')
  })

  it('에이전트 있으면 이름과 디바이스 출력', async () => {
    createMockWs((h) => {
      h.open()
      h.message(Buffer.from(JSON.stringify({
        type: 'agents:listed',
        sessions: [{
          agentName: 'mac-mini-office',
          devices: [
            { name: 'iPhone 16 Pro', status: 'available', joinedBy: 'qa@company.com' },
            { name: 'iPhone 15', status: 'available' },
          ],
        }],
      })))
    })

    await cmdStatus({})
    const joined = output.join('\n')
    expect(joined).toContain('mac-mini-office')
    expect(joined).toContain('iPhone 16 Pro')
    expect(joined).toContain('iPhone 15')
  })

  it('세션 요약(agent/device/active 수) 출력', async () => {
    createMockWs((h) => {
      h.open()
      h.message(Buffer.from(JSON.stringify({
        type: 'agents:listed',
        sessions: [{
          agentName: 'mac-mini',
          devices: [
            { name: 'iPhone 16 Pro', status: 'available', joinedBy: 'qa@company.com' },
            { name: 'iPhone 15', status: 'available' },
          ],
        }],
      })))
    })

    await cmdStatus({})
    const joined = output.join('\n')
    expect(joined).toContain('1 agent(s)')
    expect(joined).toContain('2 device(s)')
    expect(joined).toContain('1 active session(s)')
  })

  it('연결 오류 시 exit(1)', async () => {
    createMockWs((h) => {
      h.error(new Error('ECONNREFUSED'))
    })

    await expect(cmdStatus({})).rejects.toThrow('process.exit')
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('--relay 옵션의 URL 사용', async () => {
    createMockWs((h) => {
      h.open()
      h.message(Buffer.from(JSON.stringify({ type: 'agents:listed', sessions: [] })))
    })

    await cmdStatus({ relay: 'http://remote:4000' })
    expect(vi.mocked(WebSocket)).toHaveBeenCalledWith('ws://remote:4000')
  })
})
