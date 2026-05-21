import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ScrcpyControl } from '../scrcpy/ScrcpyControl'
import type { Socket } from 'net'

function mockSocket(): Socket {
  return { write: vi.fn() } as unknown as Socket
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
})
