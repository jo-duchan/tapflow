import { Document, isScalar, visit } from 'yaml'
import { parseFlow, type Flow, type Selector, type Step } from '../schema.js'

function selectorValue(s: Selector): unknown {
  if (s.text !== undefined) return s.text
  return {
    ...(s.id !== undefined ? { id: s.id } : {}),
    ...(s.label !== undefined ? { label: s.label } : {}),
    ...(s.role !== undefined ? { role: s.role } : {}),
    ...(s.index !== undefined ? { index: s.index } : {}),
    ...(s.timeoutMs !== undefined ? { timeout: s.timeoutMs / 1000 } : {}),
  }
}

/** A step as the YAML that `parseFlow` reads back into it. */
function stepValue(step: Step): unknown {
  switch (step.type) {
    case 'clearState': return step.appId !== undefined ? { clearState: step.appId } : 'clearState'
    case 'launchApp': return step.options ? { launchApp: step.options } : 'launchApp'
    case 'tapOn': return { tapOn: selectorValue(step.selector) }
    case 'tapPoint': return { tapOn: step.at }
    case 'inputText': return { inputText: step.replace ? { text: step.text, replace: true } : step.text }
    case 'inputSecret': return { inputText: step.replace ? { secret: step.name, replace: true } : { secret: step.name } }
    case 'pressKey': return { pressKey: step.modifiers ? { code: step.code, modifiers: step.modifiers } : step.code }
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
 * A flow as a YAML file, **read back through `parseFlow` before it is returned**: a captured flow that would not load,
 * or would load as different steps, fails here instead of in the person's CI. Points and modifier lists are written
 * inline (`[0.4, 0.6]`), as a person writes them.
 */
export function flowToYaml(flow: Omit<Flow, 'file'>): string {
  const doc = new Document({
    name: flow.name,
    ...(flow.appId !== undefined ? { appId: flow.appId } : {}),
    ...(flow.tags?.length ? { tags: flow.tags } : {}),
    steps: flow.steps.map(stepValue),
  })
  visit(doc, {
    Seq(_, node) {
      if (node.items.every((i) => isScalar(i))) node.flow = true
    },
  })
  const text = doc.toString({ lineWidth: 0 })
  const back = parseFlow(text, 'captured.yaml')
  if (canonical(back.steps) !== canonical(flow.steps)) {
    throw new Error('the captured flow does not read back as the same steps — this is a bug in Flow Capture')
  }
  return text
}
