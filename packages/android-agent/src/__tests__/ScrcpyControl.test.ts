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

  describe('touchDown', () => {
    it('writes 28-byte TYPE_INJECT_TOUCH_EVENT with action=DOWN', () => {
      ctrl.touchDown(0, 100, 200)
      expect(socket.write).toHaveBeenCalledOnce()
      const buf: Buffer = (socket.write as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(buf.length).toBe(28)
      expect(buf.readUInt8(0)).toBe(2)   // TYPE_INJECT_TOUCH_EVENT
      expect(buf.readUInt8(1)).toBe(0)   // action DOWN
      expect(buf.readInt32BE(2)).toBe(0) // pointerId
      expect(buf.readInt32BE(6)).toBe(100) // x
      expect(buf.readInt32BE(10)).toBe(200) // y
      expect(buf.readUInt16BE(14)).toBe(1080) // screenWidth
      expect(buf.readUInt16BE(16)).toBe(2400) // screenHeight
    })
  })

  describe('touchMove', () => {
    it('writes action=MOVE (2)', () => {
      ctrl.touchMove(0, 300, 400)
      const buf: Buffer = (socket.write as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(buf.readUInt8(1)).toBe(2) // action MOVE
      expect(buf.readInt32BE(6)).toBe(300)
      expect(buf.readInt32BE(10)).toBe(400)
    })
  })

  describe('touchUp', () => {
    it('writes action=UP (1)', () => {
      ctrl.touchUp(0)
      const buf: Buffer = (socket.write as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(buf.readUInt8(1)).toBe(1) // action UP
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
