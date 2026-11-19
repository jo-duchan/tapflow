import type { ReachTarget, UIElementRole } from '@tapflowio/protocol'

/** A batch is one screen's elements at most: Flow Capture asks for every element a swipe might scroll to. */
const MAX_TARGETS = 64
export const REACH_BODY_MAX_BYTES = 64 * 1024
/** What a reach waits per target beyond the tree's deadline: more than any agent spends judging one. */
export const REACH_MS_PER_TARGET = 300

const ROLES: readonly UIElementRole[] = ['button', 'text', 'input', 'image', 'checkbox', 'switch', 'slider', 'list', 'cell', 'tab', 'other']

/**
 * The targets of `POST /sessions/:id/reach`, checked field by field: they go to the agent, which finds each again by
 * role, identifier, label and frame. Throws what is wrong, for the 400 that answers it.
 */
export function readReachTargets(body: unknown): ReachTarget[] {
  const targets = (body as { targets?: unknown } | null)?.targets
  if (!Array.isArray(targets) || targets.length === 0) throw new Error('targets must be a non-empty array')
  if (targets.length > MAX_TARGETS) throw new Error(`at most ${MAX_TARGETS} targets`)
  return targets.map((t, i): ReachTarget => {
    const o = (t ?? {}) as Record<string, unknown>
    const f = (o['frame'] ?? {}) as Record<string, unknown>
    const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v)
    if (!ROLES.includes(o['role'] as UIElementRole)) throw new Error(`targets[${i}].role is not a UI element role`)
    if (typeof o['label'] !== 'string') throw new Error(`targets[${i}].label must be a string`)
    if (o['identifier'] !== undefined && typeof o['identifier'] !== 'string') throw new Error(`targets[${i}].identifier must be a string`)
    if (o['rawRole'] !== undefined && typeof o['rawRole'] !== 'string') throw new Error(`targets[${i}].rawRole must be a string`)
    if (![f['x'], f['y'], f['width'], f['height']].every(num)) throw new Error(`targets[${i}].frame must have numeric x, y, width and height`)
    return {
      role: o['role'] as UIElementRole,
      label: o['label'] as string,
      ...(o['identifier'] !== undefined ? { identifier: o['identifier'] as string } : {}),
      ...(o['rawRole'] !== undefined ? { rawRole: o['rawRole'] as string } : {}),
      frame: { x: f['x'] as number, y: f['y'] as number, width: f['width'] as number, height: f['height'] as number },
    }
  })
}
