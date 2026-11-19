import { describe, expect, it } from 'vitest'
import { judgeTouch, parseFramestats, parseHit, seenAt, type HitAnswer, type HitNode, type TouchFacts } from '../touchObservation.js'

const APP = 'dev.tapflow.sample.compose'

// Measured: `hit 0.162 0.519` on the Compose sample's Submit (Pixel_9_tapflow Android 14, 2026-11-18). The Button node
// carries no id and no name; the clickable node above it has the test tag.
const SUBMIT = '{"rx":647878995308,"w":1080,"h":2424,"under":"dev.tapflow.sample.compose","type":1,"pkg":"dev.tapflow.sample.compose","branch":[{"c":"android.widget.Button","b":[53,1205,296,1311]},{"c":"android.view.View","id":"form.submit","k":1,"b":[53,1195,296,1321]},{"c":"android.view.View","b":[0,211,1080,2361]},{"c":"android.view.View","b":[0,211,1080,2361]},{"c":"androidx.compose.ui.platform.ComposeView","b":[0,211,1080,2361]},{"c":"android.widget.FrameLayout","id":"android:id\\/content","b":[0,211,1080,2361]},{"c":"android.view.ViewGroup","id":"android:id\\/decor_content_parent","b":[0,0,1080,2361]},{"c":"android.widget.FrameLayout","b":[0,0,1080,2424]}],"done":648105508475}'

const hitOf = (branch: HitNode[], over: Partial<HitAnswer> = {}): HitAnswer =>
  ({ rx: 1, done: 2, w: 1000, h: 2000, type: 1, pkg: APP, under: APP, branch, ...over })
const node = (c: string, extra: Partial<HitNode> = {}): HitNode => ({ c, b: [100, 200, 300, 400], ...extra })

describe('parseHit', () => {
  it('reads a measured answer', () => {
    const hit = parseHit(SUBMIT)!
    expect(hit.pkg).toBe(APP)
    expect(hit.branch).toHaveLength(8)
    expect(hit.branch![1]).toEqual({ c: 'android.view.View', id: 'form.submit', k: 1, b: [53, 1195, 296, 1321] })
    expect(hit.done! - hit.rx).toBe(226513167)
  })

  it('refuses what is not an answer, and drops a node with no bounds', () => {
    expect(parseHit('')).toBeNull()
    expect(parseHit('{"error":"x"}')).toBeNull()
    expect(parseHit('not json')).toBeNull()
    const hit = parseHit('{"rx":1,"w":10,"h":10,"type":1,"branch":[{"c":"a"},{"c":"b","b":[0,0,1,1]}]}')!
    expect(hit.branch).toEqual([{ c: 'b', b: [0, 0, 1, 1] }])
  })
})

