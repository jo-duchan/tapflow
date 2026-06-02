import { describe, it, expect, vi, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import { existsSync } from 'fs'
import { parseStreamFrames } from '../ScreenCaptureStreamer'

vi.mock('child_process', () => ({ spawn: vi.fn(), execFileSync: vi.fn() }))
vi.mock('fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('fs')>()),
  existsSync: vi.fn(),
  statSync: vi.fn(),
  unlinkSync: vi.fn(),
}))

function makeFakeProc() {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter
    stderr: EventEmitter
    stdin: EventEmitter & { writable: boolean; write: ReturnType<typeof vi.fn> }
    kill: ReturnType<typeof vi.fn>
  }
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  proc.stdin = Object.assign(new EventEmitter(), { writable: true, write: vi.fn() }) as EventEmitter & { writable: boolean; write: ReturnType<typeof vi.fn> }
  proc.kill = vi.fn()
  return proc
}

async function setupProc() {
  const { spawn } = await import('child_process')
  const proc = makeFakeProc()
  vi.mocked(spawn).mockReturnValue(proc as never)
  // existsSync(BINARY)=true, existsSync(SWIFT_SRC)=false → ensureCompiled() skips recompile
  vi.mocked(existsSync).mockReturnValueOnce(true).mockReturnValueOnce(false)
  return proc
}

describe('ScreenCaptureStreamer', () => {
  afterEach(() => vi.useRealTimers())

  it('sends SIGTERM on cancel', async () => {
    const proc = await setupProc()
    const { ScreenCaptureStreamer } = await import('../ScreenCaptureStreamer')

    const reader = new ScreenCaptureStreamer(30, 'booted').start().getReader()
    await reader.cancel()

    expect(proc.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('does not send SIGKILL when process exits within 1s', async () => {
    vi.useFakeTimers()
    const proc = await setupProc()
    const { ScreenCaptureStreamer } = await import('../ScreenCaptureStreamer')

    const reader = new ScreenCaptureStreamer(30, 'booted').start().getReader()
    await reader.cancel()
    proc.emit('exit', 0)
    await vi.advanceTimersByTimeAsync(1000)

    expect(proc.kill).toHaveBeenCalledWith('SIGTERM')
    expect(proc.kill).not.toHaveBeenCalledWith('SIGKILL')
  })

  it('sends SIGKILL if process does not exit within 1s', async () => {
    vi.useFakeTimers()
    const proc = await setupProc()
    const { ScreenCaptureStreamer } = await import('../ScreenCaptureStreamer')

    const reader = new ScreenCaptureStreamer(30, 'booted').start().getReader()
    await reader.cancel()
    await vi.advanceTimersByTimeAsync(1000)

    expect(proc.kill).toHaveBeenCalledWith('SIGTERM')
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL')
  })
})

// [4-byte len BE][payload]
function jpegFrame(payload: number[]): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(payload.length, 0)
  return Buffer.concat([len, Buffer.from(payload)])
}

// [4-byte len BE][flags:u8][payload]  (len counts the flags byte)
function h264Frame(payload: number[], keyframe: boolean): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(payload.length + 1, 0)
  return Buffer.concat([len, Buffer.from([keyframe ? 0x01 : 0x00]), Buffer.from(payload)])
}

describe('parseStreamFrames — JPEG', () => {
  it('parses a single complete frame and drains the buffer', () => {
    const { frames, rest } = parseStreamFrames(jpegFrame([0xFF, 0xD8, 0xAA]), false)
    expect(frames).toHaveLength(1)
    expect([...frames[0].payload]).toEqual([0xFF, 0xD8, 0xAA])
    expect(frames[0].keyframe).toBe(false)
    expect(rest.length).toBe(0)
  })

  it('parses multiple frames in one buffer', () => {
    const buf = Buffer.concat([jpegFrame([0x01]), jpegFrame([0x02, 0x03])])
    const { frames, rest } = parseStreamFrames(buf, false)
    expect(frames.map((f) => [...f.payload])).toEqual([[0x01], [0x02, 0x03]])
    expect(rest.length).toBe(0)
  })

  it('keeps an incomplete frame as the remainder', () => {
    const partial = jpegFrame([0x01, 0x02, 0x03]).subarray(0, 5) // header + 1 of 3 bytes
    const { frames, rest } = parseStreamFrames(partial, false)
    expect(frames).toHaveLength(0)
    expect(rest).toEqual(partial)
  })

  it('returns a complete frame and keeps the trailing partial frame', () => {
    const buf = Buffer.concat([jpegFrame([0x01]), jpegFrame([0x02, 0x03]).subarray(0, 5)])
    const { frames, rest } = parseStreamFrames(buf, false)
    expect(frames).toHaveLength(1)
    expect([...frames[0].payload]).toEqual([0x01])
    expect(rest.length).toBe(5)
  })

  it('returns no frames when fewer than 4 bytes are buffered', () => {
    const buf = Buffer.from([0x00, 0x00])
    const { frames, rest } = parseStreamFrames(buf, false)
    expect(frames).toHaveLength(0)
    expect(rest).toEqual(buf)
  })
})

describe('parseStreamFrames — H.264', () => {
  it('strips the flags byte and marks a keyframe', () => {
    const { frames } = parseStreamFrames(h264Frame([0x67, 0x42, 0x00], true), true)
    expect(frames).toHaveLength(1)
    expect([...frames[0].payload]).toEqual([0x67, 0x42, 0x00])
    expect(frames[0].keyframe).toBe(true)
  })

  it('marks a non-keyframe (flags bit0 clear)', () => {
    const { frames } = parseStreamFrames(h264Frame([0x41, 0x9A], false), true)
    expect([...frames[0].payload]).toEqual([0x41, 0x9A])
    expect(frames[0].keyframe).toBe(false)
  })

  it('parses a keyframe followed by a delta frame', () => {
    const buf = Buffer.concat([h264Frame([0x67], true), h264Frame([0x41], false)])
    const { frames, rest } = parseStreamFrames(buf, true)
    expect(frames.map((f) => f.keyframe)).toEqual([true, false])
    expect(frames.map((f) => [...f.payload])).toEqual([[0x67], [0x41]])
    expect(rest.length).toBe(0)
  })
})
