import { agreedEffect, flowSteps, flowToYaml, type CapturedFlow, type CapturedStep, type Flow, type FlowResult, type Step, type StepExpect } from '@tapflowio/flow-runner/browser'
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

/**
 * The flow with what Verify saw (#1125): each touch's effect beside it as its `expect`, so a run fails when a touch stops
 * doing it — a tap on a row an overlay covers sends fine and changes nothing — and the screen it ran on as `viewport`
 * when the flow touches points, so a run on another size is refused. Only from a Verify of this very flow (Edit drops
 * the result, so the steps line up), and only what it saw: a touch that changed nothing gets no `expect`.
 *
 * Where Match's replay watched the same touch (`matched`, the captured steps the flow was made from), only what both saw
 * is written (`agreedEffect`): two looks minutes apart are what tells a number that changes by itself from the touch's
 * effect, which no pattern can. A touch Match could not watch keeps what Verify saw.
 */
export function withEffects(flow: Omit<Flow, 'file'>, verified: FlowResult | undefined, matched: readonly CapturedStep[] = []): Omit<Flow, 'file'> {
  if (!verified || verified.steps.length !== flow.steps.length) return flow
  const byMatch = new Map<Step, StepExpect | null>()
  for (const m of matched) if (m.step && m.observed !== undefined) byMatch.set(m.step, m.observed)
  return {
    ...flow,
    ...(verified.viewport ? { viewport: verified.viewport } : {}),
    steps: flow.steps.map((step, i): Step => {
      const verifySaw = verified.steps[i]?.observed ?? null
      const seen = byMatch.has(step) ? agreedEffect(verifySaw, byMatch.get(step)!) : verifySaw
      if (!seen) return step
      return step.type === 'tapOn' || step.type === 'tapPoint' || step.type === 'longPressOn' || step.type === 'longPressPoint'
        ? { ...step, expect: seen }
        : step
    }),
  }
}

/** The flow Export shows and writes: Edit's flow with what Verify and Match both saw beside each touch. */
export function exportedFlow(state: Pick<CaptureState, 'captured' | 'removed' | 'renamed' | 'name' | 'tags' | 'verify'>, appId: string | null): Omit<Flow, 'file'> | null {
  const flow = flowOf(state, appId)
  return flow ? withEffects(flow, state.verify?.result, state.captured?.steps) : null
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
