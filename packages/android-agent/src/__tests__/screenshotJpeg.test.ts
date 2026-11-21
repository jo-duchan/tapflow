import { describe, it, expect } from 'vitest'
import { existsSync, promises as fs } from 'fs'
import { deflateSync } from 'zlib'
import { toJpeg, withoutLeadingText, type RunFile } from '../screenshotJpeg.js'

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** A real 4×2 grey PNG, so `sips` has something it can read. */
function png(): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const crcBuf = Buffer.concat([Buffer.from(type), data])
    let c = ~0
    for (const b of crcBuf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)) }
    const crc = Buffer.alloc(4); crc.writeUInt32BE((~c) >>> 0)
    return Buffer.concat([len, Buffer.from(type), data, crc])
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(4, 0); ihdr.writeUInt32BE(2, 4); ihdr[8] = 8; ihdr[9] = 0
  const rows = Buffer.concat([Buffer.from([0, 128, 128, 128, 128]), Buffer.from([0, 64, 64, 64, 64])])
  return Buffer.concat([PNG_SIG, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))])
}

describe('withoutLeadingText', () => {
  // #1118: a device with several displays writes a warning ahead of the PNG. Mutation: keep the bytes as they are.
  it('cuts the warning screencap writes ahead of the PNG, and leaves a clean PNG alone', () => {
    const shot = png()
    const warned = Buffer.concat([Buffer.from('[Warning] Multiple displays were found…\n'), shot])
    expect(withoutLeadingText(warned).equals(shot)).toBe(true)
    expect(withoutLeadingText(shot)).toBe(shot)
    const text = Buffer.from('no image here')
    expect(withoutLeadingText(text)).toBe(text)
  })
})

describe('toJpeg', () => {
  // A conversion that writes a JPEG is used; one that fails or writes anything else is not, and the caller answers
  // with the PNG it has (#508: the reply says what was made). Mutations: return the output unchecked, or throw.
  it('answers the JPEG sips wrote, and null for a failure or something that is not one', async () => {
    const writes = (bytes: Buffer): RunFile => async (_f, args) => { await fs.writeFile(args[args.length - 1]!, bytes) }
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
    expect((await toJpeg(png(), writes(jpeg)))?.equals(jpeg)).toBe(true)
    expect(await toJpeg(png(), writes(Buffer.from('not a jpeg')))).toBeNull()
    expect(await toJpeg(png(), async () => { throw new Error('spawn /usr/bin/sips ENOENT') })).toBeNull()
  })

  // Its own directory each time, gone afterwards, so two at once never share a file and none is left behind.
  it('uses a temp directory of its own and removes it, whatever happened', async () => {
    const dirs: string[] = []
    const run: RunFile = async (_f, args) => { dirs.push(args[args.length - 3]!); throw new Error('boom') }
    await Promise.all([toJpeg(png(), run), toJpeg(png(), run)])
    expect(new Set(dirs.map((d) => d.replace(/\/in\.png$/, ''))).size).toBe(2)
    for (const d of dirs) expect(existsSync(d)).toBe(false)
  })

  // The real tool, where it exists (every Mac an agent runs on). Elsewhere — CI on Linux — there is nothing to run.
  it.skipIf(process.platform !== 'darwin')('makes a JPEG with macOS sips', async () => {
    const out = await toJpeg(png())
    expect(out?.subarray(0, 2).equals(Buffer.from([0xff, 0xd8]))).toBe(true)
  })
})
