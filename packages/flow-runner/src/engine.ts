import type { UIElement } from '@tapflowio/agent-core'
import type { Flow, Selector, Step, ScrollDirection } from './schema.js'

// Transport-agnostic device surface the engine drives (DIP): the relay-backed
// implementation lives in RelayDriver, tests use fakes, and mcp-server adapts
// its own client. All coordinates are normalized 0-1.
export interface FlowDriver {
  queryUITree(): Promise<UIElement[]>
  tap(x: number, y: number): Promise<void>
  swipe(from: [number, number], to: [number, number], durationMs: number): Promise<void>
  inputText(text: string): Promise<void>
  pressKey(code: string): Promise<void>
  openUrl(url: string): Promise<void>
  launchApp(): Promise<void>
  clearState(appId: string): Promise<void>
  screenshot(): Promise<Buffer>
}

export interface EngineOptions {
  defaultTimeoutMs?: number
  pollIntervalMs?: number
}

export interface StepResult {
  index: number
  name: string
  status: 'passed' | 'failed' | 'skipped'
  durationMs: number
  message?: string
}

export interface FlowResult {
  name: string
  file?: string
  status: 'passed' | 'failed'
  steps: StepResult[]
  durationMs: number
  failureMessage?: string
  failureScreenshot?: Buffer
}

const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_POLL_INTERVAL_MS = 500

