import { describe, it, expect } from 'vitest'
import { CODEC_AUDIO, CODEC_H264, CODEC_JPEG, writeEnvelopeHeader } from '@tapflowio/agent-core/utils'
import { VideoTap, carriesParameterSets, type VideoChunk, type VideoMeta, type VideoSink } from '../video'

// A flow's video is cut from the frames the runner already receives (A4). These pin the shape the relay stores and
// the dashboard will play: where a video starts, where chunks are cut, and what a chunk's `keyframe` promises.

const SPS = Buffer.from([0, 0, 0, 1, 0x67, 0x42, 0, 0, 0, 1, 0x68, 0xce])
const IDR = (n = 8) => Buffer.concat([SPS, Buffer.from([0, 0, 0, 1, 0x65]), Buffer.alloc(n, 7)])
const BARE_IDR = (n = 8) => Buffer.concat([Buffer.from([0, 0, 0, 1, 0x65]), Buffer.alloc(n, 7)])
const P = (n = 8) => Buffer.concat([Buffer.from([0, 0, 0, 1, 0x41]), Buffer.alloc(n, 3)])

const h264 = (payload: Buffer, keyframe: boolean) => writeEnvelopeHeader(payload, 1_000, { codec: CODEC_H264, keyframe })

class Sink implements VideoSink {
  meta: VideoMeta | null = null
  chunks: VideoChunk[] = []
  ends: { lastSeq: number; reason: string }[] = []
  open(meta: VideoMeta) { this.meta = meta }
  chunk(c: VideoChunk) { this.chunks.push(c) }
  end(lastSeq: number, reason: string) { this.ends.push({ lastSeq, reason }) }
}

/** Splits a chunk back into its records. */
function records(data: Buffer): { kind: number; ms: number; payload: Buffer }[] {
  const out = []
  for (let o = 0; o < data.length;) {
    const len = data.readUInt32BE(o + 5)
    out.push({ kind: data[o]!, ms: data.readUInt32BE(o + 1), payload: data.subarray(o + 9, o + 9 + len) })
    o += 9 + len
  }
  return out
}

function clock(start = 10_000) {
  let t = start
  return { now: () => t, advance: (ms: number) => { t += ms } }
}

