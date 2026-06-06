import type { Socket } from 'net'

// Device meta header (send_device_meta=true):
//   [0..63]  device name, null-padded (64 bytes)
//   [64..67] codec ID as ASCII ("h264")  (4 bytes)
//   [68..71] width   uint32 BE           (4 bytes)
//   [72..75] height  uint32 BE           (4 bytes)
const HEADER_SIZE = 76
const DEVICE_NAME_SIZE = 64

// Frame meta header (send_frame_meta=true), one per packet:
//   [0..7] pts_flags uint64 BE — bit63 = CONFIG (codec config / SPS+PPS),
//                                bit62 = KEY_FRAME (IDR); low 62 bits = PTS
//   [8..11] packet length uint32 BE
// (Verified against scrcpy v3.3 app/src/demuxer.c: SC_PACKET_HEADER_SIZE 12,
//  SC_PACKET_FLAG_CONFIG=1<<63, SC_PACKET_FLAG_KEY_FRAME=1<<62.)
const PACKET_HEADER_SIZE = 12
const FLAG_CONFIG = 0x80000000 // bit63, tested on the high 32 bits
const FLAG_KEY_FRAME = 0x40000000 // bit62

export interface ScrcpyDeviceInfo {
  deviceName: string
  width: number
  height: number
}

/** One H.264 access unit. Mirrors ios-agent's StreamFrame so the relay's
 *  keyframe-aware backpressure can preserve the reference chain. */
export interface ScrcpyFrame {
  payload: Buffer
  /** True for IDR access units (config packet merged in). */
  keyframe: boolean
}

export class ScrcpyVideo {
  private headerBuf: Buffer | null = null
  private readonly dataFrames: ScrcpyFrame[] = []
  private headerResolve: ((info: ScrcpyDeviceInfo) => void) | null = null
  private headerReject: ((e: Error) => void) | null = null
  private streamController: ReadableStreamDefaultController<ScrcpyFrame> | null = null
  private pending = Buffer.alloc(0)
  // CONFIG packet (SPS+PPS) buffered until the next packet (the IDR) so the keyframe
  // access unit carries its parameter sets — the relay then never forwards an IDR whose
  // config was dropped, and the browser decoder can always (re)initialize.
  private pendingConfig: Buffer | null = null
  private headerConsumed = false
  private endReceived = false
  private streamSettled = false

  constructor(private readonly socket: Socket) {
    socket.on('data', (chunk: Buffer) => this.onData(chunk))
    // 'end' = clean FIN; 'close' = socket torn down without a FIN (e.g. ScrcpySession.stop()
    // → videoSocket.destroy(), or device shutdown). BOTH must terminate the stream, else the
    // agent pump blocks forever on reader.read() and its metrics timer leaks.
    socket.on('end', () => this.finish())
    socket.on('close', () => this.finish())
    socket.on('error', (e) => this.finish(e))
  }

  // Settles the stream exactly once: rejects deviceInfo() if the header never arrived,
  // otherwise closes (or errors) the ReadableStream so the consumer's reader sees `done`.
  // Length-prefixed framing means a partial trailing packet is incomplete → discarded.
  private finish(err?: Error): void {
    if (this.streamSettled) return
    this.streamSettled = true
    this.endReceived = true
    if (!this.headerConsumed) {
      this.headerReject?.(err ?? new Error('scrcpy server connection closed before sending device info'))
      this.headerReject = null
      return
    }
    if (!this.streamController) return // start() will close once it observes endReceived
    if (err) this.streamController.error(err)
    else this.streamController.close()
  }

  deviceInfo(): Promise<ScrcpyDeviceInfo> {
    if (this.headerBuf) return Promise.resolve(this.parseHeader(this.headerBuf))
    return new Promise((resolve, reject) => {
      this.headerResolve = resolve
      this.headerReject = reject
    })
  }

  start(): ReadableStream<ScrcpyFrame> {
    return new ReadableStream<ScrcpyFrame>({
      start: (controller) => {
        this.streamController = controller
        // Flush frames that arrived before start() was called
        for (const frame of this.dataFrames) controller.enqueue(frame)
        this.dataFrames.length = 0
        if (this.endReceived) controller.close()
      },
      cancel: () => {
        this.socket.destroy()
      },
    })
  }

  private onData(chunk: Buffer): void {
    this.pending = Buffer.concat([this.pending, chunk])

    if (!this.headerConsumed) {
      if (this.pending.length < HEADER_SIZE) return
      const header = this.pending.subarray(0, HEADER_SIZE)
      this.pending = this.pending.subarray(HEADER_SIZE)
      this.headerBuf = header
      this.headerConsumed = true
      const info = this.parseHeader(header)
      this.headerResolve?.(info)
      this.headerResolve = null
      this.headerReject = null
    }

    this.drainPackets()
  }

  private drainPackets(): void {
    while (this.pending.length >= PACKET_HEADER_SIZE) {
      const flagsHi = this.pending.readUInt32BE(0) // high 32 bits of pts_flags
      const len = this.pending.readUInt32BE(8)
      if (this.pending.length < PACKET_HEADER_SIZE + len) break // wait for the rest

      const payload = Buffer.from(this.pending.subarray(PACKET_HEADER_SIZE, PACKET_HEADER_SIZE + len))
      this.pending = this.pending.subarray(PACKET_HEADER_SIZE + len)

      if ((flagsHi & FLAG_CONFIG) !== 0) {
        // Hold SPS/PPS until the next (key)frame packet; do not emit alone.
        this.pendingConfig = this.pendingConfig ? Buffer.concat([this.pendingConfig, payload]) : payload
        continue
      }

      const keyframe = (flagsHi & FLAG_KEY_FRAME) !== 0
      let frame = payload
      if (this.pendingConfig) {
        frame = Buffer.concat([this.pendingConfig, payload])
        this.pendingConfig = null
      }
      this.emit({ payload: frame, keyframe })
    }
  }

  private emit(frame: ScrcpyFrame): void {
    if (this.streamController) this.streamController.enqueue(frame)
    else this.dataFrames.push(frame)
  }

  private parseHeader(buf: Buffer): ScrcpyDeviceInfo {
    const deviceName = buf
      .subarray(0, DEVICE_NAME_SIZE)
      .toString('utf8')
      .replace(/\0.*/, '')
    // bytes [64..67] = codec ID ("h264"), skip
    const width = buf.readUInt32BE(68)
    const height = buf.readUInt32BE(72)
    return { deviceName, width, height }
  }
}
