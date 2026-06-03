import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { pickDecoder, canDecodeH264, detectCapabilities, type DecoderCapabilities } from '@/lib/decoders/pickDecoder'
import { WebCodecsDecoder } from '@/lib/decoders/WebCodecsDecoder'
import { WASMDecoder } from '@/lib/decoders/WASMDecoder'

// WASMDecoder's default ctor spawns a Web Worker (jsdom has none) — stub it so the
// WASM branch can be constructed. WebGL getContext returns null in jsdom, which the
// renderers handle gracefully (init() → false, no throw), so no GL stub is needed.
class FakeWorker {
  onmessage: ((e: MessageEvent) => void) | null = null
  postMessage() {}
  terminate() {}
}

beforeAll(() => { vi.stubGlobal('Worker', FakeWorker) })
afterAll(() => { vi.unstubAllGlobals() })

function caps(p: Partial<DecoderCapabilities> = {}): DecoderCapabilities {
  return { secureContext: false, webCodecs: false, webgl2: false, wasm: false, ...p }
}

// ── WebCodecs (secure) ──────────────────────────────────────────────────────────
describe('pickDecoder — WebCodecs 선택 (secure)', () => {
  it('secure + VideoDecoder + WebGL2 → WebCodecsDecoder', () => {
    const d = pickDecoder(caps({ secureContext: true, webCodecs: true, webgl2: true }))
    expect(d).toBeInstanceOf(WebCodecsDecoder)
  })

  it('WebCodecs·WASM 모두 가능하면 WebCodecs 우선', () => {
    const d = pickDecoder(caps({ secureContext: true, webCodecs: true, webgl2: true, wasm: true }))
    expect(d).toBeInstanceOf(WebCodecsDecoder)
  })
})

// ── WASM (plain HTTP) ─────────────────────────────────────────────────────────────
describe('pickDecoder — WASM 선택 (plain HTTP)', () => {
  it('비-secure + wasm + WebGL2 → WASMDecoder', () => {
    const d = pickDecoder(caps({ wasm: true, webgl2: true }))
    expect(d).toBeInstanceOf(WASMDecoder)
  })

  it('secure지만 WebCodecs 미지원 → WASM 폴백', () => {
    const d = pickDecoder(caps({ secureContext: true, webCodecs: false, wasm: true, webgl2: true }))
    expect(d).toBeInstanceOf(WASMDecoder)
  })
})

// ── 디코더 없음 (MSE 폴백 제거됨) ──────────────────────────────────────────────────
describe('pickDecoder — 디코더 없음', () => {
  it('WebGL2 없으면 null (두 디코더 다 WebGL 렌더)', () => {
    expect(pickDecoder(caps({ secureContext: true, webCodecs: true, wasm: true, webgl2: false }))).toBeNull()
  })

  it('wasm 미지원 + 비-secure → null (MSE 폴백 없음)', () => {
    expect(pickDecoder(caps({ wasm: false, webgl2: true }))).toBeNull()
  })

  it('아무 것도 불가 → null', () => {
    expect(pickDecoder(caps())).toBeNull()
  })
})

// ── canDecodeH264 (사전 코덱 협상 판정) ─────────────────────────────────────────────
describe('canDecodeH264 — boot acceptH264 판정 (pickDecoder와 동일 조건)', () => {
  it('secure + WebCodecs + WebGL2 → true', () => {
    expect(canDecodeH264(caps({ secureContext: true, webCodecs: true, webgl2: true }))).toBe(true)
  })

  it('비-secure + wasm + WebGL2 → true', () => {
    expect(canDecodeH264(caps({ wasm: true, webgl2: true }))).toBe(true)
  })

  it('WebGL2 없으면 false (디코드 불가 → agent가 JPEG)', () => {
    expect(canDecodeH264(caps({ secureContext: true, webCodecs: true, wasm: true, webgl2: false }))).toBe(false)
  })

  it('wasm 미지원 + 비-secure → false', () => {
    expect(canDecodeH264(caps({ wasm: false, webgl2: true }))).toBe(false)
  })

  it('아무 것도 불가 → false', () => {
    expect(canDecodeH264(caps())).toBe(false)
  })
})

// ── detectCapabilities ────────────────────────────────────────────────────────────
describe('detectCapabilities', () => {
  it('4개 boolean 필드 객체를 반환한다 (throw 없음)', () => {
    const c = detectCapabilities()
    expect(typeof c.secureContext).toBe('boolean')
    expect(typeof c.webCodecs).toBe('boolean')
    expect(typeof c.webgl2).toBe('boolean')
    expect(typeof c.wasm).toBe('boolean')
  })
})
