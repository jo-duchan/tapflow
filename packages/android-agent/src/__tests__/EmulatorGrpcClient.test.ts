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

// No `as RawEmulatorController`: the cast used to hide missing members. That annotation is now
// checked — #422 gave this tree a `tsconfig.json`, so a double short of a member is a compile error
// rather than something only an editor mentions. The runtime completeness check below predates that
// and is kept: it catches a member added to the interface that this file satisfies structurally by
// accident, which the compiler is happy with.
function makeRaw(overrides: Partial<RawEmulatorController> = {}): RawEmulatorController {
  const base: RawEmulatorController = {
    streamScreenshot: vi.fn() as unknown as RawEmulatorController['streamScreenshot'],
    streamAudio: vi.fn() as unknown as RawEmulatorController['streamAudio'],
    sendTouch: vi.fn((_e, _o, cb) => cb(null)),
    streamInputEvent: vi.fn((_o, cb) => ({ write: vi.fn(), end: vi.fn(() => cb(null)) })) as unknown as RawEmulatorController['streamInputEvent'],
    sendKey: vi.fn((_e, _o, cb) => cb(null)),
    sendMouse: vi.fn((_e, cb) => cb(null)),
    sendWheel: vi.fn((_e, cb) => cb(null)),
    getClipboard: vi.fn((_e, _o, cb) => cb(null, { text: '' })),
    setClipboard: vi.fn((_c, _o, cb) => cb(null)),
    getDisplayConfigurations: vi.fn((_e, _o, cb) => cb(null, { displays: [{ width: 1080, height: 2400, display: 0 }] })),
    close: vi.fn(),
  }
  return { ...base, ...overrides }
}

describe('getDisplaySize — the divisor for injected touch pixels', () => {
  const call = (res: unknown, err: Error | null = null) => new EmulatorGrpcClient('x', makeRaw({
    getDisplayConfigurations: vi.fn((_e, _o, cb) => cb(err, res as never)),
  }))

  it('answers display 0, which is what the emulator divides by', async () => {
    // Deliberately not `displays[0]`: the array's order is not part of the contract, and the id
    // is — "the primary (default) display has the display ID of 0".
    await expect(call({ displays: [
      { width: 1920, height: 1080, display: 2 },
      { width: 2076, height: 2152, display: 0 },
    ] }).getDisplaySize()).resolves.toEqual({ width: 2076, height: 2152 })
  })

  it('takes the only display when none is numbered 0', async () => {
    await expect(call({ displays: [{ width: 1080, height: 2400 }] }).getDisplaySize())
      .resolves.toEqual({ width: 1080, height: 2400 })
  })

  it('answers null rather than a zero that would send every tap to the corner', async () => {
    await expect(call({ displays: [{ width: 0, height: 2152, display: 0 }] }).getDisplaySize()).resolves.toBeNull()
    await expect(call({ displays: [] }).getDisplaySize()).resolves.toBeNull()
    await expect(call(undefined).getDisplaySize()).resolves.toBeNull()
  })

  it('answers null on an RPC error instead of rejecting into the boot path', async () => {
    // An emulator too old to know this call must still boot; the panel size is the fallback and
    // it is what every release before this one used.
    await expect(call(null, new Error('12 UNIMPLEMENTED')).getDisplaySize()).resolves.toBeNull()
  })
})

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
    const sendTouch = vi.fn((_e: unknown, _o: unknown, cb: (e: Error | null) => void) => cb(null))
    const client = new EmulatorGrpcClient('x', makeRaw({ sendTouch: sendTouch as never }))

    await client.touchDown(0, 100, 200)
    await client.touchMove(0, 110, 210)
    await client.touchUp(0, 110, 210)

    expect(sendTouch.mock.calls[0][0]).toEqual({ touches: [{ x: 100, y: 200, identifier: 0, pressure: 1 }], display: 0 })
    expect(sendTouch.mock.calls[1][0]).toEqual({ touches: [{ x: 110, y: 210, identifier: 0, pressure: 1 }], display: 0 })
    expect(sendTouch.mock.calls[2][0]).toEqual({ touches: [{ x: 110, y: 210, identifier: 0, pressure: 0 }], display: 0 })
  })

  it('pinch sends two distinct identifiers, released on pinchEnd', async () => {
    const sendTouch = vi.fn((_e: unknown, _o: unknown, cb: (e: Error | null) => void) => cb(null))
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
      sendTouch: ((_e: unknown, _o: unknown, cb: (e: Error | null) => void) => cb(boom)) as never,
    }))
    await expect(client.touchDown(0, 1, 2)).rejects.toThrow('grpc down')
  })
})

