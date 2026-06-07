import { describe, it, expect, vi } from 'vitest'
import { EmulatorVideo, detectCornerRadius, type EncoderProcess } from '../emulator/EmulatorVideo'
import { EmulatorGrpcClient, type RawEmulatorController } from '../emulator/EmulatorGrpcClient'
import type { ScrcpyFrame } from '../scrcpy/ScrcpyVideo'

// A controllable fake gRPC client: yields the given frames, then blocks until cancel() (so the
// capture stream stays open like a live emulator) — cancel rejects the wait to end cleanly.
function fakeClient(frames: Array<{ image: Buffer; width: number; height: number }>): EmulatorGrpcClient {
  const raw: RawEmulatorController = {
    streamScreenshot() {
      let onCancel: (e: Error) => void = () => {}
      const call = {
        cancel() { onCancel(new Error('cancelled')) },
        async *[Symbol.asyncIterator]() {
          for (let i = 0; i < frames.length; i++) {
            const f = frames[i]!
            yield { image: f.image, seq: i, format: { rotation: { rotation: 'PORTRAIT' }, width: f.width, height: f.height } }
          }
          await new Promise<void>((_, reject) => { onCancel = reject })
        },
      }
      return call as never
    },
    sendTouch: vi.fn(), sendKey: vi.fn(), sendMouse: vi.fn(), sendWheel: vi.fn(), close: vi.fn(),
  }
  return new EmulatorGrpcClient('x', raw)
}

// A fake encoder: records stdin writes (frame headers), and lets the test push stdout chunks. It
// deliberately does NOT clear its data listener on removeAllListeners, so a "late" stdout chunk
// after stop() still reaches onEncoderOutput — exercising EmulatorVideo's enqueue-after-close guard.
function fakeEncoder() {
  let dataCb: ((c: Buffer) => void) | null = null
  const stdinWrites: Buffer[] = []
  const enc = {
    stdin: { write: (c: Buffer) => { stdinWrites.push(c); return true }, end: () => {}, destroyed: false, on: () => {} },
    stdout: { on: (_e: string, cb: (c: Buffer) => void) => { dataCb = cb }, removeAllListeners: () => {} },
    stderr: { on: () => {} },
    on: () => enc,
    kill: vi.fn(),
  }
  return { enc: enc as unknown as EncoderProcess, stdinWrites, push: (b: Buffer) => dataCb?.(b) }
}

// Build the encoder's Annex B output framing: [len:u32][flags:u8][payload].
function framed(payload: Buffer, keyframe: boolean): Buffer {
  const head = Buffer.alloc(5)
  head.writeUInt32BE(payload.length + 1, 0)
  head[4] = keyframe ? 1 : 0
  return Buffer.concat([head, payload])
}

function rgba(w: number, h: number): Buffer { return Buffer.alloc(w * h * 4) }

describe('detectCornerRadius', () => {
  // left edge black for the top `r` rows (the baked rounded corner is exact 0,0,0), rest white.
  function withCorner(w: number, h: number, r: number): Buffer {
    const b = Buffer.alloc(w * h * 4, 255)
    for (let y = 0; y < r; y++) { const o = (y * w) * 4; b[o] = 0; b[o + 1] = 0; b[o + 2] = 0 }
    return b
  }

  it('measures the black corner run as a fraction of width', () => {
    expect(detectCornerRadius(withCorner(40, 80, 6), 40, 80)).toBeCloseTo(6 / 40)
  })

  it('returns 0 for square content (no black corner)', () => {
    expect(detectCornerRadius(Buffer.alloc(40 * 80 * 4, 255), 40, 80)).toBe(0)
  })

  it('returns 0 when the whole edge is black (runaway → not a corner)', () => {
    expect(detectCornerRadius(Buffer.alloc(40 * 80 * 4, 0), 40, 80)).toBe(0)
  })
})

