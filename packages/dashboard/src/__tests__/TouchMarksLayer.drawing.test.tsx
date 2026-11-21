import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { TouchMarksLayer } from '@/components/touch/TouchMarksLayer'
import { TouchMarkStore, type PlaceOnLayer } from '@/lib/touchMarks'

// The drawing itself, which the anchor tests cannot see: they hold where a mark is placed, and stay green with the
// drawing disconnected (review, CodeRabbit). A 2D context that records its calls, and frames run by hand.
type Call = { name: string; args: unknown[] }
let calls: Call[] = []
let frames = new Map<number, FrameRequestCallback>()
let nextFrame = 1

function fakeContext(): CanvasRenderingContext2D {
  const handler: ProxyHandler<object> = {
    get: (_t, name) => (...args: unknown[]) => { calls.push({ name: String(name), args }); return new Proxy({}, handler) },
    set: () => true,
  }
  return new Proxy({}, handler) as CanvasRenderingContext2D
}

/** Runs the frames asked for so far, as the browser would on its next paint. */
function flush(): void {
  act(() => {
    const due = [...frames.values()]
    frames.clear()
    for (const f of due) f(performance.now())
  })
}

const arcs = () => calls.filter((c) => c.name === 'arc').map((c) => [Math.round(c.args[0] as number), Math.round(c.args[1] as number)])
const sinceLastClear = () => { const i = calls.map((c) => c.name).lastIndexOf('clearRect'); return calls.slice(i) }

beforeEach(() => {
  calls = []
  frames = new Map()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => fakeContext() as never)
  // A 200 × 400 box, bled 40 px on each side.
  vi.spyOn(HTMLCanvasElement.prototype, 'clientWidth', 'get').mockReturnValue(280)
  vi.spyOn(HTMLCanvasElement.prototype, 'clientHeight', 'get').mockReturnValue(480)
  vi.stubGlobal('requestAnimationFrame', (f: FrameRequestCallback) => { const id = nextFrame++; frames.set(id, f); return id })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

const upright: PlaceOnLayer = (x, y) => ({ left: x, top: y })

describe('TouchMarksLayer — what it draws', () => {
  it('draws a machine\'s touch, and clears the canvas once there is none', () => {
    const { rerender } = render(<TouchMarksLayer tone="machine" place={upright} touch={{ id: 1, at: performance.now(), kind: 'tap', point: { x: 0.25, y: 0.5 } }} />)
    flush()
    expect(arcs()).toContainEqual([90, 240])
    rerender(<TouchMarksLayer tone="machine" place={upright} touch={null} />)
    flush()
    expect(sinceLastClear().some((c) => c.name === 'arc')).toBe(false)
  })

  // A device body turning spins the box by CSS: its size stays, so no resize redraws it. Mutation: drop the placement
  // from the drawing's dependencies, and the disc stays where it was.
  it('draws again where a mark now sits when the placement turns, then stops asking for frames', () => {
    const store = new TouchMarkStore()
    store.hover([{ x: 0.25, y: 0.5 }])
    const { rerender } = render(<TouchMarksLayer tone="person" place={upright} store={store} />)
    flush()
    expect(arcs()).toContainEqual([90, 240])
    calls = []
    rerender(<TouchMarksLayer tone="person" place={(x, y) => ({ left: 1 - y, top: x })} store={store} />)
    flush()
    expect(arcs()).toContainEqual([140, 140])
    expect(frames.size).toBe(0)
  })

  // The 200 × 400 box: 0.009 across is 1.8 px, 0.006 down is 2.4 px. The store judges the farthest point in the
  // pixels this layer draws in, which only the layer knows. Mutation: drop the layer's `measureIn`.
  it('has its store measure the farthest point in the pixels it draws in', () => {
    const store = new TouchMarkStore()
    render(<TouchMarksLayer tone="person" place={upright} store={store} />)
    flush()
    store.down([{ x: 0.4, y: 0.4 }], 0)
    store.move([{ x: 0.409, y: 0.4 }])
    store.move([{ x: 0.4, y: 0.406 }])
    expect(store.stateAt(0).touch?.fingers[0]!.far).toEqual({ x: 0.4, y: 0.406 })
  })

  // The canvas cannot read the screen under it, so the moving dot's blur is a CSS backdrop placed under the dot: in the
  // 200 × 400 box, a finger 100 px down from (90, 240) has its dot at (90, 340), 8.5 px in radius inside its border.
  // Mutation: place it at the start, or leave it shown once the swipe is a tap again.
  it('puts the CSS backdrop under a moving finger\'s dot, and nowhere when there is none', () => {
    const store = new TouchMarkStore()
    render(<TouchMarksLayer tone="person" place={upright} store={store} />)
    store.down([{ x: 0.25, y: 0.5 }], performance.now())
    store.move([{ x: 0.25, y: 0.75 }])
    flush()
    const [first, second] = screen.getAllByTestId('touch-glass')
    expect(first!.style.display).toBe('block')
    expect(first!.style.transform).toBe('translate(41.5px, 291.5px)')
    expect(first!.style.width).toBe('17px')
    expect(second!.style.display).toBe('none')
    act(() => { store.clear() })
    flush()
    expect(first!.style.display).toBe('none')
  })

  // A caller builds `place` on every render; the same mapping is not a reason to draw.
  it('does not draw again for a new function that places the same way', () => {
    const store = new TouchMarkStore()
    store.hover([{ x: 0.25, y: 0.5 }])
    const { rerender } = render(<TouchMarksLayer tone="person" place={(x, y) => ({ left: x, top: y })} store={store} />)
    flush()
    calls = []
    rerender(<TouchMarksLayer tone="person" place={(x, y) => ({ left: x, top: y })} store={store} />)
    flush()
    expect(calls).toEqual([])
  })
})
