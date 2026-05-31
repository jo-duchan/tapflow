import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'

const mockProc = (exitCode = 0, stdout = '', stderr = '') => {
  const proc = new EventEmitter() as ReturnType<typeof import('child_process').spawn>
  const stdoutEmitter = new EventEmitter()
  const stderrEmitter = new EventEmitter()
  Object.assign(proc, { stdout: stdoutEmitter, stderr: stderrEmitter, stdin: null })
  setTimeout(() => {
    if (stdout) stdoutEmitter.emit('data', Buffer.from(stdout))
    if (stderr) stderrEmitter.emit('data', Buffer.from(stderr))
    proc.emit('exit', exitCode)
  }, 0)
  return proc
}

vi.mock('child_process', () => ({ spawn: vi.fn() }))

import { spawn } from 'child_process'
import { sshExec, scpUpload } from '../../lib/ssh.js'

const SSH = { host: 'vps.example.com', user: 'ubuntu', keyPath: '~/.ssh/id_rsa' }

describe('sshExec', () => {
  beforeEach(() => vi.resetAllMocks())
  afterEach(() => vi.restoreAllMocks())

  it('ssh 실행 성공 → stdout 반환', async () => {
    vi.mocked(spawn).mockReturnValue(mockProc(0, 'hello\n') as never)
    const result = await sshExec(SSH, 'echo hello')
    expect(result).toBe('hello')
    expect(spawn).toHaveBeenCalledWith('ssh', expect.arrayContaining([
      'ubuntu@vps.example.com', 'echo hello',
    ]))
  })

  it('keyPath 있으면 -i 플래그 포함', async () => {
    vi.mocked(spawn).mockReturnValue(mockProc(0) as never)
    await sshExec(SSH, 'ls')
    expect(spawn).toHaveBeenCalledWith('ssh', expect.arrayContaining(['-i', '~/.ssh/id_rsa']))
  })

  it('keyPath 없으면 -i 플래그 미포함', async () => {
    vi.mocked(spawn).mockReturnValue(mockProc(0) as never)
    await sshExec({ host: 'vps.example.com', user: 'ubuntu' }, 'ls')
    const args = vi.mocked(spawn).mock.calls[0][1] as string[]
    expect(args).not.toContain('-i')
  })

  it('exit code 1 → reject', async () => {
    vi.mocked(spawn).mockReturnValue(mockProc(1, '', 'permission denied') as never)
    await expect(sshExec(SSH, 'ls')).rejects.toThrow('permission denied')
  })
})

describe('scpUpload', () => {
  beforeEach(() => vi.resetAllMocks())
  afterEach(() => vi.restoreAllMocks())

  it('scp 업로드 성공', async () => {
    vi.mocked(spawn).mockReturnValue(mockProc(0) as never)
    await expect(scpUpload(SSH, '/local/file', '~/remote/file')).resolves.toBeUndefined()
    expect(spawn).toHaveBeenCalledWith('scp', expect.arrayContaining([
      '/local/file', 'ubuntu@vps.example.com:~/remote/file',
    ]))
  })

  it('scp 실패 → reject', async () => {
    vi.mocked(spawn).mockReturnValue(mockProc(1) as never)
    await expect(scpUpload(SSH, '/local/file', '~/remote/file')).rejects.toThrow()
  })
})
