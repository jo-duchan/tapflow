import { describe, it, expect } from 'vitest'
import { parseAudioFrames, AudioCaptureStreamer } from '../AudioCaptureStreamer'
import net from 'node:net'

// Build a length-prefixed frame: [u32 BE len][payload].
function frame(payload: Buffer): Buffer {
  const head = Buffer.alloc(4)
  head.writeUInt32BE(payload.length, 0)
  return Buffer.concat([head, payload])
}

describe('parseAudioFrames', () => {
  it('parses a single complete frame', () => {
    const pcm = Buffer.from([1, 2, 3, 4])
    const { frames, rest } = parseAudioFrames(frame(pcm))
    expect(frames).toHaveLength(1)
    expect(frames[0]).toEqual(pcm)
    expect(rest).toHaveLength(0)
  })

  it('parses multiple frames in one buffer', () => {
    const a = Buffer.from([1, 2]); const b = Buffer.from([3, 4, 5, 6])
    const { frames, rest } = parseAudioFrames(Buffer.concat([frame(a), frame(b)]))
    expect(frames).toEqual([a, b])
    expect(rest).toHaveLength(0)
  })

  it('keeps a partial frame as remainder (no over-read)', () => {
    const a = Buffer.from([1, 2, 3, 4])
    const split = Buffer.concat([frame(a), Buffer.from([0, 0, 0, 9])]) // 2nd frame: only its length header
    const { frames, rest } = parseAudioFrames(split)
    expect(frames).toEqual([a])
    expect(rest.length).toBe(4)
  })

  it('reassembles a frame split across two reads', () => {
    const pcm = Buffer.from([10, 20, 30, 40, 50, 60])
    const full = frame(pcm)
    const r1 = parseAudioFrames(full.subarray(0, 5))
    expect(r1.frames).toHaveLength(0)
    const r2 = parseAudioFrames(Buffer.concat([r1.rest, full.subarray(5)]))
    expect(r2.frames).toEqual([pcm])
  })

  it('returns nothing for fewer than 4 header bytes', () => {
    const { frames, rest } = parseAudioFrames(Buffer.from([0, 0]))
    expect(frames).toHaveLength(0)
    expect(rest.length).toBe(2)
  })
})

describe('AudioCaptureStreamer (loopback TCP → AudioFrame stream)', () => {
  it('listens on an ephemeral port and yields AudioFrames for PCM a client writes', async () => {
    const streamer = new AudioCaptureStreamer()
    const port = await streamer.listen()
    expect(port).toBeGreaterThan(0)
    const stream = streamer.frames()
    const reader = stream.getReader()

    // a fake dylib: connect to the loopback port and write two length-prefixed PCM frames
    const client = await new Promise<net.Socket>((resolve) => {
      const c = net.createConnection(port, '127.0.0.1', () => {
        c.write(frame(Buffer.from([1, 2, 3, 4])))
        c.write(frame(Buffer.from([5, 6])))
        resolve(c)
      })
      c.on('error', () => resolve(c))
    })

    const f1 = await reader.read()
    const f2 = await reader.read()
    expect(f1.value?.payload).toEqual(Buffer.from([1, 2, 3, 4]))
    expect(f2.value?.payload).toEqual(Buffer.from([5, 6]))
    expect(typeof f1.value?.timestamp).toBe('number')

    client.destroy()
    streamer.stop()
  })
})
