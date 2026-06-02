/**
 * Minimal H.264 SPS tooling — reads and rewrites the VUI bitstream_restriction
 * fields that govern decoder latency: max_num_reorder_frames / max_dec_frame_buffering.
 *
 * Why: a decoder buffers up to max_num_reorder_frames before emitting output. If
 * the encoder doesn't declare 0 (VUI bitstream_restriction), the decoder assumes
 * the level's max DPB and adds frames of latency even with no B-frames.
 * `rewriteSpsLowLatency` injects "reorder=0" so the decoder emits immediately.
 *
 * Mirror: packages/agent-core/src/utils/sps.ts is the canonical copy (the agent
 * rewrites the SPS at the source). This browser copy is defense-in-depth for an
 * unpatched agent and becomes a no-op once the SPS already declares it. Keep in sync.
 */

export interface SpsVuiInfo {
  profileIdc: number
  levelIdc: number
  vuiPresent: boolean
  bitstreamRestriction: boolean
  /** null when not declared (decoder then assumes the level max). */
  maxNumReorderFrames: number | null
  maxDecFrameBuffering: number | null
}

class BitReader {
  private bitPos = 0
  constructor(private readonly bytes: Uint8Array) {}

  get position(): number { return this.bitPos }

  bit(): number {
    const byteIdx = this.bitPos >> 3
    const bitIdx = 7 - (this.bitPos & 7)
    this.bitPos++
    if (byteIdx >= this.bytes.length) return 0
    return (this.bytes[byteIdx] >> bitIdx) & 1
  }

  bits(n: number): number {
    let v = 0
    for (let i = 0; i < n; i++) v = (v << 1) | this.bit()
    return v >>> 0
  }

  flag(): boolean { return this.bit() === 1 }

  ue(): number {
    let zeros = 0
    while (this.bit() === 0 && zeros < 32) zeros++
    if (zeros === 0) return 0
    return (1 << zeros) - 1 + this.bits(zeros)
  }

  se(): number {
    const k = this.ue()
    return (k & 1) ? Math.ceil(k / 2) : -Math.ceil(k / 2)
  }
}

class BitWriter {
  private readonly bitsArr: number[] = []
  bit(b: number): void { this.bitsArr.push(b & 1) }
  ue(val: number): void {
    const code = val + 1
    const len = Math.floor(Math.log2(code))
    for (let i = 0; i < len; i++) this.bit(0)
    for (let i = len; i >= 0; i--) this.bit((code >> i) & 1)
  }
  toBytes(): Uint8Array {
    const out: number[] = []
    for (let i = 0; i < this.bitsArr.length; i += 8) {
      let b = 0
      for (let j = 0; j < 8; j++) b = (b << 1) | (this.bitsArr[i + j] ?? 0)
      out.push(b)
    }
    return new Uint8Array(out)
  }
}

// Strip the 1-byte NAL header and emulation_prevention_three_byte (00 00 03 → 00 00).
function toRbsp(nal: Uint8Array): Uint8Array {
  const out: number[] = []
  let zeros = 0
  for (let i = 1; i < nal.length; i++) {
    const b = nal[i]
    if (zeros >= 2 && b === 0x03) { zeros = 0; continue }
    out.push(b)
    zeros = b === 0 ? zeros + 1 : 0
  }
  return new Uint8Array(out)
}

// Re-insert emulation_prevention_three_byte before any 00 00 {00,01,02,03}.
function addEmulation(rbsp: Uint8Array): Uint8Array {
  const out: number[] = []
  let zeros = 0
  for (const b of rbsp) {
    if (zeros >= 2 && b <= 0x03) { out.push(0x03); zeros = 0 }
    out.push(b)
    zeros = b === 0 ? zeros + 1 : 0
  }
  return new Uint8Array(out)
}

const HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135])

function skipHrd(r: BitReader): void {
  const cpbCnt = r.ue() + 1
  r.bits(4); r.bits(4) // bit_rate_scale, cpb_size_scale
  for (let i = 0; i < cpbCnt; i++) { r.ue(); r.ue(); r.flag() }
  r.bits(5); r.bits(5); r.bits(5); r.bits(5)
}

interface SpsWalk {
  profileIdc: number
  levelIdc: number
  numRefFrames: number
  vuiPresent: boolean
  bitstreamRestriction: boolean
  maxNumReorderFrames: number | null
  maxDecFrameBuffering: number | null
  /** Bit offset (within RBSP) of bitstream_restriction_flag; -1 if no VUI reached. */
  restrictionFlagPos: number
}

