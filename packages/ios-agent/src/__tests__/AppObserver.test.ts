import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, statSync, readdirSync, writeFileSync, symlinkSync, mkdirSync, existsSync, readFileSync, lstatSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AppObserver, fieldOf, keyboardOf, type AppTouch, type ObserverRead } from '../AppObserver'

// The host side of the app observer (#1135): the code inside the app answers a nonce written to `request`, and the
// agent judges what it reads. These hold that judgement; app-observer.m itself is measured on a simulator (AGENTS.md).

const UDID = 'D3290FCF-0000-0000-0000-000000000001'
let root: string
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }) })

function setup(opts: { running?: boolean; deadlineMs?: number } = {}) {
  root = mkdtempSync(join(tmpdir(), 'observer-'))
  let n = 100n
  const asked: string[] = []
  const observer = new AppObserver(
    { appRunning: async () => opts.running ?? true },
    { root, deadlineMs: opts.deadlineMs ?? 300, pollMs: 2, nonce: () => ++n },
  )
  const dir = observer.dir(UDID)
  return { observer, dir, asked }
}

/**
 * Plays the app: answers each request it finds, the way app-observer.m does, with `body` filled in. Given `bundle`, it
 * answers only a request naming that bundle, as app-observer.m does; without one it answers any.
 */
function app(dir: string, body: (nonce: string) => Record<string, unknown> | undefined, bundle?: string) {
  let last = ''
  const timer = setInterval(() => {
    // Read once, not checked first: the agent takes the request back the moment it has an answer, and a read between
    // a check and the read threw ENOENT out of this timer, an unhandled error that failed the run (CI on #1165).
    let text: string
    try { text = readFileSync(join(dir, 'request'), 'utf8') } catch { return }
    const [nonce = '', asked] = text.split('\n')
    if (bundle !== undefined && asked !== bundle) return
    if (nonce === last) return
    last = nonce
    const answer = body(nonce)
    if (answer) writeFileSync(join(dir, `${nonce}.json`), JSON.stringify(answer), { mode: 0o600 })
  }, 1)
  return () => clearInterval(timer)
}

const KEYBOARD_UP = { shown: true, orientation: 1, rect: { x: 0, y: 0.62, width: 1, height: 0.38 } }

