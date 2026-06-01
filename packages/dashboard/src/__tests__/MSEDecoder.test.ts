import { describe, it, expect, vi, type Mock } from 'vitest'
import { MSEDecoder } from '@/lib/decoders/MSEDecoder'
import type { Decoder } from '@/lib/decoders/types'

// ── Muxer seam 목 (jmuxer 대체 — jsdom엔 MediaSource가 없음) ──────────────────
function mockMuxer(): { feed: Mock<(data: { video: Uint8Array }) => void>; destroy: Mock<() => void> } {
  return {
    feed: vi.fn<(data: { video: Uint8Array }) => void>(),
    destroy: vi.fn<() => void>(),
  }
}

function setVideoSize(video: HTMLVideoElement, w: number, h: number) {
  Object.defineProperty(video, 'videoWidth', { value: w, configurable: true })
  Object.defineProperty(video, 'videoHeight', { value: h, configurable: true })
}

// ── Decoder 인터페이스 ────────────────────────────────────────────────────────
describe('MSEDecoder — Decoder 인터페이스', () => {
  it('decode/close/onResize를 갖추고 surface는 video, size는 null로 시작', () => {
    const d: Decoder = new MSEDecoder(() => mockMuxer())
    expect(typeof d.decode).toBe('function')
    expect(typeof d.close).toBe('function')
    expect(typeof d.onResize).toBe('function')
    expect(d.size).toBeNull()
    expect(d.surface).toBeInstanceOf(HTMLVideoElement)
  })

  it('video는 muted/autoplay/playsInline로 설정된다 (제스처 없이 재생)', () => {
    const d = new MSEDecoder(() => mockMuxer())
    const video = d.surface as HTMLVideoElement
    expect(video.muted).toBe(true)
    expect(video.autoplay).toBe(true)
    expect(video.playsInline).toBe(true)
  })
})

// ── decode → muxer.feed ───────────────────────────────────────────────────────
describe('MSEDecoder — decode', () => {
  it('ArrayBuffer를 Uint8Array로 변환해 muxer.feed로 전달한다', () => {
    const muxer = mockMuxer()
    const d = new MSEDecoder(() => muxer)
    const buf = new Uint8Array([0, 0, 0, 1, 0x65, 0x11, 0x22]).buffer
    d.decode(buf)
    expect(muxer.feed).toHaveBeenCalledOnce()
    const arg = muxer.feed.mock.calls[0][0]
    expect(arg.video).toBeInstanceOf(Uint8Array)
    expect(Array.from(arg.video)).toEqual([0, 0, 0, 1, 0x65, 0x11, 0x22])
  })
})

// ── resize → size / onResize ──────────────────────────────────────────────────
describe('MSEDecoder — resize 이벤트로 size/onResize', () => {
  it('resize 시 videoWidth/Height로 size를 갱신하고 onResize를 발화한다', () => {
    const d = new MSEDecoder(() => mockMuxer())
    const onResize = vi.fn()
    d.onResize(onResize)
    const video = d.surface as HTMLVideoElement
    setVideoSize(video, 640, 480)
    video.dispatchEvent(new Event('resize'))
    expect(d.size).toEqual({ width: 640, height: 480 })
    expect(onResize).toHaveBeenCalledWith({ width: 640, height: 480 })
  })

  it('동일 크기 resize 반복은 onResize를 한 번만 발화한다', () => {
    const d = new MSEDecoder(() => mockMuxer())
    const onResize = vi.fn()
    d.onResize(onResize)
    const video = d.surface as HTMLVideoElement
    setVideoSize(video, 640, 480)
    video.dispatchEvent(new Event('resize'))
    video.dispatchEvent(new Event('resize'))
    expect(onResize).toHaveBeenCalledOnce()
  })

  it('크기가 바뀌면 onResize를 다시 발화한다', () => {
    const d = new MSEDecoder(() => mockMuxer())
    const onResize = vi.fn()
    d.onResize(onResize)
    const video = d.surface as HTMLVideoElement
    setVideoSize(video, 640, 480)
    video.dispatchEvent(new Event('resize'))
    setVideoSize(video, 480, 640)
    video.dispatchEvent(new Event('resize'))
    expect(onResize).toHaveBeenCalledTimes(2)
  })

  it('videoWidth가 0이면 무시한다(메타데이터 전)', () => {
    const d = new MSEDecoder(() => mockMuxer())
    const onResize = vi.fn()
    d.onResize(onResize)
    const video = d.surface as HTMLVideoElement
    setVideoSize(video, 0, 0)
    video.dispatchEvent(new Event('resize'))
    expect(d.size).toBeNull()
    expect(onResize).not.toHaveBeenCalled()
  })
})

