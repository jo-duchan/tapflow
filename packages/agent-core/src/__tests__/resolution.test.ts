import { describe, it, expect, afterEach } from 'vitest'
import { pickMaxSize } from '../utils/resolution.js'

describe('pickMaxSize', () => {
  const saved = { ...process.env }
  afterEach(() => { process.env = { ...saved } })

  it('secure context (localhost / LAN-HTTPS) → native (0)', () => {
    expect(pickMaxSize({ secureContext: true, external: false })).toBe(0)
  })

  it('LAN-HTTP (non-secure) → 1280', () => {
    expect(pickMaxSize({ secureContext: false, external: false })).toBe(1280)
  })

  it('external connection → 1000 (even when secure)', () => {
    expect(pickMaxSize({ secureContext: false, external: true })).toBe(1000)
    expect(pickMaxSize({ secureContext: true, external: true })).toBe(1000)
  })

  it('override wins, including "0" for forced native', () => {
    expect(pickMaxSize({ secureContext: false, external: true, override: '720' })).toBe(720)
    expect(pickMaxSize({ secureContext: false, external: false, override: '0' })).toBe(0)
  })

  it('LAN / external defaults are env-tunable', () => {
    process.env.TAPFLOW_MAX_SIZE_LAN = '1440'
    process.env.TAPFLOW_MAX_SIZE_EXTERNAL = '800'
    expect(pickMaxSize({ secureContext: false, external: false })).toBe(1440)
    expect(pickMaxSize({ secureContext: false, external: true })).toBe(800)
  })

  it('env "0" forces native (not swallowed as falsy)', () => {
    process.env.TAPFLOW_MAX_SIZE_LAN = '0'
    process.env.TAPFLOW_MAX_SIZE_EXTERNAL = '0'
    expect(pickMaxSize({ secureContext: false, external: false })).toBe(0)
    expect(pickMaxSize({ secureContext: false, external: true })).toBe(0)
  })

  it('invalid / negative env falls back to the default', () => {
    process.env.TAPFLOW_MAX_SIZE_LAN = 'abc'
    process.env.TAPFLOW_MAX_SIZE_EXTERNAL = '-5'
    expect(pickMaxSize({ secureContext: false, external: false })).toBe(1280)
    expect(pickMaxSize({ secureContext: false, external: true })).toBe(1000)
  })
})
