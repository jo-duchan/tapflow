import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn(),
}))

import * as readline from 'node:readline/promises'
import { cmdInitConfig } from '../../commands/init.js'

const mockCreateInterface = vi.mocked(readline.createInterface)

describe('cmdInitConfig', () => {
  let output: string[]
  let exitSpy: MockInstance
  let tmpDir: string

  beforeEach(() => {
    vi.resetAllMocks()
    output = []
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')))
    vi.spyOn(console, 'error').mockImplementation((...args) => output.push(args.join(' ')))
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit') })

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-init-test-'))
    vi.spyOn(process, 'cwd').mockReturnValue(tmpDir)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('--tunnel tailscale → tailscale 섹션 포함 config 생성', async () => {
    await cmdInitConfig({ tunnel: 'tailscale' })

    const cfg = JSON.parse(fs.readFileSync(path.join(tmpDir, 'tapflow.config.json'), 'utf-8'))
    expect(cfg.tunnel).toEqual({ provider: 'tailscale' })
    expect(output.join('\n')).toContain('CONFIG CREATED')
  })

  it('--tunnel rathole → rathole placeholder config 생성', async () => {
    await cmdInitConfig({ tunnel: 'rathole' })

    const cfg = JSON.parse(fs.readFileSync(path.join(tmpDir, 'tapflow.config.json'), 'utf-8'))
    expect(cfg.tunnel.provider).toBe('rathole')
    expect(cfg.tunnel.serverAddr).toBe('')
    expect(cfg.tunnel.ssh).toBeNull()
  })

  it('tunnel 없음 → 기본 config 생성 (tunnel 섹션 없음)', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true })

    await cmdInitConfig({})

    const cfg = JSON.parse(fs.readFileSync(path.join(tmpDir, 'tapflow.config.json'), 'utf-8'))
    expect(cfg.tunnel).toBeUndefined()
    expect(cfg.local.port).toBe(4000)
  })

  it('이미 config 존재 → --force 없으면 exit(1)', async () => {
    fs.writeFileSync(path.join(tmpDir, 'tapflow.config.json'), '{}', 'utf-8')

    await expect(cmdInitConfig({})).rejects.toThrow('process.exit')
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(output.join('\n')).toContain('ALREADY INITIALIZED')
  })

  it('이미 config 존재 + --force → 덮어쓰기', async () => {
    fs.writeFileSync(path.join(tmpDir, 'tapflow.config.json'), '{}', 'utf-8')

    await cmdInitConfig({ tunnel: 'tailscale', force: true })

    const cfg = JSON.parse(fs.readFileSync(path.join(tmpDir, 'tapflow.config.json'), 'utf-8'))
    expect(cfg.tunnel.provider).toBe('tailscale')
  })

  it('알 수 없는 tunnel provider → exit(1)', async () => {
    await expect(cmdInitConfig({ tunnel: 'unknown' })).rejects.toThrow('process.exit')
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(output.join('\n')).toContain('INVALID TUNNEL')
  })

  it('인터랙티브 모드 tailscale 선택 → tailscale config 생성', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
    mockCreateInterface.mockReturnValueOnce({
      question: vi.fn().mockResolvedValue('2'),
      close: vi.fn(),
    } as never)

    await cmdInitConfig({})

    const cfg = JSON.parse(fs.readFileSync(path.join(tmpDir, 'tapflow.config.json'), 'utf-8'))
    expect(cfg.tunnel.provider).toBe('tailscale')
  })

  it('인터랙티브 모드 none 선택 → tunnel 없는 config 생성', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
    mockCreateInterface.mockReturnValueOnce({
      question: vi.fn().mockResolvedValue('1'),
      close: vi.fn(),
    } as never)

    await cmdInitConfig({})

    const cfg = JSON.parse(fs.readFileSync(path.join(tmpDir, 'tapflow.config.json'), 'utf-8'))
    expect(cfg.tunnel).toBeUndefined()
  })

  describe('.gitignore', () => {
    it('.gitignore 없음 → 새로 생성되고 .tapflow-data/ 포함', async () => {
      await cmdInitConfig({ tunnel: 'tailscale' })

      const content = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf-8')
      expect(content).toContain('.tapflow-data/')
      expect(output.join('\n')).toContain('.gitignore created')
    })

    it('.gitignore 있고 항목 없음 → .tapflow-data/ 추가', async () => {
      fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'node_modules/\n', 'utf-8')

      await cmdInitConfig({ tunnel: 'tailscale' })

      const content = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf-8')
      expect(content).toContain('node_modules/')
      expect(content).toContain('.tapflow-data/')
      expect(output.join('\n')).toContain('.tapflow-data/ added to .gitignore')
    })

    it('.gitignore에 이미 .tapflow-data/ 있음 → 중복 추가 안 됨', async () => {
      fs.writeFileSync(path.join(tmpDir, '.gitignore'), '.tapflow-data/\n', 'utf-8')

      await cmdInitConfig({ tunnel: 'tailscale' })

      const content = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf-8')
      const count = content.split('\n').filter((l) => l.trim() === '.tapflow-data/').length
      expect(count).toBe(1)
    })
  })
})
