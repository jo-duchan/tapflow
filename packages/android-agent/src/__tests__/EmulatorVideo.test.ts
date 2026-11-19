import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EmulatorVideo, detectCornerRadius, ensureExecutable, type EncoderProcess } from '../emulator/EmulatorVideo'
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
    sendTouch: vi.fn(),
    streamInputEvent: vi.fn(),
    getDisplayConfigurations: vi.fn((_e: unknown, _o: unknown, cb: (e: null, r: unknown) => void) => cb(null, { displays: [] })) as unknown as RawEmulatorController['getDisplayConfigurations'], sendKey: vi.fn(), sendMouse: vi.fn(), sendWheel: vi.fn(), close: vi.fn(),
    // Video tests never reach these, but `RawEmulatorController` declares them and a double short
    // of a member is what #418 shipped behind a cast. Present so the annotation means something.
    streamAudio: vi.fn(), getClipboard: vi.fn(), setClipboard: vi.fn(),
  }
  return new EmulatorGrpcClient('x', raw)
}

// A fake encoder: records stdin writes (frame headers), and lets the test push stdout chunks. It
// deliberately does NOT clear its data listener on removeAllListeners, so a "late" stdout chunk
// after stop() still reaches onEncoderOutput — exercising EmulatorVideo's enqueue-after-close guard.
// `writeReturns:false` simulates a saturated stdin (backpressure); exit()/error()/drain() let a test
// fire the corresponding encoder events.
function fakeEncoder(opts: { writeReturns?: boolean } = {}) {
  let dataCb: ((c: Buffer) => void) | null = null
  let exitCb: ((code: number | null) => void) | null = null
  let errorCb: ((e: Error) => void) | null = null
  let drainCb: (() => void) | null = null
  const stdinWrites: Buffer[] = []
  const enc = {
    stdin: {
      write: (c: Buffer) => { stdinWrites.push(c); return opts.writeReturns ?? true },
      end: () => {}, destroyed: false,
      on: () => {},
      once: (_e: string, cb: () => void) => { drainCb = cb },
    },
    stdout: { on: (_e: string, cb: (c: Buffer) => void) => { dataCb = cb }, removeAllListeners: () => {} },
    stderr: { on: () => {} },
    on: (e: string, cb: (arg: never) => void) => { if (e === 'exit') exitCb = cb as never; else if (e === 'error') errorCb = cb as never; return enc },
    kill: vi.fn(),
  }
  return {
    enc: enc as unknown as EncoderProcess,
    stdinWrites,
    push: (b: Buffer) => dataCb?.(b),
    exit: (code: number | null) => exitCb?.(code),
    error: (e: Error) => errorCb?.(e),
    drain: () => drainCb?.(),
  }
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
    expect(info).toEqual({ width: 8, height: 16, rotation: 'PORTRAIT', cornerRadius: 0 })
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
    try {
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
    } finally {
      vi.useRealTimers()
    }
  })

  // A foldable swaps which physical display is on, so the frame size changes mid-stream — and the
  // agent de-normalises touches with `state.videoWidth/Height`, which on the gRPC path came from
  // `adb wm size` once at boot. Measured on a Pixel 9 Pro Fold: `wm size` reports the natural
  // 2076x2152 while the live display is 2152x2076, so touches landed rotated 90° counter-clockwise
  // before anyone folded anything. This callback is how the size reaches the agent.
  it('reports a mid-stream size change to its caller', async () => {
    vi.useFakeTimers()
    try {
      const fe = fakeEncoder()
      const seen: Array<[number, number]> = []
      const client = fakeClient([
        { image: rgba(8, 16), width: 8, height: 16 },
        { image: rgba(16, 8), width: 16, height: 8 },  // the aspect flips, as folding does
      ])
      const video = new EmulatorVideo(client, {
        fps: 30, spawnEncoder: () => fe.enc, onSizeChange: (w, h) => seen.push([w, h]),
      })
      await video.start()
      await vi.advanceTimersByTimeAsync(40)
      expect(seen).toContainEqual([16, 8])
      video.stop()
    } finally { vi.useRealTimers() }
  })

  // The pair for the absence below: without it, "not called again" also describes a callback that
  // was never wired up at all.
  it('does not report a size that did not change', async () => {
    vi.useFakeTimers()
    try {
      const fe = fakeEncoder()
      const seen: Array<[number, number]> = []
      const client = fakeClient([
        { image: rgba(8, 16), width: 8, height: 16 },
        { image: rgba(8, 16), width: 8, height: 16 },
        { image: rgba(8, 16), width: 8, height: 16 },
      ])
      const video = new EmulatorVideo(client, {
        fps: 30, spawnEncoder: () => fe.enc, onSizeChange: (w, h) => seen.push([w, h]),
      })
      await video.start()
      await vi.advanceTimersByTimeAsync(40)
      // Exactly one report — the first frame, which fixes the size. The two that follow are the
      // same size and must be silent.
      expect(seen).toEqual([[8, 16]])
      video.stop()
    } finally { vi.useRealTimers() }
  })

  it('rejects start() when the capture errors before the first frame (→ scrcpy fallback)', async () => {
    const raw: RawEmulatorController = {
      streamScreenshot() {
        return { cancel() {}, async *[Symbol.asyncIterator]() { throw new Error('16 UNAUTHENTICATED') } } as never
      },
      sendTouch: vi.fn(), streamInputEvent: vi.fn(), sendKey: vi.fn(), sendMouse: vi.fn(), sendWheel: vi.fn(), close: vi.fn(),
      streamAudio: vi.fn(), getClipboard: vi.fn(), setClipboard: vi.fn(), getDisplayConfigurations: vi.fn(),
    }
    const fe = fakeEncoder()
    const video = new EmulatorVideo(new EmulatorGrpcClient('x', raw), { spawnEncoder: () => fe.enc })
    await expect(video.start()).rejects.toThrow('UNAUTHENTICATED')
  })

  it('rejects start() when the encoder dies before the first frame (→ scrcpy fallback)', async () => {
    const fe = fakeEncoder()
    // Capture yields nothing then blocks (live emulator), so only the encoder-exit path can settle.
    const video = new EmulatorVideo(fakeClient([]), { spawnEncoder: () => fe.enc })
    const started = video.start()
    fe.exit(1)
    await expect(started).rejects.toThrow('encoder exited (1)')
    video.stop()
  })

  it('drops frames while the encoder stdin is saturated (backpressure, no unbounded buffering)', async () => {
    vi.useFakeTimers()
    try {
      const fe = fakeEncoder({ writeReturns: false }) // stdin never drains on its own
      const video = new EmulatorVideo(fakeClient([
        { image: rgba(8, 16), width: 8, height: 16 },
        { image: rgba(8, 16), width: 8, height: 16 },
        { image: rgba(8, 16), width: 8, height: 16 },
      ]), { fps: 30, spawnEncoder: () => fe.enc })
      await video.start()                    // frame 1 writes; write()=false → busy
      await vi.advanceTimersByTimeAsync(40)   // trailing flush fires but the encoder is busy → dropped
      const framesWritten = fe.stdinWrites.filter((b) => b.length === 13 && b[0] === 0x00).length
      expect(framesWritten).toBe(1)           // only frame 1; the rest dropped instead of buffered
      video.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})

// followups M3: a lost encoder exec bit makes spawn EACCES → silent scrcpy fallback (no audio/host-mute); ensureExecutable self-heals it.
describe('ensureExecutable', () => {
  it('restores the exec bit on a non-executable binary', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-encoder-'))
    const bin = path.join(dir, 'emulator-encoder')
    try {
      fs.writeFileSync(bin, '#!/bin/sh\n')
      fs.chmodSync(bin, 0o644) // no exec bit — mimics a --ignore-scripts install
      expect(() => fs.accessSync(bin, fs.constants.X_OK)).toThrow()

      ensureExecutable(bin)

      expect(() => fs.accessSync(bin, fs.constants.X_OK)).not.toThrow()
      expect(fs.statSync(bin).mode & 0o111).not.toBe(0)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('is a no-op (no throw) when the binary is already executable', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-encoder-'))
    const bin = path.join(dir, 'emulator-encoder')
    try {
      fs.writeFileSync(bin, '#!/bin/sh\n')
      fs.chmodSync(bin, 0o755)
      expect(() => ensureExecutable(bin)).not.toThrow()
      expect(() => fs.accessSync(bin, fs.constants.X_OK)).not.toThrow()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not throw when the binary is missing (spawn will surface the real error)', () => {
    expect(() => ensureExecutable('/no/such/emulator-encoder')).not.toThrow()
  })
})
