/**
 * Low-level H.264 NAL → VideoFrame decoder via the WebCodecs VideoDecoder API.
 *
 * Emits decoded frames through the `onFrame` callback. Callers own rendering and
 * must call `frame.close()` once done (the WebGL renderer does this).
 *
 * The first two NAL units from scrcpy are SPS and PPS (parameter sets).
 * We buffer them and configure the decoder lazily on the first IDR frame.
 *
 * Used as the decode core of WebCodecsDecoder (which adds a render surface).
 */

// Splits an Annex B buffer into individual NAL units (without start codes).
// Handles both 3- and 4-byte start codes, and a single buffer that bundles
// multiple NALs (e.g. iOS sends SPS+PPS+IDR together; scrcpy sends them apart).
function splitNALUnits(buf: Uint8Array): Uint8Array[] {
  const nals: Uint8Array[] = []
  const n = buf.length
  let start = -1
  let p = 0
  while (p + 2 < n) {
    const sc4 = p + 3 < n && buf[p] === 0 && buf[p + 1] === 0 && buf[p + 2] === 0 && buf[p + 3] === 1
    const sc3 = buf[p] === 0 && buf[p + 1] === 0 && buf[p + 2] === 1
    if (sc4 || sc3) {
      if (start >= 0) nals.push(buf.subarray(start, p))
      p += sc4 ? 4 : 3
      start = p
    } else {
      p++
    }
  }
  if (start >= 0) nals.push(buf.subarray(start, n))
  return nals
}

export class WebCodecsCore {
  private decoder: VideoDecoder | null = null
  private sps: Uint8Array | null = null
  private pps: Uint8Array | null = null
  private frameCount = 0

  constructor(private readonly onFrame: (frame: VideoFrame) => void) {}

  decode(data: ArrayBuffer): void {
    // A single buffer may bundle multiple NALs (iOS: SPS+PPS+IDR together) or carry
    // just one (scrcpy). Split and process each; SPS/PPS feed the config, VCL slices
    // (types 1–5) are collected into one AVCC access unit for the decoder.
    const vcl: Uint8Array[] = []
    let hasIDR = false

    for (const nalData of splitNALUnits(new Uint8Array(data))) {
      const nalType = nalData[0] & 0x1f
      if (nalType === 7) { // SPS
        const changed = !this.sps || nalData.length !== this.sps.length || nalData.some((b, i) => b !== this.sps![i])
        this.sps = nalData
        if (changed && this.decoder) {
          this.decoder.close()
          this.decoder = null
        }
      } else if (nalType === 8) { // PPS
        this.pps = nalData
      } else if (nalType >= 1 && nalType <= 5) { // VCL slice
        if (nalType === 5) hasIDR = true
        vcl.push(nalData)
      }
    }

    if (hasIDR && this.sps && this.pps && !this.decoder) {
      this.initDecoder(this.sps, this.pps)
    }
    if (!this.decoder || vcl.length === 0) return

    // avc1 + description requires AVCC: each NAL prefixed by a 4-byte big-endian length.
    let total = 0
    for (const n of vcl) total += 4 + n.length
    const avcc = new Uint8Array(total)
    const view = new DataView(avcc.buffer)
    let off = 0
    for (const n of vcl) {
      view.setUint32(off, n.length, false); off += 4
      avcc.set(n, off); off += n.length
    }

    try {
      this.decoder.decode(new EncodedVideoChunk({
        type: hasIDR ? 'key' : 'delta',
        timestamp: this.frameCount++ * (1_000_000 / 30),
        data: avcc,
      }))
    } catch {
      // Decoder may be closed or in error state — ignore
    }
  }

  close(): void {
    this.decoder?.close()
    this.decoder = null
  }

  private initDecoder(sps: Uint8Array, pps: Uint8Array): void {
    const spsData = sps[0] === 0 ? sps.subarray(4) : sps
    // Build codec string from actual SPS bytes: avc1.PPCCLL (profile, constraints, level)
    const codec = `avc1.${spsData[1].toString(16).padStart(2, '0')}${spsData[2].toString(16).padStart(2, '0')}${spsData[3].toString(16).padStart(2, '0')}`
    const description = this.buildAVCC(sps, pps)

    this.decoder = new VideoDecoder({
      output: (frame) => this.onFrame(frame),
      error: (e) => console.error('[WebCodecsCore]', e),
    })

    this.decoder.configure({ codec, description, optimizeForLatency: true })
  }

  // Build AVCDecoderConfigurationRecord from raw SPS/PPS NAL units
  private buildAVCC(sps: Uint8Array, pps: Uint8Array): Uint8Array {
    // Strip 4-byte start code if present
    const spsData = sps[0] === 0 ? sps.subarray(4) : sps
    const ppsData = pps[0] === 0 ? pps.subarray(4) : pps

    const buf = new Uint8Array(
      1 + 3 + 1 + 1 + 2 + spsData.length + 1 + 2 + ppsData.length,
    )
    let i = 0
    buf[i++] = 0x01                  // configurationVersion
    buf[i++] = spsData[1]            // AVCProfileIndication
    buf[i++] = spsData[2]            // profile_compatibility
    buf[i++] = spsData[3]            // AVCLevelIndication
    buf[i++] = 0xff                  // lengthSizeMinusOne = 3 → 4-byte NALU length
    buf[i++] = 0xe1                  // numSequenceParameterSets = 1
    buf[i++] = (spsData.length >> 8) & 0xff
    buf[i++] = spsData.length & 0xff
    buf.set(spsData, i); i += spsData.length
    buf[i++] = 0x01                  // numPictureParameterSets = 1
    buf[i++] = (ppsData.length >> 8) & 0xff
    buf[i++] = ppsData.length & 0xff
    buf.set(ppsData, i)
    return buf
  }
}
