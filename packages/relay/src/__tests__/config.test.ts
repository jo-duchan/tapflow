import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn(),
  },
}))

describe('relay config validation', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllEnvs()
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit') })
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('유효한 기본값 → 정상 로드', async () => {
    const { config } = await import('../lib/config.js')
    expect(config.server.port).toBe(4000)
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('TAPFLOW_PORT=abc → exit(1) + 에러 로그', async () => {
    vi.stubEnv('TAPFLOW_PORT', 'abc')
    await expect(import('../lib/config.js')).rejects.toThrow('process.exit')
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('server.port'))
  })

  it('TAPFLOW_PORT=99999 → exit(1)', async () => {
    vi.stubEnv('TAPFLOW_PORT', '99999')
    await expect(import('../lib/config.js')).rejects.toThrow('process.exit')
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('JWT_SECRET 32자 미만 → exit(1) + 에러 로그', async () => {
    vi.stubEnv('JWT_SECRET', 'tooshort')
    await expect(import('../lib/config.js')).rejects.toThrow('process.exit')
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('server.jwtSecret'))
  })

  it('JWT_SECRET 32자 이상 → 정상 로드', async () => {
    vi.stubEnv('JWT_SECRET', 'a'.repeat(32))
    const { config } = await import('../lib/config.js')
    expect(config.server.jwtSecret).toBe('a'.repeat(32))
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('기본 JWT_SECRET 사용 시 경고 로그', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { config } = await import('../lib/config.js')
    expect(config.server.jwtSecret).toContain('tapflow-dev-secret')
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('dev default'))
  })
})
