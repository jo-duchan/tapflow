import type { BrowserToRelay } from '@tapflowio/protocol'

export const APP_LOG_BUFFER_LIMIT = 64 * 1024

export function appendAppLogText(previous: string, next: string): string {
  const combined = previous + next
  if (combined.length <= APP_LOG_BUFFER_LIMIT) return combined
  let start = combined.length - APP_LOG_BUFFER_LIMIT
  const firstRetained = combined.charCodeAt(start)
  if (firstRetained >= 0xdc00 && firstRetained <= 0xdfff) start++
  return combined.slice(start)
}

/**
 * Whether sending `msg` ends the launch whose logs are shown. The relay forgets that launch on each of these (Flow
 * Capture's replay sends them through the same socket), and the agent's next output carries another launch id, so the
 * box would wait on output that is not coming. The viewer's own Launch sets the shown id before it sends, so it is not
 * one of them.
 */
export function endsShownLaunch(msg: BrowserToRelay, shownLaunchId: string | null): boolean {
  if (msg.type === 'app:clear-state' || msg.type === 'app:install') return true
  return msg.type === 'app:launch' && msg.requestId !== shownLaunchId
}