describe('VideoTap', () => {
  it('knows an IDR that carries SPS and PPS from one that lacks either', () => {
    expect(carriesParameterSets(IDR())).toBe(true)
    expect(carriesParameterSets(BARE_IDR())).toBe(false)
    expect(carriesParameterSets(Buffer.from([0, 0, 1, 0x67, 1, 0, 0, 1, 0x68, 1]))).toBe(true)
    expect(carriesParameterSets(Buffer.from([0, 0, 1, 0x67, 1, 0, 0, 1, 0x65, 1]))).toBe(false)
    expect(carriesParameterSets(Buffer.from([0, 0, 1, 0x68, 1, 0, 0, 1, 0x65, 1]))).toBe(false)
  })

  it('starts a flow\'s video at the last decodable keyframe before it, and places the flow on its clock', () => {
    const c = clock()
    const tap = new VideoTap({ now: c.now })
    tap.frame(h264(P(), false)) // before any keyframe: not kept
    tap.frame(h264(IDR(), true))
    c.advance(100)
    tap.frame(h264(P(), false))
    c.advance(400)
    const sink = new Sink()
    tap.begin(sink, 'ios')
    tap.end()

    expect(sink.meta).toEqual({ formatVersion: 1, codec: 'h264', platform: 'ios', clockBase: 10_000, flowStartMs: 500 })
    expect(sink.chunks).toHaveLength(1)
    expect(sink.chunks[0]).toMatchObject({ seq: 0, startMs: 0, keyframe: true })
    const recs = records(sink.chunks[0]!.data)
    expect(recs.map((r) => [r.kind, r.ms])).toEqual([[1, 0], [1, 100]])
    expect(recs[0]!.payload.subarray(0, 4).toString()).toBe('TFFE')
    expect(sink.ends).toEqual([{ lastSeq: 0, reason: 'done' }])
  })

  it('cuts chunks by time, and before every decodable keyframe', () => {
    const c = clock()
    const tap = new VideoTap({ now: c.now })
    tap.frame(h264(IDR(), true))
    const sink = new Sink()
    tap.begin(sink)
    for (let i = 0; i < 5; i++) { c.advance(500); tap.frame(h264(P(), false)) } // 2.5 s of a still screen
    c.advance(100)
    tap.frame(h264(IDR(), true))
    c.advance(100)
    tap.frame(h264(P(), false))
    tap.end()

    expect(sink.chunks.map((ch) => [ch.seq, ch.startMs, ch.keyframe])).toEqual([[0, 0, true], [1, 2500, false], [2, 2600, true]])
    expect(sink.ends).toEqual([{ lastSeq: 2, reason: 'done' }])
  })

  it('never calls an IDR without SPS a keyframe, and waits for one that has it to start', () => {
    const c = clock()
    const tap = new VideoTap({ now: c.now })
    const sink = new Sink()
    tap.begin(sink)
    tap.frame(h264(BARE_IDR(), true))
    expect(sink.meta).toBeNull()
    tap.frame(h264(IDR(), true))
    c.advance(10)
    tap.frame(h264(BARE_IDR(), true))
    tap.end()
    expect(sink.chunks.map((ch) => ch.keyframe)).toEqual([true])
    expect(records(sink.chunks[0]!.data)).toHaveLength(2)
  })

  it('writes the latest chrome and device info first, then changes and step marks as they happen', () => {
    const c = clock()
    const tap = new VideoTap({ now: c.now })
    tap.event('chrome', { model: 'a' })
    tap.event('deviceInfo', { deviceName: 'iPhone', osVersion: '18' })
    tap.frame(h264(IDR(), true))
    const sink = new Sink()
    tap.begin(sink)
    c.advance(50)
    tap.step({ index: 0, name: 'tap', phase: 'start' })
    tap.event('chrome', { model: 'b' })
    tap.end()

    expect(sink.chunks).toHaveLength(1)
    expect(sink.chunks[0]!.keyframe).toBe(true)
    expect(records(sink.chunks[0]!.data)[0]!.kind).toBe(1)
    const events = records(sink.chunks[0]!.data).filter((r) => r.kind === 2).map((r) => [r.ms, JSON.parse(r.payload.toString())])
    expect(events).toEqual([
      [0, { type: 'chrome', payload: { model: 'a' } }],
      [0, { type: 'deviceInfo', payload: { deviceName: 'iPhone', osVersion: '18' } }],
      [50, { type: 'step', index: 0, name: 'tap', phase: 'start' }],
      [50, { type: 'chrome', payload: { model: 'b' } }],
    ])
  })

  // The player draws a touch over the picture at the moment it was sent, on the frames' clock. Before the video opens
  // there is nothing to play, so a touch then is dropped, as a step mark is. Mutation: drop the event.
  it('records a touch on the frames\' clock once the video is open, and none before', () => {
    const c = clock()
    const tap = new VideoTap({ now: c.now })
    tap.touch({ kind: 'tap', point: [0.1, 0.2] })
    tap.frame(h264(IDR(), true))
    const sink = new Sink()
    tap.begin(sink)
    c.advance(30)
    tap.touch({ kind: 'pinch', from: [[0.4, 0.45], [0.6, 0.55]], to: [[0.2, 0.35], [0.8, 0.65]], durationMs: 500 })
    tap.end()
    const touches = records(sink.chunks[0]!.data).filter((r) => r.kind === 2).map((r) => [r.ms, JSON.parse(r.payload.toString())])
      .filter(([, e]) => e.type === 'touch')
    expect(touches).toEqual([[30, { type: 'touch', kind: 'pinch', from: [[0.4, 0.45], [0.6, 0.55]], to: [[0.2, 0.35], [0.8, 0.65]], durationMs: 500 }]])
  })

  it('opens a JPEG stream\'s video only to say it is not kept', () => {
    const tap = new VideoTap({ now: clock().now })
    const sink = new Sink()
    tap.begin(sink)
    tap.frame(writeEnvelopeHeader(Buffer.from([0xff, 0xd8]), 1, { codec: CODEC_JPEG }))
    tap.frame(writeEnvelopeHeader(Buffer.from([0xff, 0xd8]), 2, { codec: CODEC_JPEG }))
    tap.end()
    expect(sink.meta).toMatchObject({ codec: 'jpeg', notRecorded: 'jpeg' })
    expect(sink.chunks).toEqual([])
    expect(sink.ends).toEqual([{ lastSeq: -1, reason: 'done' }])
  })

  it('ignores audio and frames without an envelope', () => {
    const tap = new VideoTap({ now: clock().now })
    const sink = new Sink()
    tap.begin(sink)
    tap.frame(writeEnvelopeHeader(Buffer.alloc(4), 1, { codec: CODEC_AUDIO }))
    tap.frame(Buffer.from('not a frame'))
    tap.end()
    expect(sink.meta).toBeNull()
  })

  it('says why when H.264 arrived but nothing a decoder could start from', () => {
    // scrcpy keys its SPS/PPS once per stream: once that keyframe has aged out of the lead-in, a later flow has none.
    const c = clock()
    const tap = new VideoTap({ now: c.now })
    const sink = new Sink()
    tap.begin(sink)
    tap.frame(h264(BARE_IDR(), true))
    tap.frame(h264(P(), false))
    tap.end()
    expect(sink.meta).toMatchObject({ codec: 'h264', notRecorded: 'no-keyframe', clockBase: 10_000, flowStartMs: 0 })
    expect(sink.chunks).toEqual([])
    expect(sink.ends).toEqual([{ lastSeq: -1, reason: 'done' }])
  })

  it('opens nothing for a flow during which no frame arrived', () => {
    const tap = new VideoTap({ now: clock().now })
    const sink = new Sink()
    tap.begin(sink)
    tap.end()
    expect(sink.meta).toBeNull()
    expect(sink.ends).toEqual([])
  })

  it('stops a video at its size limit and says so, once', () => {
    const c = clock()
    const tap = new VideoTap({ now: c.now, maxFlowBytes: 200 })
    tap.frame(h264(IDR(), true))
    const sink = new Sink()
    tap.begin(sink)
    for (let i = 0; i < 10; i++) { c.advance(10); tap.frame(h264(P(40), false)) }
    tap.end()
    expect(sink.ends).toEqual([{ lastSeq: 0, reason: 'size-limit' }])
    expect(sink.chunks.reduce((n, ch) => n + ch.data.length, 0)).toBeLessThanOrEqual(200)
  })

  it('lets go of a lead-in past its byte cap, and starts the video at the next keyframe instead', () => {
    const c = clock()
    const tap = new VideoTap({ now: c.now, keptGopBytes: 150 })
    tap.frame(h264(IDR(), true))
    for (let i = 0; i < 5; i++) { c.advance(10); tap.frame(h264(P(20), false)) }
    const sink = new Sink()
    tap.begin(sink)
    expect(sink.meta).toBeNull()
    c.advance(10)
    tap.frame(h264(IDR(), true))
    tap.end()
    expect(sink.meta).toMatchObject({ clockBase: 10_060, flowStartMs: 0 })
    expect(records(sink.chunks[0]!.data)).toHaveLength(1)
  })

  it('ends a video cut short as cancelled', () => {
    const tap = new VideoTap({ now: clock().now })
    tap.frame(h264(IDR(), true))
    const sink = new Sink()
    tap.begin(sink)
    tap.end('cancelled')
    expect(sink.ends).toEqual([{ lastSeq: 0, reason: 'cancelled' }])
  })

  it('starts the next flow\'s video from the frames since the last keyframe, not from the previous video', () => {
    const c = clock()
    const tap = new VideoTap({ now: c.now })
    tap.frame(h264(IDR(), true))
    const first = new Sink()
    tap.begin(first)
    c.advance(100); tap.frame(h264(IDR(), true))
    c.advance(100); tap.frame(h264(P(), false))
    tap.end()
    const second = new Sink()
    c.advance(100)
    tap.begin(second)
    tap.end()
    expect(second.meta).toMatchObject({ clockBase: 10_100, flowStartMs: 200 })
    expect(records(second.chunks[0]!.data)).toHaveLength(2)
  })
})