describe('seenAt', () => {
  it('names a Compose button by the test tag above it, as the tree names it', () => {
    const seen = seenAt(parseHit(SUBMIT)!, APP)
    expect(seen).toEqual({
      kind: 'app',
      observation: { element: { identifier: 'form.submit', traits: 0, frame: { x: 0.0491, y: 0.493, width: 0.2249, height: 0.0519 } } },
      takes: true, scrollable: false, opaque: false,
    })
  })

  it('takes the element from the deepest named node and the button from the nearest one the tree calls a button', () => {
    const seen = seenAt(hitOf([
      node('android.widget.TextView', { t: 'Order' }),
      node('android.widget.Button', { id: 'app:id/order', t: 'Order now', k: 1 }),
      node('android.widget.LinearLayout', { k: 16 }),
    ]), APP)
    expect(seen).toMatchObject({
      kind: 'app',
      observation: { element: { label: 'Order', traits: 0 }, button: { identifier: 'app:id/order', label: 'Order now', traits: 1 } },
      scrollable: true,
    })
  })

  it('names an input by its id only, never by what it holds, and marks it', () => {
    const seen = seenAt(hitOf([node('android.widget.EditText', { id: 'form.email', t: 'qa@wdio.dev', k: 7 })]), APP)
    expect(seen).toMatchObject({ observation: { element: { identifier: 'form.email', input: true, traits: 0 } } })
    expect(JSON.stringify(seen)).not.toContain('qa@wdio.dev')
    const password = seenAt(hitOf([node('android.view.View', { d: 'secret', k: 8 })]), APP)
    expect(password).toMatchObject({ observation: {} })
    // Editable whatever its class: its description can be the value.
    const custom = seenAt(hitOf([node('com.example.CodeInputView', { d: 'qa@wdio.dev', k: 4 })]), APP)
    expect(JSON.stringify(custom)).not.toContain('qa@wdio.dev')
  })

  it('leaves out the window decor ids, and cuts a long name', () => {
    const seen = seenAt(hitOf([node('android.widget.FrameLayout', { id: 'android:id/content' }), node('android.widget.TextView', { t: 'x'.repeat(300) })]), APP)
    expect(seen).toMatchObject({ observation: { element: { label: 'x'.repeat(256) } } })
    expect(JSON.stringify(seen)).not.toContain('android:id/content')
  })

  it('reports nothing for a touch on another app or the system', () => {
    expect(seenAt(hitOf([], { pkg: 'com.google.android.apps.nexuslauncher' }), APP)).toEqual({ kind: 'elsewhere' })
    expect(seenAt(hitOf([], { type: 3, pkg: 'com.android.systemui' }), APP)).toEqual({ kind: 'elsewhere' })
    expect(seenAt({ rx: 1, w: 10, h: 10 }, APP)).toBeNull()
  })

  it('says the keyboard for a touch on the IME over the app, and nothing over another app', () => {
    const ime = { type: 2, pkg: 'com.google.android.inputmethod.latin', branch: [] }
    expect(seenAt(hitOf([], ime), APP)).toMatchObject({ kind: 'app', observation: { surface: 'keyboard' }, opaque: true })
    expect(seenAt(hitOf([], { ...ime, under: 'com.other' }), APP)).toEqual({ kind: 'elsewhere' })
  })

  it('names a web view and Flutter as surfaces, and a view drawing its own surface as opaque', () => {
    expect(seenAt(hitOf([node('android.view.View', { t: 'Sign in' }), node('android.webkit.WebView')]), APP))
      .toMatchObject({ observation: { surface: 'web' }, opaque: true })
    expect(seenAt(hitOf([node('io.flutter.embedding.android.FlutterView')]), APP)).toMatchObject({ observation: { surface: 'flutter' } })
    expect(seenAt(hitOf([node('android.view.TextureView', { id: 'app:id/map' })]), APP))
      .toMatchObject({ observation: { element: { identifier: 'app:id/map' } }, opaque: true })
  })
})

const HEADER = 'Flags,FrameTimelineVsyncId,IntendedVsync,Vsync,InputEventId,HandleInputStart,AnimationStart,PerformTraversalsStart,DrawStart,FrameDeadline,FrameInterval,FrameStartTime,SyncQueued,SyncStart,IssueDrawCommandsStart,SwapBuffers,FrameCompleted,DequeueBufferDuration,QueueBufferDuration,GpuCompleted,SwapBuffersCompleted,DisplayPresentTime,CommandSubmissionCompleted,'
const row = (completed: number, flags = 0, vsync = completed - 20e6) =>
  HEADER.split(',').slice(0, -1).map((h) => (h === 'Flags' ? flags : h === 'IntendedVsync' ? vsync : h === 'FrameCompleted' ? completed : 0)).join(',') + ','
/** `dumpsys gfxinfo` as Android 14 prints it: a header naming the process, then one PROFILEDATA block per window. */
const framestatsText = (pid: number, ...windows: string[][]) =>
  `Applications Graphics Acceleration Info:\n\n** Graphics info for pid ${pid} [${APP}] **\n\nStats since: 1ns\n`
  + windows.map((rows) => `\n---PROFILEDATA---\n${HEADER}\n${rows.join('\n')}\n---PROFILEDATA---\n\n`).join('View hierarchy:\n')

describe('parseFramestats', () => {
  it('reads the process and every window\'s completed frames, one per vsync, skipping skipped frames', () => {
    const f = parseFramestats(framestatsText(4495, [row(100e6), row(200e6), row(300e6, 8)], [row(205e6, 0, 180e6), row(400e6)]))!
    expect(f.pid).toBe(4495)
    // The second window's frame on the first's vsync (180e6) is one frame, at the later completion.
    expect(f.completed).toEqual([100e6, 205e6, 400e6])
    expect(f.since).toBe(0)
  })

  it('knows a full ring lists only its newest frames', () => {
    const rows = Array.from({ length: 120 }, (_, i) => row((1000 + i * 16) * 1e6))
    expect(parseFramestats(framestatsText(1, rows))!.since).toBe(1000e6)
  })

  it('is null with no process', () => {
    expect(parseFramestats('No process found for: dev.tapflow.sample.compose\n')).toBeNull()
  })
})

