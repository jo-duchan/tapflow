import { describe, it, expect, vi } from 'vitest'
import { EmulatorGrpcClient, type RawEmulatorController } from '../emulator/EmulatorGrpcClient'

// A fake server-stream: async-iterable over the given messages, with a spyable cancel().
function fakeCall(messages: unknown[]) {
  const cancel = vi.fn()
  return {
    cancel,
    async *[Symbol.asyncIterator]() {
      for (const m of messages) yield m
    },
  }
}

function img(image: Buffer, width: number, height: number, rotation = 'PORTRAIT', seq = 0) {
  return { image, seq, format: { rotation: { rotation }, width, height } }
}

function pkt(audio: Buffer, timestamp: string) {
  return { format: { samplingRate: '44100', channels: 'Stereo', format: 'AUD_FMT_S16', mode: 'MODE_REAL_TIME' }, timestamp, audio }
}

function makeRaw(overrides: Partial<RawEmulatorController> = {}): RawEmulatorController {
  return {
    streamScreenshot: vi.fn(),
    streamAudio: vi.fn(),
    sendTouch: vi.fn((_e, cb) => cb(null)),
    sendKey: vi.fn((_e, cb) => cb(null)),
    sendMouse: vi.fn((_e, cb) => cb(null)),
    sendWheel: vi.fn((_e, cb) => cb(null)),
    close: vi.fn(),
    ...overrides,
  } as RawEmulatorController
}

describe('EmulatorGrpcClient', () => {
  it('loads the vendored proto and builds a real client without a live server', () => {
    // grpc-js connects lazily, so construction must not throw — validates PROTO_PATH + pkg shape.
    expect(() => new EmulatorGrpcClient('127.0.0.1:1')).not.toThrow()
  })

  it('requests RGBA8888 with server-side resize and maps frames, skipping empties', async () => {
    const px = Buffer.alloc(720 * 1280 * 4)
    const call = fakeCall([
      img(Buffer.alloc(0), 0, 0),        // display-inactive empty — must be skipped
      img(px, 720, 1280, 'PORTRAIT', 5),
      img(px, 1280, 720, 'LANDSCAPE', 8),
    ])
    const streamScreenshot = vi.fn(() => call)
    const client = new EmulatorGrpcClient('x', makeRaw({ streamScreenshot: streamScreenshot as never }))

    const { frames } = client.streamScreenshot({ width: 720, height: 1280 })
    const out = []
    for await (const f of frames) out.push(f)

    expect(streamScreenshot).toHaveBeenCalledWith({ format: 'RGBA8888', width: 720, height: 1280, display: 0 })
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ width: 720, height: 1280, rotation: 'PORTRAIT', seq: 5 })
    expect(out[1]).toMatchObject({ width: 1280, height: 720, rotation: 'LANDSCAPE', seq: 8 })
    expect(out[0].image).toBe(px)
  })

  it('defaults to native resolution (0×0) when no size given', () => {
    const streamScreenshot = vi.fn(() => fakeCall([]))
    const client = new EmulatorGrpcClient('x', makeRaw({ streamScreenshot: streamScreenshot as never }))
    client.streamScreenshot()
    expect(streamScreenshot).toHaveBeenCalledWith({ format: 'RGBA8888', width: 0, height: 0, display: 0 })
  })

  it('cancel() cancels the underlying call', () => {
    const call = fakeCall([])
    const client = new EmulatorGrpcClient('x', makeRaw({ streamScreenshot: (() => call) as never }))
    const stream = client.streamScreenshot()
    stream.cancel()
    expect(call.cancel).toHaveBeenCalledOnce()
  })

  it('requests S16/44100/Stereo real-time audio, maps packets, skips empty, converts us timestamp', async () => {
    const a = Buffer.from([1, 2, 3, 4])
    const b = Buffer.from([5, 6, 7, 8])
    const call = fakeCall([
      pkt(Buffer.alloc(0), '1000'),  // empty packet — must be skipped
      pkt(a, '2000'),
      pkt(b, '3000'),
    ])
    const streamAudio = vi.fn(() => call)
    const client = new EmulatorGrpcClient('x', makeRaw({ streamAudio: streamAudio as never }))

    const { frames } = client.streamAudio()
    const out = []
    for await (const f of frames) out.push(f)

    expect(streamAudio).toHaveBeenCalledWith({
      samplingRate: 44100, channels: 'Stereo', format: 'AUD_FMT_S16', mode: 'MODE_REAL_TIME',
    })
    expect(out).toHaveLength(2)
    expect(out[0]).toEqual({ audio: a, timestamp: 2000 })
    expect(out[1]).toEqual({ audio: b, timestamp: 3000 })
  })

  it('streamAudio cancel() cancels the underlying call', () => {
    const call = fakeCall([])
    const client = new EmulatorGrpcClient('x', makeRaw({ streamAudio: (() => call) as never }))
    const stream = client.streamAudio()
    stream.cancel()
    expect(call.cancel).toHaveBeenCalledOnce()
  })

  it('touchDown/Move send pressure>0, touchUp sends pressure 0 to close the slot', async () => {
    const sendTouch = vi.fn((_e: unknown, cb: (e: Error | null) => void) => cb(null))
    const client = new EmulatorGrpcClient('x', makeRaw({ sendTouch: sendTouch as never }))

    await client.touchDown(0, 100, 200)
    await client.touchMove(0, 110, 210)
    await client.touchUp(0, 110, 210)

    expect(sendTouch.mock.calls[0][0]).toEqual({ touches: [{ x: 100, y: 200, identifier: 0, pressure: 1 }], display: 0 })
    expect(sendTouch.mock.calls[1][0]).toEqual({ touches: [{ x: 110, y: 210, identifier: 0, pressure: 1 }], display: 0 })
    expect(sendTouch.mock.calls[2][0]).toEqual({ touches: [{ x: 110, y: 210, identifier: 0, pressure: 0 }], display: 0 })
  })

  it('pinch sends two distinct identifiers, released on pinchEnd', async () => {
    const sendTouch = vi.fn((_e: unknown, cb: (e: Error | null) => void) => cb(null))
    const client = new EmulatorGrpcClient('x', makeRaw({ sendTouch: sendTouch as never }))

    await client.pinchStart(10, 20, 30, 40)
    await client.pinchEnd()

    expect(sendTouch.mock.calls[0][0]).toEqual({
      touches: [
        { x: 10, y: 20, identifier: 0, pressure: 1 },
        { x: 30, y: 40, identifier: 1, pressure: 1 },
      ],
      display: 0,
    })
    const end = sendTouch.mock.calls[1][0] as { touches: Array<{ identifier: number; pressure: number }> }
    expect(end.touches.map((t) => t.pressure)).toEqual([0, 0])
    expect(end.touches.map((t) => t.identifier)).toEqual([0, 1])
  })

  it('rejects when a touch RPC errors', async () => {
    const boom = new Error('grpc down')
    const client = new EmulatorGrpcClient('x', makeRaw({
      sendTouch: ((_e: unknown, cb: (e: Error | null) => void) => cb(boom)) as never,
    }))
    await expect(client.touchDown(0, 1, 2)).rejects.toThrow('grpc down')
  })
})
