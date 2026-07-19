import { describe, it, expect, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { migrateDataDir } from '../../lib/migrate-data-dir.js'

// Real temp dirs so the atomic rename + config/gitignore rewrites are exercised for real.
function makeCwd(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-migrate-'))
}

describe('migrateDataDir', () => {
  const cwds: string[] = []
  const track = (d: string) => {
    cwds.push(d)
    return d
  }

  afterEach(() => {
    vi.restoreAllMocks()
    for (const d of cwds.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  })

  it('레거시만 존재 → .tapflow/data로 이동, 내용 보존', () => {
    const cwd = track(makeCwd())
    fs.mkdirSync(path.join(cwd, '.tapflow-data', 'uploads'), { recursive: true })
    fs.writeFileSync(path.join(cwd, '.tapflow-data', 'tapflow.db'), 'DB')
    fs.writeFileSync(path.join(cwd, '.tapflow-data', 'uploads', 'a.apk'), 'BIN')

    const result = migrateDataDir(cwd)

    expect(result.status).toBe('migrated')
    expect(fs.existsSync(path.join(cwd, '.tapflow-data'))).toBe(false)
    expect(fs.readFileSync(path.join(cwd, '.tapflow', 'data', 'tapflow.db'), 'utf-8')).toBe('DB')
    expect(fs.readFileSync(path.join(cwd, '.tapflow', 'data', 'uploads', 'a.apk'), 'utf-8')).toBe('BIN')
  })

  it('config.json이 옛 기본값을 고정 → .tapflow/data로 재작성', () => {
    const cwd = track(makeCwd())
    fs.mkdirSync(path.join(cwd, '.tapflow-data'), { recursive: true })
    fs.writeFileSync(
      path.join(cwd, 'tapflow.config.json'),
      JSON.stringify({ local: { port: 4000, dataDir: '.tapflow-data' }, relay: { url: '' } }, null, 2) + '\n',
    )

    const result = migrateDataDir(cwd)

    expect(result).toMatchObject({ status: 'migrated', configUpdated: true })
    const cfg = JSON.parse(fs.readFileSync(path.join(cwd, 'tapflow.config.json'), 'utf-8')) as {
      local: { dataDir: string; port?: number }
    }
    expect(cfg.local.dataDir).toBe('.tapflow/data')
    expect(cfg.local.port).toBe(4000) // other keys preserved
  })

  it('config.json이 커스텀 dataDir → 건드리지 않음', () => {
    const cwd = track(makeCwd())
    fs.mkdirSync(path.join(cwd, '.tapflow-data'), { recursive: true })
    fs.writeFileSync(
      path.join(cwd, 'tapflow.config.json'),
      JSON.stringify({ local: { dataDir: '/var/lib/custom' } }, null, 2) + '\n',
    )

    const result = migrateDataDir(cwd)

    expect(result).toMatchObject({ status: 'migrated', configUpdated: false })
    const cfg = JSON.parse(fs.readFileSync(path.join(cwd, 'tapflow.config.json'), 'utf-8')) as {
      local: { dataDir: string; port?: number }
    }
    expect(cfg.local.dataDir).toBe('/var/lib/custom')
  })

  it('이동 시 기존 .gitignore에 런타임 경로 추가(secrets 보호)', () => {
    const cwd = track(makeCwd())
    fs.mkdirSync(path.join(cwd, '.tapflow-data'), { recursive: true })
    fs.writeFileSync(path.join(cwd, '.tapflow-data', '.env'), 'JWT_SECRET=x')
    fs.writeFileSync(path.join(cwd, '.gitignore'), '.tapflow-data/\n')

    const result = migrateDataDir(cwd)

    expect(result).toMatchObject({ status: 'migrated', gitignoreUpdated: true })
    const gi = fs.readFileSync(path.join(cwd, '.gitignore'), 'utf-8')
    expect(gi).toContain('.tapflow/data/')
    expect(gi).toContain('.tapflow/artifacts/')
  })

  it('.gitignore 없고 git repo → 생성해서 secrets 보호', () => {
    const cwd = track(makeCwd())
    fs.mkdirSync(path.join(cwd, '.git'), { recursive: true })
    fs.mkdirSync(path.join(cwd, '.tapflow-data'), { recursive: true })
    fs.writeFileSync(path.join(cwd, '.tapflow-data', '.env'), 'JWT_SECRET=x')

    const result = migrateDataDir(cwd)

    expect(result).toMatchObject({ status: 'migrated', gitignoreUpdated: true })
    const gi = fs.readFileSync(path.join(cwd, '.gitignore'), 'utf-8')
    expect(gi).toContain('.tapflow/data/')
    expect(gi).toContain('.tapflow/artifacts/')
  })

  it('.gitignore 없고 git repo 아님 → 생성 안 함', () => {
    const cwd = track(makeCwd())
    fs.mkdirSync(path.join(cwd, '.tapflow-data'), { recursive: true })
    const result = migrateDataDir(cwd)
    expect(result).toMatchObject({ status: 'migrated', gitignoreUpdated: false })
    expect(fs.existsSync(path.join(cwd, '.gitignore'))).toBe(false)
  })

  it('.gitignore가 이미 **/ glob으로 커버 → 중복 추가 안 함', () => {
    const cwd = track(makeCwd())
    fs.mkdirSync(path.join(cwd, '.tapflow-data'), { recursive: true })
    fs.writeFileSync(path.join(cwd, '.gitignore'), '**/.tapflow/data/\n**/.tapflow/artifacts/\n')

    const result = migrateDataDir(cwd)

    expect(result).toMatchObject({ status: 'migrated', gitignoreUpdated: false })
    const gi = fs.readFileSync(path.join(cwd, '.gitignore'), 'utf-8')
    expect(gi).not.toContain('\n.tapflow/data/') // bare entry not appended
  })

  it('레거시 없음 + 통합 경로 있음 → noop-already (멱등)', () => {
    const cwd = track(makeCwd())
    fs.mkdirSync(path.join(cwd, '.tapflow', 'data'), { recursive: true })
    expect(migrateDataDir(cwd).status).toBe('noop-already')
  })

  it('둘 다 없음 → noop-no-legacy', () => {
    const cwd = track(makeCwd())
    expect(migrateDataDir(cwd).status).toBe('noop-no-legacy')
  })

  it('레거시·통합 둘 다 존재 → conflict, 데이터 무손상', () => {
    const cwd = track(makeCwd())
    fs.mkdirSync(path.join(cwd, '.tapflow-data'), { recursive: true })
    fs.writeFileSync(path.join(cwd, '.tapflow-data', 'tapflow.db'), 'LEGACY')
    fs.mkdirSync(path.join(cwd, '.tapflow', 'data'), { recursive: true })
    fs.writeFileSync(path.join(cwd, '.tapflow', 'data', 'tapflow.db'), 'NEW')

    const result = migrateDataDir(cwd)

    expect(result.status).toBe('conflict')
    expect(fs.readFileSync(path.join(cwd, '.tapflow-data', 'tapflow.db'), 'utf-8')).toBe('LEGACY')
    expect(fs.readFileSync(path.join(cwd, '.tapflow', 'data', 'tapflow.db'), 'utf-8')).toBe('NEW')
  })

  it('rename가 EXDEV → exdev 상태, 레거시 원위치(수동 이동 안내)', () => {
    const cwd = track(makeCwd())
    fs.mkdirSync(path.join(cwd, '.tapflow-data'), { recursive: true })
    fs.writeFileSync(path.join(cwd, '.tapflow-data', 'tapflow.db'), 'DB')
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      const e = new Error('cross-device link not permitted') as NodeJS.ErrnoException
      e.code = 'EXDEV'
      throw e
    })

    const result = migrateDataDir(cwd)

    expect(result.status).toBe('exdev')
    expect(fs.readFileSync(path.join(cwd, '.tapflow-data', 'tapflow.db'), 'utf-8')).toBe('DB')
  })
})
