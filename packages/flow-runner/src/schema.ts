import { parse as parseYaml } from 'yaml'
import { ValidationError } from '@tapflowio/agent-core/errors'
import type { LaunchOptions } from '@tapflowio/protocol'
import { compactLaunchOptions, launchOptionsProblem } from '@tapflowio/protocol/launch'
import type { EffectAnchor, StepExpect } from './effect.js'

export interface Selector {
  // Bare-string selector: resolved as exact identifier → exact label → partial label.
  text?: string
  id?: string
  label?: string
  // Disambiguators for the object form: role narrows by element kind (button/cell/…),
  // index (0-based) picks the Nth match when role/label still resolve to several.
  role?: string
  index?: number
  timeoutMs?: number
}

export type ScrollDirection = 'up' | 'down' | 'left' | 'right'

/** Held with a key. The names are the flow's; the wire carries them as the HID bitmap `keyModifierBits` builds. */
export type KeyModifier = 'shift' | 'ctrl' | 'alt' | 'meta'

// The HID modifier bits both agents read from `input:key` (protocol `InputKey`; iOS passes them to the touch helper,
// Android maps each to its left-hand meta key).
const KEY_MODIFIER_BITS: Record<KeyModifier, number> = { ctrl: 0x01, shift: 0x02, alt: 0x04, meta: 0x08 }

export function keyModifierBits(modifiers: readonly KeyModifier[] = []): number {
  return modifiers.reduce((bits, m) => bits | KEY_MODIFIER_BITS[m], 0)
}

export type Step =
  | { type: 'clearState'; appId?: string }
  | { type: 'launchApp'; options?: LaunchOptions }
  /** `expect`, on the four touch steps: what the touch brings on screen and takes off it, which a run looks for after
   *  it (#1125). Flow Capture writes it from what Verify saw; a flow without it is checked for nothing more. */
  | { type: 'tapOn'; selector: Selector; expect?: StepExpect }
  /** `tapOn: [x, y]` — a point, for a screen whose tree names nothing there. The last resort: it waits for nothing and
   *  lands wherever the layout puts that point. Its own type so every reader of `selector` stays one. */
  | { type: 'tapPoint'; at: [number, number]; expect?: StepExpect }
  /** `replace`: what the field holds is replaced, not added to — the field is selected first. What Flow Capture writes
   *  when it read the field's value (#1135). Android selects with Ctrl+A, which it takes from Android 13. */
  | { type: 'inputText'; text: string; replace?: true }
  /** `inputText: { secret: NAME }` — the value is given to the run, never written in the flow, and never logged. */
  /** `replace`, as on `inputText`: a secret Flow Capture read as a field's whole value replaces what it holds. */
  | { type: 'inputSecret'; name: string; replace?: true }
  | { type: 'pressKey'; code: string; modifiers?: KeyModifier[] }
  /** The focused field's own action — Done, Next, Search, Go — as its keyboard's action key presses it (#1135). Not
   *  `pressKey: Enter`: an Android app that checks which action it was given does not take an Enter key event. */
  | { type: 'imeAction' }
  | { type: 'swipe'; from: [number, number]; to: [number, number]; durationMs: number }
  /** With `until`, scrolls until that element is on screen rather than once — what a swipe was for, not how far it went. */
  | { type: 'scroll'; direction: ScrollDirection; until?: Selector }
  | { type: 'openUrl'; url: string }
  | { type: 'assertVisible'; selector: Selector }
  | { type: 'assertNotVisible'; selector: Selector }
  | { type: 'pressButton'; name: string }
  | { type: 'longPressOn'; selector: Selector; durationMs: number; expect?: StepExpect }
  /** `longPressOn: [x, y]` or `{ on: [x, y], durationMs }` — a point, as `tapPoint`. */
  | { type: 'longPressPoint'; at: [number, number]; durationMs: number; expect?: StepExpect }
  | { type: 'pinch'; on: Selector | [number, number]; scale: number; durationMs: number }
  | { type: 'setOrientation'; orientation: 'portrait' | 'landscape' }
  | { type: 'setPosture'; posture: 'folded' | 'unfolded' }

