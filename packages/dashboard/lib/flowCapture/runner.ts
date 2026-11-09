import {
  defaultRange, matchStep, rangeStartOrientation, replayStep, runFlow, segment, SocketFlowDriver, toFlowSteps,
  waitForStableScreen, type CapturedStep, type Flow, type FlowResult, type MatchContext, type RawStep, type StepRange,
} from '@tapflowio/flow-runner/browser'
import { chromeOrientation } from '@tapflowio/protocol/screen'
import type { AndroidChrome, ChromePayload } from '@tapflowio/protocol'
import type { CaptureSnapshot } from '@tapflowio/protocol/capture'
import { copy } from './copy'
import type { DashboardSessionChannel } from './channel'
import type { CaptureTap } from './tap'

const base = (tap: CaptureTap) => `/api/v1/sessions/${tap.sessionId}/capture`
const SETTLE_TIMEOUT_MS = 15_000
/** Renewed at a third of the relay's 30 s lease, so one late timer does not lose it. */
const RENEW_EVERY_MS = 10_000

export class CaptureGone extends Error {}

/** The person's steps so far, frozen for the dialog. `null` when nothing was captured on this device. */
export async function loadSnapshot(tap: CaptureTap): Promise<CaptureSnapshot | null> {
  const res = await fetch(`${base(tap)}/snapshot`, { method: 'POST', credentials: 'include' })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`Could not read the captured steps (${res.status})`)
  return await res.json() as CaptureSnapshot
}

export function stepsOf(snapshot: CaptureSnapshot): { steps: RawStep[]; range: StepRange } {
  const steps = segment(snapshot.entries)
  return { steps, range: defaultRange(steps) }
}

/**
 * The relay's pause on recording, held while the dialog replays or verifies: what reaches the device then is not the
 * person, and recorded it would be mixed into their capture. A 30 s lease the relay drops on its own, so a tab that
 * dies does not leave the person unrecorded. Renewed on a timer and before every step; `ensure` refuses to go on once
 * it may have lapsed, because a hidden tab's timers can run a minute late.
 */
export class PauseLease {
  private timer: ReturnType<typeof setInterval> | null = null
  private lastOk = 0
  private ttlMs = 30_000

  constructor(private readonly tap: CaptureTap) {}

  private async renew(): Promise<boolean> {
    const res = await fetch(`${base(this.tap)}/pause`, { method: 'PUT', credentials: 'include' }).catch(() => null)
    if (!res?.ok) return false
    const body = await res.json().catch(() => ({})) as { ttlMs?: number }
    if (typeof body.ttlMs === 'number') this.ttlMs = body.ttlMs
    this.lastOk = Date.now()
    return true
  }

  async start(): Promise<void> {
    if (!(await this.renew())) throw new CaptureGone(copy.errors.captureEnded)
    this.timer ??= setInterval(() => { void this.renew() }, RENEW_EVERY_MS)
  }

  /** Before each step: renewed now, and refused if the last renewal is older than the lease. */
  async ensure(): Promise<void> {
    const ok = await this.renew()
    if (!ok && Date.now() - this.lastOk > this.ttlMs) throw new CaptureGone(copy.errors.pauseLost)
  }

  /** Renewed without waiting, for a run that has no step to wait in (verification's start marks). */
  touch(): void { void this.renew() }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await fetch(`${base(this.tap)}/pause`, { method: 'DELETE', credentials: 'include' }).catch(() => {})
  }
}

/** Let the dialog's snapshot go: the relay keeps it until asked, and it holds what was typed. */
export async function dropSnapshot(tap: CaptureTap): Promise<void> {
  await fetch(`${base(tap)}/snapshot`, { method: 'DELETE', credentials: 'include' }).catch(() => {})
}

/** The chrome the channel holds now: it follows the relay, unlike the viewer's snapshot. */
async function chromeNow(channel: DashboardSessionChannel, tap: CaptureTap): Promise<ChromePayload | null> {
  return channel.chrome(tap.sessionId, 1)
}

function frameTurnOf(chrome: ChromePayload | null): 0 | 90 | 180 | 270 | undefined {
  // Android body mode sends points in the frame's space; its `streamRotation` is the turn from that frame to the screen.
  if (!chrome || 'framePng' in chrome) return undefined
  return (chrome as AndroidChrome).streamRotation
}

const TYPING = new Set<RawStep['kind']>(['text', 'type', 'paste', 'key'])

export interface MatchHooks {
  onStep: (step: CapturedStep, screenshot?: string) => void
  signal: AbortSignal
}

