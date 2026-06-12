import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { loadOrCreatePersistedSecret } from '../lib/config'

// P0-2 — 공개된 dev 기본 시크릿 제거, per-install 자동 생성·영속화
describe('loadOrCreatePersistedSecret', () => {
  let dir: string
  const DEV_DEFAULT = 'tapflow-dev-secret-change-in-production'

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-secret-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('파일이 없으면 강한 시크릿을 생성한다 (≥32자, dev 기본값과 다름)', () => {
    const secret = loadOrCreatePersistedSecret(dir)
    expect(secret.length).toBeGreaterThanOrEqual(32)
    expect(secret).not.toBe(DEV_DEFAULT)
  })

  it('생성한 시크릿을 dataDir/jwt-secret 에 저장한다', () => {
    const secret = loadOrCreatePersistedSecret(dir)
    const onDisk = fs.readFileSync(path.join(dir, 'jwt-secret'), 'utf-8').trim()
    expect(onDisk).toBe(secret)
  })

  it('재호출 시 저장된 시크릿을 재사용한다 (재시작해도 세션 유지)', () => {
    const first = loadOrCreatePersistedSecret(dir)
    const second = loadOrCreatePersistedSecret(dir)
    expect(second).toBe(first)
  })

  it('dataDir가 없으면 생성한다', () => {
    const nested = path.join(dir, 'a', 'b')
    const secret = loadOrCreatePersistedSecret(nested)
    expect(secret.length).toBeGreaterThanOrEqual(32)
    expect(fs.existsSync(path.join(nested, 'jwt-secret'))).toBe(true)
  })

  it('시크릿 파일은 소유자 전용(0600) 권한으로 저장된다 (POSIX 한정)', () => {
    loadOrCreatePersistedSecret(dir)
    // Windows(NTFS)는 POSIX 권한이 없고 chmodSync도 best-effort라 단언을 POSIX로 게이트한다.
    if (process.platform !== 'win32') {
      const mode = fs.statSync(path.join(dir, 'jwt-secret')).mode & 0o777
      expect(mode).toBe(0o600)
    }
  })

  it('손상된(너무 짧은) 시크릿 파일은 무시하고 새로 생성한다', () => {
    fs.writeFileSync(path.join(dir, 'jwt-secret'), 'short')
    const secret = loadOrCreatePersistedSecret(dir)
    expect(secret.length).toBeGreaterThanOrEqual(32)
    expect(secret).not.toBe('short')
  })
})