// The clipboard calls run inside a per-device critical section on the agent, so one that never
// settles would wedge every later copy/paste on that device. The deadline is what prevents it,
// and it has to reach grpc-js as a CALL OPTION — passing it as a message field would typecheck
// and do nothing.
describe('clipboard', () => {
  // Belt and braces for the exclude above: if the client gains a call the double lacks, this
  // fails at runtime instead of surfacing as an opaque "not a function" inside another test.
  it('the double implements every member of the stub interface', () => {
    const raw = makeRaw() as unknown as Record<string, unknown>
    for (const m of ['streamScreenshot', 'streamAudio', 'sendTouch', 'sendKey', 'sendMouse',
      'sendWheel', 'getClipboard', 'setClipboard', 'close']) {
      expect(typeof raw[m]).toBe('function')
    }
  })

  it('reads the guest clipboard', async () => {
    const getClipboard = vi.fn((_e: unknown, _o: unknown, cb: (e: Error | null, r?: { text: string }) => void) =>
      cb(null, { text: 'from the guest' }))
    const client = new EmulatorGrpcClient('x', makeRaw({ getClipboard }))
    await expect(client.getClipboard()).resolves.toBe('from the guest')
  })

  it('coalesces a missing text field to an empty string', async () => {
    const getClipboard = vi.fn((_e: unknown, _o: unknown, cb: (e: Error | null, r?: { text: string }) => void) =>
      cb(null, undefined))
    const client = new EmulatorGrpcClient('x', makeRaw({ getClipboard }))
    await expect(client.getClipboard()).resolves.toBe('')
  })

  it('writes the guest clipboard', async () => {
    const setClipboard = vi.fn((_c: unknown, _o: unknown, cb: (e: Error | null) => void) => cb(null))
    const client = new EmulatorGrpcClient('x', makeRaw({ setClipboard }))
    await client.setClipboard('한글 🎉')
    expect(setClipboard.mock.calls[0][0]).toEqual({ text: '한글 🎉' })
  })

  it('passes a deadline as a call option on both calls', async () => {
    const getClipboard = vi.fn((_e: unknown, _o: unknown, cb: (e: Error | null, r?: { text: string }) => void) =>
      cb(null, { text: '' }))
    const setClipboard = vi.fn((_c: unknown, _o: unknown, cb: (e: Error | null) => void) => cb(null))
    const client = new EmulatorGrpcClient('x', makeRaw({ getClipboard, setClipboard }))

    const before = Date.now()
    await client.getClipboard()
    await client.setClipboard('x')

    for (const call of [getClipboard.mock.calls[0], setClipboard.mock.calls[0]]) {
      // second position, not folded into the message — that is what grpc-js reads
      const opts = call[1] as { deadline?: number }
      expect(opts?.deadline).toBeGreaterThan(before)
    }
  })

  it('rejects with the gRPC error rather than swallowing it', async () => {
    const getClipboard = vi.fn((_e: unknown, _o: unknown, cb: (e: Error | null) => void) =>
      cb(new Error('14 UNAVAILABLE: no connection')))
    const client = new EmulatorGrpcClient('x', makeRaw({ getClipboard }))
    await expect(client.getClipboard()).rejects.toThrow(/UNAVAILABLE/)
  })
})

describe('EmulatorGrpcClient — input readiness and deadline', () => {
  it('stops reporting ready once closed, so no RPC is fired at a dead client', () => {
    const client = new EmulatorGrpcClient('x', makeRaw())
    expect(client.isReady()).toBe(true)
    client.close()
    expect(client.isReady()).toBe(false)
  })

  it('carries a deadline on input RPCs — unlike scrcpy, this backend can be genuinely cancelled', async () => {
    const sendTouch = vi.fn((_e: unknown, _o: unknown, cb: (e: Error | null) => void) => cb(null))
    const sendKey = vi.fn((_e: unknown, _o: unknown, cb: (e: Error | null) => void) => cb(null))
    const client = new EmulatorGrpcClient('x', makeRaw({ sendTouch: sendTouch as never, sendKey: sendKey as never }))

    await client.touchDown(0, 1, 2)
    await client.sendKey({ key: 'a' })

    // A deadline is what makes answering failure safe to retry: the emulator did not get it.
    for (const spy of [sendTouch, sendKey]) {
      const opts = spy.mock.calls[0][1] as { deadline?: number }
      expect(typeof opts.deadline).toBe('number')
      expect(opts.deadline! - Date.now()).toBeGreaterThan(0)
      // Under the window the MCP client waits before falling back to optimistic success.
      expect(opts.deadline! - Date.now()).toBeLessThan(2_000)
    }
  })

  describe('touch order', () => {
    // Callbacks held back so the test decides when the emulator answers each call.
    function pending() {
      const calls: Array<{ event: { touches: Array<{ pressure: number }> }; cb: (e: Error | null) => void }> = []
      const sendTouch = vi.fn((event: never, _o: unknown, cb: (e: Error | null) => void) => { calls.push({ event, cb }) })
      return { calls, client: new EmulatorGrpcClient('x', makeRaw({ sendTouch: sendTouch as never })) }
    }
    const flush = () => new Promise((r) => setTimeout(r, 0))

    it('sends a touch only after the one before it has been answered', async () => {
      const { calls, client } = pending()
      const down = client.touchDown(0, 10, 10)
      const up = client.touchUp(0, 10, 10)
      await flush()
      expect(calls.map((c) => c.event.touches[0]!.pressure)).toEqual([1])
      calls[0]!.cb(null)
      await down
      await flush()
      expect(calls.map((c) => c.event.touches[0]!.pressure)).toEqual([1, 0])
      calls[1]!.cb(null)
      await expect(up).resolves.toBeUndefined()
    })

    it('still sends the up when the down failed, and reports each on its own', async () => {
      const { calls, client } = pending()
      const down = client.touchDown(0, 10, 10)
      const up = client.touchUp(0, 10, 10)
      await flush()
      calls[0]!.cb(new Error('DEADLINE_EXCEEDED'))
      await expect(down).rejects.toThrow('DEADLINE_EXCEEDED')
      await flush()
      expect(calls).toHaveLength(2)
      calls[1]!.cb(null)
      await expect(up).resolves.toBeUndefined()
    })
  })
})

