/**
 * A flow's video as the runner recorded it (A4), and the arithmetic the player needs. No React here.
 *
 * The file is records `[u8 kind][u32 BE ms][u32 BE length][payload]` (flow-runner `video.ts`): kind 1 is a frame as
 * the runner received it, in its envelope; kind 2 is a JSON event — the device's chrome, its info, a step mark, or a touch.
 * `ms` is the runner's receive time on the video's clock, which starts at its first record. The relay never reads
 * a byte of it; the chunk index it keeps (`GET …/video/index`) is the seek index: a chunk whose `keyframe` is set
 * starts with an IDR carrying SPS/PPS, a point decoding can begin from.
 */

import type { MachineTouch } from '@/lib/touchMarks'

export const VIDEO_FORMAT_VERSION = 1

const KIND_FRAME = 1
const KIND_EVENT = 2
const RECORD_HEADER = 9

/** `GET /api/v1/runs/:id` carries one of these per flow that has a video. */
export interface VideoSummary {
  ended: boolean
  endReason: string | null
  evicted: boolean
  notRecorded: string | null
  bytes: number
}

export interface VideoMeta {
  formatVersion: number
  codec: string
  platform?: string
  clockBase: number
  flowStartMs: number
  notRecorded?: string
}

export interface VideoChunkIndex {
  seq: number
  offset: number
  length: number
  startMs: number
  keyframe: boolean
}

/** `GET /api/v1/runs/:id/flows/:idx/video/index`. */
export interface VideoIndex {
  meta: VideoMeta
  bytes: number
  ended: boolean
  endReason: string | null
  evicted: boolean
  chunks: VideoChunkIndex[]
  gaps: number[]
}

export type VideoEvent =
  | { type: 'chrome'; payload: unknown }
  | { type: 'deviceInfo'; payload: unknown }
  | { type: 'step'; index: number; name: string; phase: 'start' | 'end'; status?: string }
  /** A touch the runner sent, in the frame it sent it in (flow-runner's `SentTouch`) — drawn over the picture. */
  | ({ type: 'touch' } & (
    | { kind: 'tap'; point: [number, number]; holdMs?: number }
    | { kind: 'swipe'; from: [number, number]; to: [number, number]; durationMs: number }
    | { kind: 'pinch'; from: [[number, number], [number, number]]; to: [[number, number], [number, number]]; durationMs: number }
  ))

export interface FrameRecord { kind: 'frame'; ms: number; chunk: number; data: ArrayBuffer }
export interface EventRecord { kind: 'event'; ms: number; chunk: number; event: VideoEvent }
export type VideoRecord = FrameRecord | EventRecord

/** A stretch of the timeline the video does not have: a chunk that never reached the relay. */
export interface Gap { fromMs: number; toMs: number }

/** Everything the player needs, once the bytes are in. */
export interface LoadedVideo {
  meta: VideoMeta
  records: VideoRecord[]
  /** Index into `records` where each chunk (by position in `index.chunks`) starts. */
  chunkStarts: number[]
  chunks: VideoChunkIndex[]
  durationMs: number
  gaps: Gap[]
  steps: { index: number; name: string; ms: number; status?: string }[]
  /** The touches the runner sent, on the video's clock (`at` is ms into it), in order. Empty from an older runner. */
  touches: MachineTouch[]
}

/** Splits one chunk's bytes into records. A truncated tail (a write cut short) is dropped, not thrown. */
export function parseRecords(bytes: ArrayBuffer, chunk: number): VideoRecord[] {
  const view = new DataView(bytes)
  const out: VideoRecord[] = []
  let o = 0
  while (o + RECORD_HEADER <= bytes.byteLength) {
    const kind = view.getUint8(o)
    const ms = view.getUint32(o + 1)
    const len = view.getUint32(o + 5)
    const start = o + RECORD_HEADER
    if (start + len > bytes.byteLength) break
    if (kind === KIND_FRAME) {
      out.push({ kind: 'frame', ms, chunk, data: bytes.slice(start, start + len) })
    } else if (kind === KIND_EVENT) {
      try {
        out.push({ kind: 'event', ms, chunk, event: JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, start, len))) as VideoEvent })
      } catch { /* an event this player cannot read is skipped, not fatal */ }
    }
    o = start + len
  }
  return out
}