describe('asking the app', () => {
  it('reads the answer to its own nonce, and removes it', async () => {
    const { observer, dir } = setup()
    await observer.prepare(UDID)
    const stop = app(dir, (nonce) => ({ nonce, bundle: 'com.app', pid: 1, keyboard: KEYBOARD_UP, field: { reason: 'no-focus' } }))
    const read = await observer.read(UDID, 'com.app')
    stop()
    expect(read).toEqual({ kind: 'answer', keyboard: KEYBOARD_UP, field: { reason: 'no-focus' } })
    expect(readdirSync(dir).filter((f) => f.endsWith('.json'))).toEqual([])
  })

  it('drops an answer for another app, rather than reading it as this one\'s', async () => {
    const { observer, dir } = setup()
    await observer.prepare(UDID)
    const stop = app(dir, (nonce) => ({ nonce, bundle: 'com.other', pid: 1, keyboard: KEYBOARD_UP, field: {} }))
    const read = await observer.read(UDID, 'com.app')
    stop()
    expect(read.kind).toBe('silent')
  })

  // Every app observed since the boot watches the same directory, and one sent behind the app asked about can still
  // answer for a few seconds (iOS 27.0): first, so the read was dropped as another app's, or over the right answer.
  it('names the app it asks about, so only that app answers', async () => {
    const { observer, dir } = setup()
    await observer.prepare(UDID)
    const requests: string[] = []
    const peek = setInterval(() => { try { requests.push(readFileSync(join(dir, 'request'), 'utf8')) } catch { /* not yet */ } }, 1)
    const other = app(dir, (nonce) => ({ nonce, bundle: 'com.other', pid: 1, keyboard: {}, field: {} }), 'com.other')
    const asked = app(dir, (nonce) => ({ nonce, bundle: 'com.app', pid: 2, keyboard: KEYBOARD_UP, field: { reason: 'no-focus' } }), 'com.app')
    const read = await observer.read(UDID, 'com.app')
    other(); asked(); clearInterval(peek)
    expect(read).toEqual({ kind: 'answer', keyboard: KEYBOARD_UP, field: { reason: 'no-focus' } })
    expect(requests[0]).toBe('101\ncom.app')
  })

  // A suspended app cannot answer: the marker it wrote on DidEnterBackground says where it is, without the wait.
  it('reads an app behind the home screen as away, at once, from its background marker', async () => {
    const { observer, dir } = setup({ deadlineMs: 5_000 })
    await observer.prepare(UDID)
    writeFileSync(join(dir, 'background'), 'com.app')
    const started = Date.now()
    expect(await observer.read(UDID, 'com.app')).toEqual({ kind: 'away' })
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(existsSync(join(dir, 'request'))).toBe(false)
  })

  it('reads no answer as away when the app has no process, and as unknown when it has one', async () => {
    const gone = setup({ running: false })
    await gone.observer.prepare(UDID)
    expect(await gone.observer.read(UDID, 'com.app')).toEqual({ kind: 'away' })
    rmSync(root, { recursive: true, force: true })
    const silent = setup({ running: true })
    await silent.observer.prepare(UDID)
    expect(await silent.observer.read(UDID, 'com.app')).toEqual({ kind: 'silent' })
  })

  // An app installed and never opened, on the home screen: waiting out the deadline made each read there take ~2 s, and
  // Capture's default range kept the home-screen taps before the icon tap.
  it('reads an app with no process as away well before the deadline', async () => {
    root = mkdtempSync(join(tmpdir(), 'observer-'))
    const observer = new AppObserver({ appRunning: async () => false }, { root, deadlineMs: 2_000, pollMs: 2, processCheckMs: 20 })
    await observer.prepare(UDID)
    const t0 = Date.now()
    expect(await observer.read(UDID, 'com.app')).toEqual({ kind: 'away' })
    expect(Date.now() - t0).toBeLessThan(500)
    expect(readdirSync(observer.dir(UDID))).not.toContain('request')
  })

  // Pre-PR review: a marker left after the request was written (the app went to the background just then) is read at
  // the process check, not after the deadline.
  it('reads a background marker that appears while it waits as away, before the deadline', async () => {
    root = mkdtempSync(join(tmpdir(), 'observer-'))
    const observer = new AppObserver({ appRunning: async () => true }, { root, deadlineMs: 2_000, pollMs: 2, processCheckMs: 30 })
    await observer.prepare(UDID)
    // Written once the request is there (CodeRabbit on #1182): before it, the check ahead of the request would read it.
    const dir = observer.dir(UDID)
    const marker = setInterval(() => { if (existsSync(join(dir, 'request'))) { writeFileSync(join(dir, 'background'), 'com.app'); clearInterval(marker) } }, 1)
    const t0 = Date.now()
    expect(await observer.read(UDID, 'com.app')).toEqual({ kind: 'away' })
    expect(Date.now() - t0).toBeLessThan(500)
  })

  it('asks for the process again at the deadline, so an app that quit while it waited is away', async () => {
    root = mkdtempSync(join(tmpdir(), 'observer-'))
    const answers = [true, false]
    const observer = new AppObserver({ appRunning: async () => answers.shift() ?? false }, { root, deadlineMs: 80, pollMs: 2, processCheckMs: 10 })
    await observer.prepare(UDID)
    expect(await observer.read(UDID, 'com.app')).toEqual({ kind: 'away' })
    expect(answers).toEqual([])
  })

  it('reads a process check that fails as unknown, never as away', async () => {
    root = mkdtempSync(join(tmpdir(), 'observer-'))
    const observer = new AppObserver({ appRunning: async () => { throw new Error('simctl') } }, { root, deadlineMs: 80, pollMs: 2, processCheckMs: 10 })
    await observer.prepare(UDID)
    expect(await observer.read(UDID, 'com.app')).toEqual({ kind: 'silent' })
  })

  it('does not ask for the process when the app answers at once, and waits on when it has one', async () => {
    root = mkdtempSync(join(tmpdir(), 'observer-'))
    const appRunning = vi.fn(async () => true)
    const observer = new AppObserver({ appRunning }, { root, deadlineMs: 150, pollMs: 2, processCheckMs: 40 })
    await observer.prepare(UDID)
    const stop = app(observer.dir(UDID), (nonce) => ({ nonce, bundle: 'com.app', pid: 1, keyboard: KEYBOARD_UP, field: null }))
    expect((await observer.read(UDID, 'com.app')).kind).toBe('answer')
    stop()
    expect(appRunning).not.toHaveBeenCalled()
    // Running and silent: the read waits for the app to the deadline rather than calling it away, and asks again there,
    // since the app may have quit meanwhile (CodeRabbit on #1182).
    const t0 = Date.now()
    expect(await observer.read(UDID, 'com.app')).toEqual({ kind: 'silent' })
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140)
    expect(appRunning).toHaveBeenCalledTimes(2)
  })

  // A keyboard probe and a field read are asked together after a key on the soft keyboard: a second request written
  // before the first is answered would replace it.
  it('asks one request at a time per device, so each gets its own answer', async () => {
    const { observer, dir } = setup()
    await observer.prepare(UDID)
    const stop = app(dir, (nonce) => ({ nonce, bundle: 'com.app', pid: 1, keyboard: { shown: false, orientation: 1 }, field: { reason: 'no-focus', n: nonce } }))
    const reads = await Promise.all([observer.read(UDID, 'com.app'), observer.read(UDID, 'com.app')])
    stop()
    expect(reads.map((r) => r.kind)).toEqual(['answer', 'answer'])
    const nonces = reads.map((r) => (r.kind === 'answer' ? (r.field as { n: string }).n : ''))
    expect(new Set(nonces).size).toBe(2)
  })

  // An app that starts after its asker gave up would answer into a file nobody reads, holding a field's value.
  it('takes back a request nobody answered, and clears an answer that came too late for anyone', async () => {
    const { observer, dir } = setup({ running: true, deadlineMs: 50 })
    await observer.prepare(UDID)
    expect(await observer.read(UDID, 'com.app')).toEqual({ kind: 'silent' })
    expect(existsSync(join(dir, 'request'))).toBe(false)
    writeFileSync(join(dir, '42.json'), '{"field":{"value":"typed"}}')
    utimesSync(join(dir, '42.json'), new Date(Date.now() - 10_000), new Date(Date.now() - 10_000))
    await observer.read(UDID, 'com.app')
    expect(existsSync(join(dir, '42.json'))).toBe(false)
  })

  it('takes back its request once answered, so a process started next does not answer it again', async () => {
    const { observer, dir } = setup()
    await observer.prepare(UDID)
    const stop = app(dir, (nonce) => ({ nonce, bundle: 'com.app', pid: 1, keyboard: KEYBOARD_UP, field: {} }))
    expect((await observer.read(UDID, 'com.app')).kind).toBe('answer')
    stop()
    expect(existsSync(join(dir, 'request'))).toBe(false)
  })

  it('removes an answer that lands after its asker gave up', async () => {
    root = mkdtempSync(join(tmpdir(), 'observer-'))
    const observer = new AppObserver({ appRunning: async () => true }, { root, deadlineMs: 20, pollMs: 2, lateAnswerMs: 60, nonce: () => 101n })
    const dir = observer.dir(UDID)
    await observer.prepare(UDID)
    expect((await observer.read(UDID, 'com.app')).kind).toBe('silent')
    writeFileSync(join(dir, '101.json'), '{"field":{"value":"typed"}}')
    await vi.waitFor(() => expect(existsSync(join(dir, '101.json'))).toBe(false), { timeout: 1000 })
  })

  // Behind reads on an app that stopped answering, a read can outwait the relay (5 s); asked then, it only holds up
  // the reads behind it.
  it('answers a read that waited in line longer than the relay waits as unknown, without asking', async () => {
    root = mkdtempSync(join(tmpdir(), 'observer-'))
    let asked = 0
    const observer = new AppObserver({ appRunning: async () => true }, {
      root, deadlineMs: 80, pollMs: 2, staleQueueMs: 40, nonce: () => BigInt(++asked),
    })
    await observer.prepare(UDID)
    const [first, second] = await Promise.all([observer.read(UDID, 'com.app'), observer.read(UDID, 'com.app')])
    expect([first.kind, second.kind]).toEqual(['silent', 'silent'])
    expect(asked).toBe(1)
  })

  it('asks nothing without an app to ask about', async () => {
    const { observer } = setup()
    expect(await observer.read(UDID, '')).toEqual({ kind: 'silent' })
  })
})

