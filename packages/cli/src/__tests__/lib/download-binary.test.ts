import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'

vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    chmodSync: vi.fn(),
    renameSync: vi.fn(),
    unlinkSync: vi.fn(),
    createWriteStream: vi.fn(),
  },
}))
vi.mock('child_process', () => ({ spawn: vi.fn() }))
vi.mock('os', () => ({ default: { homedir: () => '/home/user' } }))

import fs from 'fs'
import { spawn } from 'child_process'
import { cachedBinaryPath, downloadBinary, extractZip, RATHOLE_VERSION } from '../../lib/download-binary.js'

const mockSpawnProc = (exitCode = 0) => {
  const proc = new EventEmitter()
  Object.assign(proc, { stderr: new EventEmitter() })
  setTimeout(() => proc.emit('exit', exitCode), 0)
  return proc
}

describe('cachedBinaryPath', () => {
  it('darwin arm64', () => {
    expect(cachedBinaryPath('darwin', 'arm64')).toBe('/home/user/.tapflow/bin/rathole-darwin-arm64')
  })
  it('linux x86_64', () => {
    expect(cachedBinaryPath('linux', 'x86_64')).toBe('/home/user/.tapflow/bin/rathole-linux-x86_64')
  })
  it('linux aarch64', () => {
    expect(cachedBinaryPath('linux', 'aarch64')).toBe('/home/user/.tapflow/bin/rathole-linux-aarch64')
  })
})

describe('RATHOLE_VERSION', () => {
  it('버전 상수가 정의됨', () => {
    expect(RATHOLE_VERSION).toMatch(/^v\d+\.\d+\.\d+$/)
  })
})

describe('downloadBinary', () => {
  beforeEach(() => vi.resetAllMocks())
  afterEach(() => vi.restoreAllMocks())

  it('캐시 있으면 다운로드 없이 경로 반환', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    const p = await downloadBinary('darwin', 'arm64')
    expect(p).toBe('/home/user/.tapflow/bin/rathole-darwin-arm64')
    expect(spawn).not.toHaveBeenCalled()
  })
})

describe('extractZip', () => {
  beforeEach(() => vi.resetAllMocks())
  afterEach(() => vi.restoreAllMocks())

  it('unzip spawn 호출 후 경로 반환', async () => {
    vi.mocked(spawn).mockReturnValue(mockSpawnProc(0) as never)
    const result = await extractZip('/tmp/rathole.zip', '/home/user/.tapflow/bin/rathole-darwin-arm64')
    expect(spawn).toHaveBeenCalledWith('unzip', ['-o', '-j', '/tmp/rathole.zip', 'rathole', '-d', '/home/user/.tapflow/bin'])
    expect(result).toBe('/home/user/.tapflow/bin/rathole-darwin-arm64')
  })

  it('unzip 성공 후 rename + chmod 호출', async () => {
    vi.mocked(spawn).mockReturnValue(mockSpawnProc(0) as never)
    await extractZip('/tmp/rathole.zip', '/home/user/.tapflow/bin/rathole-darwin-arm64')
    expect(fs.renameSync).toHaveBeenCalledWith(
      '/home/user/.tapflow/bin/rathole',
      '/home/user/.tapflow/bin/rathole-darwin-arm64'
    )
    expect(fs.chmodSync).toHaveBeenCalledWith('/home/user/.tapflow/bin/rathole-darwin-arm64', 0o755)
  })

  it('unzip 실패 시 에러', async () => {
    vi.mocked(spawn).mockReturnValue(mockSpawnProc(1) as never)
    await expect(extractZip('/tmp/rathole.zip', '/tmp/out')).rejects.toThrow(/unzip/)
  })
})
