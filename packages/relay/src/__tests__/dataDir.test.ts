import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { resolveDefaultDataDir } from '../lib/dataDir.js'

// Real temp dirs — verify the read-only resolution never moves or creates anything.
function makeCwd(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-datadir-'))
}

describe('resolveDefaultDataDir (read-only)', () => {
  const cwds: string[] = []
  const track = (d: string) => {
    cwds.push(d)
    return d
  }

  afterEach(() => {
    for (const d of cwds.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  })

  it('신규(둘 다 없음) → 통합 경로, usingLegacy=false, 아무것도 안 만듦', () => {
    const cwd = track(makeCwd())
    const result = resolveDefaultDataDir(cwd)
    expect(result).toEqual({ dataDir: path.join(cwd, '.tapflow', 'data'), usingLegacy: false })
    expect(fs.existsSync(path.join(cwd, '.tapflow'))).toBe(false)
    expect(fs.existsSync(path.join(cwd, '.tapflow-data'))).toBe(false)
  })

  it('통합 경로 존재 → 통합 경로, usingLegacy=false', () => {
    const cwd = track(makeCwd())
    fs.mkdirSync(path.join(cwd, '.tapflow', 'data'), { recursive: true })
    const result = resolveDefaultDataDir(cwd)
    expect(result).toEqual({ dataDir: path.join(cwd, '.tapflow', 'data'), usingLegacy: false })
  })

  it('레거시만 존재(미마이그레이션) → 레거시 계속 읽음, usingLegacy=true, 이동 없음', () => {
    const cwd = track(makeCwd())
    fs.mkdirSync(path.join(cwd, '.tapflow-data'), { recursive: true })
    fs.writeFileSync(path.join(cwd, '.tapflow-data', 'tapflow.db'), 'DB')
    const result = resolveDefaultDataDir(cwd)
    expect(result).toEqual({ dataDir: path.join(cwd, '.tapflow-data'), usingLegacy: true })
    // read-only: legacy untouched, unified path not created
    expect(fs.readFileSync(path.join(cwd, '.tapflow-data', 'tapflow.db'), 'utf-8')).toBe('DB')
    expect(fs.existsSync(path.join(cwd, '.tapflow', 'data'))).toBe(false)
  })

  it('둘 다 존재 → 통합 경로 우선, usingLegacy=false', () => {
    const cwd = track(makeCwd())
    fs.mkdirSync(path.join(cwd, '.tapflow-data'), { recursive: true })
    fs.mkdirSync(path.join(cwd, '.tapflow', 'data'), { recursive: true })
    const result = resolveDefaultDataDir(cwd)
    expect(result).toEqual({ dataDir: path.join(cwd, '.tapflow', 'data'), usingLegacy: false })
  })
})
