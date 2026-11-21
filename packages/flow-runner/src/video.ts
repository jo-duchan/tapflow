import { CODEC_AUDIO, CODEC_H264, HEADER_SIZE, hasEnvelope, readEnvelopeFlags } from '@tapflowio/agent-core/utils'
import type { SentTouch } from './SocketFlowDriver.js'

/**
 * A flow's video, cut from the stream the runner already receives as the session's holder (A4).
 *
 * **Nothing here is re-encoded or decoded.** The frames are stored as they arrived, in their envelopes, so the
 * dashboard replays them with the decoders the live viewer has. What this adds is framing:
 *
 * - **A record** is `[u8 kind][u32 BE ms][u32 BE length][payload]`. Kind 1 is a frame, as received; kind 2 is a JSON
 *   event (`chrome`, `deviceInfo`, `step`, `touch`). `ms` is the runner's receive time on the video's clock.
 * - **The clock** starts at the video's first record (`clockBase`, epoch ms, in the open call's meta), so every time
 *   is ≥ 0 even though the video starts before the flow: the frames since the last keyframe are kept at all times,
 *   because on a still screen a keyframe may not come for a minute. `flowStartMs` places the flow on that clock.
 * - **A chunk** is ~2 s or ~2 MB of records, and a new one starts at every decodable keyframe, so a chunk lost in
 *   upload costs the least. Cut by time, not only by keyframe: a still screen would otherwise hold a minute here.
 *
 * **`keyframe` means a point decoding can begin from**: an IDR that carries SPS/PPS. iOS and the emulator's gRPC
 * encoder put them on every IDR. scrcpy (real devices, and the fallback when gRPC is unavailable) puts them on its
 * first IDR only, so its video plays from the start, seeks only there, and a lost chunk leaves the rest a gap —
 * the standing that backend has, without a detector that could only answer after the video was opened.
 */

export const VIDEO_FORMAT_VERSION = 1

const KIND_FRAME = 1
const KIND_EVENT = 2
const RECORD_HEADER = 9

/** A chunk is cut at this age or size. */
const CHUNK_MS = 2_000
const CHUNK_BYTES = 2 * 1024 * 1024
/** The frames since the last keyframe, kept so a flow's video can start before the flow. Past this it starts at the
 *  next keyframe instead; the relay's chunk cap is 8 MB. */
const KEPT_GOP_BYTES = 6 * 1024 * 1024
/** The relay's per-flow cap. Stopping here rather than at its 413 keeps the end reason the runner's own. */
export const MAX_FLOW_VIDEO_BYTES = 100 * 1024 * 1024

export interface VideoMeta {
  formatVersion: number
  codec: 'h264' | 'jpeg'
  platform?: string
  clockBase: number
  flowStartMs: number
  /**
   * Present when the flow's stream cannot be kept, so the page can say why: `jpeg`, or `no-keyframe` — H.264 arrived
   * but nothing a decoder could start from (scrcpy keys its SPS/PPS once per stream, so a later flow can have none).
   */
  notRecorded?: 'jpeg' | 'no-keyframe'
}

export interface VideoChunk {
  seq: number
  startMs: number
  keyframe: boolean
  data: Buffer
}

export type VideoEndReason = 'done' | 'cancelled' | 'size-limit'

/** What one flow's video produces, in order. The consumer uploads them; nothing here waits on it. */
export interface VideoSink {
  open(meta: VideoMeta): void
  chunk(chunk: VideoChunk): void
  /** `lastSeq` is the last chunk produced, or -1. */
  end(lastSeq: number, reason: VideoEndReason): void
}

interface Pending { at: number; kind: number; payload: Buffer; decodable: boolean }

/**
 * An access unit carrying both an SPS (NAL type 7) and a PPS (type 8): one a decoder can start from cold. Both,
 * because the player trusts this to seek and to resume after a gap, and either alone cannot configure a decoder.
 */
