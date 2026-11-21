import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  TOUCH_MARK as M, NO_TOUCH, PointerTouchMarks, TouchMarkStore, drawTouchParts, machineState, machineTouchEnd, stillParts, touchParts,
  type NormPoint, type TouchPart, type TouchState,
} from '@/lib/touchMarks'

// A 400 × 800 screen: 0.01 across is 4 px, 0.01 down is 8 px.
const toPx = (p: NormPoint) => ({ x: p.x * 400, y: p.y * 800 })
const kinds = (parts: TouchPart[]) => parts.map((p) => p.kind)
const pressed = (start: NormPoint, cur: NormPoint, far: NormPoint = cur, upAt: number | null = null): TouchState =>
  ({ hover: [], touch: { fingers: [{ start, cur, far }], downAt: 0, upAt } })

describe('touch marks — the motion (one for a person and a machine)', () => {
  it('shows the hover disc where the pointer is, and a pinch guide\'s two', () => {
    expect(touchParts({ hover: [{ x: 0.5, y: 0.5 }], touch: null }, 0, toPx)).toEqual([{ kind: 'disc', at: { x: 200, y: 400 }, r: M.hoverR }])
    expect(touchParts({ hover: [{ x: 0.2, y: 0.2 }, { x: 0.8, y: 0.8 }], touch: null }, 0, toPx)).toHaveLength(2)
    expect(touchParts(NO_TOUCH, 0, toPx)).toEqual([])
  })

  it('tightens a press from the hover disc to the pressed dot, at once with reduced motion', () => {
    const s = pressed({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 })
    expect(touchParts(s, 0, toPx)).toEqual([{ kind: 'disc', at: { x: 200, y: 400 }, r: M.hoverR }])
    expect(touchParts(s, M.growMs, toPx)).toEqual([{ kind: 'disc', at: { x: 200, y: 400 }, r: M.dotR }])
    expect(touchParts(s, 0, toPx, { reduced: true })).toEqual([{ kind: 'disc', at: { x: 200, y: 400 }, r: M.dotR }])
  })

  // A tap's release widens and fades; the hover disc is not drawn over it, and comes back once it is done.
  it('releases a tap as a widening ring, then shows the hover again', () => {
    const s = { ...pressed({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }, undefined, 100), hover: [{ x: 0.5, y: 0.5 }] }
    expect(touchParts(s, 100 + M.rippleMs / 2, toPx)).toEqual([{ kind: 'ring', at: { x: 200, y: 400 }, r: M.dotR + M.rippleGrowPx / 2, alpha: 0.5 }])
    expect(kinds(touchParts(s, 100 + M.rippleMs, toPx))).toEqual(['disc'])
    // Reduced motion: no ripple at all.
    expect(kinds(touchParts(s, 101, toPx, { reduced: true }))).toEqual(['disc'])
  })

  // The split is at 4 px of travel: 0.01 across is exactly 4 px, still a tap; 0.0125 (5 px) is a swipe.
  it('splits a press into a faint start, a line and a moving glass dot once it travels past 4 px', () => {
    expect(kinds(touchParts(pressed({ x: 0.5, y: 0.5 }, { x: 0.51, y: 0.5 }), 500, toPx))).toEqual(['disc'])
    const swipe = touchParts(pressed({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.6 }), 500, toPx)
    expect(swipe).toEqual([
      // From the start's centre — seen through its faint disc — to the finger.
      { kind: 'line', from: { x: 200, y: 400 }, to: { x: 200, y: 480 } },
      { kind: 'disc', at: { x: 200, y: 400 }, r: M.dotR, alpha: M.startAlpha },
      { kind: 'disc', at: { x: 200, y: 480 }, r: M.endR, glass: true },
    ])
  })

  it('shrinks the moving dot over the first 24 px of travel', () => {
    // 12 px down: half way.
    const half = touchParts(pressed({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.515 }), 500, toPx)
    expect(half.at(-1)).toEqual({ kind: 'disc', at: { x: 200, y: 412 }, r: (M.dotR + M.endR) / 2, glass: true })
  })

  // Judged by the farthest the finger went, not where it is: a swipe that comes back is still a swipe.
  it('keeps a swipe that came back to where it started a swipe', () => {
    expect(kinds(touchParts(pressed({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }, { x: 0.5, y: 0.7 }), 500, toPx))).toEqual(['disc', 'disc'])
  })

  // User: no fade, no easing. Mutation: fade it out over the hold, and the frame before the end stops matching.
  it('holds a lifted swipe whole for 200 ms, then removes it at once', () => {
    const s = pressed({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.6 }, undefined, 1000)
    const atLift = touchParts(s, 1000, toPx)
    expect(touchParts(s, 1000 + M.holdMs, toPx)).toEqual(atLift)
    expect(touchParts(s, 1000 + M.holdMs + 1, toPx)).toEqual([])
  })

  it('draws each finger of a pinch as a swipe', () => {
    const pinch: TouchState = { hover: [], touch: { downAt: 0, upAt: null, fingers: [
      { start: { x: 0.4, y: 0.4 }, cur: { x: 0.3, y: 0.3 }, far: { x: 0.3, y: 0.3 } },
      { start: { x: 0.6, y: 0.6 }, cur: { x: 0.7, y: 0.7 }, far: { x: 0.7, y: 0.7 } },
    ] } }
    expect(kinds(touchParts(pinch, 500, toPx))).toEqual(['line', 'disc', 'disc', 'line', 'disc', 'disc'])
  })

  it('draws a still picture\'s mark as the frame before the lift', () => {
    expect(stillParts({ kind: 'tap', point: { x: 0.5, y: 0.5 } }, toPx)).toEqual([{ kind: 'disc', at: { x: 200, y: 400 }, r: M.dotR }])
    expect(kinds(stillParts({ kind: 'swipe', from: { x: 0.5, y: 0.8 }, to: { x: 0.5, y: 0.2 } }, toPx))).toEqual(['line', 'disc', 'disc'])
  })
})

