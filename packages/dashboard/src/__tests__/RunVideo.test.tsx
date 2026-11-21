import { describe, it, expect, vi, afterEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RunVideo } from '@/components/runs/RunVideo'

import { WatchedDevice } from '@/components/device/WatchedDevice'
import { framelessChrome } from '@/lib/framelessChrome'
import { chromeAt, loadVideo, parseRecords, seekChunk, snapToStep, videoEndNote, videoUnavailableText, type VideoIndex, type VideoSummary } from '@/lib/runVideo'
import { withQuery } from './withQuery'

// A flow's video on the run page (A4): the file the runner wrote, read back. Records are
// `[u8 kind][u32 BE ms][u32 BE length][payload]`; a frame is an envelope as received, an event is JSON.

const enc = new TextEncoder()
function record(kind: number, ms: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(9 + payload.length)
  const v = new DataView(out.buffer)
  v.setUint8(0, kind)
  v.setUint32(1, ms)
  v.setUint32(5, payload.length)
  out.set(payload, 9)
  return out
}
/** An envelope: TFFE, version 1, flags (H.264 + keyframe), capturedAt, relayedAt, then the payload. */
function frame(keyframe: boolean): Uint8Array {
  const out = new Uint8Array(22 + 4)
  out.set([0x54, 0x46, 0x46, 0x45, 1, keyframe ? 0x03 : 0x01])
  out.set([0, 0, 0, 1], 22)
  return out
}
const event = (ms: number, body: unknown) => record(2, ms, enc.encode(JSON.stringify(body)))
const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}

/** A video of three chunks with seq 1 lost: chunk 0 (keyframe, step 0 starts), [gap], chunk 2 (keyframe, step 1 fails). */
function fixture() {
  const c0 = concat([record(1, 0, frame(true)), event(0, { type: 'chrome', payload: { model: 'a' } }), event(500, { type: 'step', index: 0, name: 'tap Login', phase: 'start' }), record(1, 900, frame(false))])
  const c2 = concat([record(1, 4000, frame(true)), event(4100, { type: 'step', index: 1, name: 'see Home', phase: 'start' }), event(4800, { type: 'step', index: 1, name: 'see Home', phase: 'end', status: 'failed' }), record(1, 5000, frame(false))])
  const file = concat([c0, c2])
  const index: VideoIndex = {
    meta: { formatVersion: 1, codec: 'h264', platform: 'ios', clockBase: 1, flowStartMs: 400 },
    bytes: file.length, ended: true, endReason: 'done', evicted: false,
    chunks: [
      { seq: 0, offset: 0, length: c0.length, startMs: 0, keyframe: true },
      { seq: 2, offset: c0.length, length: c2.length, startMs: 4000, keyframe: true },
    ],
    gaps: [1],
  }
  return { index, file: file.buffer }
}

