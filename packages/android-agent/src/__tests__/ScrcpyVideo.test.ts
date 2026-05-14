import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'events'
import { ScrcpyVideo } from '../scrcpy/ScrcpyVideo'
import type { Socket } from 'net'

// Header layout: 64 bytes device name + 4 bytes codec ID + 4 bytes width + 4 bytes height = 76 bytes
function makeHeader(name: string, width: number, height: number): Buffer {
  const header = Buffer.alloc(76)
  header.write(name, 0, 'utf8')
  header.write('h264', 64, 'utf8')
  header.writeUInt32BE(width, 68)
  header.writeUInt32BE(height, 72)
  return header
}

// Build a minimal Annex B stream from NAL unit payloads (without start code)
function annexB(...nals: Buffer[]): Buffer {
  const parts = nals.flatMap((nal) => [Buffer.from([0x00, 0x00, 0x00, 0x01]), nal])
  return Buffer.concat(parts)
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

describe('ScrcpyVideo', () => {
  it('parses device name, width and height from 76-byte header', async () => {
    const header = makeHeader('Pixel_8', 1080, 2400)
    const socket = fakeSocket(header, [])
    const video = new ScrcpyVideo(socket)
    const info = await video.deviceInfo()
    expect(info.deviceName).toBe('Pixel_8')
    expect(info.width).toBe(1080)
    expect(info.height).toBe(2400)
  })

  it('extracts NAL units from Annex B stream', async () => {
    const sps = Buffer.from([0x67, 0x42, 0xc0, 0x32])
    const pps = Buffer.from([0x68, 0xce, 0x01, 0xa8])
    const header = makeHeader('test', 576, 1280)
    const socket = fakeSocket(header, [annexB(sps, pps)])

    const video = new ScrcpyVideo(socket)
    await video.deviceInfo()

    const stream = video.start()
    const reader = stream.getReader()
    const results: Buffer[] = []
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      results.push(value)
    }
    // Each NAL unit includes its Annex B start code
    expect(results).toHaveLength(2)
    expect(results[0].subarray(4)).toEqual(sps)
    expect(results[1].subarray(4)).toEqual(pps)
  })

  it('handles fragmented TCP data correctly', async () => {
    const sps = Buffer.from([0x67, 0x42, 0xc0, 0x32])
    const pps = Buffer.from([0x68, 0xce, 0x01])
    const stream = annexB(sps, pps)
    const header = makeHeader('test', 576, 1280)

    // Split data across two TCP segments mid-stream
    const socket = fakeSocket(header, [stream.subarray(0, 5), stream.subarray(5)])
    const video = new ScrcpyVideo(socket)
    await video.deviceInfo()

    const videoStream = video.start()
    const reader = videoStream.getReader()
    const results: Buffer[] = []
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      results.push(value)
    }
    expect(results).toHaveLength(2)
    expect(results[0].subarray(4)).toEqual(sps)
    expect(results[1].subarray(4)).toEqual(pps)
  })
})
