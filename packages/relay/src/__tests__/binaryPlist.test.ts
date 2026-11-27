import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { MAX_PLIST_BYTES, parseBinaryPlist } from '../lib/binaryPlist'
import { extractAppZipInfo, parseInfoPlist } from '../api/builds'
import { writeZipFixture } from './helpers/zipFixture'
import { assertArchiveTools } from './helpers/archivePrereqs'

// Both fixtures were written by `plutil -convert binary1`, so they are what Xcode ships rather than
// what this parser expects. The large one has more than 255 objects, so its object refs are 2 bytes.
const FIXTURES = path.join(__dirname, 'fixtures')
const SMALL = fs.readFileSync(path.join(FIXTURES, 'Info-binary.plist'))
const LARGE = fs.readFileSync(path.join(FIXTURES, 'Info-binary-large.plist'))

/** The trailer and offset table of a well-formed fixture, read independently of the parser under test. */
function trailerOf(buf: Buffer): { offsetSize: number; tableAt: number; offsets: number[] } {
  const t = buf.length - 32
  const offsetSize = buf[t + 6]
  const count = Number(buf.readBigUInt64BE(t + 8))
  const tableAt = Number(buf.readBigUInt64BE(t + 24))
  const offsets = Array.from({ length: count }, (_, i) => buf.readUIntBE(tableAt + i * offsetSize, offsetSize))
  return { offsetSize, tableAt, offsets }
}

/**
 * A bplist00 whose top-level dict maps each key to the string object at `valueIndex` in `strings`.
 * Written here rather than by plutil so a test can shape what plutil never would: one string named by
 * every entry, or a file past the size cap. Refs and offsets are 4 bytes wide, ASCII strings only.
 */
function buildPlist(strings: string[], entries: Array<[keyIndex: number, valueIndex: number]>): Buffer {
  const W = 4
  const parts: Buffer[] = [Buffer.from('bplist00', 'latin1')]
  const offsets: number[] = []
  let at = 8
  const push = (b: Buffer): void => { offsets.push(at); parts.push(b); at += b.length }
  const lengthHeader = (marker: number, n: number): Buffer => {
    if (n < 15) return Buffer.from([marker | n])
    const b = Buffer.alloc(6); b[0] = marker | 0x0f; b[1] = 0x12; b.writeUInt32BE(n, 2); return b
  }
  const dict = Buffer.alloc(entries.length * 2 * W)
  entries.forEach(([k, v], i) => { dict.writeUInt32BE(k + 1, i * W); dict.writeUInt32BE(v + 1, (entries.length + i) * W) })
  push(Buffer.concat([lengthHeader(0xd0, entries.length), dict]))
  for (const s of strings) push(Buffer.concat([lengthHeader(0x50, s.length), Buffer.from(s, 'latin1')]))
  const tableAt = at
  const table = Buffer.alloc(offsets.length * W)
  offsets.forEach((o, i) => table.writeUInt32BE(o, i * W))
  const trailer = Buffer.alloc(32)
  trailer[6] = W; trailer[7] = W
  trailer.writeBigUInt64BE(BigInt(offsets.length), 8)
  trailer.writeBigUInt64BE(0n, 16)
  trailer.writeBigUInt64BE(BigInt(tableAt), 24)
  return Buffer.concat([...parts, table, trailer])
}

