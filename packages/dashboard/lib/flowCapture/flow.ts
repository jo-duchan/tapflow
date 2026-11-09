import { flowSteps, flowToYaml, type CapturedFlow, type Flow } from '@tapflowio/flow-runner/browser'
import type { CaptureState } from './machine'

/** The captured flow as Edit left it: removed steps gone, renamed secrets renamed, values of unused secrets dropped. */
export function editedCapture(state: Pick<CaptureState, 'captured' | 'removed' | 'renamed'>): CapturedFlow | null {
  const { captured, removed, renamed } = state
  if (!captured) return null
  const steps = captured.steps
    .filter((_, i) => !removed.includes(i))
    .map((s) => s.step?.type === 'inputSecret' && renamed[s.step.name] !== undefined
      ? { ...s, step: { ...s.step, name: renamed[s.step.name]! } }
      : s)
  const used = new Set(steps.flatMap((s) => (s.step?.type === 'inputSecret' ? [s.step.name] : [])))
  const secrets: Record<string, string> = {}
  for (const [name, value] of Object.entries(captured.secrets)) {
    const to = renamed[name] ?? name
    if (used.has(to)) secrets[to] = value
  }
  return { ...captured, steps, secrets }
}

/** The flow file's content. `appId` is the build's bundle id: the flow clears and runs that app, and only that app. */
export function flowOf(state: Pick<CaptureState, 'captured' | 'removed' | 'renamed' | 'name' | 'tags'>, appId: string | null): Omit<Flow, 'file'> | null {
  const edited = editedCapture(state)
  if (!edited) return null
  const tags = state.tags.split(',').map((t) => t.trim()).filter(Boolean)
  return {
    name: state.name.trim() || 'Captured flow',
    ...(appId ? { appId } : {}),
    ...(tags.length ? { tags } : {}),
    steps: flowSteps(edited, appId ? { appId } : {}),
  }
}

export function yamlOf(flow: Omit<Flow, 'file'>): string {
  return flowToYaml(flow)
}

/** `flows/<slug>.yaml`: the name in lowercase words joined by hyphens. */
export function fileNameOf(name: string): string {
  const slug = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return `flows/${slug || 'captured-flow'}.yaml`
}

export type Edge = 'start' | 'end'

/**
 * The range with one handle moved to the boundary `at` (0 = before the first step, `total` = after the last). A handle
 * stops one step short of the other, so the range never runs empty or turns inside out.
 */
export function moveEdge(range: { start: number; end: number }, edge: Edge, at: number, total: number): { start: number; end: number } {
  return edge === 'start'
    ? { start: Math.max(0, Math.min(at, range.end - 1)), end: range.end }
    : { start: range.start, end: Math.min(total, Math.max(at, range.start + 1)) }
}
