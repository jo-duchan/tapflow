import type { AiClientKind, WatchEndReason, WatchRefusal } from '@tapflowio/protocol'

/** How the dashboard names an AI client. "Coding agent", not "agent": in tapflow's own words an agent is the
 *  process on a Mac that runs the devices, and the MCP server is driven by a tool like Claude Code. */
export function holderKindLabel(kind: AiClientKind): string {
  return kind === 'mcp' ? 'Coding agent' : 'Flow runner'
}

/** What a watcher is told when the relay refuses the watch — one sentence per thing they do differently. */
export function watchRefusalText(reason: WatchRefusal): string {
  switch (reason) {
    case 'session-not-found': return 'This session has ended.'
    case 'not-watchable': return 'This device is not being driven by an AI agent, so it cannot be watched.'
    case 'not-permitted': return 'Sign in to the dashboard to watch a session.'
    case 'watchers-full': return 'This session already has as many viewers as it allows. Try again later.'
  }
}

/** Why a watch ended without the watcher leaving. */
export function watchEndText(reason: WatchEndReason): string {
  switch (reason) {
    case 'session-ended': return 'The session ended.'
    case 'holder-changed': return 'Someone else picked up this device, so the watch ended.'
  }
}
