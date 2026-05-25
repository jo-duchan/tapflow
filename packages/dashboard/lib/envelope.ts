export const HEADER_SIZE = 22

const MAGIC = [0x54, 0x46, 0x46, 0x45]

export function parseEnvelopeHeader(
  frame: ArrayBuffer,
): { capturedAt: number; relayedAt: number } | null {
  if (frame.byteLength < HEADER_SIZE) return null
  const view = new DataView(frame)
  for (let i = 0; i < MAGIC.length; i++) {
    if (view.getUint8(i) !== MAGIC[i]) return null
  }
  return {
    capturedAt: Number(view.getBigUint64(6)),
    relayedAt: Number(view.getBigUint64(14)),
  }
}
