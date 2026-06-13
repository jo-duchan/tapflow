import { describe, it, expect } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'
import { ImportCertProvider } from '../lib/cert/ImportCertProvider.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const certPath = path.join(here, 'fixtures/tls-cert.pem')
const keyPath = path.join(here, 'fixtures/tls-key.pem')

describe('ImportCertProvider', () => {
  it('ensureCert는 파일에서 cert/key를 읽고 만료를 파싱한다', async () => {
    const p = new ImportCertProvider({ certPath, keyPath })
    const m = await p.ensureCert()
    expect(m.cert).toContain('BEGIN CERTIFICATE')
    expect(m.key).toContain('PRIVATE KEY')
    expect(m.expiresAt.getTime()).toBeGreaterThan(Date.now())
  })

  it('strategy는 import-cert', () => {
    expect(new ImportCertProvider({ certPath, keyPath }).strategy).toBe('import-cert')
  })

  it('renewIfNeeded는 항상 null (사용자가 갱신을 관리)', async () => {
    const p = new ImportCertProvider({ certPath, keyPath })
    expect(await p.renewIfNeeded()).toBeNull()
  })
})
