import { describe, it, expect, vi } from 'vitest'
import type { BrowserToRelay } from '@tapflowio/protocol'
import { ThumbnailRecorder } from '@/lib/flowCapture/thumbnails'

// 1b-3b: which inputs leave a picture of the screen they began on, and under which key — flow-runner's `thumbnailKey`,
// the first requestId among the step's messages.
function recorder(over: { recording?: () => boolean; now?: () => number; status?: number[] } = {}) {
  const uploads: string[] = []
  const statuses = [...(over.status ?? [])]
  const r = new ThumbnailRecorder({
    sessionId: 's',
    surface: () => ({}) as CanvasImageSource,
    recording: over.recording ?? (() => true),
    ...(over.now ? { now: over.now } : {}),
    grab: async () => ({}) as ImageBitmap,
    encode: async () => new Blob(['jpeg']),
    upload: async (id) => { uploads.push(id); return new Response(null, { status: statuses.shift() ?? 201 }) },
  })
  return { r, uploads }
}
const touch = (end: string): BrowserToRelay[] => [
  { type: 'input:touch:start', sessionId: 's', payload: { x: 0.5, y: 0.5 } },
  { type: 'input:touch:move', sessionId: 's', payload: { x: 0.5, y: 0.6 } },
  { type: 'input:touch:end', sessionId: 's', requestId: end, payload: { x: 0.5, y: 0.6 } },
]
const key = (requestId: string, code: string, modifiers = 0): BrowserToRelay => ({ type: 'input:key', sessionId: 's', requestId, payload: { code, modifiers } })

