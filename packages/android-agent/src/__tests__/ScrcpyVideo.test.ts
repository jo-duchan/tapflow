import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'events'
import { ScrcpyVideo, type ScrcpyFrame } from '../scrcpy/ScrcpyVideo'
import type { Socket } from 'net'

// Device meta header: 64 bytes device name + 4 bytes codec ID + 4 bytes width + 4 bytes height = 76 bytes
function makeHeader(name: string, width: number, height: number): Buffer {
  const header = Buffer.alloc(76)
  header.write(name, 0, 'utf8')
  header.write('h264', 64, 'utf8')
  header.writeUInt32BE(width, 68)
  header.writeUInt32BE(height, 72)
  return header
}

// scrcpy send_frame_meta=true packet: [8B pts_flags BE][4B len BE][payload].
// CONFIG flag = bit63 (top bit), KEY_FRAME flag = bit62.
function makePacket(payload: Buffer, opts: { config?: boolean; keyframe?: boolean } = {}): Buffer {
  const header = Buffer.alloc(12)
  let hi = 0
  if (opts.config) hi |= 0x80000000
  if (opts.keyframe) hi |= 0x40000000
  header.writeUInt32BE(hi >>> 0, 0) // top 32 bits of pts_flags (flags live here)
  header.writeUInt32BE(0, 4)        // low 32 bits of PTS
  header.writeUInt32BE(payload.length, 8)
  return Buffer.concat([header, payload])
}

// Annex B NAL run (start code + body), for building realistic payloads.
function annexB(...nals: Buffer[]): Buffer {
  return Buffer.concat(nals.flatMap((nal) => [Buffer.from([0x00, 0x00, 0x00, 0x01]), nal]))
}

function fakeSocket(header: Buffer, dataChunks: Buffer[], emitEnd = true): Socket {
  const emitter = new EventEmitter()
  const socket = emitter as unknown as Socket
  process.nextTick(() => {
    emitter.emit('data', header)
    for (const chunk of dataChunks) emitter.emit('data', chunk)
    if (emitEnd) emitter.emit('end')
  })
  return socket
}

async function collect(video: ScrcpyVideo): Promise<ScrcpyFrame[]> {
  const reader = video.start().getReader()
  const out: ScrcpyFrame[] = []
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    out.push(value)
  }
  return out
}

const SPS = Buffer.from([0x67, 0x42, 0xc0, 0x32])
const PPS = Buffer.from([0x68, 0xce, 0x01, 0xa8])
const IDR = Buffer.from([0x65, 0x88, 0x80, 0x10])  // NAL type 5
const PSLICE = Buffer.from([0x41, 0x9a, 0x00, 0x20]) // NAL type 1

describe('ScrcpyVideo (send_frame_meta=true)', () => {
  it('parses device name, width and height from 76-byte header', async () => {
    const socket = fakeSocket(makeHeader('Pixel_8', 1080, 2400), [])
    const video = new ScrcpyVideo(socket)
    const info = await video.deviceInfo()
    expect(info.deviceName).toBe('Pixel_8')
    expect(info.width).toBe(1080)
    expect(info.height).toBe(2400)
  })

  // B-2 #1 + #3: config packet (SPS/PPS) merges into the following IDR packet,
  // emitted as ONE keyframe access unit (SPS+PPS+IDR together).
  it('merges the config packet into the following keyframe as one access unit', async () => {
    const config = annexB(SPS, PPS)
    const idr = annexB(IDR)
    const socket = fakeSocket(makeHeader('t', 576, 1280), [
      makePacket(config, { config: true }),
      makePacket(idr, { keyframe: true }),
    ])
    const video = new ScrcpyVideo(socket)
    await video.deviceInfo()

    const frames = await collect(video)
    expect(frames).toHaveLength(1)
    expect(frames[0].keyframe).toBe(true)
    expect(frames[0].payload).toEqual(Buffer.concat([config, idr]))
  })

  // B-2 #2: a non-IDR packet is a P-frame access unit (keyframe=false), no config prepended.
  it('emits a P-frame packet as a non-keyframe access unit', async () => {
    const p = annexB(PSLICE)
    const socket = fakeSocket(makeHeader('t', 576, 1280), [makePacket(p)])
    const video = new ScrcpyVideo(socket)
    await video.deviceInfo()

    const frames = await collect(video)
    expect(frames).toHaveLength(1)
    expect(frames[0].keyframe).toBe(false)
    expect(frames[0].payload).toEqual(p)
  })

  it('reassembles a packet fragmented across TCP segments', async () => {
    const p = annexB(PSLICE)
    const packet = makePacket(p, { keyframe: true })
    // Split mid-header and mid-payload across three segments
    const socket = fakeSocket(makeHeader('t', 576, 1280), [
      packet.subarray(0, 5),
      packet.subarray(5, 13),
      packet.subarray(13),
    ])
    const video = new ScrcpyVideo(socket)
    await video.deviceInfo()

    const frames = await collect(video)
    expect(frames).toHaveLength(1)
    expect(frames[0].keyframe).toBe(true)
    expect(frames[0].payload).toEqual(p)
  })

  it('drains multiple packets bundled in a single chunk', async () => {
    const p1 = annexB(PSLICE)
    const p2 = annexB(Buffer.from([0x41, 0x9b, 0x10, 0x20]))
    const socket = fakeSocket(makeHeader('t', 576, 1280), [
      Buffer.concat([makePacket(p1), makePacket(p2)]),
    ])
    const video = new ScrcpyVideo(socket)
    await video.deviceInfo()

    const frames = await collect(video)
    expect(frames.map((f) => f.payload)).toEqual([p1, p2])
    expect(frames.every((f) => f.keyframe === false)).toBe(true)
  })

  it('rejects deviceInfo when the server closes before the header arrives', async () => {
    const emitter = new EventEmitter()
    const socket = emitter as unknown as Socket
    process.nextTick(() => emitter.emit('end'))
    const video = new ScrcpyVideo(socket)
    await expect(video.deviceInfo()).rejects.toThrow()
  })
})