describe('touch marks — a machine\'s touch, played', () => {
  const tap = { id: 1, at: 1000, kind: 'tap' as const, point: { x: 0.5, y: 0.5 } }
  const swipe = { id: 2, at: 1000, kind: 'swipe' as const, from: { x: 0.5, y: 0.8 }, to: { x: 0.5, y: 0.2 }, durationMs: 400 }

  // Review of this change: a machine's touch arrives after the device already took it, so a hover before the press drew
  // the press 300 ms late, over the screen the touch brought. Mutation: wait before pressing.
  it('presses the moment it arrives, with no hover first', () => {
    expect(machineState(tap, 999)).toEqual(NO_TOUCH)
    const at = machineState(tap, 1000)
    expect(at.hover).toEqual([])
    expect(at.touch?.downAt).toBe(1000)
  })

  it('lifts a tap after its hold, and is done once the ripple is', () => {
    const lift = 1000 + M.tapMs
    expect(machineState(tap, lift - 1).touch?.upAt).toBeNull()
    expect(machineState(tap, lift).touch?.upAt).toBe(lift)
    expect(machineTouchEnd(tap)).toBe(lift + M.rippleMs)
  })

  it('moves a swipe\'s finger from one end to the other over its own length', () => {
    const moveAt = 1000 + M.swipeLeadMs
    expect(machineState(swipe, moveAt).touch?.fingers[0]!.cur).toEqual(swipe.from)
    const end = machineState(swipe, moveAt + 400).touch!
    expect(end.fingers[0]!.cur).toEqual(swipe.to)
    expect(end.upAt).toBe(moveAt + 400)
  })

  // A swipe that moves no further than the split is drawn as a tap, whose ripple outlasts a swipe's hold: ended at the
  // hold, the last frame left the ring half-widened on the screen (review). Mutation: end a swipe at its hold.
  it('keeps a swipe that barely moved going until its ripple is done', () => {
    const still = { id: 3, at: 1000, kind: 'swipe' as const, from: { x: 0.5, y: 0.5 }, to: { x: 0.5, y: 0.5 }, durationMs: 400 }
    const end = machineTouchEnd(still)
    expect(touchParts(machineState(still, end - 1), end - 1, toPx)).not.toEqual([])
    expect(touchParts(machineState(still, end), end, toPx)).toEqual([])
  })
})