describe('runVideo', () => {
  // #1047: a launch learns which of the relay's defaults it applied only when it answers, so its end mark names them
  // and its start mark cannot. The timeline shows the name the run record shows.
  it('names a step by its end mark when the two differ', () => {
    const file = concat([record(1, 0, frame(true)),
      event(100, { type: 'step', index: 0, name: 'launchApp', phase: 'start' }),
      event(900, { type: 'step', index: 0, name: 'launchApp(config: a)', phase: 'end', status: 'passed' })])
    const index: VideoIndex = { ...fixture().index, bytes: file.length, chunks: [{ seq: 0, offset: 0, length: file.length, startMs: 0, keyframe: true }], gaps: [] }
    expect(loadVideo(index, file.buffer).steps).toEqual([{ index: 0, name: 'launchApp(config: a)', ms: 100, status: 'passed' }])
  })

  // The runner's touches, on the video's clock, as touches to play (#1205's follow-up). Mutations: lose the hold, swap
  // a pinch's fingers, or read none.
  it('reads the runner\'s touches as touches on the video\'s clock', () => {
    const file = concat([record(1, 0, frame(true)),
      event(100, { type: 'touch', kind: 'tap', point: [0.25, 0.75], holdMs: 900 }),
      event(300, { type: 'touch', kind: 'pinch', from: [[0.4, 0.45], [0.6, 0.55]], to: [[0.2, 0.35], [0.8, 0.65]], durationMs: 500 })])
    const index: VideoIndex = { ...fixture().index, bytes: file.length, chunks: [{ seq: 0, offset: 0, length: file.length, startMs: 0, keyframe: true }], gaps: [] }
    expect(loadVideo(index, file.buffer).touches).toEqual([
      { id: 1, at: 100, kind: 'tap', point: { x: 0.25, y: 0.75 }, holdMs: 900 },
      { id: 2, at: 300, kind: 'pinch', from: [{ x: 0.4, y: 0.45 }, { x: 0.6, y: 0.55 }], to: [{ x: 0.2, y: 0.35 }, { x: 0.8, y: 0.65 }], durationMs: 500 },
    ])
  })

  it('reads records, the steps with their outcome, the duration and where frames are missing', () => {
    const { index, file } = fixture()
    const v = loadVideo(index, file)
    expect(v.records.filter((r) => r.kind === 'frame')).toHaveLength(4)
    expect(v.durationMs).toBe(5000)
    expect(v.steps).toEqual([{ index: 0, name: 'tap Login', ms: 500 }, { index: 1, name: 'see Home', ms: 4100, status: 'failed' }])
    expect(v.gaps).toEqual([{ fromMs: 900, toMs: 4000 }])
  })

  it('seeks to the last decodable chunk at or before a time', () => {
    const v = loadVideo(fixture().index, fixture().file)
    expect(seekChunk(v, 100)).toBe(0)
    expect(seekChunk(v, 3999)).toBe(0)
    expect(seekChunk(v, 4500)).toBe(1)
  })

  it('catches a drag on the nearest step start within 2% of the video, at least 150 ms', () => {
    const v = { durationMs: 5000, steps: [{ index: 0, name: 'a', ms: 500 }, { index: 1, name: 'b', ms: 4100 }] }
    expect(snapToStep(v, 600)).toBe(500)
    expect(snapToStep(v, 700)).toBe(700)
    expect(snapToStep(v, 3960)).toBe(4100)
    expect(snapToStep({ ...v, durationMs: 60_000 }, 1600)).toBe(500)
  })

  it('never decodes across a missing chunk: a seek past a gap resumes at the next decodable chunk', () => {
    const chunks = [
      { seq: 0, offset: 0, length: 1, startMs: 0, keyframe: true },
      { seq: 1, offset: 1, length: 1, startMs: 2000, keyframe: false },
      { seq: 3, offset: 2, length: 1, startMs: 6000, keyframe: false },
      { seq: 4, offset: 3, length: 1, startMs: 8000, keyframe: true },
    ]
    expect(seekChunk({ chunks }, 3000)).toBe(0)
    // Chunk 3 follows a gap and starts mid-GOP: the keyframe before the gap would decode frames whose references never arrived.
    expect(seekChunk({ chunks }, 7000)).toBe(3)
    expect(seekChunk({ chunks: chunks.slice(0, 3) }, 7000)).toBe(-1)
  })

  it('marks a lost first chunk as a gap from the start', () => {
    const { index, file } = fixture()
    const shifted = { ...index, chunks: index.chunks.map((c) => ({ ...c, seq: c.seq + 1 })), gaps: [0, 2] }
    expect(loadVideo(shifted, file).gaps[0]).toEqual({ fromMs: 0, toMs: 0 })
  })

  it('takes the chrome in force at a time', () => {
    const v = loadVideo(fixture().index, fixture().file)
    expect(chromeAt(v, 3000)).toEqual({ model: 'a' })
  })

  it('drops a truncated last record rather than throwing', () => {
    const whole = record(1, 0, frame(true))
    expect(parseRecords(whole.slice(0, whole.length - 3).buffer, 0)).toEqual([])
  })

  it('says why a flow has no video, and what an early end means', () => {
    const base: VideoSummary = { ended: true, endReason: 'done', evicted: false, notRecorded: null, bytes: 10 }
    expect(videoUnavailableText(base)).toBeNull()
    expect(videoUnavailableText({ ...base, notRecorded: 'jpeg' })).toContain('JPEG')
    expect(videoUnavailableText({ ...base, evicted: true })).toContain('no longer kept')
    expect(videoEndNote('truncated')).toContain('did not reach the relay')
    expect(videoEndNote('done')).toBeNull()
  })
})