describe('parseBinaryPlist', () => {
  it('reads the string values of the top-level dictionary', () => {
    const parsed = parseBinaryPlist(SMALL)
    expect(parsed).not.toBeNull()
    // Longer than 14 characters, so its length is written as a separate integer object.
    expect(parsed!['CFBundleIdentifier']).toBe('com.example.apple-samplecode.Food-Truck')
    expect(parsed!['CFBundleShortVersionString']).toBe('1.4.2')
    expect(parsed!['CFBundleVersion']).toBe('87')
    expect(parsed!['CFBundleName']).toBe('FoodTruck')
    // Not ASCII, so plutil stores it as UTF-16.
    expect(parsed!['CFBundleDisplayName']).toBe('푸드 트럭')
  })

  it('leaves out values that are not strings, and does not descend into nested containers', () => {
    const parsed = parseBinaryPlist(SMALL)!
    expect(Object.keys(parsed).sort()).toEqual([
      'CFBundleDisplayName', 'CFBundleIdentifier', 'CFBundleName', 'CFBundleShortVersionString', 'CFBundleVersion',
    ])
  })

  it('reads a plist whose object refs are two bytes wide', () => {
    const parsed = parseBinaryPlist(LARGE)
    expect(parsed).not.toBeNull()
    expect(parsed!['CFBundleIdentifier']).toBe('com.example.large')
    expect(parsed!['Key299']).toBe('value-299')
    expect(Object.keys(parsed!)).toHaveLength(301)
  })

  it('returns null for a buffer that is not a binary plist', () => {
    expect(parseBinaryPlist(Buffer.from('<?xml version="1.0"?><plist></plist>'))).toBeNull()
    expect(parseBinaryPlist(Buffer.alloc(0))).toBeNull()
  })

  it('returns null when the top object is not a dictionary', () => {
    const copy = Buffer.from(SMALL)
    // The trailer's last 8 bytes before the offset-table offset name the top object; point it at a string.
    const trailer = copy.length - 32
    const topObject = Number(copy.readBigUInt64BE(trailer + 16))
    copy.writeBigUInt64BE(BigInt(topObject === 1 ? 2 : 1), trailer + 16)
    expect(parseBinaryPlist(copy)).toBeNull()
  })

  it('returns null when the offset table lies outside the buffer', () => {
    const copy = Buffer.from(SMALL)
    copy.writeBigUInt64BE(BigInt(copy.length), copy.length - 32 + 24)
    expect(parseBinaryPlist(copy)).toBeNull()
  })

  it('returns null when the trailer claims more objects than the buffer can hold', () => {
    const copy = Buffer.from(SMALL)
    copy.writeBigUInt64BE(0xffffffffffffn, copy.length - 32 + 8)
    expect(parseBinaryPlist(copy)).toBeNull()
  })

  it('returns null when an integer width in the trailer is zero or wider than 8 bytes', () => {
    for (const [at, value] of [[6, 0], [7, 0], [6, 9], [7, 9]] as const) {
      const copy = Buffer.from(SMALL)
      copy[copy.length - 32 + at] = value
      expect(parseBinaryPlist(copy), `trailer byte ${at} = ${value}`).toBeNull()
    }
  })

  it('returns null for another plist format behind the same prefix', () => {
    // bplist15 and bplist16 are later, different encodings; this reads only bplist00.
    const copy = Buffer.from(SMALL)
    copy.write('bplist15', 0, 'latin1')
    expect(parseBinaryPlist(copy)).toBeNull()
  })

  it('returns null when an object offset points into the header', () => {
    const copy = Buffer.from(SMALL)
    const t = trailerOf(copy)
    copy.writeUIntBE(0, t.tableAt + 1 * t.offsetSize, t.offsetSize)
    expect(parseBinaryPlist(copy)).toBeNull()
  })

  it('returns null when an object offset points into the offset table', () => {
    const copy = Buffer.from(SMALL)
    const t = trailerOf(copy)
    copy.writeUIntBE(t.tableAt, t.tableAt + 1 * t.offsetSize, t.offsetSize)
    expect(parseBinaryPlist(copy)).toBeNull()
  })

  // Without this bound a crafted count runs the loop that many times: 8 bytes of count is a relay
  // stuck on one upload.
  it('returns null when the dictionary claims more entries than the object area can hold', () => {
    const copy = Buffer.from(LARGE)
    const dictAt = trailerOf(copy).offsets[0]
    // 0xDF: a dictionary whose count follows as an integer object, here 0x11 (2 bytes) holding 301.
    expect([copy[dictAt], copy[dictAt + 1], copy.readUInt16BE(dictAt + 2)]).toEqual([0xdf, 0x11, 301])
    copy.writeUInt16BE(0xffff, dictAt + 2)
    expect(parseBinaryPlist(copy)).toBeNull()
  })

  it('leaves out a string that runs into the offset table', () => {
    const copy = Buffer.from(LARGE)
    const t = trailerOf(copy)
    const lastAt = Math.max(...t.offsets)
    // The object written last is Key230's value, 'value-230' (0x59: ASCII, 9 bytes), which ends where the table starts.
    expect([copy[lastAt], copy.toString('latin1', lastAt + 1, lastAt + 10), lastAt + 10]).toEqual([0x59, 'value-230', t.tableAt])
    copy[lastAt] = 0x5a
    const parsed = parseBinaryPlist(copy)
    expect(parsed!['Key229']).toBe('value-229')
    expect(parsed!['Key230']).toBeUndefined()
  })

  it('leaves out a string whose length is not written as an integer object', () => {
    const copy = Buffer.from(SMALL)
    const at = copy.indexOf(Buffer.from('CFBundleShortVersionString', 'latin1')) - 3
    expect([copy[at], copy[at + 1], copy[at + 2]]).toEqual([0x5f, 0x10, 26])
    copy[at + 1] = 0x50
    const parsed = parseBinaryPlist(copy)
    expect(parsed!['CFBundleIdentifier']).toBe('com.example.apple-samplecode.Food-Truck')
    expect(parsed!['CFBundleShortVersionString']).toBeUndefined()
  })

  it('returns null for every truncation of a plist', () => {
    for (const input of [SMALL, LARGE]) {
      for (let len = 0; len < input.length; len++) {
        expect(parseBinaryPlist(input.subarray(0, len)), `length ${len}`).toBeNull()
      }
    }
  })

  // An uploaded build is hostile input. This does not assert what comes back, only that the parser
  // answers at all: a corrupted byte may still leave a readable plist, so null is not the only right answer.
  it('reads a plist the test builder wrote', () => {
    expect({ ...parseBinaryPlist(buildPlist(['CFBundleIdentifier', 'a.b'], [[0, 1]])) }).toEqual({ CFBundleIdentifier: 'a.b' })
  })

  it('keeps the first value of a repeated key, as CoreFoundation does', () => {
    expect({ ...parseBinaryPlist(buildPlist(['k', '1', '2'], [[0, 1], [0, 2]])) }).toEqual({ k: '1' })
  })

  it('returns null for a plist larger than the cap, however well formed', () => {
    const just = buildPlist(['k', 'v'.repeat(MAX_PLIST_BYTES - 100)], [[0, 1]])
    expect(just.length).toBeLessThanOrEqual(MAX_PLIST_BYTES)
    expect(parseBinaryPlist(just)?.['k']).toHaveLength(MAX_PLIST_BYTES - 100)
    const over = buildPlist(['k', 'v'.repeat(MAX_PLIST_BYTES)], [[0, 1]])
    expect(parseBinaryPlist(over)).toBeNull()
  })

  // Every entry names one 400 KB string. Decoded per entry that is 12 GB of work and minutes of a
  // blocked relay; decoded once it is a millisecond. The timeout is the assertion.
  it('decodes a string named by many entries once', { timeout: 2000 }, () => {
    const keys = Array.from({ length: 30000 }, (_, i) => `k${i}`)
    const input = buildPlist(['x'.repeat(400_000), ...keys], keys.map((_, i) => [i + 1, 0]))
    expect(input.length).toBeLessThanOrEqual(MAX_PLIST_BYTES)
    const parsed = parseBinaryPlist(input)!
    expect(Object.keys(parsed)).toHaveLength(30000)
    expect(parsed['k29999']).toHaveLength(400_000)
  })

  // The two shapes below come from review: objects whose bytes overlap, which no writer produces, made
  // every decode a distinct string. 40,000 overlapping keys in 760 KB exhausted the heap and killed the
  // relay; these are small enough to stay harmless if the budget is ever removed, and still exceed it.
  it('returns null when string objects overlap one another', () => {
    const K = 200
    const headers = 8 + 10 * K
    const valueAt = headers
    const dictAt = valueAt + 2
    const tableAt = dictAt + 6 + 2 * K * 4
    const body = Buffer.alloc(tableAt)
    body.write('bplist00', 0, 'latin1')
    for (let i = 0; i < K; i++) {
      // Each key string runs to the end of the object area, so it contains every header after it.
      const at = 8 + 10 * i
      body[at] = 0x5f; body[at + 1] = 0x13
      body.writeBigUInt64BE(BigInt(tableAt - (at + 10)), at + 2)
    }
    body[valueAt] = 0x51; body[valueAt + 1] = 0x76
    body[dictAt] = 0xdf; body[dictAt + 1] = 0x12; body.writeUInt32BE(K, dictAt + 2)
    for (let i = 0; i < K; i++) {
      body.writeUInt32BE(i, dictAt + 6 + i * 4)
      body.writeUInt32BE(K, dictAt + 6 + (K + i) * 4)
    }
    const offsets = [...Array.from({ length: K }, (_, i) => 8 + 10 * i), valueAt, dictAt]
    const table = Buffer.alloc(offsets.length * 4)
    offsets.forEach((o, i) => table.writeUInt32BE(o, i * 4))
    const trailer = Buffer.alloc(32)
    trailer[6] = 4; trailer[7] = 4
    trailer.writeBigUInt64BE(BigInt(offsets.length), 8)
    trailer.writeBigUInt64BE(BigInt(K + 1), 16)
    trailer.writeBigUInt64BE(BigInt(tableAt), 24)
    const input = Buffer.concat([body, table, trailer])

    // A null result alone does not show the work stopped: decoding every key and then refusing returns
    // null too, after the cost the budget exists to prevent. So count the decodes. The first key fits the
    // budget, the second overruns it, and nothing after that is decoded.
    const toString = vi.spyOn(Buffer.prototype, 'toString')
    try {
      expect(parseBinaryPlist(input)).toBeNull()
      expect(toString.mock.calls.filter(([encoding]) => encoding === 'latin1').length).toBeLessThanOrEqual(3)
    } finally {
      toString.mockRestore()
    }
  })

  it('returns null when many objects share one string\'s bytes', () => {
    // Objects 2.. all start at the same 1,000-byte string, so each key ref is a different object with the
    // same bytes and none of them is decoded from the cache.
    const K = 50
    const longAt = 8
    const long = Buffer.concat([Buffer.from([0x5f, 0x11, 0x03, 0xe8]), Buffer.alloc(1000, 0x78)])
    const valueAt = longAt + long.length
    const value = Buffer.from([0x51, 0x76])
    const dictAt = valueAt + value.length
    const dict = Buffer.alloc(3 + 2 * K * 4)
    dict[0] = 0xdf; dict[1] = 0x10; dict[2] = K
    for (let i = 0; i < K; i++) {
      dict.writeUInt32BE(2 + i, 3 + i * 4)
      dict.writeUInt32BE(1, 3 + (K + i) * 4)
    }
    const tableAt = dictAt + dict.length
    const offsets = [dictAt, valueAt, ...Array.from({ length: K }, () => longAt)]
    const table = Buffer.alloc(offsets.length * 4)
    offsets.forEach((o, i) => table.writeUInt32BE(o, i * 4))
    const trailer = Buffer.alloc(32)
    trailer[6] = 4; trailer[7] = 4
    trailer.writeBigUInt64BE(BigInt(offsets.length), 8)
    trailer.writeBigUInt64BE(0n, 16)
    trailer.writeBigUInt64BE(BigInt(tableAt), 24)
    expect(parseBinaryPlist(Buffer.concat([Buffer.from('bplist00', 'latin1'), long, value, dict, table, trailer]))).toBeNull()
  })

  it('never throws when any single byte is corrupted', () => {
    for (let i = 0; i < SMALL.length; i++) {
      for (const value of [0x00, 0x0f, 0x5f, 0x6f, 0xdf, 0xff]) {
        const copy = Buffer.from(SMALL)
        copy[i] = value
        expect(() => parseBinaryPlist(copy), `byte ${i} = ${value}`).not.toThrow()
      }
    }
  })
})

