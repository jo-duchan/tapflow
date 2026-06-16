import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { loadDataDirEnv } from '../lib/loadEnvFile'

// #287 — 자격 증명을 gitignore된 dataDir/.env 에서 로드. ambient process.env 가 항상 우선.
describe('loadDataDirEnv', () => {
  let dir: string
  const KEY = 'TAPFLOW_TEST_287_TOKEN'
  const AMBIENT_KEY = 'TAPFLOW_TEST_287_AMBIENT'

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-env-'))
    delete process.env[KEY]
    delete process.env[AMBIENT_KEY]
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
    delete process.env[KEY]
    delete process.env[AMBIENT_KEY]
  })

  it('.env 가 있으면 미설정 변수를 채우고 경로를 반환한다', () => {
    fs.writeFileSync(path.join(dir, '.env'), `${KEY}=from_file\n`)
    const loaded = loadDataDirEnv(dir)
    expect(loaded).toBe(path.join(dir, '.env'))
    expect(process.env[KEY]).toBe('from_file')
  })

  it('ambient process.env 가 파일보다 우선한다 (덮어쓰지 않음)', () => {
    process.env[AMBIENT_KEY] = 'from_ambient'
    fs.writeFileSync(path.join(dir, '.env'), `${AMBIENT_KEY}=from_file\n`)
    loadDataDirEnv(dir)
    expect(process.env[AMBIENT_KEY]).toBe('from_ambient')
  })

  it('.env 가 없으면 null 을 반환하고 아무것도 하지 않는다', () => {
    expect(loadDataDirEnv(dir)).toBeNull()
    expect(process.env[KEY]).toBeUndefined()
  })

  it('손상된 .env 도 throw 하지 않는다 (best-effort)', () => {
    // 디렉터리를 .env 로 만들어 loadEnvFile 가 실패하도록 강제
    fs.mkdirSync(path.join(dir, '.env'))
    expect(() => loadDataDirEnv(dir)).not.toThrow()
  })
})
