import fs from 'fs'
import type { CertProvider, CertMaterial, CertStrategy } from './CertProvider.js'
import { parseCertNotAfter } from './parseCert.js'

export interface ImportCertProviderOptions {
  certPath: string
  keyPath: string
  /** 테스트 주입용. 기본 fs.readFileSync(utf-8). */
  readFileFn?: (filePath: string) => string
}

/**
 * 사용자가 직접 마련한 cert/key 파일을 로드하는 CertProvider.
 * ACME를 돌리지 않으므로 갱신은 사용자 책임 — renewIfNeeded는 항상 null.
 */
export class ImportCertProvider implements CertProvider {
  readonly strategy: CertStrategy = 'import-cert'
  private readonly readFile: (filePath: string) => string

  constructor(private readonly opts: ImportCertProviderOptions) {
    this.readFile = opts.readFileFn ?? ((filePath: string) => fs.readFileSync(filePath, 'utf-8'))
  }

  async ensureCert(): Promise<CertMaterial> {
    const cert = this.readFile(this.opts.certPath)
    const key = this.readFile(this.opts.keyPath)
    return { cert, key, expiresAt: parseCertNotAfter(cert) }
  }

  async renewIfNeeded(): Promise<CertMaterial | null> {
    return null
  }
}