// Record-time observation: the app writes a report per touch-down while the agent records a person.
describe('the app\'s touch reports', () => {
  it('turns them on and off with the file the app looks for', async () => {
    const { observer, dir } = setup()
    await observer.prepare(UDID)
    await observer.watchTouches(UDID, true)
    expect(statSync(join(dir, 'touches')).mode & 0o777).toBe(0o600)
    await observer.watchTouches(UDID, false)
    expect(existsSync(join(dir, 'touches'))).toBe(false)
  })

  it('stops the reports and removes any left on disk', async () => {
    const { observer, dir } = setup()
    await observer.prepare(UDID)
    await observer.watchTouches(UDID, true)
    writeFileSync(join(dir, 'touch-1.json'), '{}')
    writeFileSync(join(dir, 'touch-2.json.tmp'), '{}')
    writeFileSync(join(dir, 'touch-2-end.json'), '{}')
    writeFileSync(join(dir, 'touch-3-end.json.tmp'), '{}')
    writeFileSync(join(dir, 'background'), 'com.app')
    await observer.stopTouches(UDID)
    expect(readdirSync(dir).sort()).toEqual(['background'])
  })

  // CodeRabbit on #1166: every gesture's pairing takes on its own, and two takes in flight read the same report.
  it('gives each report to one take, when takes overlap', async () => {
    const { observer, dir } = setup()
    await observer.prepare(UDID)
    for (let seq = 1; seq <= 5; seq++) writeFileSync(join(dir, `touch-${seq}.json`), JSON.stringify({ seq, at: seq, bundle: 'com.app', point: { x: 0.5, y: 0.5 }, moving: false }))
    const takes = await Promise.all([observer.takeTouches(UDID), observer.takeTouches(UDID), observer.takeTouches(UDID)])
    expect(takes.flat().map((t) => t.seq).sort()).toEqual([1, 2, 3, 4, 5])
  })

  // P2a: the verdict that follows a touch-down, and iOS's own count of a quick repeat.
  it('reads a verdict file beside the down reports, and the tap count a down report carries', async () => {
    const { observer, dir } = setup()
    await observer.prepare(UDID)
    writeFileSync(join(dir, 'touch-1.json'), JSON.stringify({ seq: 1, at: 10, bundle: 'com.app', point: { x: 0.5, y: 0.5 }, moving: false, tapCount: 2 }))
    writeFileSync(join(dir, 'touch-1-end.json'), JSON.stringify({ seq: 1, at: 10, bundle: 'com.app', acted: false }))
    writeFileSync(join(dir, 'touch-2-end.json'), JSON.stringify({ seq: 2, at: 11, bundle: 'com.app', acted: 'yes' }))
    writeFileSync(join(dir, 'touch-3-end.json'), JSON.stringify({ seq: 3, bundle: 'com.app', acted: true }))
    writeFileSync(join(dir, 'touch-4.json'), JSON.stringify({ seq: 4, at: 12, bundle: 'com.app', point: { x: 0, y: 0 }, moving: false, tapCount: 0 }))
    const taken = await observer.takeTouches(UDID)
    expect(taken).toEqual([
      { seq: 1, at: 10, bundle: 'com.app', observation: { point: { x: 0.5, y: 0.5 }, moving: false, tapCount: 2 } },
      { seq: 1, at: 10, bundle: 'com.app', end: true, acted: false },
      // Not a boolean: the verdict is unknown, not refused.
      { seq: 2, at: 11, bundle: 'com.app', end: true },
      { seq: 4, at: 12, bundle: 'com.app', observation: { point: { x: 0, y: 0 }, moving: false } },
    ])
    expect(readdirSync(dir).filter((f) => f.startsWith('touch-'))).toEqual([])
  })

  it('cuts a long label or identifier, which would fill the capture on every tap', async () => {
    const { observer, dir } = setup()
    await observer.prepare(UDID)
    writeFileSync(join(dir, 'touch-1.json'), JSON.stringify({ seq: 1, at: 1, bundle: 'com.app', point: { x: 0, y: 0 }, moving: false, element: { label: 'x'.repeat(5000), identifier: 'y'.repeat(5000), traits: 0 } }))
    const [t] = await observer.takeTouches(UDID) as AppTouch[]
    expect(t!.observation.element!.label).toHaveLength(256)
    expect(t!.observation.element!.identifier).toHaveLength(256)
  })

  it('reads each report once, oldest first, and keeps only what the protocol carries', async () => {
    const { observer, dir } = setup()
    await observer.prepare(UDID)
    const write = (seq: number, body: Record<string, unknown>) => writeFileSync(join(dir, `touch-${seq}.json`), JSON.stringify({ seq, at: 1000 + seq, bundle: 'com.app', point: { x: 0.5, y: 0.4 }, moving: false, ...body }))
    write(2, { element: { label: 'Donuts', identifier: 'd', traits: 1, frame: { x: 0.1, y: 0.2, width: 0.3, height: 0.04 }, extra: 'x' }, windowPoint: { x: 0.5, y: 0.4 } })
    write(1, { moving: true })
    // A text input is named by its identifier only, whatever the file says.
    write(3, { element: { label: 'hunter2', identifier: 'form.password', traits: 262144, input: true } })
    write(4, { surface: 'keyboard', element: { label: 'q', traits: 1 } })
    // Ten sorts before two by name: the order is the app's sequence, not the file name's.
    write(10, { moving: false })
    writeFileSync(join(dir, 'touch-5.json'), 'not json')
    writeFileSync(join(dir, 'touch-6.json'), JSON.stringify({ seq: 6, at: 'soon', bundle: 'com.app', point: { x: 0, y: 0 } }))
    const touches = await observer.takeTouches(UDID) as AppTouch[]
    expect(touches.map((t) => t.seq)).toEqual([1, 2, 3, 4, 10])
    expect(touches[0]!.observation).toEqual({ point: { x: 0.5, y: 0.4 }, moving: true })
    expect(touches[1]!.observation.element).toEqual({ label: 'Donuts', identifier: 'd', traits: 1, frame: { x: 0.1, y: 0.2, width: 0.3, height: 0.04 } })
    expect(touches[2]!.observation.element).toEqual({ identifier: 'form.password', traits: 262144, input: true })
    expect(touches[3]!.observation).toEqual({ point: { x: 0.5, y: 0.4 }, moving: false, surface: 'keyboard' })
    expect(readdirSync(dir).filter((f) => f.startsWith('touch-'))).toEqual([])
    expect(await observer.takeTouches(UDID)).toEqual([])
  })
})

