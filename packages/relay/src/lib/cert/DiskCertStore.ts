import fs from 'fs'
import path from 'path'
import type { CertStore } from './AcmeCertProvider.js'
import type { CertMaterial } from './CertProvider.js'
import { parseCertNotAfter } from './parseCert.js'

// cert/key를 디스크에 영속화한다. 만료는 저장값이 아니라 cert에서 파싱(드리프트 방지).
// 키 파일은 0600(JWT secret과 동일 패턴) — 개인키는 소유자만 읽는다.
export class DiskCertStore implements CertStore {
  private readonly certPath: string
  private readonly keyPath: string

  constructor(dir: string) {
    this.certPath = path.join(dir, 'cert.pem')
    this.keyPath = path.join(dir, 'key.pem')
  }

  async load(): Promise<CertMaterial | null> {
    try {
      const cert = fs.readFileSync(this.certPath, 'utf-8')
      const key = fs.readFileSync(this.keyPath, 'utf-8')
      return { cert, key, expiresAt: parseCertNotAfter(cert) }
    } catch {
      return null
    }
  }

  async save(material: CertMaterial): Promise<void> {
    fs.mkdirSync(path.dirname(this.certPath), { recursive: true })
    fs.writeFileSync(this.certPath, material.cert, { mode: 0o644 })
    fs.writeFileSync(this.keyPath, material.key, { mode: 0o600 })
    try {
      fs.chmodSync(this.keyPath, 0o600)
    } catch {
      // best-effort on platforms without POSIX permissions
    }
  }
}