/** A screen's size in the device's own units (iOS points, Android pixels), the shorter side first. */
export interface Viewport {
  width: number
  height: number
}

export interface Flow {
  name: string
  appId?: string
  tags?: string[]
  /** The screen a flow's points were made on (#1125). A point is a fraction of the screen, and on a screen of another
   *  size the layout under it differs, so a run on one is refused before its first step. Flow Capture writes it when the
   *  flow touches a point. */
  viewport?: Viewport
  steps: Step[]
  file?: string
}

const SCROLL_DIRECTIONS = new Set<string>(['up', 'down', 'left', 'right'])
const KEY_MODIFIERS = new Set<string>(['shift', 'ctrl', 'alt', 'meta'])
// The shape of an environment variable's name, since that is where the CLI reads the value from.
const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Whether `inputText: { secret }` accepts this name — the dashboard checks a secret it lets a person rename. */
export function isSecretName(name: string): boolean {
  return SECRET_NAME.test(name)
}
const DEFAULT_SWIPE_DURATION_MS = 300
// Both platforms recognise a long press at about half a second; twice that leaves room for a busy Mac's timing
// (#1037). Holding past the threshold changes nothing for an ordinary long press, so the margin costs only time.
const DEFAULT_LONG_PRESS_MS = 1000
const DEFAULT_PINCH_MS = 500
// A hold or a pinch keeps a pointer down for its whole length, and nothing on the agent or the relay lifts one a
// client left open, so a length is capped at what a test could mean rather than at what a timer can hold.
const MAX_GESTURE_MS = 60_000
// Wider than this and the two fingers no longer fit on a screen at a spacing a recogniser reads as two.
const MIN_PINCH_SCALE = 0.1
const MAX_PINCH_SCALE = 10
const MAX_TIMER_MS = 2_147_483_647
const MAX_TIMEOUT_SECONDS = MAX_TIMER_MS / 1000

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function parseSelector(v: unknown, ctx: string): Selector {
  if (typeof v === 'string') {
    if (v.length === 0) throw new ValidationError(`${ctx}: selector must not be empty`)
    return { text: v }
  }
  if (isRecord(v)) {
    const { id, label, role, index, timeout, ...rest } = v as {
      id?: unknown; label?: unknown; role?: unknown; index?: unknown; timeout?: unknown
    }
    const unknownKeys = Object.keys(rest)
    if (unknownKeys.length > 0) throw new ValidationError(`${ctx}: unknown selector keys: ${unknownKeys.join(', ')}`)
    if (id === undefined && label === undefined && role === undefined) {
      throw new ValidationError(`${ctx}: selector needs "id", "label", or "role"`)
    }
    const selector: Selector = {}
    if (id !== undefined) {
      if (typeof id !== 'string' || id.length === 0) throw new ValidationError(`${ctx}: "id" must be a non-empty string`)
      selector.id = id
    }
    if (label !== undefined) {
      if (typeof label !== 'string' || label.length === 0) throw new ValidationError(`${ctx}: "label" must be a non-empty string`)
      selector.label = label
    }
    if (role !== undefined) {
      if (typeof role !== 'string' || role.length === 0) throw new ValidationError(`${ctx}: "role" must be a non-empty string`)
      selector.role = role
    }
    if (index !== undefined) {
      if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) throw new ValidationError(`${ctx}: "index" must be a non-negative integer`)
      selector.index = index
    }
    if (timeout !== undefined) {
      if (typeof timeout !== 'number' || !Number.isFinite(timeout) || !(timeout > 0) || timeout > MAX_TIMEOUT_SECONDS) {
        throw new ValidationError(`${ctx}: "timeout" must be a positive number of seconds no greater than ${MAX_TIMEOUT_SECONDS}`)
      }
      const timeoutMs = Math.round(timeout * 1000)
      if (timeoutMs <= 0) {
        throw new ValidationError(`${ctx}: "timeout" must be at least 1ms (got ${timeout}s, which rounds to 0ms)`)
      }
      selector.timeoutMs = timeoutMs
    }
    return selector
  }
  throw new ValidationError(`${ctx}: selector must be a string or { id, label, role, index, timeout }`)
}