// scroll direction = where the user wants to reveal more content, so the
// finger gesture goes the opposite way (scroll down → swipe up).
const SCROLL_GESTURES: Record<ScrollDirection, { from: [number, number]; to: [number, number] }> = {
  down: { from: [0.5, 0.7], to: [0.5, 0.3] },
  up: { from: [0.5, 0.3], to: [0.5, 0.7] },
  right: { from: [0.8, 0.5], to: [0.2, 0.5] },
  left: { from: [0.2, 0.5], to: [0.8, 0.5] },
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const round4 = (n: number): number => Math.round(n * 10000) / 10000

function describeSelector(sel: Selector): string {
  if (sel.text !== undefined) return `"${sel.text}"`
  const parts: string[] = []
  if (sel.id !== undefined) parts.push(`id="${sel.id}"`)
  if (sel.label !== undefined) parts.push(`label="${sel.label}"`)
  return parts.join(', ')
}

function describeStep(step: Step): string {
  switch (step.type) {
    case 'clearState': return step.appId ? `clearState(${step.appId})` : 'clearState'
    case 'launchApp': return 'launchApp'
    case 'tapOn': return `tapOn(${describeSelector(step.selector)})`
    case 'inputText': return `inputText("${step.text}")`
    case 'pressKey': return `pressKey(${step.code})`
    case 'swipe': return `swipe(${step.from} → ${step.to})`
    case 'scroll': return `scroll(${step.direction})`
    case 'openUrl': return `openUrl(${step.url})`
    case 'assertVisible': return `assertVisible(${describeSelector(step.selector)})`
    case 'assertNotVisible': return `assertNotVisible(${describeSelector(step.selector)})`
  }
}

// Selector resolution: explicit id → identifier only; explicit label → exact
// then partial; bare text → exact identifier, then exact label, then partial label.
export function matchSelector(tree: UIElement[], sel: Selector): UIElement[] {
  if (sel.text !== undefined) {
    const byId = tree.filter((e) => e.identifier === sel.text)
    if (byId.length > 0) return byId
    const exact = tree.filter((e) => e.label === sel.text)
    if (exact.length > 0) return exact
    return tree.filter((e) => sel.text !== undefined && sel.text.length > 0 && e.label.includes(sel.text))
  }
  let pool = tree
  if (sel.id !== undefined) pool = pool.filter((e) => e.identifier === sel.id)
  if (sel.label !== undefined) {
    const label = sel.label
    const exact = pool.filter((e) => e.label === label)
    pool = exact.length > 0 ? exact : pool.filter((e) => e.label.includes(label))
  }
  return pool
}

class StepFailure extends Error {}

async function resolveOne(
  driver: FlowDriver,
  sel: Selector,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<UIElement> {
  const deadline = Date.now() + (sel.timeoutMs ?? timeoutMs)
  for (;;) {
    const matches = matchSelector(await driver.queryUITree(), sel)
    if (matches.length === 1) return matches[0]
    if (matches.length > 1) {
      const described = matches.slice(0, 5).map((m) => `${m.role} "${m.label}"${m.identifier ? ` id=${m.identifier}` : ''}`).join(' | ')
      throw new StepFailure(`${matches.length} elements match ${describeSelector(sel)} — make the selector unique (candidates: ${described})`)
    }
    if (Date.now() >= deadline) {
      throw new StepFailure(`no element matched ${describeSelector(sel)} within ${(sel.timeoutMs ?? timeoutMs) / 1000}s`)
    }
    await delay(pollIntervalMs)
  }
}

async function waitVisible(driver: FlowDriver, sel: Selector, timeoutMs: number, pollIntervalMs: number): Promise<void> {
  const deadline = Date.now() + (sel.timeoutMs ?? timeoutMs)
  for (;;) {
    if (matchSelector(await driver.queryUITree(), sel).length > 0) return
    if (Date.now() >= deadline) {
      throw new StepFailure(`no element matched ${describeSelector(sel)} within ${(sel.timeoutMs ?? timeoutMs) / 1000}s`)
    }
    await delay(pollIntervalMs)
  }
}

async function waitNotVisible(driver: FlowDriver, sel: Selector, timeoutMs: number, pollIntervalMs: number): Promise<void> {
  const deadline = Date.now() + (sel.timeoutMs ?? timeoutMs)
  for (;;) {
    if (matchSelector(await driver.queryUITree(), sel).length === 0) return
    if (Date.now() >= deadline) {
      throw new StepFailure(`element ${describeSelector(sel)} is still visible after ${(sel.timeoutMs ?? timeoutMs) / 1000}s`)
    }
    await delay(pollIntervalMs)
  }
}

async function executeStep(step: Step, flow: Flow, driver: FlowDriver, timeoutMs: number, pollIntervalMs: number): Promise<void> {
  switch (step.type) {
    case 'clearState': {
      // schema guarantees appId presence at parse time for the bare form
      await driver.clearState(step.appId ?? flow.appId!)
      return
    }
    case 'launchApp': return driver.launchApp()
    case 'tapOn': {
      const el = await resolveOne(driver, step.selector, timeoutMs, pollIntervalMs)
      return driver.tap(round4(el.frame.x + el.frame.width / 2), round4(el.frame.y + el.frame.height / 2))
    }
    case 'inputText': return driver.inputText(step.text)
    case 'pressKey': return driver.pressKey(step.code)
    case 'swipe': return driver.swipe(step.from, step.to, step.durationMs)
    case 'scroll': {
      const g = SCROLL_GESTURES[step.direction]
      return driver.swipe(g.from, g.to, 300)
    }
    case 'openUrl': return driver.openUrl(step.url)
    case 'assertVisible': return waitVisible(driver, step.selector, timeoutMs, pollIntervalMs)
    case 'assertNotVisible': return waitNotVisible(driver, step.selector, timeoutMs, pollIntervalMs)
  }
}

export async function runFlow(flow: Flow, driver: FlowDriver, options: EngineOptions = {}): Promise<FlowResult> {
  const timeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const started = Date.now()
  const steps: StepResult[] = []
  let failureMessage: string | undefined
  let failureScreenshot: Buffer | undefined

  for (const [index, step] of flow.steps.entries()) {
    const name = describeStep(step)
    if (failureMessage !== undefined) {
      steps.push({ index, name, status: 'skipped', durationMs: 0 })
      continue
    }
    const stepStart = Date.now()
    try {
      await executeStep(step, flow, driver, timeoutMs, pollIntervalMs)
      steps.push({ index, name, status: 'passed', durationMs: Date.now() - stepStart })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      failureMessage = `${name}: ${message}`
      steps.push({ index, name, status: 'failed', durationMs: Date.now() - stepStart, message })
      failureScreenshot = await driver.screenshot().catch(() => undefined)
    }
  }

  const result: FlowResult = {
    name: flow.name,
    status: failureMessage === undefined ? 'passed' : 'failed',
    steps,
    durationMs: Date.now() - started,
  }
  if (flow.file !== undefined) result.file = flow.file
  if (failureMessage !== undefined) result.failureMessage = failureMessage
  if (failureScreenshot !== undefined) result.failureScreenshot = failureScreenshot
  return result
}