export function carriesParameterSets(payload: Buffer): boolean {
  let sps = false
  let pps = false
  for (let i = 0; i + 3 < payload.length; i++) {
    if (payload[i] !== 0 || payload[i + 1] !== 0) continue
    const at = payload[i + 2] === 1 ? i + 3 : payload[i + 2] === 0 && payload[i + 3] === 1 ? i + 4 : -1
    if (at <= 0 || at >= payload.length) continue
    const type = payload[at]! & 0x1f
    if (type === 7) sps = true
    else if (type === 8) pps = true
    if (sps && pps) return true
  }
  return false
}

function record(kind: number, ms: number, payload: Buffer): Buffer {
  const head = Buffer.allocUnsafe(RECORD_HEADER)
  head.writeUInt8(kind, 0)
  head.writeUInt32BE(Math.max(0, Math.round(ms)), 1)
  head.writeUInt32BE(payload.length, 5)
  return Buffer.concat([head, payload])
}

/**
 * Taps the holder's stream and turns it into one video per flow. Flows are sequential, so one is open at a time.
 */
export class VideoTap {
  private kept: Pending[] = []
  private keptBytes = 0
  private readonly latest = new Map<string, unknown>()
  private flow: {
    sink: VideoSink
    flowStart: number
    platform?: string
    clockBase: number | null
    opened: 'h264' | 'jpeg' | null
    seq: number
    chunk: Buffer[]
    chunkBytes: number
    chunkStart: number
    chunkKeyframe: boolean
    total: number
    stopped: boolean
    /** H.264 arrived during the flow, whether or not a video could start on it. */
    sawH264: boolean
  } | null = null

  private readonly now: () => number
  private readonly maxFlowBytes: number
  private readonly keptGopBytes: number

  constructor(opts: { now?: () => number; maxFlowBytes?: number; keptGopBytes?: number } = {}) {
    this.now = opts.now ?? Date.now
    this.maxFlowBytes = opts.maxFlowBytes ?? MAX_FLOW_VIDEO_BYTES
    this.keptGopBytes = opts.keptGopBytes ?? KEPT_GOP_BYTES
  }

  /** A binary message from the relay: a frame of the session this runner holds. */
  frame(data: Buffer): void {
    if (!hasEnvelope(data)) return
    const { codec, keyframe } = readEnvelopeFlags(data)
    if (codec === CODEC_AUDIO) return
    const at = this.now()
    if (codec !== CODEC_H264) {
      // JPEG: every frame stands alone, and a video of it is several times the H.264 one (measured 82 vs 3–9
      // Mbit/s). Not kept; a flow that sees it says so.
      this.kept = []
      this.keptBytes = 0
      this.onFrame({ at, kind: KIND_FRAME, payload: data, decodable: false }, 'jpeg')
      return
    }
    const decodable = keyframe && carriesParameterSets(data.subarray(HEADER_SIZE))
    const p: Pending = { at, kind: KIND_FRAME, payload: data, decodable }
    if (decodable) {
      this.kept = []
      this.keptBytes = 0
    }
    if (this.kept.length > 0 || decodable) {
      this.keptBytes += data.length
      if (this.keptBytes > this.keptGopBytes) {
        this.kept = []
        this.keptBytes = 0
      } else {
        this.kept.push(p)
      }
    }
    this.onFrame(p, 'h264')
  }

  /** A `session:chrome` or `session:deviceInfo` payload: kept as the latest, and written into an open video. */
  event(type: 'chrome' | 'deviceInfo', payload: unknown): void {
    this.latest.set(type, payload)
    this.writeEvent({ type, payload })
  }

  /**
   * A touch the runner just sent, so the player draws it over the picture (#1205's follow-up). Stamped on the frames'
   * own clock at send time, a little before the frame that shows its effect; before the video opens it is dropped, as
   * a step mark is, since nothing before the first keyframe plays.
   */
  touch(t: SentTouch): void {
    this.writeEvent({ type: 'touch', ...t })
  }

  /** A step boundary of the open flow, for the player's timeline. */
  step(mark: { index: number; name: string; phase: 'start' | 'end'; status?: string }): void {
    this.writeEvent({ type: 'step', ...mark })
  }

  /** Starts a flow's video. Its frames begin with the kept GOP, so the video starts at the last decodable keyframe. */
  begin(sink: VideoSink, platform?: string): void {
    this.flow = {
      sink, flowStart: this.now(), ...(platform ? { platform } : {}), clockBase: null, opened: null, seq: 0,
      chunk: [], chunkBytes: 0, chunkStart: 0, chunkKeyframe: false, total: 0, stopped: false, sawH264: false,
    }
    for (const p of [...this.kept]) this.append(p, 'h264')
  }

