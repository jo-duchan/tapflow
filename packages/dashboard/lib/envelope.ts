export const HEADER_SIZE = 22

const MAGIC = [0x54, 0x46, 0x46, 0x45]
const SUPPORTED_VERSION = 1

// Mirrors agent-core envelope flags (byte 5): bit0 = H.264 codec, bit1 = keyframe, bit2 = audio.
export const CODEC_JPEG = 0
export const CODEC_H264 = 1
export const CODEC_AUDIO = 2
const FLAG_H264 = 0x01
const FLAG_KEYFRAME = 0x02
const FLAG_AUDIO = 0x04

export interface EnvelopeHeader {
  capturedAt: number
  relayedAt: number
  codec: number
  keyframe: boolean
}

// Per-frame codec/keyframe info passed from DeviceViewer to the active viewer's
// binary frame handler so it can route JPEG vs H.264 frames.
export interface FrameMeta {
  codec: number
  keyframe: boolean
  /** Envelope wall-clock hops (epoch ms) for latency correlation; undefined when no envelope. */
  capturedAt?: number
  relayedAt?: number
}

export type BinaryFrameHandler = (data: ArrayBuffer, meta?: FrameMeta) => void

export function parseEnvelopeHeader(frame: ArrayBuffer): EnvelopeHeader | null {
  if (frame.byteLength < HEADER_SIZE) return null
  const view = new DataView(frame)
  for (let i = 0; i < MAGIC.length; i++) {
    if (view.getUint8(i) !== MAGIC[i]) return null
  }
  if (view.getUint8(4) !== SUPPORTED_VERSION) return null
  const flags = view.getUint8(5)
  // Audio is an independent bit and takes precedence over the video codec bits.
  const codec = flags & FLAG_AUDIO ? CODEC_AUDIO : flags & FLAG_H264 ? CODEC_H264 : CODEC_JPEG
  return {
    capturedAt: Number(view.getBigUint64(6)),
    relayedAt: Number(view.getBigUint64(14)),
    codec,
    // keyframe is only valid for H.264; normalize JPEG/audio frames to false.
    keyframe: codec === CODEC_H264 && (flags & FLAG_KEYFRAME) !== 0,
  }
}
