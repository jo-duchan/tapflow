import type { Socket } from 'net'

const TYPE_INJECT_KEYCODE = 0
const TYPE_INJECT_TOUCH_EVENT = 2

const ACTION_DOWN = 0
const ACTION_UP = 1
const ACTION_MOVE = 2

// Server → client device message types
const DEVICE_MSG_CLIPBOARD = 0
const DEVICE_MSG_ACK_CLIPBOARD = 1
const DEVICE_MSG_ROTATION_NOTIFICATION = 4

export class ScrcpyControl {
  private parseBuf = Buffer.alloc(0)

  constructor(
    private readonly socket: Socket,
    private screenWidth: number,
    private screenHeight: number,
    private readonly onRotation?: (rotation: number) => void,
  ) {
    if (onRotation) {
      socket.on('data', (data: Buffer) => this.handleServerMessage(data))
    }
  }

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

  pinchStart(x1: number, y1: number, x2: number, y2: number): void {
    this.touchDown(0, x1, y1)
    this.touchDown(1, x2, y2)
  }

  pinchMove(x1: number, y1: number, x2: number, y2: number): void {
    this.touchMove(0, x1, y1)
    this.touchMove(1, x2, y2)
  }

  pinchEnd(): void {
    this.touchUp(0)
    this.touchUp(1)
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

  private handleServerMessage(data: Buffer): void {
    this.parseBuf = Buffer.concat([this.parseBuf, data])
    while (this.parseBuf.length > 0) {
      const type = this.parseBuf[0]
      if (type === DEVICE_MSG_ROTATION_NOTIFICATION) {
        // [type(1), rotation(1)] — total 2 bytes
        if (this.parseBuf.length < 2) return
        const rotation = this.parseBuf[1]
        this.parseBuf = Buffer.from(this.parseBuf.subarray(2))
        this.onRotation!(rotation)
      } else if (type === DEVICE_MSG_CLIPBOARD) {
        // [type(1), seq(8), clip_len(4), clip(N)]
        if (this.parseBuf.length < 13) return
        const clipLen = this.parseBuf.readUInt32BE(9)
        if (this.parseBuf.length < 13 + clipLen) return
        this.parseBuf = Buffer.from(this.parseBuf.subarray(13 + clipLen))
      } else if (type === DEVICE_MSG_ACK_CLIPBOARD) {
        // [type(1), seq(8)] — total 9 bytes
        if (this.parseBuf.length < 9) return
        this.parseBuf = Buffer.from(this.parseBuf.subarray(9))
      } else {
        // Unknown type — discard buffer to avoid getting stuck
        this.parseBuf = Buffer.alloc(0)
        return
      }
    }
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
