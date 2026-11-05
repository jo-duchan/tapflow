import type { Socket } from 'net'

const TYPE_INJECT_KEYCODE = 0
const TYPE_INJECT_TOUCH_EVENT = 2
const TYPE_RESET_VIDEO = 17

const ACTION_DOWN = 0
const ACTION_UP = 1
const ACTION_MOVE = 2
const ACTION_CANCEL = 3

export class ScrcpyControl {
  constructor(
    private readonly socket: Socket,
    private screenWidth: number,
    private screenHeight: number,
  ) {}

  /**
   * Whether a write now reaches the device — as far as anything local can tell.
   *
   * `socket.write()` does **not** throw for a dead peer (it reports asynchronously, via the write
   * callback or `'error'`), so there is no result to inspect and this flag is the only signal this
   * backend has. It is a **local-end** flag, not a liveness probe: it goes false after our own
   * destroy, after a FIN (`allowHalfOpen` defaults false, so node ends the writable side for us),
   * or after an error has already been observed — which means it is edge-triggered and one turn
   * late, so the first input after a silent death still reads `true`. It cannot see a live socket
   * whose guest has stopped consuming at all; those bytes queue and look delivered. The ack this
   * feeds promises delivery, not landing, so that is consistent — but do not read more into it.
   *
   * A pure query on purpose: the writes below stay ungated so `AndroidAgent` owns the decision in
   * one place, next to the ack it has to send.
   */
  isReady(): boolean {
    return this.socket.writable
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

  /**
   * Cancel the touch (#1115), then release it: the server forgets a pointer only on an up, and one left in its state
   * turns the next touch into a second pointer. Android drops that up as inconsistent once the cancel has landed.
   */
  touchCancel(pointerId: number, x = 0, y = 0): void {
    this.writeTouchEvent(ACTION_CANCEL, pointerId, x, y)
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

  // Forces the scrcpy server to reset the video encoder, which re-emits codec config
  // (SPS/PPS) + a keyframe (IDR). Used for relay drop-to-keyframe recovery so the stream
  // resyncs fast instead of waiting for the periodic IDR. (scrcpy v3.3: 1-byte message.)
  resetVideo(): void {
    this.socket.write(Buffer.from([TYPE_RESET_VIDEO]))
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
    buf.writeUInt16BE(action === ACTION_UP || action === ACTION_CANCEL ? 0 : 0xffff, 22) // pressure
    buf.writeInt32BE(0x1, 24)    // actionButton (BUTTON_PRIMARY)
    buf.writeInt32BE(0, 28)      // buttons
    this.socket.write(buf)
  }
}
