import type { DeviceSummary, SessionInfo } from '@/lib/types'

/**
 * Coming back to a session through its URL (#1087): what to do, decided from one device listing.
 *
 * Decided here and not by joining straight away. A session id is a device slot, so a join succeeds for a device that
 * is off and the viewer then boots it — the restart the dialog exists to ask about. And the listing is what tells this
 * tab whether the device is waiting for it, held by another of its own tabs, or someone else's.
 */

/** How long another of this user's tabs must have been gone before this one takes the session: longer than a tab's
 *  own reconnect (`useRelay`'s 2 s), so the tab that dropped gets back first. */
export const OWN_TAB_SETTLE_MS = 10_000
/** How long to wait for a device that is not listed, or for this user's other tab to be noticed as gone (the relay
 *  takes up to about 45 s), before saying so. */
export const GIVE_UP_MS = 45_000

export interface ResumeTarget {
  sessionId: string
  deviceId: string
  /** When the first listing was read for this target; set by the caller, since a render cannot read the clock. */
  since: number
  /** When this tab first found the session held by another of its user's tabs. From then on it joins only once the
   *  session has been free for `OWN_TAB_SETTLE_MS`. */
  ownTabSince?: number
}

export type ResumeStep =
  /** Keep the target and read the next listing. */
  | { kind: 'wait'; why: 'mac-away' | 'ai-holding' | 'own-tab'; agentName?: string; device?: DeviceSummary }
  | { kind: 'join'; agentName: string; device: DeviceSummary }
  /** The device is off, or on and not this person's to come back to: ask before starting it. */
  | { kind: 'restart'; agentName: string; device: DeviceSummary }
  | { kind: 'taken'; agentName: string; device: DeviceSummary; by: string }
  /** `self`: held by another of this person's own tabs, which never let go. */
  | { kind: 'in-use'; agentName: string; self?: true }
  /** Someone else's session is waiting on it. The card says so, and picking it asks first. */
  | { kind: 'others'; agentName: string }
  | { kind: 'gone' }

/** First match wins, and the order is the decision: a notice about an old session must not hide a session this person
 *  can resume now, so `resumable` and `heldBySelf` come before `endedBy`. */
export function classifyResume(sessions: SessionInfo[], target: ResumeTarget, now: number): ResumeStep {
  const listed = sessions.flatMap((s) => s.devices.map((device) => ({ agentName: s.agentName ?? '', device })))
  const same = listed.find((x) => x.device.sessionId === target.sessionId)
  if (!same) {
    // A session id outlives an agent only for its reconnect window. The device under a new id is the Mac back after it.
    const moved = listed.find((x) => x.device.id === target.deviceId)
    if (moved) return { kind: 'restart', ...moved }
    return now - target.since > GIVE_UP_MS ? { kind: 'gone' } : { kind: 'wait', why: 'mac-away' }
  }
  const { agentName, device } = same
  if (device.waiting?.aiHolding && device.waiting.yours) return { kind: 'wait', why: 'ai-holding', agentName, device }
  if (device.resumable) {
    if (target.ownTabSince !== undefined && (device.releasedAgoMs ?? 0) < OWN_TAB_SETTLE_MS) {
      return { kind: 'wait', why: 'own-tab', agentName, device }
    }
    return { kind: 'join', agentName, device }
  }
  if (device.heldBySelf) {
    if (target.ownTabSince !== undefined && now - target.ownTabSince > GIVE_UP_MS) return { kind: 'in-use', agentName, self: true }
    return { kind: 'wait', why: 'own-tab', agentName, device }
  }
  if (device.endedBy) return { kind: 'taken', agentName, device, by: device.endedBy.by }
  if (device.busy) return { kind: 'in-use', agentName }
  if (device.waiting) return { kind: 'others', agentName }
  return { kind: 'restart', agentName, device }
}

/** The tester's own sessions that dropped and are still waiting for them, including one an AI client is borrowing.
 *  `platform` narrows it to the devices a page can show: a QA page for an iOS build cannot resume an Android session. */
export function interruptedSessions(sessions: SessionInfo[], platform?: string): { agentName: string; device: DeviceSummary }[] {
  return sessions.flatMap((s) => s.devices
    .filter((d) => d.waiting?.yours && (d.resumable || d.waiting.aiHolding) && (platform === undefined || d.platform === platform))
    .map((device) => ({ agentName: s.agentName ?? '', device })))
}

// Per document, shared by every page that reads the listing: the relay sends a notice on every listing until it
// expires, and each open page polls.
const announced = new Set<string>()

/** Calls `say` once per notice that someone took or shut down a device while it waited for this person. */
export function announceEndedSessions(sessions: SessionInfo[], say: (by: string, deviceName: string) => void): void {
  for (const s of sessions) {
    for (const d of s.devices) {
      if (!d.endedBy) continue
      const key = `${d.sessionId}:${d.endedBy.at}`
      if (announced.has(key)) continue
      announced.add(key)
      say(d.endedBy.name, d.name)
    }
  }
}

/** Minutes left, rounded up, for a label that should not change every few seconds. */
export function minutesLeft(ms: number): number {
  return Math.max(1, Math.ceil(ms / 60_000))
}