function parsePoint(v: unknown, ctx: string, key: string): [number, number] {
  // Number.isFinite guards YAML's `.nan`/`.inf`, which pass plain range checks
  if (!Array.isArray(v) || v.length !== 2 || v.some((n) => typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1)) {
    throw new ValidationError(`${ctx}: "${key}" must be [x, y] with normalized 0-1 coordinates`)
  }
  return [v[0] as number, v[1] as number]
}

function parseGestureMs(v: unknown, ctx: string, fallback: number): number {
  if (v === undefined) return fallback
  if (typeof v !== 'number' || !Number.isFinite(v) || !(v > 0) || v > MAX_GESTURE_MS) {
    throw new ValidationError(`${ctx}: "durationMs" must be a positive number no greater than ${MAX_GESTURE_MS}ms`)
  }
  return v
}

/** The steps a touch's expected effect may ride on. */
export const EXPECTING_STEPS = new Set<Step['type']>(['tapOn', 'tapPoint', 'longPressOn', 'longPressPoint'])

const ANCHOR_KEYS = new Set(['id', 'text', 'role', 'checked', 'selected'])

function parseAnchors(v: unknown, ctx: string, key: string): EffectAnchor[] {
  if (!Array.isArray(v) || v.length === 0) throw new ValidationError(`${ctx}: "expect.${key}" must be a non-empty list`)
  return v.map((a, i) => {
    const at = `${ctx}: expect.${key}[${i}]`
    if (!isRecord(a)) throw new ValidationError(`${at}: must be a mapping of id, text, role, checked, selected`)
    const unknownKeys = Object.keys(a).filter((k) => !ANCHOR_KEYS.has(k))
    if (unknownKeys.length > 0) throw new ValidationError(`${at}: unknown keys: ${unknownKeys.join(', ')} (expected id, text, role, checked, selected)`)
    for (const k of ['id', 'text', 'role'] as const) {
      if (a[k] !== undefined && (typeof a[k] !== 'string' || a[k] === '')) throw new ValidationError(`${at}: "${k}" must be a non-empty string`)
    }
    for (const k of ['checked', 'selected'] as const) {
      if (a[k] !== undefined && typeof a[k] !== 'boolean') throw new ValidationError(`${at}: "${k}" must be true or false`)
    }
    // An anchor naming nothing would match every element, so a "gone" one could never pass and an "appear" one always would.
    if (a.id === undefined && a.text === undefined) throw new ValidationError(`${at}: needs an id or a text`)
    return a as EffectAnchor
  })
}

function parseExpect(v: unknown, ctx: string): StepExpect {
  if (!isRecord(v)) throw new ValidationError(`${ctx}: "expect" must be { appear, gone }`)
  const { appear, gone, ...rest } = v
  const unknownKeys = Object.keys(rest)
  if (unknownKeys.length > 0) throw new ValidationError(`${ctx}: unknown expect keys: ${unknownKeys.join(', ')} (expected appear, gone)`)
  if (appear === undefined && gone === undefined) throw new ValidationError(`${ctx}: "expect" needs appear or gone`)
  return {
    ...(appear !== undefined ? { appear: parseAnchors(appear, ctx, 'appear') } : {}),
    ...(gone !== undefined ? { gone: parseAnchors(gone, ctx, 'gone') } : {}),
  }
}

