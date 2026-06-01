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
export class WebCodecsCore {
  private decoder: VideoDecoder | null = null
  private sps: Uint8Array | null = null
  private pps: Uint8Array | null = null
  private frameCount = 0

  constructor(private readonly onFrame: (frame: VideoFrame) => void) {}

  decode(data: ArrayBuffer): void {
    const nal = new Uint8Array(data)
    // Strip Annex B start code (4 bytes: 00 00 00 01) to get raw NAL data
    const startCode = nal[0] === 0 && nal[1] === 0 && nal[2] === 0 && nal[3] === 1
    const nalData = startCode ? nal.subarray(4) : nal
    const nalType = nalData[0] & 0x1f

    if (nalType === 7) { // SPS
      const changed = !this.sps || nal.length !== this.sps.length || nal.some((b, i) => b !== this.sps![i])
      this.sps = nal
      if (changed && this.decoder) {
        this.decoder.close()
        this.decoder = null
      }
      return
    }
    if (nalType === 8) { // PPS
      this.pps = nal
      return
    }
    if (nalType === 5 && this.sps && this.pps && !this.decoder) { // IDR
      this.initDecoder(this.sps, this.pps)
    }

    if (!this.decoder) return

    // avc1 + description requires AVCC format: 4-byte big-endian length prefix, not Annex B start codes
    const avcc = new Uint8Array(4 + nalData.length)
    new DataView(avcc.buffer).setUint32(0, nalData.length, false)
    avcc.set(nalData, 4)

    try {
      this.decoder.decode(new EncodedVideoChunk({
        type: nalType === 5 ? 'key' : 'delta',
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
