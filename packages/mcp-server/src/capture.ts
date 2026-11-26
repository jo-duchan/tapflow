import type { BrowserToRelay, CaptureObservation, UIElement } from '@tapflowio/protocol'
import { fromFramePoint, type InterfaceTurn } from '@tapflowio/protocol/screen'
import type { AgentAction, AgentCapture, TreeRead } from '@tapflowio/flow-runner/browser'
import type { FlowDriver } from '@tapflowio/flow-runner'

/** How long a capture outlives the device it was made on (D8): an upper bound, not a promise. It holds what was typed,
 *  passwords included, so it is dropped sooner when a new capture opens or this process ends. */
export const KEEP_AFTER_RELEASE_MS = 60 * 60_000

type Touch = Extract<AgentAction, { kind: 'tap' } | { kind: 'swipe' }>

/**
 * MCP Flow Capture (L6a): what the agent did on one device while its capture was open, as this server saw it — the
 * element it tapped, what it typed, the trees it read, the `run_flow` blocks it ran — plus what the relay passed on of
 * each touch it sent (`capture:observation`). Held in memory only, never written to disk or logged.
 *
 * Touches are paired with their observations by `requestId`, which only this client knows: the relay passes on the
 * observation of a touch this socket sent, and nothing else. A Verify's own touches are sent while `verifying`, so they
 * are never paired and their observations are dropped (R-E).
 */
export class AgentCaptureRecorder implements AgentCapture {
  readonly actions: AgentAction[] = []
  readonly trees: TreeRead[] = []
  /** The app's interface turn from the latest tree, to carry a screenshot pixel into the app's space as a flow's points
   *  are. Undefined (Android, an older agent) turns nothing. */
  turn: InterfaceTurn | undefined
  /** The build `launch_app` last launched: what Verify launches and resets. */
  buildId: number | undefined
  /** A `launch_app` carried arguments, which a flow's `launchApp` does not write. */
  launchOptions = false
  verifying = false
  attempts = 0
  readonly failedBefore = new Set<number>()
  private blocks = 0
  /** When the device was let go; the capture is kept `KEEP_AFTER_RELEASE_MS` after it. */
  private released: number | undefined
  /** Touch-ends sent since the last `take`, outside a Verify. */
  private sent: string[] = []
  /** Every touch this capture sent, so an observation of anything else is dropped rather than held. */
  private readonly ours = new Set<string>()
  private readonly touches = new Map<string, Touch>()
  /** Observations that came before their touch was recorded (an ack can trail the agent's report). */
  private readonly early = new Map<string, CaptureObservation[]>()

  constructor(
    readonly sessionId: string,
    readonly platform: string | undefined,
    readonly observing: boolean,
    private readonly now: () => number = Date.now,
  ) {}

  /** The `client.onSend` listener. */
  noteSent(msg: BrowserToRelay): void {
    if (this.verifying || !('sessionId' in msg) || msg.sessionId !== this.sessionId) return
    if ((msg.type === 'input:touch:end' || msg.type === 'input:pinch:end') && msg.requestId) {
      this.sent.push(msg.requestId)
      this.ours.add(msg.requestId)
    }
  }

  /** The touch-ends sent since the last call: the one input a tool just made. */
  take(): string[] {
    return this.sent.splice(0)
  }

  /** The `client.onObservation` listener. The latest report of a touch wins: iOS repeats it with the app's verdict. */
  noteObservation(msg: CaptureObservation): void {
    if (msg.sessionId !== this.sessionId || !this.ours.has(msg.requestId)) return
    const touch = this.touches.get(msg.requestId)
    if (!touch) {
      this.early.set(msg.requestId, [...(this.early.get(msg.requestId) ?? []), msg])
      return
    }
    if (msg.touched && touch.kind === 'tap') touch.observed = msg.touched
    if (msg.landed) touch.landed = msg.landed
  }

  tree(elements: UIElement[], read: { interfaceTurn?: InterfaceTurn; aspect?: number } = {}, at = this.now()): void {
    this.trees.push({ at, elements, ...(read.aspect !== undefined ? { aspect: read.aspect } : {}) })
    if ('interfaceTurn' in read) this.turn = read.interfaceTurn
  }

  /** A pixel of the screenshot (the device's framebuffer, as `tap` and `swipe` take it) in the app's space. */
  appPoint(x: number, y: number): [number, number] {
    return fromFramePoint(this.turn, [x, y])
  }

  /** Record an action; a touch is paired with the touch-ends its tool sent (the last of them is the gesture's). */
  add(action: AgentAction, touchEnds: string[] = []): void {
    this.actions.push(action)
    if (action.kind !== 'tap' && action.kind !== 'swipe') return
    const id = touchEnds.at(-1)
    if (id === undefined) return
    this.touches.set(id, action)
    for (const msg of this.early.get(id) ?? []) this.noteObservation(msg)
    this.early.delete(id)
  }

  /** A `run_flow` the agent ran while capturing, numbered from 1. */
  addBlock(action: Omit<Extract<AgentAction, { kind: 'flow' }>, 'block'>): void {
    this.blocks++
    this.actions.push({ ...action, block: this.blocks })
  }

  release(): void {
    this.released = this.now()
  }

  hold(): void {
    this.released = undefined
  }

  get expired(): boolean {
    return this.released !== undefined && this.now() - this.released >= KEEP_AFTER_RELEASE_MS
  }
}

/**
 * The driver an element tap and `run_flow` use while a capture is open: every tree the engine reads is recorded, and
 * with `touches`, the point and touch-end of each tap and long press, in the app's space, as the engine sent them.
 */
export function recordingDriver(base: FlowDriver, rec: AgentCaptureRecorder, touches?: { last?: Extract<AgentAction, { kind: 'tap' }>; ends?: string[] }): FlowDriver {
  const touched = (point: [number, number], at: number, holdMs?: number) => {
    if (!touches) return
    touches.last = { kind: 'tap', at, point, ...(holdMs !== undefined ? { holdMs } : {}) }
    touches.ends = rec.take()
  }
  return {
    ...base,
    queryUITree: async (signal) => {
      const elements = await base.queryUITree(signal)
      rec.tree(elements)
      return elements
    },
    tap: async (x, y) => {
      const at = Date.now()
      rec.take()
      await base.tap(x, y)
      touched([x, y], at)
    },
    longPress: async (x, y, durationMs) => {
      const at = Date.now()
      rec.take()
      await base.longPress(x, y, durationMs)
      touched([x, y], at, durationMs)
    },
  }
}