describe('ThumbnailRecorder', () => {
  it('keys a gesture by its end and keeps none for one that was cancelled', async () => {
    const { r, uploads } = recorder()
    for (const m of touch('t1')) r.note(m)
    r.note({ type: 'input:touch:start', sessionId: 's', payload: { x: 0.1, y: 0.1 } })
    r.note({ type: 'input:touch:cancel', sessionId: 's' })
    await r.flush()
    expect(uploads).toEqual(['t1'])
  })

  it('takes a typed run at its first key, again after a key that types nothing or a pause', async () => {
    let t = 0
    const { r, uploads } = recorder({ now: () => t })
    for (const [id, code] of [['a', 'KeyH'], ['b', 'KeyI'], ['c', 'Enter'], ['d', 'KeyO'], ['e', 'KeyK']]) { r.note(key(id!, code!)); t += 200 }
    t += 11_000
    r.note(key('f', 'KeyZ'))
    r.note(key('g', 'KeyA', 0x08)) // Cmd+A types nothing
    await r.flush()
    expect(uploads).toEqual(['a', 'c', 'd', 'f', 'g'])
  })

  it('starts a new run after a touch between keys, as the steps do', async () => {
    const { r, uploads } = recorder()
    r.note(key('a', 'KeyH'))
    for (const m of touch('t')) r.note(m)
    r.note(key('b', 'KeyI'))
    await r.flush()
    expect(uploads).toEqual(['a', 't', 'b'])
  })

  // As `segment` cuts runs: Caps Lock is inside one, Alt types nothing, and a copy or a join between keys splits nothing.
  it('cuts typed runs where the steps do', async () => {
    const { r, uploads } = recorder()
    r.note(key('a', 'KeyA'))
    r.note(key('caps', 'CapsLock'))
    r.note({ type: 'clipboard:write', sessionId: 's', requestId: 'copy', payload: { text: 'x' } })
    r.note({ type: 'session:start', sessionId: 's', clientKind: 'dashboard' })
    r.note(key('b', 'KeyB'))
    r.note(key('alt', 'KeyC', 0x04))
    r.note(key('d', 'KeyD'))
    await r.flush()
    expect(uploads).toEqual(['a', 'alt', 'd'])
  })

  it('lets go of a gesture\'s picture when the gesture is cancelled or recording stops', async () => {
    let on = true
    const closed: string[] = []
    const r = new ThumbnailRecorder({
      sessionId: 's', surface: () => ({}) as CanvasImageSource, recording: () => on,
      grab: async () => ({ close: () => closed.push('frame') }) as unknown as ImageBitmap,
      encode: async () => { throw new Error('no canvas') },
      upload: async () => new Response(null, { status: 201 }),
    })
    r.note({ type: 'input:touch:start', sessionId: 's', payload: { x: 0.5, y: 0.5 } })
    r.note({ type: 'input:touch:cancel', sessionId: 's' })
    r.note({ type: 'input:touch:start', sessionId: 's', payload: { x: 0.5, y: 0.5 } })
    on = false
    r.note({ type: 'input:touch:end', sessionId: 's', requestId: 't', payload: { x: 0.5, y: 0.5 } })
    on = true
    r.note(key('k', 'Enter')) // its encoding fails, and the frame is let go all the same
    await r.flush()
    await new Promise((res) => setTimeout(res, 0))
    expect(closed).toEqual(['frame', 'frame', 'frame'])
  })

  it('takes a button at its press, and commands, a paste and a cut by their own requestId', async () => {
    const { r, uploads } = recorder()
    r.note({ type: 'input:button', sessionId: 's', requestId: 'down', payload: { name: 'volume_up', phase: 'down' } })
    r.note({ type: 'input:button', sessionId: 's', requestId: 'up', payload: { name: 'volume_up', phase: 'up' } })
    r.note({ type: 'app:launch', sessionId: 's', requestId: 'launch', buildId: 1 })
    r.note({ type: 'clipboard:write', sessionId: 's', requestId: 'copy', payload: { text: 'x' } })
    r.note({ type: 'clipboard:write', sessionId: 's', requestId: 'paste', payload: { text: 'x', pasteAfter: true } })
    r.note({ type: 'input:rotate', sessionId: 's' })
    await r.flush()
    expect(uploads).toEqual(['down', 'launch', 'paste'])
  })

  it('keeps nothing while the person is not recorded, a gesture begun then included', async () => {
    let on = false
    const { r, uploads } = recorder({ recording: () => on })
    const [start, move, end] = touch('t1')
    r.note(start!)
    on = true
    r.note(move!)
    r.note(end!)
    r.note(key('k', 'KeyA'))
    on = false
    r.note(key('k2', 'Enter'))
    await r.flush()
    expect(uploads).toEqual(['k'])
  })

  it('asks again while the relay has not recorded the input or a read it waits on is still out', async () => {
    vi.useFakeTimers()
    const { r, uploads } = recorder({ status: [409, 409, 409, 201] })
    r.note(key('k', 'Enter'))
    const done = r.flush()
    await vi.advanceTimersByTimeAsync(2_000)
    await done
    expect(uploads).toEqual(['k', 'k', 'k', 'k'])
    vi.useRealTimers()
  })

  it('stops asking once a read could no longer be out', async () => {
    vi.useFakeTimers()
    const { r, uploads } = recorder({ status: Array<number>(40).fill(409) })
    r.note(key('k', 'Enter'))
    const done = r.flush()
    await vi.advanceTimersByTimeAsync(10_000)
    await done
    // Every 500 ms for 6 s: the first ask and twelve more.
    expect(uploads).toHaveLength(13)
    vi.useRealTimers()
  })

  // CodeRabbit on #1153: an upload that never answers must not keep the dialog on its loading screen.
  it('lets the dialog go on without a picture that does not arrive', async () => {
    vi.useFakeTimers()
    const r = new ThumbnailRecorder({
      sessionId: 's', surface: () => ({}) as CanvasImageSource, recording: () => true,
      grab: async () => ({}) as ImageBitmap, encode: async () => new Blob(['jpeg']),
      upload: () => new Promise<Response>(() => {}),
    })
    r.note(key('k', 'Enter'))
    let flushed = false
    void r.flush().then(() => { flushed = true })
    await vi.advanceTimersByTimeAsync(7_000)
    expect(flushed).toBe(false)
    await vi.advanceTimersByTimeAsync(1_500)
    expect(flushed).toBe(true)
    vi.useRealTimers()
  })

  // CodeRabbit on #1153: capture turned off ends that capture, so a key soon after it turns back on starts a new one.
  it('starts a typed run afresh after capture was turned off', async () => {
    let t = 0
    let on = true
    const { r, uploads } = recorder({ now: () => t, recording: () => on })
    r.note(key('a', 'KeyA'))
    on = false
    r.note(key('off', 'KeyB'))
    on = true
    t = 1_000
    r.note(key('c', 'KeyC'))
    await r.flush()
    expect(uploads).toEqual(['a', 'c'])
  })
})
