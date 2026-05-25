export const TFFE_MAGIC = [0x54, 0x46, 0x46, 0x45] as const
export const HEADER_SIZE = 22

export function hasEnvelope(frame: Buffer): boolean {
  return (
    frame.length >= HEADER_SIZE &&
    frame[0] === 0x54 &&
    frame[1] === 0x46 &&
    frame[2] === 0x46 &&
    frame[3] === 0x45
  )
}

export function writeEnvelopeHeader(payload: Buffer, capturedAt: number): Buffer {
  const header = Buffer.allocUnsafe(HEADER_SIZE)
  header[0] = 0x54; header[1] = 0x46; header[2] = 0x46; header[3] = 0x45
  header[4] = 1   // version
  header[5] = 0   // flags (reserved)
  header.writeBigUInt64BE(BigInt(capturedAt), 6)
  header.writeBigUInt64BE(0n, 14) // relayedAt: filled in by relay
  return Buffer.concat([header, payload])
}

export function patchRelayedAt(frame: Buffer, relayedAt: number): void {
  frame.writeBigUInt64BE(BigInt(relayedAt), 14)
}