// ── close ─────────────────────────────────────────────────────────────────────
describe('MSEDecoder — close', () => {
  it('muxer.destroy를 호출한다', () => {
    const muxer = mockMuxer()
    const d = new MSEDecoder(() => muxer)
    d.close()
    expect(muxer.destroy).toHaveBeenCalledOnce()
  })

  it('close 후 resize 이벤트는 onResize를 발화하지 않는다(리스너 제거)', () => {
    const d = new MSEDecoder(() => mockMuxer())
    const onResize = vi.fn()
    d.onResize(onResize)
    const video = d.surface as HTMLVideoElement
    d.close()
    setVideoSize(video, 640, 480)
    video.dispatchEvent(new Event('resize'))
    expect(onResize).not.toHaveBeenCalled()
  })
})

// ── 해상도 변경(SPS 변경) 시 재초기화 ─────────────────────────────────────────
// MSE는 스트림 중간 해상도 변경을 못 버티므로, SPS가 바뀌면 muxer/MediaSource를 재생성한다.
function trackingFactory() {
  const muxers: ReturnType<typeof mockMuxer>[] = []
  const factory = (_v: HTMLVideoElement) => { const m = mockMuxer(); muxers.push(m); return m }
  return { factory, muxers }
}
// SPS(type 7): level 바이트만 바꿔 "다른 해상도" 시뮬레이트
const SPS = (level = 0x1f) => new Uint8Array([0, 0, 0, 1, 0x67, 0x42, 0x00, level, 0xaa]).buffer
const IDR = () => new Uint8Array([0, 0, 0, 1, 0x65, 0x11, 0x22]).buffer

describe('MSEDecoder — 해상도 변경(SPS 변경) 시 재초기화', () => {
  it('초기 SPS는 muxer를 재생성하지 않는다', () => {
    const { factory, muxers } = trackingFactory()
    const d = new MSEDecoder(factory)
    d.decode(SPS())
    expect(muxers).toHaveLength(1) // 생성자에서 만든 1개뿐
  })

  it('동일 SPS 재수신은 재생성하지 않는다', () => {
    const { factory, muxers } = trackingFactory()
    const d = new MSEDecoder(factory)
    d.decode(SPS()); d.decode(IDR()); d.decode(SPS())
    expect(muxers).toHaveLength(1)
  })

  it('다른 SPS(해상도 변경)는 기존 muxer를 destroy하고 새로 만든다', () => {
    const { factory, muxers } = trackingFactory()
    const d = new MSEDecoder(factory)
    d.decode(SPS(0x1f))
    d.decode(SPS(0x28)) // 다른 level → 다른 SPS
    expect(muxers).toHaveLength(2)
    expect(muxers[0].destroy).toHaveBeenCalledOnce()
  })

  it('재생성 후 새 SPS는 새 muxer로 feed된다', () => {
    const { factory, muxers } = trackingFactory()
    const d = new MSEDecoder(factory)
    d.decode(SPS(0x1f))
    d.decode(SPS(0x28))
    expect(muxers[1].feed).toHaveBeenCalledOnce()
    expect(Array.from(muxers[1].feed.mock.calls[0][0].video))
      .toEqual([0, 0, 0, 1, 0x67, 0x42, 0x00, 0x28, 0xaa])
  })
})