/**
 * Replay `range` of `steps` on the device from a clean start and match each against the screen it was replayed on.
 * The start is the flow's own: the app's data cleared, the device turned the way it was held, the app launched when
 * the range does not begin with a launch. Each step waits for the screen to settle and is matched against that read.
 * An install in the range is not replayed (below).
 */
export async function matchRange(
  tap: CaptureTap, channel: DashboardSessionChannel, lease: PauseLease,
  steps: RawStep[], range: StepRange, bundleId: string | null, hooks: MatchHooks,
): Promise<CapturedStep[]> {
  const sessionId = tap.sessionId
  const slice = steps.slice(range.start, range.end)
  await lease.start()
  if (bundleId) await channel.clearState(sessionId, bundleId)
  const orientation = rangeStartOrientation(steps, range)
  if (orientation) await channel.setOrientation(sessionId, orientation, 10_000)
  if (slice[0]?.kind !== 'launch') await channel.launchApp(sessionId, tap.buildId)

  const read = (signal: AbortSignal) => channel.queryUITreeWithTurn(sessionId, signal)
  const matched: CapturedStep[] = []
  for (const raw of slice) {
    hooks.signal.throwIfAborted()
    // Not sent again: the flow has no install (its run installs and resets), so a replay of one would uninstall the app
    // just launched and match every step after it on a home screen the flow never sees. Matched as it is, it is skipped.
    if (raw.kind === 'install') {
      const step = matchStep(raw, { tree: [], postures: tap.postures().postures, platform: tap.platform })
      matched.push(step)
      hooks.onStep(step)
      continue
    }
    await lease.ensure()
    const before = await waitForStableScreen(read, { timeoutMs: SETTLE_TIMEOUT_MS })
    const shot = await channel.screenshot(sessionId, hooks.signal).catch(() => null)
    const chrome = await chromeNow(channel, tap)
    await replayStep(channel, sessionId, raw, hooks.signal)
    const ctx: MatchContext = {
      tree: before?.elements ?? [],
      ...(before?.interfaceTurn !== undefined ? { interfaceTurn: before.interfaceTurn } : {}),
      ...(frameTurnOf(chrome) !== undefined ? { frameTurn: frameTurnOf(chrome) } : {}),
      postures: tap.postures().postures,
      platform: tap.platform,
    }
    if (TYPING.has(raw.kind)) {
      const after = await waitForStableScreen(read, { timeoutMs: SETTLE_TIMEOUT_MS })
      if (after) ctx.treeAfter = after.elements
    }
    if (raw.kind === 'rotate') {
      const turned = await chromeNow(channel, tap)
      const o = turned ? chromeOrientation(turned) : undefined
      if (o) ctx.orientationAfter = o
    }
    const step = matchStep(raw, ctx)
    matched.push(step)
    hooks.onStep(step, shot ? URL.createObjectURL(new Blob([shot as BlobPart], { type: 'image/jpeg' })) : undefined)
  }
  return matched
}

export { toFlowSteps }

/** Run the edited flow on the device with the engine `tapflow flow run` uses. No run record: a check, not a run. */
export async function verifyFlow(
  tap: CaptureTap, channel: DashboardSessionChannel, lease: PauseLease, flow: Omit<Flow, 'file'>,
  secrets: Record<string, string>, onStep: (done: number) => void,
): Promise<FlowResult> {
  await lease.start()
  const driver = new SocketFlowDriver(channel, tap.sessionId, tap.buildId)
  return runFlow(flow, driver, {
    secrets,
    platform: tap.platform,
    onStep: (mark) => {
      if (mark.phase === 'start') lease.touch()
      else onStep(mark.index + 1)
    },
  })
}

/**
 * What one opening of the dialog holds that is not React state: the run in progress, and the screenshot URLs it made.
 * A class, so the dialog and its session share it by reference without mutating a prop.
 */
export class DialogRun {
  private controller: AbortController | null = null
  private readonly urls = new Set<string>()
  private ended = false

  /** True the first time only: the dialog's cleanup runs once, whether it was closed or taken away. */
  end(): boolean {
    if (this.ended) return false
    this.ended = true
    return true
  }

  /** A new run, stopping any before it. */
  begin(): AbortSignal {
    this.controller?.abort()
    this.controller = new AbortController()
    return this.controller.signal
  }

  abort(): void { this.controller?.abort() }

  keep(url: string): void { this.urls.add(url) }

  release(): void {
    for (const url of this.urls) URL.revokeObjectURL(url)
    this.urls.clear()
  }
}