describe('touch marks — the store and a person\'s pointer', () => {
  it('replaces a machine\'s touch with the next, and asks for frames only while one plays', () => {
    const store = new TouchMarkStore()
    store.play({ id: 1, at: 0, kind: 'tap', point: { x: 0.1, y: 0.1 } })
    store.play({ id: 2, at: 0, kind: 'tap', point: { x: 0.9, y: 0.9 } })
    expect(store.stateAt(10).touch?.fingers[0]!.start).toEqual({ x: 0.9, y: 0.9 })
    expect(store.animating(10)).toBe(true)
    expect(store.animating(10_000)).toBe(false)
  })

  it('keeps a finished touch until the drawing drops it, and never one still pressed', () => {
    const store = new TouchMarkStore()
    store.down([{ x: 0.5, y: 0.5 }], 0)
    store.dropFinished()
    expect(store.animating(1)).toBe(true)
    store.up(10)
    expect(store.animating(11)).toBe(true)
    store.dropFinished()
    expect(store.animating(12)).toBe(false)
  })

  // A press held still has nothing moving on its own: the layer stops drawing until a move wakes it (review).
  it('asks for frames while a press tightens and after a lift, not while it is held still', () => {
    const store = new TouchMarkStore()
    store.down([{ x: 0.5, y: 0.5 }], 0)
    expect(store.animating(M.growMs - 1)).toBe(true)
    expect(store.animating(M.growMs)).toBe(false)
    store.up(5000)
    expect(store.animating(5001)).toBe(true)
  })

  // A drag out and back is still a swipe: the store keeps the farthest point, not the latest (review: the model test
  // built `far` by hand). Mutation: `far: p`.
  it('remembers the farthest a finger went, so a drag that came back stays a swipe', () => {
    const store = new TouchMarkStore()
    store.down([{ x: 0.5, y: 0.5 }], 0)
    store.move([{ x: 0.5, y: 0.7 }])
    store.move([{ x: 0.5, y: 0.5 }])
    expect(store.stateAt(0).touch?.fingers[0]!.far).toEqual({ x: 0.5, y: 0.7 })
    expect(kinds(touchParts(store.stateAt(500), 500, toPx))).toEqual(['disc', 'disc'])
  })

  // On a screen taller than wide the farthest in fractions can be the nearer in pixels: 0.009 across is 3.6 px, 0.006
  // down is 4.8 px. Judged in fractions it kept the first and drew a tap; measured as drawn it is a swipe (review,
  // CodeRabbit). Mutation: compare in fractions again.
  it('measures the farthest point in the pixels it is drawn in, not the screen\'s fractions', () => {
    const store = new TouchMarkStore()
    store.measureIn(toPx)
    store.down([{ x: 0.4, y: 0.4 }], 0)
    store.move([{ x: 0.409, y: 0.4 }])
    store.move([{ x: 0.4, y: 0.406 }])
    expect(store.stateAt(0).touch?.fingers[0]!.far).toEqual({ x: 0.4, y: 0.406 })
    expect(kinds(touchParts(store.stateAt(0), 0, toPx))).toEqual(['line', 'disc', 'disc'])
  })

  // The user: Option alone shows the pinch guide, with no move needed.
  it('shows a pinch\'s two fingers as soon as Option is held, and one again when it is let go', () => {
    const p = new PointerTouchMarks()
    p.hover({ x: 0.3, y: 0.2 })
    p.option(true)
    expect(p.store.stateAt(0).hover).toEqual([{ x: 0.7, y: 0.8 }, { x: 0.3, y: 0.2 }])
    p.option(false)
    expect(p.store.stateAt(0).hover).toEqual([{ x: 0.3, y: 0.2 }])
  })

  it('presses and drags a pinch\'s two fingers mirrored, and one finger otherwise', () => {
    const p = new PointerTouchMarks()
    p.press({ x: 0.4, y: 0.4 }, true)
    p.drag({ x: 0.3, y: 0.3 })
    expect(p.store.stateAt(0).touch?.fingers.map((f) => f.cur)).toEqual([{ x: 0.7, y: 0.7 }, { x: 0.3, y: 0.3 }])
    p.lift()
    p.press({ x: 0.5, y: 0.5 }, false)
    expect(p.store.stateAt(0).touch?.fingers).toHaveLength(1)
  })

  it('drops the hover disc when the pointer leaves, and lets a touch being drawn play out', () => {
    const p = new PointerTouchMarks()
    p.press({ x: 0.5, y: 0.5 }, false)
    p.lift()
    p.leave()
    const s = p.store.stateAt(0)
    expect(s.hover).toEqual([])
    expect(s.touch?.upAt).not.toBeNull()
  })
})