// A cancel marks the slot a palm (Android's input reader then cancels the touch), releases it and puts the slot back to
// a finger, as one unit on the touch queue (#1115). Measured on a Pixel 6 (Android 14).
describe('touchCancel', () => {
  function recording(opts: { palmFails?: boolean; restoreFails?: boolean } = {}) {
    const log: string[] = []
    let streams = 0
    const raw = makeRaw({
      sendTouch: vi.fn((e: { touches: Array<{ pressure: number }> }, _o, cb) => { log.push(e.touches[0]!.pressure ? 'down' : 'up'); cb(null) }) as never,
      streamInputEvent: vi.fn((_o, cb) => {
        const n = streams++
        const events: number[][] = []
        return {
          write: (m: { android_event: { type: number; code: number; value: number } }) => { events.push([m.android_event.type, m.android_event.code, m.android_event.value]) },
          end: () => {
            const tool = events.find(([t, c]) => t === 3 && c === 0x37)?.[2]
            log.push(tool === 2 ? 'palm' : 'finger')
            const fail = tool === 2 ? opts.palmFails : opts.restoreFails && n <= 1
            cb(fail ? new Error('UNIMPLEMENTED') : null)
          },
        }
      }) as never,
    })
    return { client: new EmulatorGrpcClient('x', raw), log }
  }

  it('palms the slot, releases it, then puts it back to a finger, in that order', async () => {
    const { client, log } = recording()
    await client.touchDown(0, 10, 10)
    await client.touchCancel(0, 10, 10)
    expect(log).toEqual(['down', 'palm', 'up', 'finger'])
  })

  // The release is what keeps a touch from being left down, so it does not depend on the palm.
  // Nor is the slot put back or marked then: the palm never reached it, and every later press would pay for it.
  it('still releases the touch when the palm is refused', async () => {
    const { client, log } = recording({ palmFails: true })
    await client.touchCancel(0, 10, 10)
    await client.touchDown(0, 10, 10)
    expect(log).toEqual(['palm', 'up', 'down'])
  })

  // A slot left a palm would cancel every later touch on it while each was acked delivered.
  it('puts the slot back before the next press when putting it back failed', async () => {
    const { client, log } = recording({ restoreFails: true })
    await client.touchCancel(0, 10, 10)
    await client.touchDown(0, 10, 10)
    await client.touchDown(0, 10, 10)
    expect(log).toEqual(['palm', 'up', 'finger', 'finger', 'down', 'down'])
  })

  // The check happens in the press's own queued step: a press made while the cancel is still queued must see its
  // put-back fail, not the state at the moment it was called.
  it('puts the slot back for a press queued behind the cancel, and for a pinch', async () => {
    const queued = recording({ restoreFails: true })
    const cancel = queued.client.touchCancel(0, 10, 10)
    const press = queued.client.touchDown(0, 10, 10)
    await Promise.all([cancel, press])
    expect(queued.log).toEqual(['palm', 'up', 'finger', 'finger', 'down'])

    const pinch = recording({ restoreFails: true })
    await pinch.client.touchCancel(0, 10, 10)
    await pinch.client.pinchStart(10, 10, 20, 20)
    expect(pinch.log).toEqual(['palm', 'up', 'finger', 'finger', 'down'])
  })
})