describe('parseInfoPlist with a binary plist', () => {
  it('reads it without plutil', () => {
    const info = parseInfoPlist(SMALL, () => null)
    expect(info).toEqual({
      bundleId: 'com.example.apple-samplecode.Food-Truck',
      versionName: '1.4.2',
      buildNumber: '87',
      appName: '푸드 트럭',
    })
  })

  it('uses plutil when it converts the file', () => {
    const xml = '<plist><dict><key>CFBundleIdentifier</key><string>from.plutil</string></dict></plist>'
    expect(parseInfoPlist(SMALL, () => xml).bundleId).toBe('from.plutil')
  })

  it('reads an escaped character the way the binary parser does', () => {
    const xml = '<plist><dict><key>CFBundleName</key><string>R&amp;D &lt;Tools&gt; &#xD55C;&#44544; &bogus; &#x110000;</string></dict></plist>'
    expect(parseInfoPlist(SMALL, () => xml).appName).toBe('R&D <Tools> 한글 &bogus; &#x110000;')
    expect(parseInfoPlist(Buffer.from(xml)).appName).toBe('R&D <Tools> 한글 &bogus; &#x110000;')
  })

  it('leaves an entity named after an Object property as written', () => {
    const xml = '<plist><dict><key>CFBundleName</key><string>&constructor;&toString;</string></dict></plist>'
    expect(parseInfoPlist(Buffer.from(xml)).appName).toBe('&constructor;&toString;')
  })

  it('reads nothing from a binary plist neither can parse', () => {
    const info = parseInfoPlist(Buffer.from('bplist00garbage'), () => null)
    expect(info).toEqual({ bundleId: null, versionName: null, buildNumber: null, appName: null })
  })
})

describe('extractAppZipInfo with a binary Info.plist', () => {
  let tmpDir: string

  beforeAll(() => {
    assertArchiveTools(['unzip'])
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-bplist-test-'))
  })

  afterAll(() => { if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true }) })

  it('reads the metadata', () => {
    const zipPath = writeZipFixture(path.join(tmpDir, 'Food Truck.app.zip'), [
      { name: 'Food Truck.app/' },
      { name: 'Food Truck.app/Info.plist', data: SMALL },
    ])
    expect(extractAppZipInfo(zipPath)?.bundleId).toBe('com.example.apple-samplecode.Food-Truck')
  })
})
