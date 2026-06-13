import { describe, it, expect } from 'vitest'
import type { CertProvider, CertMaterial } from '../lib/cert/index.js'

// 인터페이스 계약 검증 — 실제 발급 없이 동작만 모사하는 fake로 미래 구현이 지켜야 할 규약을 고정한다.

const DAY = 24 * 60 * 60 * 1000
const RENEW_THRESHOLD_DAYS = 30

class FakeCertProvider implements CertProvider {
  readonly strategy = 'byo-api-token' as const
  private material: CertMaterial | null = null
  private issueCount = 0

  constructor(private readonly validForDays: number) {}

  async ensureCert(): Promise<CertMaterial> {
    if (this.material) return this.material
    this.material = this.issue()
    return this.material
  }

  async renewIfNeeded(): Promise<CertMaterial | null> {
    const cur = await this.ensureCert()
    const remainingMs = cur.expiresAt.getTime() - Date.now()
    if (remainingMs > RENEW_THRESHOLD_DAYS * DAY) return null
    this.material = this.issue()
    return this.material
  }

  get issued(): number {
    return this.issueCount
  }

  private issue(): CertMaterial {
    this.issueCount++
    return {
      cert: '-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----',
      key: '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----',
      expiresAt: new Date(Date.now() + this.validForDays * DAY),
    }
  }
}

describe('CertProvider 계약', () => {
  it('ensureCert는 cert/key/만료를 채운 자료를 반환한다', async () => {
    const p = new FakeCertProvider(90)
    const m = await p.ensureCert()
    expect(m.cert).toContain('BEGIN CERTIFICATE')
    expect(m.key).toContain('PRIVATE KEY')
    expect(m.expiresAt.getTime()).toBeGreaterThan(Date.now())
  })

  it('ensureCert는 멱등이다 — 반복 호출에도 재발급하지 않는다', async () => {
    const p = new FakeCertProvider(90)
    await p.ensureCert()
    await p.ensureCert()
    expect(p.issued).toBe(1)
  })

  it('renewIfNeeded는 유효기간이 충분하면 null (부팅마다 재발급 금지)', async () => {
    const p = new FakeCertProvider(90)
    await p.ensureCert()
    expect(await p.renewIfNeeded()).toBeNull()
    expect(p.issued).toBe(1)
  })

  it('renewIfNeeded는 만료 임박(<30일)에만 갱신한다', async () => {
    const p = new FakeCertProvider(10)
    await p.ensureCert()
    const renewed = await p.renewIfNeeded()
    expect(renewed).not.toBeNull()
    expect(p.issued).toBe(2)
  })

  // 키 locality: 키는 오직 CertMaterial로만 노출된다. 진짜 반출 방지는 구현별 테스트(네트워크 sink 미호출)로
  // 강제하되, 인터페이스 차원에선 export/upload류 메서드가 계약에 추가되지 않도록 가드한다.
  it('키 locality — 공개 계약에 키 반출 메서드가 없다', () => {
    const surface = Object.getOwnPropertyNames(FakeCertProvider.prototype).filter((n) => n !== 'constructor')
    for (const forbidden of ['exportKey', 'uploadKey', 'sendKey', 'getPrivateKey']) {
      expect(surface).not.toContain(forbidden)
    }
  })
})
