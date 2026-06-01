import { describe, it, expect, beforeEach } from 'vitest'
import { WebCodecsCore } from '@/lib/decoders/WebCodecsCore'

// ── WebCodecs 글로벌 목 (jsdom에 없음) ───────────────────────────────────────
interface CapturedChunk { type: string; timestamp: number; data: Uint8Array }

class MockVideoDecoder {
  static instances: MockVideoDecoder[] = []
  configureCalls: { codec: string; description: Uint8Array; optimizeForLatency?: boolean }[] = []
  decodeCalls: CapturedChunk[] = []
  closed = false
  constructor(public init: { output: (f: unknown) => void; error: (e: unknown) => void }) {
    MockVideoDecoder.instances.push(this)
  }
  configure(cfg: { codec: string; description: Uint8Array; optimizeForLatency?: boolean }) {
    this.configureCalls.push(cfg)
  }
  decode(chunk: CapturedChunk) { this.decodeCalls.push(chunk) }
  close() { this.closed = true }
}

class MockEncodedVideoChunk {
  type: string; timestamp: number; data: Uint8Array
  constructor(init: CapturedChunk) {
    this.type = init.type; this.timestamp = init.timestamp; this.data = init.data
  }
}

beforeEach(() => {
  MockVideoDecoder.instances = []
  ;(globalThis as unknown as { VideoDecoder: unknown }).VideoDecoder = MockVideoDecoder
  ;(globalThis as unknown as { EncodedVideoChunk: unknown }).EncodedVideoChunk = MockEncodedVideoChunk
})

// ── NAL 픽스처 (Annex B framed: 00 00 00 01 + NAL) ────────────────────────────
function nal(...bytes: number[]): ArrayBuffer {
  return new Uint8Array([0, 0, 0, 1, ...bytes]).buffer
}
// SPS(type 7): header 0x67, profile=0x42, compat=0x00, level=0x1f
const SPS = () => nal(0x67, 0x42, 0x00, 0x1f, 0xaa)
const PPS = () => nal(0x68, 0xce, 0x3c, 0x80)       // type 8
const IDR = () => nal(0x65, 0x11, 0x22)             // type 5 (keyframe)
const PFRAME = () => nal(0x41, 0x33, 0x44)          // type 1 (non-IDR slice)

function feedReady(d: WebCodecsCore) { d.decode(SPS()); d.decode(PPS()); d.decode(IDR()) }

// ── lazy init ─────────────────────────────────────────────────────────────────
describe('WebCodecsCore — lazy init (SPS+PPS+IDR 모두 모이면 생성)', () => {
  it('IDR 이전에는 디코더를 만들지 않는다', () => {
    const d = new WebCodecsCore(() => {})
    d.decode(SPS()); d.decode(PPS())
    expect(MockVideoDecoder.instances).toHaveLength(0)
  })

  it('SPS+PPS+IDR 순서로 디코더 1개 생성 + configure 1회', () => {
    const d = new WebCodecsCore(() => {})
    feedReady(d)
    expect(MockVideoDecoder.instances).toHaveLength(1)
    expect(MockVideoDecoder.instances[0].configureCalls).toHaveLength(1)
  })

  it('PPS 없이 IDR가 오면 디코더를 만들지 않는다', () => {
    const d = new WebCodecsCore(() => {})
    d.decode(SPS()); d.decode(IDR())
    expect(MockVideoDecoder.instances).toHaveLength(0)
  })
})

// ── configure 인자 ──────────────────────────────────────────────────────────
describe('WebCodecsCore — configure 인자', () => {
  it('codec 문자열을 SPS 바이트에서 유도한다 (avc1.42001f)', () => {
    const d = new WebCodecsCore(() => {})
    feedReady(d)
    expect(MockVideoDecoder.instances[0].configureCalls[0].codec).toBe('avc1.42001f')
  })

  it('optimizeForLatency=true로 설정한다', () => {
    const d = new WebCodecsCore(() => {})
    feedReady(d)
    expect(MockVideoDecoder.instances[0].configureCalls[0].optimizeForLatency).toBe(true)
  })

  it('description은 올바른 AVCDecoderConfigurationRecord 바이트', () => {
    const d = new WebCodecsCore(() => {})
    feedReady(d)
    const desc = MockVideoDecoder.instances[0].configureCalls[0].description
    expect(Array.from(desc)).toEqual([
      0x01,                   // configurationVersion
      0x42, 0x00, 0x1f,       // profile / compat / level
      0xff,                   // lengthSizeMinusOne=3
      0xe1,                   // numSPS=1
      0x00, 0x05,             // SPS length = 5
      0x67, 0x42, 0x00, 0x1f, 0xaa, // SPS NAL (start code 제거)
      0x01,                   // numPPS=1
      0x00, 0x04,             // PPS length = 4
      0x68, 0xce, 0x3c, 0x80, // PPS NAL
    ])
  })
})

// ── chunk 타입 ────────────────────────────────────────────────────────────────
describe('WebCodecsCore — chunk 타입 (key/delta)', () => {
  it('IDR은 key, 이후 P프레임은 delta', () => {
    const d = new WebCodecsCore(() => {})
    feedReady(d); d.decode(PFRAME())
    const dec = MockVideoDecoder.instances[0]
    expect(dec.decodeCalls[0].type).toBe('key')
    expect(dec.decodeCalls[1].type).toBe('delta')
  })

  it('chunk 데이터는 AVCC(4바이트 길이 프리픽스) 포맷', () => {
    const d = new WebCodecsCore(() => {})
    feedReady(d)
    // IDR nalData = [0x65,0x11,0x22] → length 3 → [00 00 00 03 65 11 22]
    expect(Array.from(MockVideoDecoder.instances[0].decodeCalls[0].data))
      .toEqual([0x00, 0x00, 0x00, 0x03, 0x65, 0x11, 0x22])
  })
})

// ── SPS 변경 → 디코더 리셋 ────────────────────────────────────────────────────
describe('WebCodecsCore — SPS 변경 시 디코더 리셋', () => {
  it('다른 SPS가 오면 기존 디코더를 close한다', () => {
    const d = new WebCodecsCore(() => {})
    feedReady(d)
    const first = MockVideoDecoder.instances[0]
    d.decode(nal(0x67, 0x4d, 0x00, 0x28, 0xbb)) // 다른 프로파일/레벨
    expect(first.closed).toBe(true)
  })

  it('동일 SPS 재수신은 디코더를 닫지 않는다', () => {
    const d = new WebCodecsCore(() => {})
    feedReady(d)
    const first = MockVideoDecoder.instances[0]
    d.decode(SPS()) // 동일 내용
    expect(first.closed).toBe(false)
  })
})

// ── onFrame / close ──────────────────────────────────────────────────────────
describe('WebCodecsCore — onFrame / close', () => {
  it('디코더 output이 onFrame 콜백으로 전달된다', () => {
    const frames: unknown[] = []
    const d = new WebCodecsCore((f) => frames.push(f))
    feedReady(d)
    const fakeFrame = { displayWidth: 1, displayHeight: 1 }
    MockVideoDecoder.instances[0].init.output(fakeFrame)
    expect(frames).toEqual([fakeFrame])
  })

  it('close()는 내부 디코더를 닫는다', () => {
    const d = new WebCodecsCore(() => {})
    feedReady(d)
    const dec = MockVideoDecoder.instances[0]
    d.close()
    expect(dec.closed).toBe(true)
  })
})