describe('EmulatorVideo', () => {
  it('resolves start() with the first frame dimensions and pipes RGBA to the encoder', async () => {
    const fe = fakeEncoder()
    const video = new EmulatorVideo(fakeClient([{ image: rgba(8, 16), width: 8, height: 16 }]), {
      spawnEncoder: () => fe.enc,
    })
    const info = await video.start()
    expect(info).toEqual({ width: 8, height: 16, cornerRadius: 0 })
    // The first frame is written: [0x00][w][h][len] header + RGBA payload.
    expect(fe.stdinWrites.length).toBeGreaterThanOrEqual(2)
    expect(fe.stdinWrites[0][0]).toBe(0x00)
    expect(fe.stdinWrites[0].readUInt32BE(1)).toBe(8)  // width
    expect(fe.stdinWrites[0].readUInt32BE(5)).toBe(16) // height
    video.stop()
  })

  it('parses the encoder Annex B framing across split chunks into {payload, keyframe}', async () => {
    const fe = fakeEncoder()
    const video = new EmulatorVideo(fakeClient([{ image: rgba(8, 16), width: 8, height: 16 }]), {
      spawnEncoder: () => fe.enc,
    })
    await video.start()
    const reader = video.frames().getReader()

    const idr = framed(Buffer.from([7, 8, 5]), true)
    const pframe = framed(Buffer.from([1, 1, 1, 1]), false)
    // Split the IDR mid-frame and merge the P-frame into the tail, to test buffering.
    fe.push(idr.subarray(0, 3))
    fe.push(Buffer.concat([idr.subarray(3), pframe]))

    const a = await reader.read()
    const b = await reader.read()
    expect(a.value).toMatchObject({ keyframe: true })
    expect([...(a.value as ScrcpyFrame).payload]).toEqual([7, 8, 5])
    expect(b.value).toMatchObject({ keyframe: false })
    expect([...(b.value as ScrcpyFrame).payload]).toEqual([1, 1, 1, 1])
    video.stop()
  })

  it('drops late encoder output after teardown without crashing (enqueue-after-close guard)', async () => {
    const fe = fakeEncoder()
    const video = new EmulatorVideo(fakeClient([{ image: rgba(8, 16), width: 8, height: 16 }]), {
      spawnEncoder: () => fe.enc,
    })
    await video.start()
    video.frames() // open + close the controller via stop()
    video.stop()
    // A late stdout chunk (the encoder flushes asynchronously) must be dropped, not enqueued.
    expect(() => fe.push(framed(Buffer.from([9, 9]), true))).not.toThrow()
  })

  it('flushes the trailing frame when the source goes static (no freeze on small changes)', async () => {
    vi.useFakeTimers()
    const fe = fakeEncoder()
    // 3 frames arrive ~together then the source hangs (static). Frames 2 & 3 fall inside the 30fps
    // interval — a plain drop would lose the final update; the trailing flush must still deliver it.
    const client = fakeClient([
      { image: rgba(8, 16), width: 8, height: 16 },
      { image: rgba(8, 16), width: 8, height: 16 },
      { image: rgba(8, 16), width: 8, height: 16 },
    ])
    const video = new EmulatorVideo(client, { fps: 30, spawnEncoder: () => fe.enc })
    await video.start()
    await vi.advanceTimersByTimeAsync(40) // let the pump consume 2 & 3, then fire the flush timer
    const framesWritten = fe.stdinWrites.filter((b) => b.length === 13 && b[0] === 0x00).length
    expect(framesWritten).toBe(2) // leading frame 1 + trailing-flushed frame 3 (frame 2 superseded)
    video.stop()
    vi.useRealTimers()
  })

  it('rejects start() when the capture errors before the first frame (→ scrcpy fallback)', async () => {
    const raw: RawEmulatorController = {
      streamScreenshot() {
        return { cancel() {}, async *[Symbol.asyncIterator]() { throw new Error('16 UNAUTHENTICATED') } } as never
      },
      sendTouch: vi.fn(), sendKey: vi.fn(), sendMouse: vi.fn(), sendWheel: vi.fn(), close: vi.fn(),
    }
    const fe = fakeEncoder()
    const video = new EmulatorVideo(new EmulatorGrpcClient('x', raw), { spawnEncoder: () => fe.enc })
    await expect(video.start()).rejects.toThrow('UNAUTHENTICATED')
  })
})
