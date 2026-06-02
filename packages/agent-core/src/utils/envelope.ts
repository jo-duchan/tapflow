export const TFFE_MAGIC = [0x54, 0x46, 0x46, 0x45] as const
export const HEADER_SIZE = 22

// Codec marker carried in byte 5 (flags) bit 0. Absence (0) = JPEG keeps full
// backward compatibility with frames written before the marker existed.
export const CODEC_JPEG = 0
export const CODEC_H264 = 1

const FLAG_H264 = 0x01     // byte5 bit0: payload codec (0 = JPEG, 1 = H.264)
const FLAG_KEYFRAME = 0x02 // byte5 bit1: H.264 keyframe (IDR) — for keyframe-aware drop

export interface EnvelopeFlags {
  codec: number
  keyframe: boolean
}

export function hasEnvelope(frame: Buffer): boolean {
  return (
    frame.length >= HEADER_SIZE &&
    frame[0] === 0x54 &&
    frame[1] === 0x46 &&
    frame[2] === 0x46 &&
    frame[3] === 0x45
  )
}

export function writeEnvelopeHeader(
  payload: Buffer,
  capturedAt: number,
  opts?: { codec?: number; keyframe?: boolean },
): Buffer {
  const header = Buffer.allocUnsafe(HEADER_SIZE)
  header[0] = 0x54; header[1] = 0x46; header[2] = 0x46; header[3] = 0x45
  header[4] = 1   // version
  header[5] = (opts?.codec === CODEC_H264 ? FLAG_H264 : 0) | (opts?.keyframe ? FLAG_KEYFRAME : 0)
  header.writeBigUInt64BE(BigInt(capturedAt), 6)
  header.writeBigUInt64BE(0n, 14) // relayedAt: filled in by relay
  return Buffer.concat([header, payload])
}

// Reads the codec/keyframe flags from byte 5. Caller must ensure hasEnvelope(frame).
export function readEnvelopeFlags(frame: Buffer): EnvelopeFlags {
  const flags = frame[5]
  return {
    codec: flags & FLAG_H264 ? CODEC_H264 : CODEC_JPEG,
    keyframe: (flags & FLAG_KEYFRAME) !== 0,
  }
}

export function patchRelayedAt(frame: Buffer, relayedAt: number): void {
  frame.writeBigUInt64BE(BigInt(relayedAt), 14)
}
