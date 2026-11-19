import { Document, isScalar, visit } from 'yaml'
import { parseFlow, type Flow, type Selector, type Step } from '../schema.js'
import { UNSEEN, visible } from '../unseen.js'

function selectorValue(s: Selector): unknown {
  if (s.text !== undefined) return s.text
  return {
    ...(s.id !== undefined ? { id: s.id } : {}),
    ...(s.label !== undefined ? { label: s.label } : {}),
    ...(s.role !== undefined ? { role: s.role } : {}),
    ...(s.index !== undefined ? { index: s.index } : {}),
    ...(s.exact ? { exact: true } : {}),
    ...(s.timeoutMs !== undefined ? { timeout: s.timeoutMs / 1000 } : {}),
  }
}

/** A step as the YAML that `parseFlow` reads back into it: its action, and beside it what its touch brings (#1125). */
function stepValue(step: Step): unknown {
  const action = actionValue(step)
  return 'expect' in step && step.expect ? { ...(action as Record<string, unknown>), expect: step.expect } : action
}

function actionValue(step: Step): unknown {
  switch (step.type) {
    case 'clearState': return step.appId !== undefined ? { clearState: step.appId } : 'clearState'
    case 'launchApp': return step.options ? { launchApp: step.options } : 'launchApp'
    case 'tapOn': return { tapOn: selectorValue(step.selector) }
    case 'tapPoint': return { tapOn: step.at }
    case 'inputText': return { inputText: step.replace ? { text: step.text, replace: true } : step.text }
    case 'inputSecret': return { inputText: step.replace ? { secret: step.name, replace: true } : { secret: step.name } }
    case 'pressKey': return { pressKey: step.modifiers ? { code: step.code, modifiers: step.modifiers } : step.code }
    case 'imeAction': return 'imeAction'
    case 'swipe': return { swipe: { from: step.from, to: step.to, durationMs: step.durationMs } }
    case 'scroll': return { scroll: step.until ? { direction: step.direction, until: selectorValue(step.until) } : step.direction }
    case 'openUrl': return { openUrl: step.url }
    case 'assertVisible': return { assertVisible: selectorValue(step.selector) }
    case 'assertNotVisible': return { assertNotVisible: selectorValue(step.selector) }
    case 'pressButton': return { pressButton: step.name }
    case 'longPressOn': return { longPressOn: { on: selectorValue(step.selector), durationMs: step.durationMs } }
    case 'longPressPoint': return { longPressOn: { on: step.at, durationMs: step.durationMs } }
    case 'pinch': return { pinch: { on: Array.isArray(step.on) ? step.on : selectorValue(step.on), scale: step.scale, durationMs: step.durationMs } }
    case 'setOrientation': return { setOrientation: step.orientation }
    case 'setPosture': return { setPosture: step.posture }
  }
}

/** JSON with keys sorted, so two objects built in a different order compare equal. */
function canonical(v: unknown): string {
  return JSON.stringify(v, (_, x: unknown) => (x && typeof x === 'object' && !Array.isArray(x)
    ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    : x))
}

/**
 * The `yaml` library writes a character no one can see (`UNSEEN`) as it is, but for the controls, so a string holding
 * one is written double-quoted with each of them escaped (`"\U000F01F0"`): the file then says which character it is,
 * and reads back as the same string. A string that shows nothing at all has every character but a plain space escaped:
 * a joiner is left as it is inside text, where it is part of an emoji or a word, but alone it is one more blank.
 */
const SHORT: Readonly<Record<string, string>> = { '\n': '\\n', '\t': '\\t', '\r': '\\r', '"': '\\"', '\\': '\\\\' }

function doubleQuoted(value: string, blank: boolean): string {
  let out = ''
  for (const ch of value) {
    const cp = ch.codePointAt(0)!
    out += SHORT[ch] ?? ((blank ? ch !== ' ' : UNSEEN.test(ch))
      ? cp <= 0xff ? `\\x${hex(cp, 2)}` : cp <= 0xffff ? `\\u${hex(cp, 4)}` : `\\U${hex(cp, 8)}`
      : ch)
  }
  return `"${out}"`
}

const hex = (n: number, width: number): string => n.toString(16).toUpperCase().padStart(width, '0')

/**
 * A flow as a YAML file, **read back through `parseFlow` before it is returned**: a captured flow that would not load,
 * or would load as different steps, fails here instead of in the person's CI. Points and modifier lists are written
 * inline (`[0.4, 0.6]`), as a person writes them.
 */
export function flowToYaml(flow: Omit<Flow, 'file'>): string {
  const doc = new Document({
    name: flow.name,
    ...(flow.appId !== undefined ? { appId: flow.appId } : {}),
    ...(flow.tags?.length ? { tags: flow.tags } : {}),
    ...(flow.viewport ? { viewport: flow.viewport } : {}),
    steps: flow.steps.map(stepValue),
  })
  // Stands in for an escaped string while the library lays the file out: letters only, so it is written as it is, and
  // found in no string of the flow, so only it is replaced.
  const values = JSON.stringify(flow)
  let stem = 'tapflowEscaped'
  while (values.includes(stem)) stem += 'X'
  const placeholder = (i: number): string => `${stem}${i}x`
  const escaped: string[] = []
  visit(doc, {
    Seq(_, node) {
      if (node.items.every((i) => isScalar(i))) node.flow = true
    },
    Scalar(_, node) {
      if (typeof node.value !== 'string' || node.value.length === 0) return
      const blank = !visible(node.value)
      if (!blank && !UNSEEN.test(node.value)) return
      escaped.push(doubleQuoted(node.value, blank))
      node.value = placeholder(escaped.length - 1)
    },
  })
  let text = doc.toString({ lineWidth: 0 })
  escaped.forEach((q, i) => { text = text.replace(placeholder(i), () => q) })
  const back = parseFlow(text, 'captured.yaml')
  if (canonical(back.steps) !== canonical(flow.steps) || canonical(back.viewport) !== canonical(flow.viewport)
    || (flow.name !== undefined && back.name !== flow.name) || canonical(back.tags ?? []) !== canonical(flow.tags ?? [])) {
    throw new Error('the captured flow does not read back as the same steps — this is a bug in Flow Capture')
  }
  return text
}
