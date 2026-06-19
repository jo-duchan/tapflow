import { describe, it, expect } from 'vitest'
import { isLocalhostWss } from '../utils/relayUrl'

describe('isLocalhostWss', () => {
  it('is true for wss to localhost / 127.0.0.1 / [::1]', () => {
    expect(isLocalhostWss('wss://localhost:4000')).toBe(true)
    expect(isLocalhostWss('wss://127.0.0.1:4000')).toBe(true)
    expect(isLocalhostWss('wss://[::1]:4000')).toBe(true)
  })

  it('is false for plain ws (no TLS, nothing to skip)', () => {
    expect(isLocalhostWss('ws://localhost:4000')).toBe(false)
  })

  it('is false for wss to a non-localhost host (verification must stay on)', () => {
    expect(isLocalhostWss('wss://relay.example.com:4000')).toBe(false)
    expect(isLocalhostWss('wss://192.168.0.10:4000')).toBe(false)
  })

  it('is false for a malformed url', () => {
    expect(isLocalhostWss('not a url')).toBe(false)
  })
})