describe('touch marks — the colour says which surface', () => {
  // A 2D context that remembers what each fill and stroke was drawn in; jsdom has none of its own.
  function recordingContext() {
    const fills: string[] = []
    const ctx = {
      fillStyle: '', strokeStyle: '' as unknown, lineWidth: 0, lineCap: '', globalAlpha: 1,
      shadowColor: '', shadowBlur: 0, shadowOffsetY: 0,
      save() {}, restore() {}, beginPath() {}, arc() {}, rect() {}, clip() {}, moveTo() {}, lineTo() {}, stroke() {},
      fill() { fills.push(ctx.fillStyle) },
      createLinearGradient: () => ({ addColorStop() {} }),
    }
    return { ctx: ctx as unknown as CanvasRenderingContext2D, fills }
  }
  const disc: TouchPart[] = [{ kind: 'disc', at: { x: 10, y: 10 }, r: M.dotR }]

  // Mutation: draw both tones in one colour.
  it('fills a person\'s touch light grey and a machine\'s blue, shadow and all', () => {
    const person = recordingContext()
    drawTouchParts(person.ctx, disc, 'person')
    const machine = recordingContext()
    drawTouchParts(machine.ctx, disc, 'machine')
    // The first fill is the shadow, the second the disc: a machine's are both blue (user: a dark shadow read grey).
    expect(person.fills).toEqual(['rgba(0,0,0,0.2)', 'rgba(228,228,228,0.8)'])
    expect(machine.fills).toEqual(['rgba(37,99,235,0.35)', 'rgba(59,130,246,0.8)'])
  })
})

describe('touch marks — the moving dot\'s glass in a recording', () => {
  afterEach(() => { vi.restoreAllMocks() })
  // A recording drew the device's frame first, so the dot's backdrop is on its own canvas: it is copied out and drawn
  // back blurred, inside the dot. The live layer blurs with CSS instead and must not do this.
  function blurringContext() {
    const filters: string[] = []
    const arcs: [number, number, number][] = []
    const images: [number, number][] = []
    const ctx = {
      canvas: {} as HTMLCanvasElement,
      fillStyle: '', strokeStyle: '' as unknown, lineWidth: 0, lineCap: '', globalAlpha: 1, shadowColor: '', shadowBlur: 0,
      set filter(f: string) { filters.push(f) },
      save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, moveTo() {}, lineTo() {}, stroke() {}, fill() {},
      setTransform() {}, drawImage(_: unknown, x: number, y: number) { images.push([x, y]) },
      arc(x: number, y: number, r: number) { arcs.push([x, y, r]) },
      getTransform: () => ({ a: 2, b: 0, c: 0, d: 2, e: 0, f: 0 }),
      createLinearGradient: () => ({ addColorStop() {} }),
    }
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({ clearRect() {}, drawImage() {} }) as never)
    return { ctx: ctx as unknown as CanvasRenderingContext2D, filters, arcs, images }
  }
  const swipe = stillParts({ kind: 'swipe', from: { x: 0.5, y: 0.8 }, to: { x: 0.5, y: 0.2 } }, toPx)

  // Mutation: blur every disc, or ignore the option.
  it('blurs under the moving dot alone, and only when asked', () => {
    const asked = blurringContext()
    drawTouchParts(asked.ctx, swipe, 'person', 2, { backdrop: true })
    expect(asked.filters).toEqual(['blur(6px)'])
    const live = blurringContext()
    drawTouchParts(live.ctx, swipe, 'person', 2)
    expect(live.filters).toEqual([])
  })

  // Where, in the canvas's own pixels: the dot at (200, 160) under a 2× transform is at (400, 320), and the blurred copy
  // is clipped to inside its border, (9.5 − 1) × 2 = 17 across the radius, from a patch around it. Mutations: swap x and
  // y, or blur the whole patch unclipped.
  it('blurs under the moving dot where the canvas has it, inside its border', () => {
    const { ctx, arcs, images } = blurringContext()
    drawTouchParts(ctx, swipe, 'person', 2, { backdrop: true })
    expect(arcs).toContainEqual([400, 320, (M.endR - 1) * 2])
    const pad = Math.ceil(M.endR * 2 + 4 * 3 * 2)
    expect(images.at(-1)).toEqual([400 - pad, 320 - pad])
  })
})

