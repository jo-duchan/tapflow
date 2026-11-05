import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ScrcpyControl } from '../scrcpy/ScrcpyControl'
import { createServer, connect, type Socket } from 'net'
import { once } from 'events'

function mockSocket(): Socket {
  return { write: vi.fn(), writable: true } as unknown as Socket
}

describe('ScrcpyControl', () => {
  let socket: Socket
  let ctrl: ScrcpyControl

  beforeEach(() => {
    socket = mockSocket()
    ctrl = new ScrcpyControl(socket, 1080, 2400)
  })

  // scrcpy 3.x INJECT_TOUCH_EVENT layout (32 bytes):
  // [0] type(1) [1] action(1) [2..9] pointerId(long,8) [10..13] x(4) [14..17] y(4)
  // [18..19] screenW(2) [20..21] screenH(2) [22..23] pressure(2) [24..27] actionButton(4) [28..31] buttons(4)
  describe('touchDown', () => {
    it('writes 32-byte TYPE_INJECT_TOUCH_EVENT with action=DOWN', () => {
      ctrl.touchDown(0, 100, 200)
      expect(socket.write).toHaveBeenCalledOnce()
      const buf: Buffer = (socket.write as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(buf.length).toBe(32)
      expect(buf.readUInt8(0)).toBe(2)              // TYPE_INJECT_TOUCH_EVENT
      expect(buf.readUInt8(1)).toBe(0)              // action DOWN
      expect(buf.readBigInt64BE(2)).toBe(0n)        // pointerId (long)
      expect(buf.readInt32BE(10)).toBe(100)          // x
      expect(buf.readInt32BE(14)).toBe(200)          // y
      expect(buf.readUInt16BE(18)).toBe(1080)        // screenWidth
      expect(buf.readUInt16BE(20)).toBe(2400)        // screenHeight
      expect(buf.readUInt16BE(22)).toBe(0xffff)      // pressure (down = max)
      expect(buf.readInt32BE(24)).toBe(0x1)          // actionButton PRIMARY
      expect(buf.readInt32BE(28)).toBe(0)            // buttons
    })
  })

  describe('touchMove', () => {
    it('writes action=MOVE (2) with correct offsets', () => {
      ctrl.touchMove(0, 300, 400)
      const buf: Buffer = (socket.write as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(buf.readUInt8(1)).toBe(2)   // action MOVE
      expect(buf.readInt32BE(10)).toBe(300)
      expect(buf.readInt32BE(14)).toBe(400)
    })
  })

  describe('touchUp', () => {
    it('writes action=UP (1) with zero pressure', () => {
      ctrl.touchUp(0)
      const buf: Buffer = (socket.write as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(buf.readUInt8(1)).toBe(1)          // action UP
      expect(buf.readUInt16BE(22)).toBe(0)       // pressure = 0 on UP
    })
  })

  // CANCEL (3), then UP: the server forgets a pointer only on an up, and one it kept turns the next touch into a
  // second pointer (#1115). Both carry no pressure.
  describe('touchCancel', () => {
    it('writes CANCEL then UP for the pointer, at the point given, with zero pressure', () => {
      ctrl.touchCancel(0, 270, 1800)
      const bufs: Buffer[] = (socket.write as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as Buffer)
      expect(bufs.map((b) => b.readUInt8(1))).toEqual([3, 1])
      for (const b of bufs) {
        expect(b.readBigInt64BE(2)).toBe(0n)
        expect(b.readInt32BE(10)).toBe(270)
        expect(b.readInt32BE(14)).toBe(1800)
        expect(b.readUInt16BE(22)).toBe(0)
      }
    })
  })

  describe('pinchStart', () => {
    it('sends touchDown for pointerId 0 then pointerId 1', () => {
      ctrl.pinchStart(100, 200, 300, 400)
      expect(socket.write).toHaveBeenCalledTimes(2)
      const buf0: Buffer = (socket.write as ReturnType<typeof vi.fn>).mock.calls[0][0]
      const buf1: Buffer = (socket.write as ReturnType<typeof vi.fn>).mock.calls[1][0]
      expect(buf0.readUInt8(1)).toBe(0)           // action DOWN
      expect(buf0.readBigInt64BE(2)).toBe(0n)     // pointerId 0
      expect(buf0.readInt32BE(10)).toBe(100)
      expect(buf0.readInt32BE(14)).toBe(200)
      expect(buf1.readUInt8(1)).toBe(0)           // action DOWN
      expect(buf1.readBigInt64BE(2)).toBe(1n)     // pointerId 1
      expect(buf1.readInt32BE(10)).toBe(300)
      expect(buf1.readInt32BE(14)).toBe(400)
    })
  })

  describe('pinchMove', () => {
    it('sends touchMove for pointerId 0 then pointerId 1', () => {
      ctrl.pinchMove(110, 210, 310, 410)
      expect(socket.write).toHaveBeenCalledTimes(2)
      const buf0: Buffer = (socket.write as ReturnType<typeof vi.fn>).mock.calls[0][0]
      const buf1: Buffer = (socket.write as ReturnType<typeof vi.fn>).mock.calls[1][0]
      expect(buf0.readUInt8(1)).toBe(2)           // action MOVE
      expect(buf0.readBigInt64BE(2)).toBe(0n)
      expect(buf0.readInt32BE(10)).toBe(110)
      expect(buf1.readUInt8(1)).toBe(2)
      expect(buf1.readBigInt64BE(2)).toBe(1n)
      expect(buf1.readInt32BE(10)).toBe(310)
    })
  })

  describe('pinchEnd', () => {
    it('sends touchUp for pointerId 0 then pointerId 1 with zero pressure', () => {
      ctrl.pinchEnd()
      expect(socket.write).toHaveBeenCalledTimes(2)
      const buf0: Buffer = (socket.write as ReturnType<typeof vi.fn>).mock.calls[0][0]
      const buf1: Buffer = (socket.write as ReturnType<typeof vi.fn>).mock.calls[1][0]
      expect(buf0.readUInt8(1)).toBe(1)           // action UP
      expect(buf0.readBigInt64BE(2)).toBe(0n)
      expect(buf0.readUInt16BE(22)).toBe(0)       // pressure = 0
      expect(buf1.readUInt8(1)).toBe(1)
      expect(buf1.readBigInt64BE(2)).toBe(1n)
      expect(buf1.readUInt16BE(22)).toBe(0)
    })
  })

  describe('keyEvent', () => {
    it('writes TYPE_INJECT_KEYCODE with given keyCode', () => {
      ctrl.keyEvent(4) // BACK
      const buf: Buffer = (socket.write as ReturnType<typeof vi.fn>).mock.calls[0][0]
      // TYPE_INJECT_KEYCODE = 0
      expect(buf.readUInt8(0)).toBe(0)
      // action=0 (down), keyCode=4
      expect(buf.readInt32BE(2)).toBe(4)
    })
  })

  describe('resetVideo', () => {
    it('writes the single-byte TYPE_RESET_VIDEO control message', () => {
      // scrcpy v3.3 control_msg.c: RESET_VIDEO (type 17) serializes to 1 byte, no payload.
      ctrl.resetVideo()
      expect(socket.write).toHaveBeenCalledOnce()
      const buf: Buffer = (socket.write as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(buf.length).toBe(1)
      expect(buf.readUInt8(0)).toBe(17)
    })
  })
})

// `socket.write()` never throws for a dead peer, so `writable` is the only signal this backend has
// for whether an input can still reach the device. Everything else about it is a fake, so this is
// the one place the claim is settled against a real socket rather than a stub.
describe('ScrcpyControl.isReady() against a real socket', () => {
  it('is true while the peer is connected and false once it goes away', async () => {
    const server = createServer()
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const { port } = server.address() as { port: number }

    const client = connect(port, '127.0.0.1')
    const [peer] = await Promise.all([once(server, 'connection').then(([s]) => s as Socket), once(client, 'connect')])
    const ctrl = new ScrcpyControl(client, 1080, 2400)

    expect(ctrl.isReady()).toBe(true)

    // Waiting for 'close' means this pins "a peer that went away makes it false", not the FIN
    // half-close mechanism specifically — by then the socket is destroyed, which is sufficient on
    // its own. The edge-triggered, one-turn-late property is documented in AGENTS.md and is not
    // exercised here.
    //
    // `client.on('error')` before the wait, not `once(client, 'close')` alone: `events.once`
    // attaches its own error listener and REJECTS on it, and a destroy against a peer holding
    // unread data sends RST, so ECONNRESET can beat 'close'. Measured 38/40 rejections when the
    // client had written first. This test does not write, which is the only reason it passes
    // without the guard — one added write away from flaking.
    client.on('error', () => { /* ECONNRESET is the point of this test, not a failure */ })
    peer.destroy()
    await once(client, 'close')

    expect(ctrl.isReady()).toBe(false)

    client.destroy()
    server.close()
    await once(server, 'close')
  })

  it('is false after our own end destroys the socket', async () => {
    const server = createServer()
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const { port } = server.address() as { port: number }

    const client = connect(port, '127.0.0.1')
    await once(client, 'connect')
    const ctrl = new ScrcpyControl(client, 1080, 2400)
    client.on('error', () => { /* see above */ })

    client.destroy()

    expect(ctrl.isReady()).toBe(false)

    server.close()
    await once(server, 'close')
  })
})