function walkSps(r: BitReader): SpsWalk {
  const profileIdc = r.bits(8)
  r.bits(8) // constraint flags + reserved
  const levelIdc = r.bits(8)
  r.ue() // seq_parameter_set_id

  if (HIGH_PROFILES.has(profileIdc)) {
    const chromaFormatIdc = r.ue()
    if (chromaFormatIdc === 3) r.flag() // separate_colour_plane_flag
    r.ue(); r.ue() // bit_depth_luma/chroma_minus8
    r.flag() // qpprime_y_zero_transform_bypass_flag
    if (r.flag()) { // seq_scaling_matrix_present_flag
      const lists = chromaFormatIdc !== 3 ? 8 : 12
      for (let i = 0; i < lists; i++) {
        if (r.flag()) {
          const size = i < 6 ? 16 : 64
          let lastScale = 8, nextScale = 8
          for (let j = 0; j < size; j++) {
            if (nextScale !== 0) nextScale = (lastScale + r.se() + 256) % 256
            lastScale = nextScale === 0 ? lastScale : nextScale
          }
        }
      }
    }
  }

  r.ue() // log2_max_frame_num_minus4
  const picOrderCntType = r.ue()
  if (picOrderCntType === 0) {
    r.ue() // log2_max_pic_order_cnt_lsb_minus4
  } else if (picOrderCntType === 1) {
    r.flag()
    r.se(); r.se()
    const n = r.ue()
    for (let i = 0; i < n; i++) r.se()
  }
  const numRefFrames = r.ue() // max_num_ref_frames
  r.flag() // gaps_in_frame_num_value_allowed_flag
  r.ue() // pic_width_in_mbs_minus1
  r.ue() // pic_height_in_map_units_minus1
  if (!r.flag()) r.flag() // frame_mbs_only_flag → mb_adaptive_frame_field_flag
  r.flag() // direct_8x8_inference_flag
  if (r.flag()) { r.ue(); r.ue(); r.ue(); r.ue() } // frame_cropping

  const base = {
    profileIdc, levelIdc, numRefFrames,
    bitstreamRestriction: false,
    maxNumReorderFrames: null as number | null,
    maxDecFrameBuffering: null as number | null,
  }

  const vuiPresent = r.flag()
  if (!vuiPresent) return { ...base, vuiPresent: false, restrictionFlagPos: -1 }

  if (r.flag()) { if (r.bits(8) === 255) { r.bits(16); r.bits(16) } } // aspect_ratio
  if (r.flag()) r.flag() // overscan
  if (r.flag()) { r.bits(3); r.flag(); if (r.flag()) { r.bits(8); r.bits(8); r.bits(8) } } // video_signal_type
  if (r.flag()) { r.ue(); r.ue() } // chroma_loc_info
  if (r.flag()) { r.bits(32); r.bits(32); r.flag() } // timing_info
  const nalHrd = r.flag(); if (nalHrd) skipHrd(r)
  const vclHrd = r.flag(); if (vclHrd) skipHrd(r)
  if (nalHrd || vclHrd) r.flag() // low_delay_hrd_flag
  r.flag() // pic_struct_present_flag

  const restrictionFlagPos = r.position
  const bitstreamRestriction = r.flag()
  if (!bitstreamRestriction) {
    return { ...base, vuiPresent: true, restrictionFlagPos }
  }
  r.flag() // motion_vectors_over_pic_boundaries_flag
  r.ue(); r.ue(); r.ue(); r.ue() // denoms + log2 max mv h/v
  return {
    ...base,
    vuiPresent: true,
    bitstreamRestriction: true,
    maxNumReorderFrames: r.ue(),
    maxDecFrameBuffering: r.ue(),
    restrictionFlagPos,
  }
}

export function parseSpsVui(spsNal: Uint8Array): SpsVuiInfo {
  const w = walkSps(new BitReader(toRbsp(spsNal)))
  return {
    profileIdc: w.profileIdc,
    levelIdc: w.levelIdc,
    vuiPresent: w.vuiPresent,
    bitstreamRestriction: w.bitstreamRestriction,
    maxNumReorderFrames: w.maxNumReorderFrames,
    maxDecFrameBuffering: w.maxDecFrameBuffering,
  }
}

/**
 * Rewrites the SPS to declare bitstream_restriction with max_num_reorder_frames=0
 * (and max_dec_frame_buffering = max_num_ref_frames) so the decoder emits frames
 * immediately. Returns null when it can't safely rewrite (no VUI, or restriction
 * already declared) — caller falls back to the original SPS.
 */
export function rewriteSpsLowLatency(spsNal: Uint8Array): Uint8Array | null {
  const rbsp = toRbsp(spsNal)
  const walk = walkSps(new BitReader(rbsp))
  if (!walk.vuiPresent || walk.restrictionFlagPos < 0) return null
  if (walk.bitstreamRestriction) return null // already declared — leave as-is

  const w = new BitWriter()
  const copy = new BitReader(rbsp)
  for (let i = 0; i < walk.restrictionFlagPos; i++) w.bit(copy.bit()) // verbatim prefix
  w.bit(1) // bitstream_restriction_flag = 1
  w.bit(1) // motion_vectors_over_pic_boundaries_flag
  w.ue(0); w.ue(0); w.ue(0); w.ue(0) // denoms + log2 max mv h/v (neutral)
  w.ue(0) // max_num_reorder_frames = 0
  w.ue(walk.numRefFrames) // max_dec_frame_buffering ≥ max_num_ref_frames (valid)
  w.bit(1) // rbsp_stop_one_bit (toBytes zero-pads the rest)

  // Preserve the original NAL header byte (nal_ref_idc may differ from 0x67).
  return Uint8Array.from([spsNal[0], ...addEmulation(w.toBytes())])
}
