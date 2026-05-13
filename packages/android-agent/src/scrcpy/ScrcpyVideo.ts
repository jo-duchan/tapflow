import type { Socket } from 'net'

// Header layout (send_device_meta=true, send_stream_meta=true default):
//   [0..63]  device name, null-padded (64 bytes)
//   [64..67] codec ID as ASCII ("h264")  (4 bytes)
//   [68..71] width   uint32 BE           (4 bytes)
//   [72..75] height  uint32 BE           (4 bytes)
const HEADER_SIZE = 76
const DEVICE_NAME_SIZE = 64

export interface ScrcpyDeviceInfo {
  deviceName: string
  width: number
  height: number
}

export class ScrcpyVideo {
  private headerBuf: Buffer | null = null
  private readonly dataChunks: Buffer[] = []
  private headerResolve: ((info: ScrcpyDeviceInfo) => void) | null = null
  private headerReject: ((e: Error) => void) | null = null
  private streamController: ReadableStreamDefaultController<Buffer> | null = null
  private pending = Buffer.alloc(0)
  private headerConsumed = false
  private endReceived = false

  constructor(private readonly socket: Socket) {
    socket.on('data', (chunk: Buffer) => this.onData(chunk))
    socket.on('end', () => {
      this.endReceived = true
      if (!this.headerConsumed) {
        this.headerReject?.(new Error('scrcpy server closed before sending device info'))
        this.headerReject = null
        return
      }
      // Flush the last NAL unit (Annex B: last unit has no following start code)
      if (this.pending.length > 0) {
        const last = Buffer.from(this.pending)
        this.pending = Buffer.alloc(0)
        if (this.streamController) {
          this.streamController.enqueue(last)
        } else {
          this.dataChunks.push(last)
        }
      }
      this.streamController?.close()
    })
    socket.on('close', () => {
      if (!this.headerConsumed) {
        this.headerReject?.(new Error('scrcpy server connection closed'))
        this.headerReject = null
      }
    })
    socket.on('error', (e) => {
      this.headerReject?.(e)
      this.headerReject = null
      this.streamController?.error(e)
    })
  }

  deviceInfo(): Promise<ScrcpyDeviceInfo> {
    if (this.headerBuf) return Promise.resolve(this.parseHeader(this.headerBuf))
    return new Promise((resolve, reject) => {
      this.headerResolve = resolve
      this.headerReject = reject
    })
  }

  start(): ReadableStream<Buffer> {
    return new ReadableStream<Buffer>({
      start: (controller) => {
        this.streamController = controller
        // Flush any NAL units that arrived before start() was called
        for (const chunk of this.dataChunks) controller.enqueue(chunk)
        this.dataChunks.length = 0
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

    this.drainNalUnits()
  }

  private drainNalUnits(): void {
    // send_frame_meta=false → raw H.264 Annex B stream (no length prefix)
    const { units, remaining } = extractAnnexBNals(this.pending)
    this.pending = Buffer.from(remaining)
    for (const nal of units) {
      if (this.streamController) {
        this.streamController.enqueue(nal)
      } else {
        this.dataChunks.push(nal)
      }
    }
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

function findStartCode(buf: Buffer, from: number): { pos: number; len: number } | null {
  for (let i = from; i + 2 < buf.length; i++) {
    if (buf[i] === 0 && buf[i + 1] === 0) {
      if (buf[i + 2] === 1) return { pos: i, len: 3 }
      if (i + 3 < buf.length && buf[i + 2] === 0 && buf[i + 3] === 1) return { pos: i, len: 4 }
    }
  }
  return null
}

function extractAnnexBNals(buf: Buffer): { units: Buffer[]; remaining: Buffer } {
  const units: Buffer[] = []
  const first = findStartCode(buf, 0)
  if (!first) return { units, remaining: buf }
  let nalStart = first.pos
  let searchFrom = first.pos + first.len
  while (true) {
    const next = findStartCode(buf, searchFrom)
    if (!next) break
    units.push(Buffer.from(buf.subarray(nalStart, next.pos)))
    nalStart = next.pos
    searchFrom = next.pos + next.len
  }
  return { units, remaining: buf.subarray(nalStart) }
}
