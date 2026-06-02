export const HEADER_SIZE = 22

const MAGIC = [0x54, 0x46, 0x46, 0x45]
const SUPPORTED_VERSION = 1

// Mirrors agent-core envelope flags (byte 5): bit0 = H.264 codec, bit1 = keyframe.
export const CODEC_JPEG = 0
export const CODEC_H264 = 1
const FLAG_H264 = 0x01
const FLAG_KEYFRAME = 0x02

export interface EnvelopeHeader {
  capturedAt: number
  relayedAt: number
  codec: number
  keyframe: boolean
}

export function parseEnvelopeHeader(frame: ArrayBuffer): EnvelopeHeader | null {
  if (frame.byteLength < HEADER_SIZE) return null
  const view = new DataView(frame)
  for (let i = 0; i < MAGIC.length; i++) {
    if (view.getUint8(i) !== MAGIC[i]) return null
  }
  if (view.getUint8(4) !== SUPPORTED_VERSION) return null
  const flags = view.getUint8(5)
  const codec = flags & FLAG_H264 ? CODEC_H264 : CODEC_JPEG
  return {
    capturedAt: Number(view.getBigUint64(6)),
    relayedAt: Number(view.getBigUint64(14)),
    codec,
    // keyframe is only valid for H.264; normalize JPEG frames to false.
    keyframe: codec === CODEC_H264 && (flags & FLAG_KEYFRAME) !== 0,
  }
}