describe('touch marks — the line stops at the moving dot', () => {
  // The live page blurs only the screen under a glass dot, not the canvas's own line, so a line through it stayed sharp
  // (user, 2026-11-21). Mutation: drop the clip, and the line is stroked with nothing cut away.
  it('cuts the line out of the moving dot, where it went down to its edge', () => {
    const calls: string[] = []
    const ctx = new Proxy({} as Record<string, unknown>, {
      get: (t, k) => k === 'createLinearGradient' ? () => { calls.push('line'); return { addColorStop() {} } }
        : k === 'arc' ? (x: number, y: number, r: number) => { calls.push(`arc ${x},${y},${r}`) }
        : k === 'clip' ? (rule?: string) => { calls.push(`clip ${rule ?? ''}`) }
        : k === 'save' ? () => { calls.push('save') }
        : k in t ? t[k as string] : () => {},
      set: (t, k, v) => { t[k as string] = v; return true },
    })
    // From (200, 640) up to (200, 160): the dot is at the end, `endR` across inside the clip.
    drawTouchParts(ctx as unknown as CanvasRenderingContext2D, stillParts({ kind: 'swipe', from: { x: 0.5, y: 0.8 }, to: { x: 0.5, y: 0.2 } }, toPx), 'person')
    const line = calls.indexOf('line')
    const block = calls.slice(calls.lastIndexOf('save', line), line)
    expect(block).toEqual(['save', `arc 200,160,${M.endR}`, 'clip evenodd'])
  })
})

describe('touch marks — a pinch\'s two glass dots', () => {
  // A single even-odd path over two overlapping dots let the line back in where they overlap (review): each dot is cut
  // on its own. Mutation: one path for both.
  it('cuts the line out of each glass dot with a clip of its own', () => {
    let clips = 0
    let line = -1
    const ctx = new Proxy({} as Record<string, unknown>, {
      get: (t, k) => k === 'clip' ? () => { clips++ }
        : k === 'createLinearGradient' ? () => { if (line < 0) line = clips; return { addColorStop() {} } }
        : k in t ? t[k as string] : () => {},
      set: (t, k, v) => { t[k as string] = v; return true },
    })
    const pinch: TouchState = { hover: [], touch: { downAt: 0, upAt: null, fingers: [
      { start: { x: 0.45, y: 0.5 }, cur: { x: 0.49, y: 0.5 }, far: { x: 0.49, y: 0.5 } },
      { start: { x: 0.55, y: 0.5 }, cur: { x: 0.51, y: 0.5 }, far: { x: 0.51, y: 0.5 } },
    ] } }
    drawTouchParts(ctx as unknown as CanvasRenderingContext2D, touchParts(pinch, 500, toPx), 'person')
    expect(line).toBe(2)
  })
})

describe('touch marks — what the renderer applies', () => {
  // The model hands over colours, alphas and the glass flag; these hold that the renderer uses them (review: a fill-only
  // record let the machine's border, the faint start and the glass fill change unseen). Mutations: machine border white,
  // `globalAlpha = 1`, glass filled like a press.
  function styleContext() {
    const fills: string[] = []
    const strokes: string[] = []
    const ctx = {
      fillStyle: '', strokeStyle: '' as unknown, lineWidth: 0, lineCap: '', globalAlpha: 1, shadowColor: '', shadowBlur: 0,
      save() {}, restore() {}, beginPath() {}, arc() {}, rect() {}, clip() {}, moveTo() {}, lineTo() {},
      fill() { fills.push(`${ctx.fillStyle}@${ctx.globalAlpha}`) },
      stroke() { if (typeof ctx.strokeStyle === 'string') strokes.push(ctx.strokeStyle) },
      createLinearGradient: () => ({ addColorStop() {} }),
    }
    return { ctx: ctx as unknown as CanvasRenderingContext2D, fills, strokes }
  }
  const swipe = stillParts({ kind: 'swipe', from: { x: 0.5, y: 0.8 }, to: { x: 0.5, y: 0.2 } }, toPx)

  it('borders a person\'s mark white and a machine\'s blue-300', () => {
    const person = styleContext(); drawTouchParts(person.ctx, [{ kind: 'disc', at: { x: 10, y: 10 }, r: M.dotR }], 'person')
    const machine = styleContext(); drawTouchParts(machine.ctx, [{ kind: 'disc', at: { x: 10, y: 10 }, r: M.dotR }], 'machine')
    expect(person.strokes).toContain('#fff')
    expect(machine.strokes).toContain('#93c5fd')
    expect(machine.strokes).not.toContain('#fff')
  })

  it('draws a swipe\'s start faint and its moving dot as lighter glass', () => {
    const { ctx, fills } = styleContext()
    drawTouchParts(ctx, swipe, 'person')
    const discs = fills.filter((f) => f.startsWith('rgba(228'))
    expect(discs).toEqual([`rgba(228,228,228,0.8)@${M.startAlpha}`, 'rgba(228,228,228,0.4)@1'])
  })
})