describe('preparing a device', () => {
  it('makes the directory private and empties what a previous boot left', async () => {
    const { observer, dir } = setup()
    mkdirSync(dir, { recursive: true })
    for (const f of ['7.json', 'request', 'background']) writeFileSync(join(dir, f), 'old')
    await observer.prepare(UDID)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    // The marker stays: a device picked up again may hold the app suspended behind the home screen.
    expect(readdirSync(dir)).toEqual(['background'])
  })

  it('replaces a symlink rather than following it', async () => {
    const { observer, dir } = setup()
    const elsewhere = join(root, 'elsewhere')
    mkdirSync(elsewhere)
    writeFileSync(join(elsewhere, 'keep'), 'x')
    symlinkSync(elsewhere, dir)
    await observer.prepare(UDID)
    expect(lstatSync(dir).isSymbolicLink()).toBe(false)
    expect(existsSync(join(elsewhere, 'keep'))).toBe(true)
  })
})

describe('what a read becomes', () => {
  const answer = (keyboard: unknown, field: unknown): ObserverRead => ({ kind: 'answer', keyboard, field })

  it('reads away as the runner\'s "not in front", and silence as unknown', () => {
    expect(keyboardOf({ kind: 'away' })).toEqual({ shown: null, onHome: true })
    expect(keyboardOf({ kind: 'silent' })).toEqual({ shown: null })
    expect(fieldOf({ kind: 'away' })).toEqual({ field: null, reason: 'no-app' })
    expect(fieldOf({ kind: 'silent' })).toEqual({ field: null, reason: 'failed' })
  })

  it('reads the keyboard through the runner\'s parser, turned for a landscape app', () => {
    expect(keyboardOf(answer(KEYBOARD_UP, {}))).toMatchObject({ shown: true, onHome: false, rect: { x: 0, y: 0.62 } })
    // UIInterfaceOrientation 4 (landscape left): the interface rect is turned onto the portrait framebuffer.
    const turned = keyboardOf(answer({ shown: true, orientation: 4, rect: { x: 0, y: 0.483, width: 1, height: 0.517 } }, {}))
    expect(turned.rect?.height).toBeCloseTo(1)
    expect(turned.rect?.width).toBeCloseTo(0.517)
  })

  // An app keeps running for a while after Home (iOS 27: answering 3 s later), so its answer carries its state.
  it('reads an answer from the background as not in front, and an inactive app\'s raised keyboard as unknown', () => {
    expect(keyboardOf(answer({ ...KEYBOARD_UP, state: 2 }, {}))).toEqual({ shown: null, onHome: true })
    expect(fieldOf(answer({ ...KEYBOARD_UP, state: 2 }, { reason: 'secure' }))).toEqual({ field: null, reason: 'no-app' })
    expect(keyboardOf(answer({ ...KEYBOARD_UP, state: 1 }, {}))).toEqual({ shown: null })
    // Down while inactive is down: the permission alert's Allow is an app tap, as it was.
    expect(keyboardOf(answer({ shown: false, orientation: 1, state: 1 }, {}))).toEqual({ shown: false, onHome: false })
    expect(keyboardOf(answer({ ...KEYBOARD_UP, state: 0 }, {}))).toMatchObject({ shown: true })
  })

  it('keeps a secure field\'s value out, and reads a field it cannot vouch for as secure', () => {
    const frame = { x: 0, y: 100, width: 300, height: 34 }
    expect(fieldOf(answer({}, { identifier: 'pw', placeholder: 'Password', frame, type: 'secure', reason: 'secure', value: 'leak' }))).toMatchObject({
      field: { identifier: 'pw', secure: true }, reason: 'secure',
    })
    expect(fieldOf(answer({}, { identifier: 'pw', placeholder: '', frame, type: 'secure', value: 'leak' })).field).not.toHaveProperty('value')
    // A WKWebView's field, or any responder not one of UIKit's text classes: the observer says secure, never false.
    expect(fieldOf(answer({}, { reason: 'secure', keyboard: KEYBOARD_UP }))).toMatchObject({ field: null, reason: 'secure' })
  })
})
