import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import path from 'path'

// .tapflow-data/.env 내용을 테스트가 제어. loadDataDirEnv mock이 ambient(셸) 우선으로 주입.
let fakeEnvFile: Record<string, string> = {}

vi.mock('../lib/loadEnvFile.js', () => ({
  loadDataDirEnv: vi.fn((dataDir: string): string | null => {
    if (Object.keys(fakeEnvFile).length === 0) return null
    for (const [k, v] of Object.entries(fakeEnvFile)) {
      if (process.env[k] === undefined) process.env[k] = v // ambient가 항상 우선
    }
    return path.join(dataDir, '.env')
  }),
}))

vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(false), // tapflow.config.json 없음 → 기본값
    readFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    chmodSync: vi.fn(),
  },
}))

// config가 secret을 읽기 전에 <dataDir>/.env를 로드하는지(=모든 비밀의 기본 경로) 검증.
describe('relay config — .env loads before secrets are read', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>

  // mock이 process.env에 직접 주입하는 키 — unstubAllEnvs로는 안 지워지므로 수동 정리.
  const MANAGED_KEYS = ['JWT_SECRET', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'TAPFLOW_DATA_DIR']
  const clearManaged = () => { for (const k of MANAGED_KEYS) delete process.env[k] }

  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.unstubAllEnvs()
    clearManaged()
    fakeEnvFile = {}
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit') })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'info').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    clearManaged()
  })

  it('JWT_SECRET을 .env에서 읽는다 (셸 미설정)', async () => {
    fakeEnvFile = { JWT_SECRET: 'a'.repeat(40) }
    const { jwtSecret } = await import('../lib/config.js')
    expect(jwtSecret).toBe('a'.repeat(40))
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('셸 JWT_SECRET이 .env보다 우선한다', async () => {
    vi.stubEnv('JWT_SECRET', 'b'.repeat(40))
    fakeEnvFile = { JWT_SECRET: 'a'.repeat(40) }
    const { jwtSecret } = await import('../lib/config.js')
    expect(jwtSecret).toBe('b'.repeat(40))
  })

  it('SMTP 자격 증명을 .env에서 읽는다', async () => {
    fakeEnvFile = { SMTP_USER: 'relay@example.com', SMTP_PASS: 'pass_from_env_file' }
    const { config } = await import('../lib/config.js')
    expect(config.smtp.user).toBe('relay@example.com')
    expect(config.smtp.pass).toBe('pass_from_env_file')
    expect(config.smtp.from).toBe('tapflow <relay@example.com>') // user 설정 시 자동 도출
  })

  it('dataDir은 .env에서 못 읽는다 (닭-달걀 — config.json/셸만)', async () => {
    fakeEnvFile = { TAPFLOW_DATA_DIR: '/from/env/file' }
    const { config } = await import('../lib/config.js')
    expect(config.local.dataDir).toBe(path.join(process.cwd(), '.tapflow', 'data'))
    expect(config.local.dataDir).not.toBe('/from/env/file')
  })

  it('TAPFLOW_DATA_DIR(셸)이 .env 경로 결정에 쓰인다', async () => {
    vi.stubEnv('TAPFLOW_DATA_DIR', '/custom/data')
    fakeEnvFile = { JWT_SECRET: 'a'.repeat(40) }
    const { config } = await import('../lib/config.js')
    const { loadDataDirEnv } = await import('../lib/loadEnvFile.js')
    expect(config.local.dataDir).toBe('/custom/data')
    expect(vi.mocked(loadDataDirEnv).mock.calls[0][0]).toBe('/custom/data')
  })

  it('.env 없음 → 회귀 없이 per-install JWT secret 자동 생성', async () => {
    const { jwtSecret, loadedEnvPath } = await import('../lib/config.js')
    expect(loadedEnvPath).toBeNull()
    expect(jwtSecret.length).toBeGreaterThanOrEqual(32)
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('.env의 JWT_SECRET이 32자 미만이면 길이 가드로 exit(1)', async () => {
    fakeEnvFile = { JWT_SECRET: 'tooshort' }
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(import('../lib/config.js')).rejects.toThrow('process.exit')
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('loadedEnvPath는 로드된 .env 경로를 노출한다', async () => {
    fakeEnvFile = { JWT_SECRET: 'a'.repeat(40) }
    const { loadedEnvPath } = await import('../lib/config.js')
    expect(loadedEnvPath).toBe(path.join(process.cwd(), '.tapflow', 'data', '.env'))
  })
})
