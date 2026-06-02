import { describe, it, expect } from 'vitest'
import { parseSpsVui, rewriteSpsLowLatency } from '@/lib/decoders/parseSpsVui'

// Mirror of the parser's Exp-Golomb encoding, to build controlled SPS fixtures.
class BitWriter {
  private bits: number[] = []
  bit(b: number) { this.bits.push(b & 1) }
  bitsN(val: number, n: number) { for (let i = n - 1; i >= 0; i--) this.bit((val >> i) & 1) }
  ue(val: number) {
    const code = val + 1
    const len = Math.floor(Math.log2(code))
    for (let i = 0; i < len; i++) this.bit(0)
    for (let i = len; i >= 0; i--) this.bit((code >> i) & 1)
  }
  /** Prepend the NAL header byte (0x67 = SPS) and pack to bytes. */
  toNal(): Uint8Array {
    const out = [0x67]
    for (let i = 0; i < this.bits.length; i += 8) {
      let b = 0
      for (let j = 0; j < 8; j++) b = (b << 1) | (this.bits[i + j] ?? 0)
      out.push(b)
    }
    return new Uint8Array(out)
  }
}

// Baseline SPS preamble up to (but not including) vui_parameters_present_flag.
function baselinePreamble(w: BitWriter) {
  w.bitsN(66, 8)   // profile_idc = baseline (not high → no extra block)
  w.bitsN(0, 8)    // constraint_set + reserved
  w.bitsN(31, 8)   // level_idc
  w.ue(0)          // seq_parameter_set_id
  w.ue(0)          // log2_max_frame_num_minus4
  w.ue(0)          // pic_order_cnt_type = 0
  w.ue(0)          //   log2_max_pic_order_cnt_lsb_minus4
  w.ue(1)          // max_num_ref_frames
  w.bit(0)         // gaps_in_frame_num_value_allowed_flag
  w.ue(10)         // pic_width_in_mbs_minus1
  w.ue(10)         // pic_height_in_map_units_minus1
  w.bit(1)         // frame_mbs_only_flag
  w.bit(1)         // direct_8x8_inference_flag
  w.bit(0)         // frame_cropping_flag
}

describe('parseSpsVui', () => {
  it('reads max_num_reorder_frames / max_dec_frame_buffering from bitstream_restriction', () => {
    const w = new BitWriter()
    baselinePreamble(w)
    w.bit(1)        // vui_parameters_present_flag
    w.bit(0)        // aspect_ratio_info_present_flag
    w.bit(0)        // overscan_info_present_flag
    w.bit(0)        // video_signal_type_present_flag
    w.bit(0)        // chroma_loc_info_present_flag
    w.bit(0)        // timing_info_present_flag
    w.bit(0)        // nal_hrd_parameters_present_flag
    w.bit(0)        // vcl_hrd_parameters_present_flag
    w.bit(0)        // pic_struct_present_flag
    w.bit(1)        // bitstream_restriction_flag
    w.bit(1)        // motion_vectors_over_pic_boundaries_flag
    w.ue(0); w.ue(0); w.ue(0); w.ue(0) // denoms + log2 max mv h/v
    w.ue(2)         // max_num_reorder_frames
    w.ue(4)         // max_dec_frame_buffering

    const info = parseSpsVui(w.toNal())
    expect(info.profileIdc).toBe(66)
    expect(info.levelIdc).toBe(31)
    expect(info.vuiPresent).toBe(true)
    expect(info.bitstreamRestriction).toBe(true)
    expect(info.maxNumReorderFrames).toBe(2)
    expect(info.maxDecFrameBuffering).toBe(4)
  })

  it('reports reorder=0 when the encoder declares low-latency', () => {
    const w = new BitWriter()
    baselinePreamble(w)
    w.bit(1) // vui present
    w.bit(0); w.bit(0); w.bit(0); w.bit(0); w.bit(0); w.bit(0); w.bit(0); w.bit(0) // all sub-flags off
    w.bit(1) // bitstream_restriction_flag
    w.bit(1)
    w.ue(0); w.ue(0); w.ue(0); w.ue(0)
    w.ue(0) // max_num_reorder_frames = 0
    w.ue(0) // max_dec_frame_buffering = 0

    const info = parseSpsVui(w.toNal())
    expect(info.maxNumReorderFrames).toBe(0)
    expect(info.maxDecFrameBuffering).toBe(0)
  })

  it('leaves reorder null when bitstream_restriction is absent (decoder assumes level max)', () => {
    const w = new BitWriter()
    baselinePreamble(w)
    w.bit(1) // vui present
    w.bit(0); w.bit(0); w.bit(0); w.bit(0); w.bit(0); w.bit(0); w.bit(0); w.bit(0)
    w.bit(0) // bitstream_restriction_flag = 0

    const info = parseSpsVui(w.toNal())
    expect(info.vuiPresent).toBe(true)
    expect(info.bitstreamRestriction).toBe(false)
    expect(info.maxNumReorderFrames).toBeNull()
  })

  it('leaves reorder null when no VUI at all', () => {
    const w = new BitWriter()
    baselinePreamble(w)
    w.bit(0) // vui_parameters_present_flag = 0

    const info = parseSpsVui(w.toNal())
    expect(info.vuiPresent).toBe(false)
    expect(info.maxNumReorderFrames).toBeNull()
  })
})

