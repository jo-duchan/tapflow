import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { parseBinaryPlist } from '../lib/binaryPlist'
import { extractAppZipInfo, parseInfoPlist } from '../api/builds'
import { writeZipFixture } from './helpers/zipFixture'
import { assertArchiveTools } from './helpers/archivePrereqs'

// Both fixtures were written by `plutil -convert binary1`, so they are what Xcode ships rather than
// what this parser expects. The large one has more than 255 objects, so its object refs are 2 bytes.
const FIXTURES = path.join(__dirname, 'fixtures')
const SMALL = fs.readFileSync(path.join(FIXTURES, 'Info-binary.plist'))
const LARGE = fs.readFileSync(path.join(FIXTURES, 'Info-binary-large.plist'))

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

  // An uploaded build is hostile input. These do not assert what comes back, only that the parser
  // answers at all: a throw here would surface as a failed upload rather than a build without metadata.
  it('never throws on a truncated plist', () => {
    for (const input of [SMALL, LARGE]) {
      for (let len = 0; len < input.length; len++) {
        expect(() => parseBinaryPlist(input.subarray(0, len)), `length ${len}`).not.toThrow()
      }
    }
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
