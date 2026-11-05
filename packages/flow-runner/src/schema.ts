import { parse as parseYaml } from 'yaml'
import { ValidationError } from '@tapflowio/agent-core'
import path from 'path'
import type { LaunchOptions } from '@tapflowio/protocol'
import { compactLaunchOptions, launchOptionsProblem } from '@tapflowio/protocol/launch'

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

export type Step =
  | { type: 'clearState'; appId?: string }
  | { type: 'launchApp'; options?: LaunchOptions }
  | { type: 'tapOn'; selector: Selector }
  | { type: 'inputText'; text: string }
  | { type: 'pressKey'; code: string }
  | { type: 'swipe'; from: [number, number]; to: [number, number]; durationMs: number }
  | { type: 'scroll'; direction: ScrollDirection }
  | { type: 'openUrl'; url: string }
  | { type: 'assertVisible'; selector: Selector }
  | { type: 'assertNotVisible'; selector: Selector }
  | { type: 'pressButton'; name: string }
  | { type: 'longPressOn'; selector: Selector; durationMs: number }
  | { type: 'pinch'; on: Selector | [number, number]; scale: number; durationMs: number }

export interface Flow {
  name: string
  appId?: string
  tags?: string[]
  steps: Step[]
  file?: string
}

const SCROLL_DIRECTIONS = new Set<string>(['up', 'down', 'left', 'right'])
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

function parseStep(raw: unknown, ctx: string): Step {
  if (typeof raw === 'string') {
    if (raw === 'clearState') return { type: 'clearState' }
    if (raw === 'launchApp') return { type: 'launchApp' }
    if (raw === 'scroll') return { type: 'scroll', direction: 'down' }
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
    case 'tapOn': return { type: 'tapOn', selector: parseSelector(value, ctx) }
    case 'assertVisible': return { type: 'assertVisible', selector: parseSelector(value, ctx) }
    case 'assertNotVisible': return { type: 'assertNotVisible', selector: parseSelector(value, ctx) }
    case 'inputText': {
      if (typeof value !== 'string') throw new ValidationError(`${ctx}: "inputText" must be a string`)
      return { type: 'inputText', text: value }
    }
    case 'pressKey': {
      if (typeof value !== 'string' || value.length === 0) throw new ValidationError(`${ctx}: "pressKey" must be a key code like Enter, Backspace, Escape`)
      return { type: 'pressKey', code: value }
    }
    case 'openUrl': {
      if (typeof value !== 'string' || value.length === 0) throw new ValidationError(`${ctx}: "openUrl" must be a URL string`)
      return { type: 'openUrl', url: value }
    }
    case 'scroll': {
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
        return { type: 'longPressOn', selector: parseSelector(on, ctx), durationMs: parseGestureMs(durationMs, ctx, DEFAULT_LONG_PRESS_MS) }
      }
      if (isRecord(value) && Object.hasOwn(value, 'durationMs')) {
        throw new ValidationError(`${ctx}: "longPressOn" takes a duration beside the selector — put the selector under "on": { on: <selector>, durationMs }`)
      }
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
    default:
      throw new ValidationError(`${ctx}: unknown step "${key}"`)
  }
}

export function parseFlow(yamlText: string, file: string): Flow {
  let doc: unknown
  try {
    doc = parseYaml(yamlText)
  } catch (e) {
    throw new ValidationError(`${file}: invalid YAML — ${(e as Error).message}`)
  }
  if (!isRecord(doc)) throw new ValidationError(`${file}: flow must be a YAML mapping with a "steps" list`)

  const { name, appId, tags, steps, ...rest } = doc as { name?: unknown; appId?: unknown; tags?: unknown; steps?: unknown }
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

  for (const [i, step] of parsedSteps.entries()) {
    if (step.type === 'clearState' && !step.appId && !appId) {
      throw new ValidationError(`${file}: steps[${i}]: bare "clearState" requires a flow-level appId`)
    }
  }

  return {
    name: (name as string | undefined) ?? path.basename(file).replace(/\.ya?ml$/i, ''),
    ...(appId !== undefined ? { appId: appId as string } : {}),
    ...(tags !== undefined ? { tags: (tags as string[]).map((t) => t.trim()) } : {}),
    steps: parsedSteps,
    file,
  }
}
