import type { Socket } from 'net'

const TYPE_INJECT_KEYCODE = 0
const TYPE_INJECT_TOUCH_EVENT = 2
const TYPE_ROTATE_DEVICE = 11

const ACTION_DOWN = 0
const ACTION_UP = 1
const ACTION_MOVE = 2

export class ScrcpyControl {
  constructor(
    private readonly socket: Socket,
    private screenWidth: number,
    private screenHeight: number,
  ) {}

  updateScreenSize(width: number, height: number): void {
    this.screenWidth = width
    this.screenHeight = height
  }

  touchDown(pointerId: number, x: number, y: number): void {
    this.writeTouchEvent(ACTION_DOWN, pointerId, x, y)
  }

  touchMove(pointerId: number, x: number, y: number): void {
    this.writeTouchEvent(ACTION_MOVE, pointerId, x, y)
  }

  touchUp(pointerId: number, x = 0, y = 0): void {
    this.writeTouchEvent(ACTION_UP, pointerId, x, y)
  }

  rotateDevice(): void {
    const buf = Buffer.allocUnsafe(1)
    buf.writeUInt8(TYPE_ROTATE_DEVICE, 0)
    this.socket.write(buf)
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
    // scrcpy 3.x INJECT_TOUCH_EVENT layout (32 bytes total):
    // [0] type [1] action [2..9] pointerId(long) [10..13] x [14..17] y
    // [18..19] screenW [20..21] screenH [22..23] pressure [24..27] actionButton [28..31] buttons
    const buf = Buffer.allocUnsafe(32)
    buf.writeUInt8(TYPE_INJECT_TOUCH_EVENT, 0)
    buf.writeUInt8(action, 1)
    buf.writeBigInt64BE(BigInt(pointerId), 2)
    buf.writeInt32BE(x, 10)
    buf.writeInt32BE(y, 14)
    buf.writeUInt16BE(this.screenWidth, 18)
    buf.writeUInt16BE(this.screenHeight, 20)
    buf.writeUInt16BE(action === ACTION_UP ? 0 : 0xffff, 22) // pressure
    buf.writeInt32BE(0x1, 24)    // actionButton (BUTTON_PRIMARY)
    buf.writeInt32BE(0, 28)      // buttons
    this.socket.write(buf)
  }
}