describe('RunVideo', () => {
  afterEach(() => { vi.unstubAllGlobals() })
  const summary: VideoSummary = { ended: true, endReason: 'done', evicted: false, notRecorded: null, bytes: 2_500_000 }

  it('loads nothing until asked, then plays from where the flow started, with its steps and the missing stretch', async () => {
    const { index, file } = fixture()
    const fetchMock = vi.fn(async (url: string) =>
      url.endsWith('/video/index') ? Response.json(index) : new Response(file))
    vi.stubGlobal('fetch', fetchMock)
    render(withQuery(<RunVideo runId="r1" idx={0} flowName="login" summary={summary} running={false} />))

    expect(fetchMock).not.toHaveBeenCalled()
    expect(screen.getByText('2.4 MB')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /Play the video/ }))

    const slider = await screen.findByRole('slider', { name: 'Position in the video of login' })
    expect(slider.getAttribute('aria-valuetext')).toBe('0:00 of 0:05')
    expect(fetchMock.mock.calls.map(([u]) => u)).toEqual(['/api/v1/runs/r1/flows/0/video/index', '/api/v1/runs/r1/flows/0/video'])
    // Marks above the bar: each step's start (the failed one says so), and the stretch that never arrived.
    expect(screen.getByRole('button', { name: '0:00 tap Login' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '0:00 to 0:04: did not reach the relay' })).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: '0:04 see Home, failed' }))
    expect(slider.getAttribute('aria-valuetext')).toBe('0:04 of 0:05')
    // The arrow keys move by 50 ms and never catch on a step.
    fireEvent.keyDown(slider, { key: 'ArrowRight' })
    expect(slider.getAttribute('aria-valuenow')).toBe('4150')
    expect(screen.queryByRole('list', { name: /Steps in the video/ })).toBeNull()
  })

  // Drawn at the playback position, not the wall clock: there at a time after it was sent, gone before it, and there
  // again on a seek back — what a timeline is for. Mutations: drop the clock on a seek, or pass no timeline.
  it('draws the runner\'s touch where playback is, and again after seeking back to it', async () => {
    const { index } = fixture()
    // No chrome: the frameless iOS screen, whose overlay is drawn where a test's DOM has no decoder.
    const c0 = concat([record(1, 0, frame(true)), event(500, { type: 'step', index: 0, name: 'tap Login', phase: 'start' }),
      event(520, { type: 'touch', kind: 'tap', point: [0.25, 0.75] }), record(1, 900, frame(false))])
    const c2 = concat([record(1, 4000, frame(true)), event(4100, { type: 'step', index: 1, name: 'see Home', phase: 'start' }), record(1, 5000, frame(false))])
    const file = concat([c0, c2])
    const withTouch: VideoIndex = { ...index, bytes: file.length, chunks: [
      { seq: 0, offset: 0, length: c0.length, startMs: 0, keyframe: true },
      { seq: 2, offset: c0.length, length: c2.length, startMs: 4000, keyframe: true },
    ] }
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.endsWith('/video/index') ? Response.json(withTouch) : new Response(file.buffer))))
    render(withQuery(<RunVideo runId="r1" idx={0} flowName="login" summary={summary} running={false} />))
    await userEvent.click(screen.getByRole('button', { name: /Play the video/ }))
    const slider = await screen.findByRole('slider', { name: 'Position in the video of login' })
    const anchor = () => screen.getByTestId('touch-marks').getAttribute('data-anchor')
    await userEvent.click(screen.getByRole('button', { name: '0:04 see Home' }))
    expect(anchor()).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: '0:00 tap Login' }))
    fireEvent.keyDown(slider, { key: 'ArrowRight' })
    expect(slider.getAttribute('aria-valuenow')).toBe('550')
    expect(anchor()).toBe('25,75')
  })

  it('moves focus to Play when the button that loaded the video had it', async () => {
    const { index, file } = fixture()
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.endsWith('/video/index') ? Response.json(index) : new Response(file))))
    render(withQuery(<RunVideo runId="r1" idx={0} flowName="login" summary={summary} running={false} />))
    screen.getByRole('button', { name: /Play the video/ }).focus()
    await userEvent.keyboard('{Enter}')
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Play' })))
  })

  it('offers the rest of a video loaded while the flow was still running', async () => {
    const { index, file } = fixture()
    let ended = false
    const fetchMock = vi.fn(async (url: string) => (url.endsWith('/video/index') ? Response.json({ ...index, ended }) : new Response(file)))
    vi.stubGlobal('fetch', fetchMock)
    render(withQuery(<RunVideo runId="r1" idx={0} flowName="login" summary={{ ...summary, ended: false }} running />))
    await userEvent.click(screen.getByRole('button', { name: /Play the video/ }))
    await userEvent.click(await screen.findByRole('button', { name: 'Load the rest' }))
    ended = true
    await waitFor(() => expect(fetchMock.mock.calls.filter(([u]) => u.endsWith('/video/index'))).toHaveLength(2))
  })

  it('says a video the relay no longer keeps is gone, without a player', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 410 })))
    render(withQuery(<RunVideo runId="r1" idx={0} flowName="login" summary={summary} running={false} />))
    await userEvent.click(screen.getByRole('button', { name: /Play the video/ }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Video no longer kept.'))
    expect(screen.queryByRole('slider')).toBeNull()
  })

  it('says why there is no video instead of offering one', () => {
    vi.stubGlobal('fetch', vi.fn())
    render(withQuery(<RunVideo runId="r1" idx={0} flowName="login" summary={{ ...summary, notRecorded: 'jpeg' }} running={false} />))
    expect(screen.queryByRole('button', { name: /Play the video/ })).toBeNull()
    expect(screen.getByText(/streamed JPEG/)).toBeTruthy()
  })

  it('offers a retry when loading fails, and a format it cannot read is said, not played', async () => {
    const { index, file } = fixture()
    let fail = true
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (fail) return new Response('', { status: 500 })
      return url.endsWith('/video/index') ? Response.json({ ...index, meta: { ...index.meta, formatVersion: 2 } }) : new Response(file)
    }))
    render(withQuery(<RunVideo runId="r1" idx={0} flowName="login" summary={summary} running={false} />))
    await userEvent.click(screen.getByRole('button', { name: /Play the video/ }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Try again'))
    fail = false
    await userEvent.click(screen.getByRole('button', { name: /Play the video/ }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('cannot play'))
  })
})

describe('WatchedDevice in a replay', () => {
  it('never says it is waiting for a frame: a paused replay has none coming', () => {
    const ref = { current: undefined }
    const chrome = framelessChrome({ width: 400, height: 800 })
    const { container, rerender } = render(<WatchedDevice chrome={chrome} deviceReady platform="ios" binaryFrameHandlerRef={ref} />)
    expect(container.querySelector('[data-testid="screen-waiting"]')).toBeTruthy()
    rerender(<WatchedDevice chrome={chrome} deviceReady platform="ios" binaryFrameHandlerRef={ref} replay />)
    expect(container.querySelector('[data-testid="screen-waiting"]')).toBeNull()
  })
})
