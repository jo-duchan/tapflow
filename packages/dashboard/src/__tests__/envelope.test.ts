import { describe, it, expect } from 'vitest'
import { parseEnvelopeHeader, HEADER_SIZE, CODEC_JPEG, CODEC_H264, CODEC_AUDIO } from '@/lib/envelope'

// Builds a TFFE envelope frame for testing. flags = byte 5.
function makeFrame(opts: {
  version?: number
  flags?: number
  capturedAt?: number
  relayedAt?: number
  payload?: number[]
  magic?: number[]
}): ArrayBuffer {
  const payload = opts.payload ?? []
  const buf = new ArrayBuffer(HEADER_SIZE + payload.length)
  const view = new DataView(buf)
  const magic = opts.magic ?? [0x54, 0x46, 0x46, 0x45]
  magic.forEach((b, i) => view.setUint8(i, b))
  view.setUint8(4, opts.version ?? 1)
  view.setUint8(5, opts.flags ?? 0)
  view.setBigUint64(6, BigInt(opts.capturedAt ?? 0))
  view.setBigUint64(14, BigInt(opts.relayedAt ?? 0))
  payload.forEach((b, i) => view.setUint8(HEADER_SIZE + i, b))
  return buf
}

describe('parseEnvelopeHeader', () => {
  it('parses capturedAt and relayedAt', () => {
    const frame = makeFrame({ capturedAt: 1_716_000_000_123, relayedAt: 1_716_000_000_200 })
    const env = parseEnvelopeHeader(frame)
    expect(env?.capturedAt).toBe(1_716_000_000_123)
    expect(env?.relayedAt).toBe(1_716_000_000_200)
  })

  it('reports JPEG / non-keyframe for default flags (backward compatible)', () => {
    const env = parseEnvelopeHeader(makeFrame({ flags: 0 }))
    expect(env?.codec).toBe(CODEC_JPEG)
    expect(env?.keyframe).toBe(false)
  })

  it('reports H.264 when bit0 is set', () => {
    const env = parseEnvelopeHeader(makeFrame({ flags: 0x01 }))
    expect(env?.codec).toBe(CODEC_H264)
    expect(env?.keyframe).toBe(false)
  })

  it('reports an H.264 keyframe when both bits are set', () => {
    const env = parseEnvelopeHeader(makeFrame({ flags: 0x03 }))
    expect(env?.codec).toBe(CODEC_H264)
    expect(env?.keyframe).toBe(true)
  })

  it('normalizes a stray keyframe bit on a JPEG frame to false', () => {
    const env = parseEnvelopeHeader(makeFrame({ flags: 0x02 }))
    expect(env?.codec).toBe(CODEC_JPEG)
    expect(env?.keyframe).toBe(false)
  })

  it('reports audio when bit2 is set, with keyframe false', () => {
    const env = parseEnvelopeHeader(makeFrame({ flags: 0x04 }))
    expect(env?.codec).toBe(CODEC_AUDIO)
    expect(env?.keyframe).toBe(false)
  })

  it('returns null for a frame shorter than the header', () => {
    expect(parseEnvelopeHeader(new ArrayBuffer(HEADER_SIZE - 1))).toBeNull()
  })

  it('returns null for wrong magic (plain JPEG)', () => {
    expect(parseEnvelopeHeader(makeFrame({ magic: [0xFF, 0xD8, 0xFF, 0xE0] }))).toBeNull()
  })

  it('returns null for an unsupported version', () => {
    expect(parseEnvelopeHeader(makeFrame({ version: 2 }))).toBeNull()
  })
})