  /** Ends the flow's video: its last chunk goes out, then the end. */
  end(reason: 'done' | 'cancelled' = 'done'): void {
    const f = this.flow
    this.flow = null
    if (!f) return
    if (f.opened === null) {
      // Frames came and none could start a video. Said, rather than leaving a flow with no video and no reason.
      if (f.sawH264) {
        f.sink.open(this.meta(f, 'h264', f.flowStart, 'no-keyframe'))
        f.sink.end(-1, 'done')
      }
      return
    }
    if (f.opened === 'h264' && !f.stopped) {
      this.cut(f)
      f.sink.end(f.seq - 1, reason)
    }
  }

  private onFrame(p: Pending, codec: 'h264' | 'jpeg'): void {
    if (this.flow) this.append(p, codec)
  }

  private writeEvent(body: Record<string, unknown>): void {
    const f = this.flow
    if (!f || f.opened !== 'h264' || f.stopped) return
    this.push(f, { at: this.now(), kind: KIND_EVENT, payload: Buffer.from(JSON.stringify(body)), decodable: false })
  }

  private append(p: Pending, codec: 'h264' | 'jpeg'): void {
    const f = this.flow!
    if (f.stopped) return
    if (f.opened === null) {
      if (codec === 'jpeg') {
        f.opened = 'jpeg'
        f.sink.open(this.meta(f, 'jpeg', p.at, 'jpeg'))
        f.sink.end(-1, 'done')
        return
      }
      // A video starts on a frame a decoder can start from.
      f.sawH264 = true
      if (!p.decodable) return
      f.clockBase = p.at
      f.opened = 'h264'
      f.chunkStart = 0
      f.sink.open(this.meta(f, 'h264', p.at))
      // The keyframe first, so the video's first chunk starts with one; the device's description right after it,
      // at the same moment, so a player has both before it draws.
      this.push(f, p)
      for (const [type, payload] of this.latest) {
        this.push(f, { at: p.at, kind: KIND_EVENT, payload: Buffer.from(JSON.stringify({ type, payload })), decodable: false })
      }
      return
    }
    // A codec change mid-flow (the agent falling back to JPEG) is not kept: its frames would not decode here.
    if (f.opened !== 'h264' || codec !== 'h264') return
    this.push(f, p)
  }

  private push(f: NonNullable<VideoTap['flow']>, p: Pending): void {
    const ms = p.at - f.clockBase!
    if (p.decodable && f.chunk.length > 0) this.cut(f)
    const rec = record(p.kind, ms, p.payload)
    if (f.total + rec.length > this.maxFlowBytes) {
      this.cut(f)
      f.stopped = true
      f.sink.end(f.seq - 1, 'size-limit')
      return
    }
    if (f.chunk.length === 0) {
      f.chunkStart = ms
      f.chunkKeyframe = p.decodable
    }
    f.chunk.push(rec)
    f.chunkBytes += rec.length
    f.total += rec.length
    if (f.chunkBytes >= CHUNK_BYTES || ms - f.chunkStart >= CHUNK_MS) this.cut(f)
  }

  private cut(f: NonNullable<VideoTap['flow']>): void {
    if (f.chunk.length === 0) return
    f.sink.chunk({ seq: f.seq++, startMs: f.chunkStart, keyframe: f.chunkKeyframe, data: Buffer.concat(f.chunk) })
    f.chunk = []
    f.chunkBytes = 0
  }

  private meta(f: NonNullable<VideoTap['flow']>, codec: 'h264' | 'jpeg', firstAt: number, notRecorded?: VideoMeta['notRecorded']): VideoMeta {
    return {
      formatVersion: VIDEO_FORMAT_VERSION,
      codec,
      ...(f.platform ? { platform: f.platform } : {}),
      clockBase: firstAt,
      flowStartMs: Math.max(0, f.flowStart - firstAt),
      ...(notRecorded ? { notRecorded } : {}),
    }
  }
}
