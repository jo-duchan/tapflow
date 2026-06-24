// Pure PCM helpers for audio playback. Kept framework-free so the bit-fiddly parts
// (endianness, channel deinterleave) are unit-testable without an AudioContext.

// Deinterleave signed-16-bit little-endian PCM into planar Float32 channels in [-1, 1).
// Interleaved layout: [L0, R0, L1, R1, ...]. Trailing bytes that don't complete a frame are ignored.
export function pcmS16ToFloat32Planar(pcm: ArrayBuffer, channels: number): Float32Array[] {
  const view = new DataView(pcm)
  const totalSamples = Math.floor(pcm.byteLength / 2)
  const frameCount = Math.floor(totalSamples / channels)
  const out: Float32Array[] = []
  for (let c = 0; c < channels; c++) out.push(new Float32Array(frameCount))
  for (let i = 0; i < frameCount; i++) {
    for (let c = 0; c < channels; c++) {
      const s = view.getInt16((i * channels + c) * 2, true) // little-endian
      out[c][i] = s / 32768 // -32768..32767 → ~[-1, 1)
    }
  }
  return out
}