/**
 * A step, with what its touch is expected to bring beside the action: `- tapOn: "Save"` / `  expect: { appear: [...] }`
 * (#1125). One more key than a step had before, so a CLI older than it refuses the file — accepted: flows are
 * experimental, and a second file per flow would be the cost on every flow from then on.
 */
function parseStep(raw: unknown, ctx: string): Step {
  if (isRecord(raw) && Object.hasOwn(raw, 'expect')) {
    const { expect, ...action } = raw
    const step = parseAction(action, ctx)
    if (!EXPECTING_STEPS.has(step.type)) {
      throw new ValidationError(`${ctx}: "expect" goes only on a touch step (tapOn, longPressOn), not on ${Object.keys(action)[0] ?? 'nothing'}`)
    }
    return { ...step, expect: parseExpect(expect, ctx) } as Step
  }
  return parseAction(raw, ctx)
}

function parseAction(raw: unknown, ctx: string): Step {
  if (typeof raw === 'string') {
    if (raw === 'clearState') return { type: 'clearState' }
    if (raw === 'launchApp') return { type: 'launchApp' }
    if (raw === 'scroll') return { type: 'scroll', direction: 'down' }
    if (raw === 'imeAction') return { type: 'imeAction' }
    throw new ValidationError(`${ctx}: unknown step "${raw}"`)
  }
  if (!isRecord(raw)) throw new ValidationError(`${ctx}: step must be a keyword or a single-key mapping`)
  const keys = Object.keys(raw)
  if (keys.length !== 1) throw new ValidationError(`${ctx}: step must have exactly one key (got: ${keys.join(', ') || 'none'})`)
  const key = keys[0]
  const value = raw[key]

  switch (key) {
    case 'clearState': {
      if (typeof value !== 'string' || value.length === 0) throw new ValidationError(`${ctx}: "clearState" takes a bundle id (or use the bare keyword with a flow-level appId)`)
      return { type: 'clearState', appId: value }
    }
    case 'launchApp': {
      // `launchApp:` with nothing after it is YAML null, the same step as the bare keyword.
      if (value === null) return { type: 'launchApp' }
      if (!isRecord(value)) throw new ValidationError(`${ctx}: "launchApp" takes { arguments, env } or nothing`)
      const { arguments: args, env, ...rest } = value
      const unknownKeys = Object.keys(rest)
      if (unknownKeys.length > 0) throw new ValidationError(`${ctx}: unknown launchApp keys: ${unknownKeys.join(', ')} (expected arguments, env)`)
      // The same check the relay and the agents apply, so a flow that loads is one every door accepts.
      const problem = launchOptionsProblem({ arguments: args, env })
      if (problem) throw new ValidationError(`${ctx}: launchApp ${problem}`)
      const options = compactLaunchOptions({ arguments: args, env } as LaunchOptions)
      return options ? { type: 'launchApp', options } : { type: 'launchApp' }
    }
    // An array is a point and anything else a selector, as `pinch.on` reads them.
    case 'tapOn': return Array.isArray(value)
      ? { type: 'tapPoint', at: parsePoint(value, ctx, 'tapOn') }
      : { type: 'tapOn', selector: parseSelector(value, ctx) }
    case 'assertVisible': return { type: 'assertVisible', selector: parseSelector(value, ctx) }
    case 'assertNotVisible': return { type: 'assertNotVisible', selector: parseSelector(value, ctx) }
    case 'inputText': {
      if (isRecord(value) && !('secret' in value)) {
        const { text, replace, ...rest } = value
        const unknownKeys = Object.keys(rest)
        if (unknownKeys.length > 0) throw new ValidationError(`${ctx}: unknown inputText keys: ${unknownKeys.join(', ')} (expected text and replace, or secret)`)
        if (typeof text !== 'string') throw new ValidationError(`${ctx}: "inputText.text" must be a string`)
        if (replace !== undefined && typeof replace !== 'boolean') throw new ValidationError(`${ctx}: "inputText.replace" must be true or false`)
        return replace === true ? { type: 'inputText', text, replace: true } : { type: 'inputText', text }
      }
      if (isRecord(value)) {
        const { secret, replace, ...rest } = value
        const unknownKeys = Object.keys(rest)
        if (unknownKeys.length > 0) throw new ValidationError(`${ctx}: unknown inputText keys: ${unknownKeys.join(', ')} (expected secret and replace)`)
        if (typeof secret !== 'string' || !SECRET_NAME.test(secret)) {
          throw new ValidationError(`${ctx}: "secret" must be a name like PASSWORD (letters, digits and _, not starting with a digit)`)
        }
        if (replace !== undefined && typeof replace !== 'boolean') throw new ValidationError(`${ctx}: "inputText.replace" must be true or false`)
        return replace === true ? { type: 'inputSecret', name: secret, replace: true } : { type: 'inputSecret', name: secret }
      }
      if (typeof value !== 'string') throw new ValidationError(`${ctx}: "inputText" must be a string, { text, replace } or { secret: NAME }`)
      return { type: 'inputText', text: value }
    }
    case 'pressKey': {
      if (isRecord(value)) {
        const { code, modifiers, ...rest } = value
        const unknownKeys = Object.keys(rest)
        if (unknownKeys.length > 0) throw new ValidationError(`${ctx}: unknown pressKey keys: ${unknownKeys.join(', ')} (expected code, modifiers)`)
        if (typeof code !== 'string' || code.length === 0) throw new ValidationError(`${ctx}: "code" must be a key code like KeyA, Enter, ArrowLeft`)
        if (!Array.isArray(modifiers) || modifiers.length === 0
          || modifiers.some((m) => typeof m !== 'string' || !KEY_MODIFIERS.has(m)) || new Set(modifiers).size !== modifiers.length) {
          throw new ValidationError(`${ctx}: "modifiers" must be a list of distinct shift, ctrl, alt, meta`)
        }
        return { type: 'pressKey', code, modifiers: modifiers as KeyModifier[] }
      }
      if (typeof value !== 'string' || value.length === 0) throw new ValidationError(`${ctx}: "pressKey" must be a key code like Enter, Backspace, Escape, or { code, modifiers }`)
      return { type: 'pressKey', code: value }
    }
    case 'openUrl': {
      if (typeof value !== 'string' || value.length === 0) throw new ValidationError(`${ctx}: "openUrl" must be a URL string`)
      return { type: 'openUrl', url: value }
    }
    case 'scroll': {
      if (isRecord(value)) {
        const { direction, until, ...rest } = value
        const unknownKeys = Object.keys(rest)
        if (unknownKeys.length > 0) throw new ValidationError(`${ctx}: unknown scroll keys: ${unknownKeys.join(', ')} (expected direction, until)`)
        if (direction !== undefined && (typeof direction !== 'string' || !SCROLL_DIRECTIONS.has(direction))) {
          throw new ValidationError(`${ctx}: "scroll" direction must be one of up, down, left, right`)
        }
        // The only reason for the mapping form: a direction alone is the string form.
        if (until === undefined || until === null) throw new ValidationError(`${ctx}: "scroll" as a mapping needs "until": the element to scroll to`)
        return { type: 'scroll', direction: (direction ?? 'down') as ScrollDirection, until: parseSelector(until, ctx) }
      }
      if (typeof value !== 'string' || !SCROLL_DIRECTIONS.has(value)) {
        throw new ValidationError(`${ctx}: "scroll" direction must be one of up, down, left, right`)
      }
      return { type: 'scroll', direction: value as ScrollDirection }
    }
    case 'swipe': {
      if (!isRecord(value)) throw new ValidationError(`${ctx}: "swipe" must be { from, to, durationMs? }`)
      const { from, to, durationMs, ...rest } = value as { from?: unknown; to?: unknown; durationMs?: unknown }
      const unknownKeys = Object.keys(rest)
      if (unknownKeys.length > 0) throw new ValidationError(`${ctx}: unknown swipe keys: ${unknownKeys.join(', ')}`)
      const parsed: Step = {
        type: 'swipe',
        from: parsePoint(from, ctx, 'from'),
        to: parsePoint(to, ctx, 'to'),
        durationMs: DEFAULT_SWIPE_DURATION_MS,
      }
      if (durationMs !== undefined) {
        // Fractional durations (e.g. 250.5) worked on 0.23.0 and stay valid;
        // only non-finite, non-positive or over-limit values are rejected.
        if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || !(durationMs > 0) || durationMs > MAX_TIMER_MS) {
          throw new ValidationError(`${ctx}: "durationMs" must be a positive number no greater than ${MAX_TIMER_MS}ms`)
        }
        parsed.durationMs = durationMs
      }
      return parsed
    }
    case 'pressButton': {
      // Any name: whether the device has the button is the device's question, answered before the run starts
      // (`unavailableButton`), not one this file can settle.
      if (typeof value !== 'string' || value.length === 0) throw new ValidationError(`${ctx}: "pressButton" must be a button name like home, back, lock, volume_up`)
      return { type: 'pressButton', name: value }
    }
    case 'longPressOn': {
      // A duration rides beside the selector under "on", never inside it: `{ label, durationMs }` would change how
      // a bare string matches (label only, never the identifier) to change how long it is held.
      if (isRecord(value) && Object.hasOwn(value, 'on')) {
        const { on, durationMs, ...rest } = value
        const unknownKeys = Object.keys(rest)
        if (unknownKeys.length > 0) throw new ValidationError(`${ctx}: unknown longPressOn keys: ${unknownKeys.join(', ')} (expected on, durationMs)`)
        const ms = parseGestureMs(durationMs, ctx, DEFAULT_LONG_PRESS_MS)
        return Array.isArray(on)
          ? { type: 'longPressPoint', at: parsePoint(on, ctx, 'on'), durationMs: ms }
          : { type: 'longPressOn', selector: parseSelector(on, ctx), durationMs: ms }
      }
      if (isRecord(value) && Object.hasOwn(value, 'durationMs')) {
        throw new ValidationError(`${ctx}: "longPressOn" takes a duration beside the selector — put the selector under "on": { on: <selector>, durationMs }`)
      }
      if (Array.isArray(value)) return { type: 'longPressPoint', at: parsePoint(value, ctx, 'longPressOn'), durationMs: DEFAULT_LONG_PRESS_MS }
      return { type: 'longPressOn', selector: parseSelector(value, ctx), durationMs: DEFAULT_LONG_PRESS_MS }
    }
    case 'pinch': {
      if (!isRecord(value)) throw new ValidationError(`${ctx}: "pinch" must be { on, scale, durationMs? }`)
      const { on, scale, durationMs, ...rest } = value
      const unknownKeys = Object.keys(rest)
      if (unknownKeys.length > 0) throw new ValidationError(`${ctx}: unknown pinch keys: ${unknownKeys.join(', ')} (expected on, scale, durationMs)`)
      if (on === undefined || on === null) throw new ValidationError(`${ctx}: "on" must be a selector or [x, y]`)
      // An array is a point and anything else a selector, so the two never compete for one value.
      const target = Array.isArray(on) ? parsePoint(on, ctx, 'on') : parseSelector(on, ctx)
      if (typeof scale !== 'number' || !Number.isFinite(scale) || scale < MIN_PINCH_SCALE || scale > MAX_PINCH_SCALE || scale === 1) {
        throw new ValidationError(`${ctx}: "scale" must be a number from ${MIN_PINCH_SCALE} to ${MAX_PINCH_SCALE}, other than 1 (above 1 spreads the fingers, below 1 closes them)`)
      }
      return { type: 'pinch', on: target, scale, durationMs: parseGestureMs(durationMs, ctx, DEFAULT_PINCH_MS) }
    }
    case 'setOrientation': {
      // A target, never "turn it": a toggle repeated is a different result, which a replay may not be (#910).
      if (value !== 'portrait' && value !== 'landscape') throw new ValidationError(`${ctx}: "setOrientation" must be portrait or landscape`)
      return { type: 'setOrientation', orientation: value }
    }
    case 'setPosture': {
      // The names the dashboard shows. A posture's id is the platform's and differs between them, so a flow names the
      // end of the device's list it wants: folded is the most closed posture, unfolded the most open.
      if (value !== 'folded' && value !== 'unfolded') throw new ValidationError(`${ctx}: "setPosture" must be folded or unfolded`)
      return { type: 'setPosture', posture: value }
    }
    default:
      throw new ValidationError(`${ctx}: unknown step "${key}"`)
  }
}

