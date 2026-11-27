/**
 * Reads the string values of a binary property list's top-level dictionary (`bplist00`).
 *
 * The relay needs this where `plutil` does not exist — in the Docker image and on Linux — to read an
 * uploaded iOS build's Info.plist (#1257). It reads only what `parseInfoPlist` uses: string keys
 * mapped to string values at the top level. Every other value is skipped, and nested containers are
 * never followed, so a reference cycle or deep nesting in a crafted file has nothing to recurse into.
 *
 * The input is an upload, so it is hostile: every offset and length is checked against the buffer
 * before it is read, and anything inconsistent returns null rather than throwing.
 *
 * Format: https://opensource.apple.com/source/CF/CF-1153.18/CFBinaryPList.c
 */

const MAGIC = 'bplist00'
const TRAILER_BYTES = 32

/**
 * Big-endian unsigned integer of `width` bytes at `at`, or -1 when it does not fit in the buffer. An 8-byte
 * value past 2^53 comes back rounded, which is harmless: every caller bounds it by the file's size.
 */
function readUint(buf: Buffer, at: number, width: number): number {
  if (width < 1 || width > 8 || at < 0 || at + width > buf.length) return -1
  let value = 0
  for (let i = 0; i < width; i++) value = value * 256 + buf[at + i]
  return value
}

/** `tableAt` is where the offset table starts, which is where every object must have ended. */
type Layout = { buf: Buffer; offsets: number[]; tableAt: number }

/** Where object `ref` starts, or -1 when the ref is not in the offset table. */
function objectStart(layout: Layout, ref: number): number {
  return ref >= 0 && ref < layout.offsets.length ? layout.offsets[ref] : -1
}

/**
 * The element count of the object whose marker is at `at`, and where its payload begins. A low nibble
 * of 0xF means the count follows as an integer object (marker 0x1n, 2^n bytes).
 */
function countAndPayload(buf: Buffer, at: number): { count: number; payload: number } | null {
  const info = buf[at] & 0x0f
  if (info !== 0x0f) return { count: info, payload: at + 1 }
  const intMarker = buf[at + 1]
  if (intMarker === undefined || (intMarker & 0xf0) !== 0x10) return null
  const width = 1 << (intMarker & 0x0f)
  const count = readUint(buf, at + 2, width)
  if (count < 0) return null
  return { count, payload: at + 2 + width }
}

/** The string object `ref` names, or null when it is not a string or does not fit. */
function readString(layout: Layout, ref: number): string | null {
  const { buf } = layout
  const at = objectStart(layout, ref)
  if (at < 0) return null
  const kind = buf[at] >> 4
  if (kind !== 0x5 && kind !== 0x6) return null
  const header = countAndPayload(buf, at)
  if (!header) return null
  const bytes = kind === 0x5 ? header.count : header.count * 2
  const end = header.payload + bytes
  if (end > layout.tableAt) return null
  if (kind === 0x5) return buf.toString('latin1', header.payload, end)
  // UTF-16 big-endian; Node decodes only little-endian, so swap a copy.
  return Buffer.from(buf.subarray(header.payload, end)).swap16().toString('utf16le')
}

export function parseBinaryPlist(buf: Buffer): Record<string, string> | null {
  if (buf.length < MAGIC.length + TRAILER_BYTES || buf.toString('latin1', 0, MAGIC.length) !== MAGIC) return null

  const trailer = buf.length - TRAILER_BYTES
  const offsetSize = buf[trailer + 6]
  const refSize = buf[trailer + 7]
  const numObjects = readUint(buf, trailer + 8, 8)
  const topObject = readUint(buf, trailer + 16, 8)
  const tableAt = readUint(buf, trailer + 24, 8)
  if (offsetSize < 1 || offsetSize > 8 || refSize < 1 || refSize > 8) return null
  if (numObjects < 1 || topObject < 0 || topObject >= numObjects || tableAt < MAGIC.length) return null
  // The offset table sits between the objects and the trailer; this also bounds numObjects by the file size.
  if (numObjects > (trailer - tableAt) / offsetSize) return null

  const offsets: number[] = new Array<number>(numObjects)
  for (let i = 0; i < numObjects; i++) {
    const offset = readUint(buf, tableAt + i * offsetSize, offsetSize)
    if (offset < MAGIC.length || offset >= tableAt) return null
    offsets[i] = offset
  }
  const layout: Layout = { buf, offsets, tableAt }

  const dictAt = offsets[topObject]
  if (buf[dictAt] >> 4 !== 0xd) return null
  const header = countAndPayload(buf, dictAt)
  if (!header) return null
  const { count, payload } = header
  // Keys come first, then values: 2 × count refs, all inside the object area.
  if (count > (tableAt - payload) / (2 * refSize)) return null

  const result: Record<string, string> = Object.create(null) as Record<string, string>
  for (let i = 0; i < count; i++) {
    const key = readString(layout, readUint(buf, payload + i * refSize, refSize))
    if (key === null) continue
    const value = readString(layout, readUint(buf, payload + (count + i) * refSize, refSize))
    if (value !== null) result[key] = value
  }
  return result
}
