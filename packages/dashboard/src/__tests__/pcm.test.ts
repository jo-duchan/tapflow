import { describe, it, expect } from 'vitest'
import { pcmS16ToFloat32Planar } from '@/lib/audio/pcm'

// Build interleaved S16LE PCM from per-channel sample arrays.
function interleave(channels: number[][]): ArrayBuffer {
  const frameCount = channels[0].length
  const buf = new ArrayBuffer(frameCount * channels.length * 2)
  const view = new DataView(buf)
  let off = 0
  for (let i = 0; i < frameCount; i++) {
    for (let c = 0; c < channels.length; c++) {
      view.setInt16(off, channels[c][i], true)
      off += 2
    }
  }
  return buf
}

describe('pcmS16ToFloat32Planar', () => {
  it('deinterleaves stereo into two planar channels', () => {
    const pcm = interleave([[1000, 2000], [-1000, -2000]]) // L=[1000,2000] R=[-1000,-2000]
    const [l, r] = pcmS16ToFloat32Planar(pcm, 2)
    expect(l.length).toBe(2)
    expect(r.length).toBe(2)
    expect(l[0]).toBeCloseTo(1000 / 32768, 6)
    expect(l[1]).toBeCloseTo(2000 / 32768, 6)
    expect(r[0]).toBeCloseTo(-1000 / 32768, 6)
    expect(r[1]).toBeCloseTo(-2000 / 32768, 6)
  })

  it('reads little-endian (not big-endian)', () => {
    // 0x0100 LE = 1; if misread BE it would be 256.
    const buf = new ArrayBuffer(2)
    new DataView(buf).setUint8(0, 0x01) // low byte
    new DataView(buf).setUint8(1, 0x00) // high byte
    const [mono] = pcmS16ToFloat32Planar(buf, 1)
    expect(mono[0]).toBeCloseTo(1 / 32768, 6)
  })

  it('maps full-scale samples near ±1', () => {
    const pcm = interleave([[32767, -32768]])
    const [mono] = pcmS16ToFloat32Planar(pcm, 1)
    expect(mono[0]).toBeCloseTo(0.99997, 4)
    expect(mono[1]).toBe(-1)
  })

  it('ignores trailing bytes that do not complete a stereo frame', () => {
    // 5 samples worth of bytes (10 bytes) for stereo → 2 complete frames, last sample dropped.
    const buf = new ArrayBuffer(10)
    const [l, r] = pcmS16ToFloat32Planar(buf, 2)
    expect(l.length).toBe(2)
    expect(r.length).toBe(2)
  })
})
