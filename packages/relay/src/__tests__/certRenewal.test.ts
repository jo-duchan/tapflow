import { describe, it, expect, vi } from 'vitest'
import { renewalTick, startCertRenewal } from '../lib/cert/renewal.js'
import type { CertProvider, CertMaterial } from '../lib/cert/CertProvider.js'

const material: CertMaterial = { cert: 'C', key: 'K', expiresAt: new Date(Date.now() + 86_400_000) }

function provider(renew: () => Promise<CertMaterial | null>): CertProvider {
  return {
    strategy: 'byo-api-token',
    ensureCert: async () => material,
    renewIfNeeded: renew,
  }
}

describe('renewalTick', () => {
  it('갱신되면 onRenew를 새 자료로 호출한다', async () => {
    const onRenew = vi.fn()
    await renewalTick(provider(async () => material), { onRenew })
    expect(onRenew).toHaveBeenCalledWith(material)
  })

  it('갱신 불필요(null)면 onRenew를 호출하지 않는다', async () => {
    const onRenew = vi.fn()
    await renewalTick(provider(async () => null), { onRenew })
    expect(onRenew).not.toHaveBeenCalled()
  })

  it('renew가 throw해도 전파하지 않고 onError로 넘긴다', async () => {
    const onError = vi.fn()
    await expect(
      renewalTick(provider(async () => { throw new Error('boom') }), { onError }),
    ).resolves.toBeUndefined()
    expect(onError).toHaveBeenCalled()
  })
})

describe('startCertRenewal', () => {
  it('stop 함수를 반환하고 호출해도 throw하지 않는다', () => {
    const stop = startCertRenewal(provider(async () => null), { intervalMs: 1_000_000 })
    expect(typeof stop).toBe('function')
    expect(() => stop()).not.toThrow()
  })
})