// Not `path.basename`: this module is to load in a browser too (Flow Capture), where there is no `path`. Both
// separators, as Windows' basename takes them.
function baseName(file: string): string {
  return file.slice(Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\')) + 1)
}

function parseViewport(v: unknown, file: string): Viewport {
  if (!isRecord(v)) throw new ValidationError(`${file}: "viewport" must be { width, height }`)
  const { width, height, ...rest } = v
  const unknownKeys = Object.keys(rest)
  if (unknownKeys.length > 0) throw new ValidationError(`${file}: unknown viewport keys: ${unknownKeys.join(', ')} (expected width, height)`)
  for (const [k, n] of [['width', width], ['height', height]] as const) {
    if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) throw new ValidationError(`${file}: "viewport.${k}" must be a positive number`)
  }
  return { width: width as number, height: height as number }
}

export function parseFlow(yamlText: string, file: string): Flow {
  let doc: unknown
  try {
    doc = parseYaml(yamlText)
  } catch (e) {
    throw new ValidationError(`${file}: invalid YAML — ${(e as Error).message}`)
  }
  if (!isRecord(doc)) throw new ValidationError(`${file}: flow must be a YAML mapping with a "steps" list`)

  const { name, appId, tags, viewport, steps, ...rest } = doc as { name?: unknown; appId?: unknown; tags?: unknown; viewport?: unknown; steps?: unknown }
  const unknownKeys = Object.keys(rest)
  if (unknownKeys.length > 0) throw new ValidationError(`${file}: unknown top-level keys: ${unknownKeys.join(', ')}`)
  if (name !== undefined && typeof name !== 'string') throw new ValidationError(`${file}: "name" must be a string`)
  if (appId !== undefined && typeof appId !== 'string') throw new ValidationError(`${file}: "appId" must be a string`)
  if (!Array.isArray(steps) || steps.length === 0) throw new ValidationError(`${file}: "steps" must be a non-empty list`)
  // `--include-tags` and `--exclude-tags` take a comma-separated list, so a tag with a comma in it could never be named.
  if (tags !== undefined && (!Array.isArray(tags) || tags.some((t) => typeof t !== 'string' || t.trim().length === 0 || t.includes(',')))) {
    throw new ValidationError(`${file}: "tags" must be a list of non-empty strings without commas`)
  }

  const parsedSteps = steps.map((raw, i) => parseStep(raw, `${file}: steps[${i}]`))
  const size = viewport === undefined ? undefined : parseViewport(viewport, file)

  for (const [i, step] of parsedSteps.entries()) {
    if (step.type === 'clearState' && !step.appId && !appId) {
      throw new ValidationError(`${file}: steps[${i}]: bare "clearState" requires a flow-level appId`)
    }
  }

  return {
    name: (name as string | undefined) ?? baseName(file).replace(/\.ya?ml$/i, ''),
    ...(appId !== undefined ? { appId: appId as string } : {}),
    ...(tags !== undefined ? { tags: (tags as string[]).map((t) => t.trim()) } : {}),
    ...(size ? { viewport: size } : {}),
    steps: parsedSteps,
    file,
  }
}