/** Builds the timeline from the index and the bytes of the whole file. */
export function loadVideo(index: VideoIndex, file: ArrayBuffer): LoadedVideo {
  const chunks = [...index.chunks].sort((a, b) => a.seq - b.seq)
  const records: VideoRecord[] = []
  const chunkStarts: number[] = []
  chunks.forEach((c, i) => {
    chunkStarts.push(records.length)
    if (c.offset + c.length <= file.byteLength) records.push(...parseRecords(file.slice(c.offset, c.offset + c.length), i))
  })
  const durationMs = records.length > 0 ? records[records.length - 1]!.ms : 0
  // A missing seq between two chunks is a stretch with no frames: from where the earlier one ends to where the
  // later one starts. One missing at the end (a lost tail) runs to the last record the video has.
  const gaps: Gap[] = []
  const missing = new Set(index.gaps)
  chunks.forEach((c, i) => {
    const next = chunks[i + 1]
    if (next && next.seq !== c.seq + 1) {
      const lastInChunk = records[(chunkStarts[i + 1] ?? records.length) - 1]
      gaps.push({ fromMs: lastInChunk?.ms ?? c.startMs, toMs: next.startMs })
    }
  })
  // A lost first chunk: the video starts late, and says so from 0.
  if (chunks.length > 0 && [...missing].some((s) => s < chunks[0]!.seq)) gaps.unshift({ fromMs: 0, toMs: chunks[0]!.startMs })
  const lastSeq = chunks.length > 0 ? chunks[chunks.length - 1]!.seq : -1
  const tailLost = [...missing].some((s) => s > lastSeq)
  if (tailLost) gaps.push({ fromMs: durationMs, toMs: durationMs })
  const steps = records.flatMap((r) => (r.kind === 'event' && r.event.type === 'step' && r.event.phase === 'start'
    ? [{ index: r.event.index, name: r.event.name, ms: r.ms }]
    : []))
  const ends = new Map(records.flatMap((r) => (r.kind === 'event' && r.event.type === 'step' && r.event.phase === 'end' ? [[r.event.index, r.event]] : [])))
  return {
    meta: index.meta, records, chunkStarts, chunks, durationMs, gaps, touches: touchesOf(records),
    // The end mark's name, when there is one: a launch learns which of the relay's defaults it applied only once it
    // answers, so its end mark is the one that matches the run record.
    steps: steps.map((s) => {
      const end = ends.get(s.index)
      if (!end) return s
      return { ...s, name: end.name || s.name, ...(end.status ? { status: end.status } : {}) }
    }),
  }
}

/**
 * The chunk to start decoding from to show time `t`: the last decodable one at or before it **with no missing chunk
 * between them** — a decoder fed across a gap gets frames whose references never arrived. With none, the first
 * decodable chunk after `t` (the picture resumes there), or -1 when the video has no decodable chunk left.
 */
/** A video's touch events as touches to play on its own clock. */
export function touchesOf(records: VideoRecord[]): MachineTouch[] {
  const pt = ([x, y]: [number, number]) => ({ x, y })
  return records.flatMap((r, id): MachineTouch[] => {
    if (r.kind !== 'event' || r.event.type !== 'touch') return []
    const e = r.event
    switch (e.kind) {
      case 'tap': return [{ id, at: r.ms, kind: 'tap', point: pt(e.point), ...(e.holdMs !== undefined ? { holdMs: e.holdMs } : {}) }]
      case 'swipe': return [{ id, at: r.ms, kind: 'swipe', from: pt(e.from), to: pt(e.to), durationMs: e.durationMs }]
      case 'pinch': return [{ id, at: r.ms, kind: 'pinch', from: [pt(e.from[0]), pt(e.from[1])], to: [pt(e.to[0]), pt(e.to[1])], durationMs: e.durationMs }]
    }
  })
}

export function seekChunk(video: Pick<LoadedVideo, 'chunks'>, t: number): number {
  const chunks = video.chunks
  let at = -1
  chunks.forEach((c, i) => { if (c.startMs <= t) at = i })
  for (let i = at; i >= 0; i--) {
    if (chunks[i]!.keyframe) return i
    if (i > 0 && chunks[i]!.seq !== chunks[i - 1]!.seq + 1) break
  }
  return chunks.findIndex((c, i) => i > at && c.keyframe)
}

/** The device's chrome as of time `t`: the last chrome event at or before it, or the first one the video has. */
export function chromeAt(video: LoadedVideo, t: number): unknown {
  let latest: unknown
  for (const r of video.records) {
    if (r.kind !== 'event' || r.event.type !== 'chrome') continue
    if (r.ms > t && latest !== undefined) break
    latest = r.event.payload
  }
  return latest ?? null
}

/**
 * Where a drag at `ms` lands: on the nearest step's start when one is within 2% of the video (at least 150 ms),
 * else where it is. The scene a step changed is the one worth landing on.
 */
export function snapToStep(video: Pick<LoadedVideo, 'steps' | 'durationMs'>, ms: number): number {
  const within = Math.max(150, video.durationMs * 0.02)
  let best: { ms: number; d: number } | null = null
  for (const st of video.steps) {
    const d = Math.abs(st.ms - ms)
    if (d <= within && (!best || d < best.d)) best = { ms: st.ms, d }
  }
  return best ? best.ms : ms
}

/** `m:ss` for the player's clock. */
export function formatClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** Why a flow has no video to play, in the page's words; null when there is one. */
export function videoUnavailableText(v: VideoSummary): string | null {
  if (v.notRecorded === 'jpeg') return 'No video: this device streamed JPEG, which is not kept. The agent sends H.264 unless TAPFLOW_IOS_CODEC=jpeg is set.'
  if (v.notRecorded === 'no-keyframe') return 'No video: the device\'s stream gave no frame a video could start from.'
  if (v.notRecorded) return 'No video for this flow.'
  if (v.evicted) return 'Video no longer kept: removed by the retention policy, or to make room when video storage was full.'
  return null
}

/** What the end of a video says about it, when it ended other than at the flow's end. */
export function videoEndNote(reason: string | null): string | null {
  switch (reason) {
    case 'size-limit': return 'The video stops early: it reached the 100 MB limit for one flow.'
    case 'storage-full': return 'The video stops early: the relay\'s storage for videos was full.'
    case 'cancelled': return 'The run was cancelled here.'
    case 'runner-lost': return 'The video stops where the runner disconnected.'
    case 'truncated': return 'The end of this video did not reach the relay.'
    default: return null
  }
}
