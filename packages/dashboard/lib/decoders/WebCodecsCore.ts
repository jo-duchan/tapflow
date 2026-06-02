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

import type { DecodeSample } from './types'
import { parseSpsVui, rewriteSpsLowLatency } from './parseSpsVui'

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
  // Diagnostics: submit time keyed by chunk timestamp → exact, drop-immune decodeMs.
  private decodeSampler?: (sample: DecodeSample) => void
  private readonly submitAt = new Map<number, number>()
  private spsLogged = false

  constructor(private readonly onFrame: (frame: VideoFrame) => void) {}

  setDecodeSampler(cb: (sample: DecodeSample) => void): void { this.decodeSampler = cb }

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

    // Integer µs so the decoder echoes the exact timestamp back on output (map key).
    const timestamp = Math.round(this.frameCount++ * (1_000_000 / 30))
    if (this.decodeSampler) {
      this.submitAt.set(timestamp, performance.now())
      // Bound the map if some submits never output (drops): drop the oldest.
      if (this.submitAt.size > 120) {
        const oldest = this.submitAt.keys().next().value
        if (oldest !== undefined) this.submitAt.delete(oldest)
      }
    }

    try {
      this.decoder.decode(new EncodedVideoChunk({ type: hasIDR ? 'key' : 'delta', timestamp, data: avcc }))
    } catch {
      // Decoder may be closed or in error state — ignore
    }
  }

  private sampleDecode(frame: VideoFrame): void {
    if (!this.decodeSampler) return
    const submittedAt = this.submitAt.get(frame.timestamp)
    if (submittedAt === undefined) return
    this.submitAt.delete(frame.timestamp)
    this.decodeSampler({
      decodeMs: performance.now() - submittedAt,
      queueSize: this.decoder?.decodeQueueSize ?? 0,
    })
  }

  close(): void {
    this.decoder?.close()
    this.decoder = null
  }

  // Logs what the encoder advertises for decoder reorder/DPB — the lever behind
  // H.264 decode latency. Only when diagnostics are active (decodeSampler set).
  private logSpsVui(sps: Uint8Array): void {
    if (this.spsLogged || !this.decodeSampler) return
    this.spsLogged = true
    try {
      console.log('[sps-vui]', JSON.stringify(parseSpsVui(sps)))
    } catch (e) {
      console.warn('[sps-vui] parse failed', e)
    }
  }

  private initDecoder(rawSps: Uint8Array, pps: Uint8Array): void {
    this.logSpsVui(rawSps)
    // Force max_num_reorder_frames=0 so the decoder emits immediately instead of
    // buffering up to the level's max DPB (~8 frames @ 30fps ≈ 250ms of latency).
    const sps = rewriteSpsLowLatency(rawSps) ?? rawSps
    const spsData = sps[0] === 0 ? sps.subarray(4) : sps
    // Build codec string from actual SPS bytes: avc1.PPCCLL (profile, constraints, level)
    const codec = `avc1.${spsData[1].toString(16).padStart(2, '0')}${spsData[2].toString(16).padStart(2, '0')}${spsData[3].toString(16).padStart(2, '0')}`
    const description = this.buildAVCC(sps, pps)

    this.decoder = new VideoDecoder({
      output: (frame) => { this.sampleDecode(frame); this.onFrame(frame) },
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
