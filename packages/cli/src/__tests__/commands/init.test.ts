import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

vi.mock('@clack/prompts', () => ({
  select: vi.fn(),
  text: vi.fn(),
  isCancel: vi.fn().mockReturnValue(false),
  cancel: vi.fn(),
}))

import * as clack from '@clack/prompts'
import { cmdInitConfig } from '../../commands/init.js'

const mockSelect = vi.mocked(clack.select)
const mockText = vi.mocked(clack.text)

describe('cmdInitConfig', () => {
  let output: string[]
  let exitSpy: MockInstance
  let tmpDir: string

  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(clack.isCancel).mockReturnValue(false)
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
    mockSelect.mockResolvedValue('tailscale')

    await cmdInitConfig({})

    const cfg = JSON.parse(fs.readFileSync(path.join(tmpDir, 'tapflow.config.json'), 'utf-8'))
    expect(cfg.tunnel.provider).toBe('tailscale')
  })

  it('인터랙티브 모드 none 선택 → tunnel 없는 config 생성', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
    mockSelect.mockResolvedValue('none')

    await cmdInitConfig({})

    const cfg = JSON.parse(fs.readFileSync(path.join(tmpDir, 'tapflow.config.json'), 'utf-8'))
    expect(cfg.tunnel).toBeUndefined()
  })

  it('인터랙티브 모드 rathole 선택 → serverAddr/publicUrl 입력 → rathole config 생성', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
    mockSelect.mockResolvedValue('rathole')
    mockText
      .mockResolvedValueOnce('vps.example.com:2333')
      .mockResolvedValueOnce('https://vps.example.com')
      .mockResolvedValueOnce('')  // ssh host blank → skip

    await cmdInitConfig({})

    const cfg = JSON.parse(fs.readFileSync(path.join(tmpDir, 'tapflow.config.json'), 'utf-8'))
    expect(cfg.tunnel.provider).toBe('rathole')
    expect(cfg.tunnel.serverAddr).toBe('vps.example.com:2333')
    expect(cfg.tunnel.publicUrl).toBe('https://vps.example.com')
    expect(cfg.tunnel.ssh).toBeNull()
  })

  it('none + Standard 성능 → tls 없음 (HTTP/WASM)', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
    mockSelect.mockResolvedValueOnce('none').mockResolvedValueOnce('standard')

    await cmdInitConfig({})

    const cfg = JSON.parse(fs.readFileSync(path.join(tmpDir, 'tapflow.config.json'), 'utf-8'))
    expect(cfg.tunnel).toBeUndefined()
    expect(cfg.tls).toBeUndefined()
  })

  it('none + High + Cloudflare → byo-api-token tls 생성', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
    mockSelect.mockResolvedValueOnce('none').mockResolvedValueOnce('high').mockResolvedValueOnce('cloudflare')
    mockText.mockResolvedValueOnce('tap.example.com')

    await cmdInitConfig({})

    const cfg = JSON.parse(fs.readFileSync(path.join(tmpDir, 'tapflow.config.json'), 'utf-8'))
    expect(cfg.tls).toEqual({ mode: 'byo-api-token', domain: 'tap.example.com', dnsProvider: 'cloudflare' })
    expect(output.join('\n')).toContain('TAPFLOW_CLOUDFLARE_TOKEN')
  })

  it('none + High + Vercel → byo-api-token(vercel) tls 생성', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
    mockSelect.mockResolvedValueOnce('none').mockResolvedValueOnce('high').mockResolvedValueOnce('vercel')
    mockText.mockResolvedValueOnce('tap.example.com')

    await cmdInitConfig({})

    const cfg = JSON.parse(fs.readFileSync(path.join(tmpDir, 'tapflow.config.json'), 'utf-8'))
    expect(cfg.tls).toEqual({ mode: 'byo-api-token', domain: 'tap.example.com', dnsProvider: 'vercel' })
    expect(output.join('\n')).toContain('TAPFLOW_VERCEL_TOKEN')
  })

  it('none + High + Import → import-cert tls 생성', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
    mockSelect.mockResolvedValueOnce('none').mockResolvedValueOnce('high').mockResolvedValueOnce('import')
    mockText.mockResolvedValueOnce('/etc/tls/fullchain.pem').mockResolvedValueOnce('/etc/tls/privkey.pem')

    await cmdInitConfig({})

    const cfg = JSON.parse(fs.readFileSync(path.join(tmpDir, 'tapflow.config.json'), 'utf-8'))
    expect(cfg.tls).toEqual({ mode: 'import-cert', certPath: '/etc/tls/fullchain.pem', keyPath: '/etc/tls/privkey.pem' })
  })

  describe('.env scaffold (#287)', () => {
    const envPath = () => path.join(tmpDir, '.tapflow-data', '.env')

    it('byo-api-token → .tapflow-data/.env 를 빈 값 템플릿으로 자동 생성', async () => {
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
      mockSelect.mockResolvedValueOnce('none').mockResolvedValueOnce('high').mockResolvedValueOnce('cloudflare')
      mockText.mockResolvedValueOnce('tap.example.com')

      await cmdInitConfig({})

      const content = fs.readFileSync(envPath(), 'utf-8')
      expect(content).toContain('TAPFLOW_CLOUDFLARE_TOKEN=')
      // 비밀은 비어 있어야 한다 (프롬프트/로그로 흐르지 않음)
      expect(content).not.toMatch(/TAPFLOW_CLOUDFLARE_TOKEN=\S/)
      if (process.platform !== 'win32') {
        expect(fs.statSync(envPath()).mode & 0o777).toBe(0o600)
      }
    })

    it('기존 .env 의 실제 값은 보존하고 누락 키만 추가', async () => {
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
      fs.mkdirSync(path.join(tmpDir, '.tapflow-data'), { recursive: true })
      fs.writeFileSync(envPath(), 'TAPFLOW_VERCEL_TOKEN=secret_existing\n', 'utf-8')
      mockSelect.mockResolvedValueOnce('none').mockResolvedValueOnce('high').mockResolvedValueOnce('cloudflare')
      mockText.mockResolvedValueOnce('tap.example.com')

      await cmdInitConfig({})

      const content = fs.readFileSync(envPath(), 'utf-8')
      expect(content).toContain('TAPFLOW_VERCEL_TOKEN=secret_existing')
      expect(content).toContain('TAPFLOW_CLOUDFLARE_TOKEN=')
    })

    it('import-cert → .env 생성 없음', async () => {
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
      mockSelect.mockResolvedValueOnce('none').mockResolvedValueOnce('high').mockResolvedValueOnce('import')
      mockText.mockResolvedValueOnce('/etc/tls/fullchain.pem').mockResolvedValueOnce('/etc/tls/privkey.pem')

      await cmdInitConfig({})

      expect(fs.existsSync(envPath())).toBe(false)
    })
  })

  describe('.gitignore', () => {
    beforeEach(() => {
      fs.mkdirSync(path.join(tmpDir, '.git'))
    })

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