describe('rewriteSpsLowLatency', () => {
  // SPS matching our real iPhone case: VUI present, bitstream_restriction absent.
  function vuiNoRestrictionSps(numRef: number): Uint8Array {
    const w = new BitWriter()
    w.bitsN(66, 8); w.bitsN(0, 8); w.bitsN(50, 8) // profile / constraints / level 5.0
    w.ue(0)                 // sps_id
    w.ue(0)                 // log2_max_frame_num_minus4
    w.ue(0); w.ue(0)        // poc type 0 + log2_max_poc_lsb
    w.ue(numRef)            // max_num_ref_frames
    w.bit(0)                // gaps
    w.ue(10); w.ue(10)      // width/height in MBs
    w.bit(1); w.bit(1); w.bit(0) // frame_mbs_only / direct_8x8 / no cropping
    w.bit(1)                // vui present
    w.bit(0); w.bit(0); w.bit(0); w.bit(0); w.bit(0); w.bit(0); w.bit(0); w.bit(0) // sub-flags off
    w.bit(0)                // bitstream_restriction_flag = 0
    return w.toNal()
  }

  it('injects reorder=0 and dpb=num_ref, re-parseable and level preserved', () => {
    const out = rewriteSpsLowLatency(vuiNoRestrictionSps(1))
    expect(out).not.toBeNull()
    const info = parseSpsVui(out!)
    expect(info.levelIdc).toBe(50)        // preserved
    expect(info.profileIdc).toBe(66)
    expect(info.vuiPresent).toBe(true)
    expect(info.bitstreamRestriction).toBe(true)
    expect(info.maxNumReorderFrames).toBe(0)
    expect(info.maxDecFrameBuffering).toBe(1) // = max_num_ref_frames
  })

  it('returns null when bitstream_restriction is already declared (no double-edit)', () => {
    const w = new BitWriter()
    baselinePreamble(w)
    w.bit(1)
    w.bit(0); w.bit(0); w.bit(0); w.bit(0); w.bit(0); w.bit(0); w.bit(0); w.bit(0)
    w.bit(1) // bitstream_restriction_flag = 1
    w.bit(1); w.ue(0); w.ue(0); w.ue(0); w.ue(0); w.ue(0); w.ue(0)
    expect(rewriteSpsLowLatency(w.toNal())).toBeNull()
  })

  it('returns null when there is no VUI to extend', () => {
    const w = new BitWriter()
    baselinePreamble(w)
    w.bit(0) // vui present = 0
    expect(rewriteSpsLowLatency(w.toNal())).toBeNull()
  })
})
