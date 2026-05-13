import type { Socket } from 'net'

const TYPE_INJECT_KEYCODE = 0
const TYPE_INJECT_TOUCH_EVENT = 2

const ACTION_DOWN = 0
const ACTION_UP = 1
const ACTION_MOVE = 2

export class ScrcpyControl {
  constructor(
    private readonly socket: Socket,
    private readonly screenWidth: number,
    private readonly screenHeight: number,
  ) {}

  touchDown(pointerId: number, x: number, y: number): void {
    this.writeTouchEvent(ACTION_DOWN, pointerId, x, y)
  }

  touchMove(pointerId: number, x: number, y: number): void {
    this.writeTouchEvent(ACTION_MOVE, pointerId, x, y)
  }

  touchUp(pointerId: number): void {
    this.writeTouchEvent(ACTION_UP, pointerId, 0, 0)
  }

  keyEvent(keyCode: number): void {
    const buf = Buffer.allocUnsafe(14)
    buf.writeUInt8(TYPE_INJECT_KEYCODE, 0)
    buf.writeUInt8(0, 1)          // action DOWN
    buf.writeInt32BE(keyCode, 2)  // keyCode
    buf.writeInt32BE(0, 6)        // repeat
    buf.writeInt32BE(0, 10)       // metaState
    this.socket.write(buf)
  }

  private writeTouchEvent(action: number, pointerId: number, x: number, y: number): void {
    const buf = Buffer.allocUnsafe(28)
    buf.writeUInt8(TYPE_INJECT_TOUCH_EVENT, 0)
    buf.writeUInt8(action, 1)
    buf.writeInt32BE(pointerId, 2)
    buf.writeInt32BE(x, 6)
    buf.writeInt32BE(y, 10)
    buf.writeUInt16BE(this.screenWidth, 14)
    buf.writeUInt16BE(this.screenHeight, 16)
    buf.writeUInt16BE(action === ACTION_UP ? 0 : 0xffff, 18) // pressure
    buf.writeUInt32BE(0x1, 22)    // actionButton (BUTTON_PRIMARY)
    buf.writeUInt32BE(0, 24)      // buttons
    this.socket.write(buf)
  }
}
