import { parse as parseYaml } from 'yaml'
import { ValidationError } from '@tapflowio/agent-core'
import path from 'path'

export interface Selector {
  // Bare-string selector: resolved as exact identifier → exact label → partial label.
  text?: string
  id?: string
  label?: string
  timeoutMs?: number
}

export type ScrollDirection = 'up' | 'down' | 'left' | 'right'

export type Step =
  | { type: 'clearState'; appId?: string }
  | { type: 'launchApp' }
  | { type: 'tapOn'; selector: Selector }
  | { type: 'inputText'; text: string }
  | { type: 'pressKey'; code: string }
  | { type: 'swipe'; from: [number, number]; to: [number, number]; durationMs: number }
  | { type: 'scroll'; direction: ScrollDirection }
  | { type: 'openUrl'; url: string }
  | { type: 'assertVisible'; selector: Selector }
  | { type: 'assertNotVisible'; selector: Selector }

export interface Flow {
  name: string
  appId?: string
  steps: Step[]
  file?: string
}

const SCROLL_DIRECTIONS = new Set<string>(['up', 'down', 'left', 'right'])
const DEFAULT_SWIPE_DURATION_MS = 300

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function parseSelector(v: unknown, ctx: string): Selector {
  if (typeof v === 'string') {
    if (v.length === 0) throw new ValidationError(`${ctx}: selector must not be empty`)
    return { text: v }
  }
  if (isRecord(v)) {
    const { id, label, timeout, ...rest } = v as { id?: unknown; label?: unknown; timeout?: unknown }
    const unknownKeys = Object.keys(rest)
    if (unknownKeys.length > 0) throw new ValidationError(`${ctx}: unknown selector keys: ${unknownKeys.join(', ')}`)
    if (id === undefined && label === undefined) {
      throw new ValidationError(`${ctx}: selector needs "id" or "label"`)
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
    if (timeout !== undefined) {
      if (typeof timeout !== 'number' || !(timeout > 0)) throw new ValidationError(`${ctx}: "timeout" must be a positive number of seconds`)
      selector.timeoutMs = Math.round(timeout * 1000)
    }
    return selector
  }
  throw new ValidationError(`${ctx}: selector must be a string or { id, label, timeout }`)
}

function parsePoint(v: unknown, ctx: string, key: string): [number, number] {
  // Number.isFinite guards YAML's `.nan`/`.inf`, which pass plain range checks
  if (!Array.isArray(v) || v.length !== 2 || v.some((n) => typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1)) {
    throw new ValidationError(`${ctx}: "${key}" must be [x, y] with normalized 0-1 coordinates`)
  }
  return [v[0] as number, v[1] as number]
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
        if (typeof durationMs !== 'number' || !(durationMs > 0)) throw new ValidationError(`${ctx}: "durationMs" must be a positive number`)
        parsed.durationMs = durationMs
      }
      return parsed
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

  const { name, appId, steps, ...rest } = doc as { name?: unknown; appId?: unknown; steps?: unknown }
  const unknownKeys = Object.keys(rest)
  if (unknownKeys.length > 0) throw new ValidationError(`${file}: unknown top-level keys: ${unknownKeys.join(', ')}`)
  if (name !== undefined && typeof name !== 'string') throw new ValidationError(`${file}: "name" must be a string`)
  if (appId !== undefined && typeof appId !== 'string') throw new ValidationError(`${file}: "appId" must be a string`)
  if (!Array.isArray(steps) || steps.length === 0) throw new ValidationError(`${file}: "steps" must be a non-empty list`)

  const parsedSteps = steps.map((raw, i) => parseStep(raw, `${file}: steps[${i}]`))

  for (const [i, step] of parsedSteps.entries()) {
    if (step.type === 'clearState' && !step.appId && !appId) {
      throw new ValidationError(`${file}: steps[${i}]: bare "clearState" requires a flow-level appId`)
    }
  }

  return {
    name: (name as string | undefined) ?? path.basename(file).replace(/\.ya?ml$/i, ''),
    ...(appId !== undefined ? { appId: appId as string } : {}),
    steps: parsedSteps,
    file,
  }
}
