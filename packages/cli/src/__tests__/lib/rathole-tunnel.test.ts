import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'

const mockProcess = () => {
  const proc = new EventEmitter() as ReturnType<typeof import('child_process').spawn>
  const stderr = new EventEmitter()
  const stdout = new EventEmitter()
  Object.assign(proc, { stdout, stderr, kill: vi.fn(), pid: 1234 })
  return proc
}

vi.mock('child_process', () => ({ spawn: vi.fn() }))
vi.mock('fs', () => ({
  default: {
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
  },
}))
vi.mock('os', () => ({ default: { tmpdir: () => '/tmp' } }))

import { spawn } from 'child_process'
import { RatholeTunnel } from '../../lib/rathole-tunnel.js'

describe('RatholeTunnel', () => {
  let proc: ReturnType<typeof mockProcess>

  beforeEach(() => {
    vi.resetAllMocks()
    proc = mockProcess()
    vi.mocked(spawn).mockReturnValue(proc as never)
  })

  afterEach(() => vi.restoreAllMocks())

  it('start() — rathole 프로세스를 spawn하고 publicUrl 반환', async () => {
    const tunnel = new RatholeTunnel({ serverAddr: 'vps.example.com:2333', publicUrl: 'https://vps.example.com', token: 'secret' })
    const startPromise = tunnel.start(4000)
    proc.stderr.emit('data', Buffer.from('[INFO] Tunnel started\n'))
    const result = await startPromise
    expect(spawn).toHaveBeenCalled()
    expect(result.publicUrl).toBe('https://vps.example.com')
  })

  it('start() — 토큰 누락 시 에러', async () => {
    const tunnel = new RatholeTunnel({ serverAddr: 'vps.example.com:2333', publicUrl: 'https://vps.example.com', token: '' })
    await expect(tunnel.start(4000)).rejects.toThrow(/TAPFLOW_TUNNEL_TOKEN/)
  })

  it('start() — serverAddr 누락 시 에러', async () => {
    const tunnel = new RatholeTunnel({ serverAddr: '', publicUrl: 'https://vps.example.com', token: 'secret' })
    await expect(tunnel.start(4000)).rejects.toThrow(/serverAddr/)
  })

  it('stop() — 프로세스를 kill하고 임시 설정 파일을 삭제', async () => {
    const fs = await import('fs')
    const tunnel = new RatholeTunnel({ serverAddr: 'vps.example.com:2333', publicUrl: 'https://vps.example.com', token: 'secret' })
    const startPromise = tunnel.start(4000)
    proc.stderr.emit('data', Buffer.from('[INFO] Tunnel started\n'))
    await startPromise
    await tunnel.stop()
    expect(vi.mocked(proc).kill).toHaveBeenCalled()
    expect(fs.default.unlinkSync).toHaveBeenCalled()
  })

  it('stop() — start 전에 호출해도 에러 없음', async () => {
    const tunnel = new RatholeTunnel({ serverAddr: 'vps.example.com:2333', publicUrl: 'https://vps.example.com', token: 'secret' })
    await expect(tunnel.stop()).resolves.toBeUndefined()
  })

  it('프로세스가 exit(1) → start()가 reject', async () => {
    const tunnel = new RatholeTunnel({ serverAddr: 'vps.example.com:2333', publicUrl: 'https://vps.example.com', token: 'secret' })
    const startPromise = tunnel.start(4000)
    proc.emit('exit', 1)
    await expect(startPromise).rejects.toThrow(/exited/)
  })
})
