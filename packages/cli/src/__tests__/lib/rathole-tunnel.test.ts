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
vi.mock('../../lib/ssh.js', () => ({
  sshExec: vi.fn(),
  scpUpload: vi.fn(),
}))
vi.mock('../../lib/download-binary.js', () => ({
  downloadBinary: vi.fn().mockResolvedValue('/home/user/.tapflow/bin/rathole-darwin-arm64'),
  cachedBinaryPath: vi.fn().mockReturnValue('/home/user/.tapflow/bin/rathole-darwin-arm64'),
}))

import { spawn } from 'child_process'
import { sshExec, scpUpload } from '../../lib/ssh.js'
import { downloadBinary } from '../../lib/download-binary.js'
import { RatholeTunnel } from '../../lib/rathole-tunnel.js'

const SSH = { host: 'vps.example.com', user: 'ubuntu', keyPath: '~/.ssh/id_rsa' }

const BASE_OPTS = {
  serverAddr: 'vps.example.com:2333',
  publicUrl: 'https://vps.example.com',
  token: 'secret',
}

describe('RatholeTunnel', () => {
  let proc: ReturnType<typeof mockProcess>

  beforeEach(() => {
    vi.resetAllMocks()
    proc = mockProcess()
    vi.mocked(spawn).mockReturnValue(proc as never)
    vi.mocked(sshExec).mockResolvedValue('')
    vi.mocked(scpUpload).mockResolvedValue(undefined)
    vi.mocked(downloadBinary).mockResolvedValue('/home/user/.tapflow/bin/rathole-darwin-arm64')
  })

  afterEach(() => vi.restoreAllMocks())

  // ── start() ──────────────────────────────────────────
  it('start() — rathole client spawn 후 publicUrl 반환', async () => {
    const tunnel = new RatholeTunnel(BASE_OPTS)
    const startPromise = tunnel.start(4000)
    await Promise.resolve() // downloadBinary microtask 완료 대기
    proc.stderr.emit('data', Buffer.from('[INFO] Tunnel started\n'))
    const result = await startPromise
    expect(spawn).toHaveBeenCalled()
    expect(result.publicUrl).toBe('https://vps.example.com')
  })

  it('start() — 토큰 누락 시 에러', async () => {
    const tunnel = new RatholeTunnel({ ...BASE_OPTS, token: '' })
    await expect(tunnel.start(4000)).rejects.toThrow(/TAPFLOW_TUNNEL_TOKEN/)
  })

  it('start() — serverAddr 누락 시 에러', async () => {
    const tunnel = new RatholeTunnel({ ...BASE_OPTS, serverAddr: '' })
    await expect(tunnel.start(4000)).rejects.toThrow(/serverAddr/)
  })

  it('프로세스 exit(1) → start() reject', async () => {
    const tunnel = new RatholeTunnel(BASE_OPTS)
    const startPromise = tunnel.start(4000)
    await Promise.resolve() // downloadBinary microtask 완료 대기
    proc.emit('exit', 1)
    await expect(startPromise).rejects.toThrow(/exited/)
  })

  // ── setupServer() ─────────────────────────────────────
  it('setupServer() — ssh 없으면 no-op', async () => {
    const tunnel = new RatholeTunnel(BASE_OPTS)
    await tunnel.setupServer()
    expect(sshExec).not.toHaveBeenCalled()
    expect(scpUpload).not.toHaveBeenCalled()
  })

  it('setupServer() — rathole 이미 있으면 binary 업로드 생략', async () => {
    vi.mocked(sshExec).mockImplementation(async (_ssh, cmd) => {
      if (cmd.includes('which rathole')) return '/usr/local/bin/rathole'
      return ''
    })
    const tunnel = new RatholeTunnel({ ...BASE_OPTS, ssh: SSH })
    await tunnel.setupServer()
    expect(scpUpload).not.toHaveBeenCalledWith(SSH, expect.stringContaining('rathole-darwin-'), expect.anything())
  })

  it('setupServer() — rathole 없으면 linux binary 다운로드 후 scp 업로드', async () => {
    vi.mocked(sshExec).mockImplementation(async (_ssh, cmd) => {
      if (cmd.includes('which rathole')) throw new Error('not found')
      if (cmd.includes('uname -m')) return 'x86_64'
      return ''
    })
    vi.mocked(downloadBinary).mockResolvedValue('/home/user/.tapflow/bin/rathole-linux-x86_64')
    const tunnel = new RatholeTunnel({ ...BASE_OPTS, ssh: SSH })
    await tunnel.setupServer()
    expect(downloadBinary).toHaveBeenCalledWith('linux', 'x86_64')
    expect(scpUpload).toHaveBeenCalledWith(SSH, '/home/user/.tapflow/bin/rathole-linux-x86_64', '~/.tapflow/rathole')
  })

  it('setupServer() — server.toml scp 업로드 + 서버 실행', async () => {
    const tunnel = new RatholeTunnel({ ...BASE_OPTS, ssh: SSH })
    await tunnel.setupServer()
    expect(scpUpload).toHaveBeenCalledWith(SSH, expect.any(String), '~/.tapflow/rathole-server.toml')
    expect(sshExec).toHaveBeenCalledWith(SSH, expect.stringContaining('rathole'))
  })

  // ── stop() ────────────────────────────────────────────
  it('stop() — client kill + 임시 파일 삭제', async () => {
    const fs = await import('fs')
    const tunnel = new RatholeTunnel(BASE_OPTS)
    const startPromise = tunnel.start(4000)
    await Promise.resolve()
    proc.stderr.emit('data', Buffer.from('[INFO] Tunnel started\n'))
    await startPromise
    await tunnel.stop()
    expect(vi.mocked(proc).kill).toHaveBeenCalled()
    expect(fs.default.unlinkSync).toHaveBeenCalled()
  })

  it('stop() — ssh 있으면 VPS server도 종료', async () => {
    const tunnel = new RatholeTunnel({ ...BASE_OPTS, ssh: SSH })
    await tunnel.setupServer()
    const startPromise = tunnel.start(4000)
    await Promise.resolve()
    proc.stderr.emit('data', Buffer.from('[INFO] Tunnel started\n'))
    await startPromise
    await tunnel.stop()
    expect(sshExec).toHaveBeenCalledWith(SSH, expect.stringContaining('tapflow-rathole.pid'))
  })

  it('stop() — start 전 호출해도 에러 없음', async () => {
    const tunnel = new RatholeTunnel(BASE_OPTS)
    await expect(tunnel.stop()).resolves.toBeUndefined()
  })
})
