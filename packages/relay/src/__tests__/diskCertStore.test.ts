import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { DiskCertStore } from '../lib/cert/DiskCertStore.js'
import { parseCertNotAfter } from '../lib/cert/parseCert.js'
import type { CertMaterial } from '../lib/cert/CertProvider.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const cert = fs.readFileSync(path.join(here, 'fixtures/tls-cert.pem'), 'utf-8')
const key = fs.readFileSync(path.join(here, 'fixtures/tls-key.pem'), 'utf-8')

describe('DiskCertStore', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-certstore-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('빈 디렉토리에서 load는 null', async () => {
    const store = new DiskCertStore(dir)
    expect(await store.load()).toBeNull()
  })

  it('save 후 load는 cert/key/만료를 복원한다', async () => {
    const store = new DiskCertStore(dir)
    const material: CertMaterial = { cert, key, expiresAt: new Date() }
    await store.save(material)
    const loaded = await store.load()
    expect(loaded!.cert).toBe(cert)
    expect(loaded!.key).toBe(key)
    // 만료는 저장값이 아니라 cert에서 파싱 — 결정적으로 파싱값과 비교(벽시계 비의존)
    expect(loaded!.expiresAt).toEqual(parseCertNotAfter(cert))
  })

  it('key 파일은 0600 권한으로 저장한다', async () => {
    const store = new DiskCertStore(dir)
    await store.save({ cert, key, expiresAt: new Date() })
    const mode = fs.statSync(path.join(dir, 'key.pem')).mode & 0o777
    expect(mode).toBe(0o600)
  })
})
