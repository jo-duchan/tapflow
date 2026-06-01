import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest'
import { WebCodecsDecoder } from '@/lib/decoders/WebCodecsDecoder'
import type { Decoder, DecoderSize } from '@/lib/decoders/types'

// ── WebCodecs 글로벌 목 (코어가 사용) ─────────────────────────────────────────
class MockVideoDecoder {
  static instances: MockVideoDecoder[] = []
  closed = false
  constructor(public init: { output: (f: unknown) => void; error: (e: unknown) => void }) {
    MockVideoDecoder.instances.push(this)
  }
  configure() {}
  decode() {}
  close() { this.closed = true }
}
class MockEncodedVideoChunk {
  constructor(public init: unknown) {}
}

beforeEach(() => {
  MockVideoDecoder.instances = []
  ;(globalThis as unknown as { VideoDecoder: unknown }).VideoDecoder = MockVideoDecoder
  ;(globalThis as unknown as { EncodedVideoChunk: unknown }).EncodedVideoChunk = MockEncodedVideoChunk
})

// ── 헬퍼 ──────────────────────────────────────────────────────────────────────
function nal(...bytes: number[]): ArrayBuffer {
  return new Uint8Array([0, 0, 0, 1, ...bytes]).buffer
}
function feedReady(d: Decoder) {
  d.decode(nal(0x67, 0x42, 0x00, 0x1f, 0xaa)) // SPS
  d.decode(nal(0x68, 0xce, 0x3c, 0x80))       // PPS
  d.decode(nal(0x65, 0x11, 0x22))             // IDR → 디코더 생성
}
const frame = () => ({ displayWidth: 1, displayHeight: 1, close: vi.fn() }) as unknown as VideoFrame
/** 코어의 VideoDecoder output을 수동으로 발화시켜 디코드된 프레임을 시뮬레이트. */
function emitFrame() { MockVideoDecoder.instances[0].init.output(frame()) }

function mockRenderer(size: DecoderSize | null = { width: 640, height: 480 }): {
  drawFrame: Mock<(frame: VideoFrame) => DecoderSize | null>; dispose: Mock<() => void>
} {
  return {
    drawFrame: vi.fn<(frame: VideoFrame) => DecoderSize | null>(() => size),
    dispose: vi.fn<() => void>(),
  }
}

// ── Decoder 인터페이스 ────────────────────────────────────────────────────────
describe('WebCodecsDecoder — Decoder 인터페이스', () => {
  it('decode/close/surface/size/onResize를 갖춘다', () => {
    const d: Decoder = new WebCodecsDecoder(() => mockRenderer())
    expect(typeof d.decode).toBe('function')
    expect(typeof d.close).toBe('function')
    expect(typeof d.onResize).toBe('function')
    expect(d.size).toBeNull()
    expect(d.surface).toBeInstanceOf(HTMLCanvasElement)
  })
})

// ── 코어 위임 ─────────────────────────────────────────────────────────────────
describe('WebCodecsDecoder — 코어 위임', () => {
  it('decode는 SPS+PPS+IDR로 내부 디코더를 구성한다', () => {
    const d = new WebCodecsDecoder(() => mockRenderer())
    feedReady(d)
    expect(MockVideoDecoder.instances).toHaveLength(1)
  })
})

// ── 렌더 + size + onResize ────────────────────────────────────────────────────
describe('WebCodecsDecoder — 프레임 출력 시 렌더/size/onResize', () => {
  it('프레임 출력 시 renderer.drawFrame을 호출하고 size를 갱신한다', () => {
    const renderer = mockRenderer({ width: 640, height: 480 })
    const d = new WebCodecsDecoder(() => renderer)
    feedReady(d)
    emitFrame()
    expect(renderer.drawFrame).toHaveBeenCalledOnce()
    expect(d.size).toEqual({ width: 640, height: 480 })
  })

  it('첫 프레임에서 onResize를 발화한다', () => {
    const d = new WebCodecsDecoder(() => mockRenderer({ width: 640, height: 480 }))
    const onResize = vi.fn()
    d.onResize(onResize)
    feedReady(d)
    emitFrame()
    expect(onResize).toHaveBeenCalledWith({ width: 640, height: 480 })
  })

  it('동일 크기 연속 프레임은 onResize를 한 번만 발화한다', () => {
    const d = new WebCodecsDecoder(() => mockRenderer({ width: 640, height: 480 }))
    const onResize = vi.fn()
    d.onResize(onResize)
    feedReady(d)
    emitFrame(); emitFrame()
    expect(onResize).toHaveBeenCalledOnce()
  })

  it('크기가 바뀌면 onResize를 다시 발화한다', () => {
    const renderer = mockRenderer()
    renderer.drawFrame
      .mockReturnValueOnce({ width: 640, height: 480 })
      .mockReturnValueOnce({ width: 480, height: 640 })
    const d = new WebCodecsDecoder(() => renderer)
    const onResize = vi.fn()
    d.onResize(onResize)
    feedReady(d)
    emitFrame(); emitFrame()
    expect(onResize).toHaveBeenCalledTimes(2)
  })

  it('drawFrame이 null이면 size/onResize를 갱신하지 않는다', () => {
    const d = new WebCodecsDecoder(() => mockRenderer(null))
    const onResize = vi.fn()
    d.onResize(onResize)
    feedReady(d)
    emitFrame()
    expect(d.size).toBeNull()
    expect(onResize).not.toHaveBeenCalled()
  })
})

// ── close ─────────────────────────────────────────────────────────────────────
describe('WebCodecsDecoder — close', () => {
  it('renderer.dispose와 내부 디코더를 모두 닫는다', () => {
    const renderer = mockRenderer()
    const d = new WebCodecsDecoder(() => renderer)
    feedReady(d)
    const dec = MockVideoDecoder.instances[0]
    d.close()
    expect(renderer.dispose).toHaveBeenCalledOnce()
    expect(dec.closed).toBe(true)
  })
})
