import { describe, it, expect } from 'vitest'
import {
  HEADER_SIZE,
  TFFE_MAGIC,
  CODEC_JPEG,
  CODEC_H264,
  hasEnvelope,
  writeEnvelopeHeader,
  readEnvelopeFlags,
  patchRelayedAt,
} from '../utils/envelope'

describe('HEADER_SIZE', () => {
  it('is 22', () => {
    expect(HEADER_SIZE).toBe(22)
  })
})

describe('writeEnvelopeHeader', () => {
  it('prepends 22-byte header to payload', () => {
    const payload = Buffer.from([0x01, 0x02, 0x03])
    const result = writeEnvelopeHeader(payload, 1000)
    expect(result.length).toBe(HEADER_SIZE + payload.length)
  })

  it('starts with TFFE magic bytes', () => {
    const result = writeEnvelopeHeader(Buffer.alloc(0), 0)
    expect([result[0], result[1], result[2], result[3]]).toEqual([...TFFE_MAGIC])
  })

  it('sets version=1 and flags=0', () => {
    const result = writeEnvelopeHeader(Buffer.alloc(0), 0)
    expect(result[4]).toBe(1)
    expect(result[5]).toBe(0)
  })

  it('writes capturedAt at offset 6 as u64 BE', () => {
    const capturedAt = 1_716_000_000_123
    const result = writeEnvelopeHeader(Buffer.alloc(0), capturedAt)
    expect(Number(result.readBigUInt64BE(6))).toBe(capturedAt)
  })

  it('initialises relayedAt at offset 14 to 0', () => {
    const result = writeEnvelopeHeader(Buffer.alloc(0), 999)
    expect(Number(result.readBigUInt64BE(14))).toBe(0)
  })

  it('preserves payload bytes after header', () => {
    const payload = Buffer.from([0xAA, 0xBB, 0xCC])
    const result = writeEnvelopeHeader(payload, 0)
    expect(result.subarray(HEADER_SIZE)).toEqual(payload)
  })

  it('defaults to flags=0 (JPEG, non-keyframe) when opts omitted', () => {
    const result = writeEnvelopeHeader(Buffer.alloc(0), 0)
    expect(result[5]).toBe(0)
  })

  it('sets bit0 for H.264 codec', () => {
    const result = writeEnvelopeHeader(Buffer.alloc(0), 0, { codec: CODEC_H264 })
    expect(result[5]).toBe(0x01)
  })

  it('ignores keyframe without the H.264 codec (keyframe is an IDR marker)', () => {
    const result = writeEnvelopeHeader(Buffer.alloc(0), 0, { keyframe: true })
    expect(result[5]).toBe(0)
  })

  it('sets both bits for an H.264 keyframe', () => {
    const result = writeEnvelopeHeader(Buffer.alloc(0), 0, { codec: CODEC_H264, keyframe: true })
    expect(result[5]).toBe(0x03)
  })

  it('JPEG codec leaves bit0 clear', () => {
    const result = writeEnvelopeHeader(Buffer.alloc(0), 0, { codec: CODEC_JPEG })
    expect(result[5] & 0x01).toBe(0)
  })
})

describe('readEnvelopeFlags', () => {
  it('reads JPEG / non-keyframe from a default header (backward compatible)', () => {
    const frame = writeEnvelopeHeader(Buffer.from([0xFF, 0xD8]), 1000)
    expect(readEnvelopeFlags(frame)).toEqual({ codec: CODEC_JPEG, keyframe: false })
  })

  it('reads H.264 codec', () => {
    const frame = writeEnvelopeHeader(Buffer.alloc(0), 0, { codec: CODEC_H264 })
    expect(readEnvelopeFlags(frame)).toEqual({ codec: CODEC_H264, keyframe: false })
  })

  it('reads an H.264 keyframe', () => {
    const frame = writeEnvelopeHeader(Buffer.alloc(0), 0, { codec: CODEC_H264, keyframe: true })
    expect(readEnvelopeFlags(frame)).toEqual({ codec: CODEC_H264, keyframe: true })
  })

  it('round-trips through patchRelayedAt without disturbing flags', () => {
    const frame = writeEnvelopeHeader(Buffer.alloc(2), 1000, { codec: CODEC_H264, keyframe: true })
    patchRelayedAt(frame, 2000)
    expect(readEnvelopeFlags(frame)).toEqual({ codec: CODEC_H264, keyframe: true })
  })

  it('normalizes a stray keyframe bit on a JPEG frame to false', () => {
    const frame = writeEnvelopeHeader(Buffer.alloc(0), 0)
    frame[5] = 0x02 // keyframe bit set but codec bit clear (malformed)
    expect(readEnvelopeFlags(frame)).toEqual({ codec: CODEC_JPEG, keyframe: false })
  })
})

describe('patchRelayedAt', () => {
  it('writes relayedAt at offset 14 in-place', () => {
    const frame = writeEnvelopeHeader(Buffer.alloc(4), 1000)
    patchRelayedAt(frame, 2000)
    expect(Number(frame.readBigUInt64BE(14))).toBe(2000)
  })

  it('does not modify capturedAt or other bytes', () => {
    const capturedAt = 1_716_000_000_123
    const payload = Buffer.from([0xDE, 0xAD])
    const frame = writeEnvelopeHeader(payload, capturedAt)
    patchRelayedAt(frame, 9999)
    expect(Number(frame.readBigUInt64BE(6))).toBe(capturedAt)
    expect(frame[4]).toBe(1)
    expect(frame.subarray(HEADER_SIZE)).toEqual(payload)
  })

  it('relayedAt is after capturedAt', () => {
    const frame = writeEnvelopeHeader(Buffer.alloc(0), 1000)
    patchRelayedAt(frame, 2000)
    const captured = Number(frame.readBigUInt64BE(6))
    const relayed = Number(frame.readBigUInt64BE(14))
    expect(relayed).toBeGreaterThanOrEqual(captured)
  })
})

describe('hasEnvelope', () => {
  it('returns true for a frame with TFFE magic', () => {
    const frame = writeEnvelopeHeader(Buffer.from([0xFF, 0xD8]), 1000)
    expect(hasEnvelope(frame)).toBe(true)
  })

  it('returns false for a plain JPEG buffer', () => {
    const jpeg = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10])
    expect(hasEnvelope(jpeg)).toBe(false)
  })

  it('returns false for a buffer shorter than HEADER_SIZE', () => {
    const short = Buffer.from([0x54, 0x46, 0x46, 0x45])
    expect(hasEnvelope(short)).toBe(false)
  })

  it('returns false for an empty buffer', () => {
    expect(hasEnvelope(Buffer.alloc(0))).toBe(false)
  })
})