describe('judgeTouch', () => {
  const ms = 1e6
  const DOWN = 10_000 * ms, UP = DOWN + 100 * ms
  const frames = (...at: number[]) => ({ pid: 1, completed: at.map((t) => DOWN + t * ms), since: 0 })
  const seen = (over: Partial<Extract<ReturnType<typeof seenAt>, { kind: 'app' }>> = {}) =>
    ({ kind: 'app' as const, observation: {}, takes: false, scrollable: false, opaque: false, ...over })
  const facts = (over: Partial<TouchFacts> = {}): TouchFacts =>
    ({ frames: frames(), downNs: DOWN, upNs: UP, moved: false, seen: seen(), ...over })

  it('acted: frames drawn after a tap on a quiet app (m3: 6–53 for controls)', () => {
    expect(judgeTouch(facts({ frames: frames(120, 140, 160) }))).toEqual({ moving: false, acted: true })
  })

  it('did not act: nothing drawn, and nothing there takes touches', () => {
    expect(judgeTouch(facts())).toEqual({ moving: false, acted: false })
  })

  it('unknown where nothing was drawn but something there takes touches, or one frame was (a View row)', () => {
    expect(judgeTouch(facts({ seen: seen({ takes: true }) }))).toEqual({ moving: false })
    expect(judgeTouch(facts({ frames: frames(120) }))).toEqual({ moving: false })
  })

  it('unknown when the app was drawing before the touch, or the previous tap\'s answer may still be drawing', () => {
    expect(judgeTouch(facts({ frames: frames(-50, 120, 140) }))).toEqual({ moving: false })
    expect(judgeTouch(facts({ previousTapUpNs: DOWN - 500 * ms }))).toEqual({ moving: false })
    expect(judgeTouch(facts({ previousTapUpNs: DOWN - 900 * ms }))).toEqual({ moving: false, acted: false })
  })

  it('unknown for a drag, a surface, or frames that no longer reach back before the touch', () => {
    expect(judgeTouch(facts({ moved: true }))).toEqual({ moving: false })
    expect(judgeTouch(facts({ seen: seen({ opaque: true }) }))).toEqual({ moving: false })
    expect(judgeTouch(facts({ frames: { ...frames(), since: DOWN - 100 * ms } }))).toEqual({ moving: false })
    expect(judgeTouch(facts({ frames: null }))).toEqual({ moving: false })
  })

  it('moving: a list under the touch, drawing every vsync up to it, after a fling', () => {
    const gliding = frames(-150, -133, -117, -100, -83, -67, -50, -33, -17)
    expect(judgeTouch(facts({ frames: gliding, swipeEndNs: DOWN - 1_000 * ms, seen: seen({ scrollable: true }) }))).toEqual({ moving: true })
    // Each sign alone is not enough: no fling just before, no list there, or too few frames.
    expect(judgeTouch(facts({ frames: gliding, seen: seen({ scrollable: true }) })).moving).toBe(false)
    expect(judgeTouch(facts({ frames: gliding, swipeEndNs: DOWN - 4_000 * ms, seen: seen({ scrollable: true }) })).moving).toBe(false)
    expect(judgeTouch(facts({ frames: gliding, swipeEndNs: DOWN - 1_000 * ms })).moving).toBe(false)
    expect(judgeTouch(facts({ frames: frames(-150, -100, -50, -17), swipeEndNs: DOWN - 1_000 * ms, seen: seen({ scrollable: true }) })).moving).toBe(false)
  })

  // Review of P4: a list the touch stopped stops drawing (measured: no frame after the down, Compose LazyColumn); a
  // spinner or a shimmer draws on through it, and is no list to stop.
  it('is not moving where the app goes on drawing through the touch', () => {
    const through = frames(-150, -133, -117, -100, -83, -67, -50, -33, -17, 0, 17, 33, 50, 67, 83, 100, 117, 133)
    expect(judgeTouch(facts({ frames: through, swipeEndNs: DOWN - 1_000 * ms, seen: seen({ scrollable: true }) })).moving).toBe(false)
  })
})
