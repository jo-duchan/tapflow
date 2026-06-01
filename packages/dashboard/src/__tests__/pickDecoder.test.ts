import { describe, it, expect } from 'vitest'
import { pickDecoder, detectCapabilities, type DecoderCapabilities } from '@/lib/decoders/pickDecoder'
import { WebCodecsDecoder } from '@/lib/decoders/WebCodecsDecoder'
import { MSEDecoder, type Muxer } from '@/lib/decoders/MSEDecoder'

// MSE 분기가 jsdom에서 jmuxer를 실행하지 않도록 목 팩토리 주입
const muxerFactory = (_v: HTMLVideoElement): Muxer => ({ feed: () => {}, destroy: () => {} })

function caps(p: Partial<DecoderCapabilities> = {}): DecoderCapabilities {
  return { secureContext: false, webCodecs: false, webgl2: false, mse: false, ...p }
}

// ── WebCodecs 선택 ────────────────────────────────────────────────────────────
describe('pickDecoder — WebCodecs 선택', () => {
  it('secure + VideoDecoder + WebGL2 → WebCodecsDecoder', () => {
    const d = pickDecoder(muxerFactory, caps({ secureContext: true, webCodecs: true, webgl2: true }))
    expect(d).toBeInstanceOf(WebCodecsDecoder)
  })

  it('WebCodecs 조건과 MSE가 모두 가능하면 WebCodecs 우선', () => {
    const d = pickDecoder(muxerFactory, caps({ secureContext: true, webCodecs: true, webgl2: true, mse: true }))
    expect(d).toBeInstanceOf(WebCodecsDecoder)
  })
})

// ── MSE 폴백 ──────────────────────────────────────────────────────────────────
describe('pickDecoder — MSE 폴백', () => {
  it('secure context 아님 → MSE (WebCodecs는 secure 필요)', () => {
    const d = pickDecoder(muxerFactory, caps({ webCodecs: true, webgl2: true, mse: true }))
    expect(d).toBeInstanceOf(MSEDecoder)
  })

  it('WebGL2 없음 → MSE (WebGL2를 WebCodecs 자격에 흡수)', () => {
    const d = pickDecoder(muxerFactory, caps({ secureContext: true, webCodecs: true, webgl2: false, mse: true }))
    expect(d).toBeInstanceOf(MSEDecoder)
  })

  it('VideoDecoder 없음 → MSE', () => {
    const d = pickDecoder(muxerFactory, caps({ secureContext: true, webCodecs: false, webgl2: true, mse: true }))
    expect(d).toBeInstanceOf(MSEDecoder)
  })

  it('MSE만 가능 → MSE', () => {
    const d = pickDecoder(muxerFactory, caps({ mse: true }))
    expect(d).toBeInstanceOf(MSEDecoder)
  })
})

// ── 폴백 불가 ─────────────────────────────────────────────────────────────────
describe('pickDecoder — 디코더 없음', () => {
  it('아무 디코더도 불가능하면 null', () => {
    expect(pickDecoder(muxerFactory, caps())).toBeNull()
  })

  it('WebCodecs가 secure만 빠지고 MSE도 없으면 null', () => {
    expect(pickDecoder(muxerFactory, caps({ webCodecs: true, webgl2: true }))).toBeNull()
  })
})

// ── detectCapabilities ────────────────────────────────────────────────────────
describe('detectCapabilities', () => {
  it('4개 boolean 필드 객체를 반환한다 (throw 없음)', () => {
    const c = detectCapabilities()
    expect(typeof c.secureContext).toBe('boolean')
    expect(typeof c.webCodecs).toBe('boolean')
    expect(typeof c.webgl2).toBe('boolean')
    expect(typeof c.mse).toBe('boolean')
  })
})
