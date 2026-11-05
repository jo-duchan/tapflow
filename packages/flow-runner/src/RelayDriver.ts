import type { FlowDriver, PinchFingers } from './engine.js'

const TURN_SETTLE_MS = 2_000
const TURN_SETTLE_POLL_MS = 200
import type { ChromePayload, LaunchApplied, LaunchOptions } from '@tapflowio/protocol'
import { toFramePoint, type InterfaceTurn } from '@tapflowio/protocol/screen'
import {
  ENVIRONMENTAL_INPUT_REASONS,
  InputRefusedError,
  InputUnconfirmedError,
  type RelayClient,
  RelayClosedError,
  RelayHttpError,
  RelayUnavailableError,
  RequestTimeoutError,
  SessionEndedError,
  SessionLeftError,
  SessionUnavailableError,
} from './RelayClient.js'
import { EnvironmentStepError, markEnvironmentFailure } from './errors.js'

// Relay, agent or session level, as opposed to a product failure the flow is
// testing for. SessionLeftError joins the set: a client that walked away from
// its session mid-run has no session to continue on, whatever the reason was.
// TransientQueryError is deliberately absent: it never escapes the engine's
// poll loop, and anything that did would be a bug rather than a category.
function isEnvironmentFailure(e: unknown): boolean {
  if (e instanceof InputRefusedError) return ENVIRONMENTAL_INPUT_REASONS.has(e.reason)
  // No trailing `instanceof PlatformError`: RelayClient.failed() returns a plain
  // PlatformError for failures on a healthy session (e.g. a broken build that
  // cannot launch), which must stay a product failure (exit 1). Session-scoped
  // failures on an actually unavailable session already arrive as
  // SessionUnavailableError, so the distinction is preserved without it.
  if (
    e instanceof SessionEndedError ||
    e instanceof SessionLeftError ||
    e instanceof RelayClosedError ||
    e instanceof RelayHttpError ||
    e instanceof RelayUnavailableError ||
    e instanceof RequestTimeoutError ||
    e instanceof InputUnconfirmedError ||
    e instanceof SessionUnavailableError
  ) {
    return true
  }
  return false
}

// Binds the engine's device surface to one relay session. launchApp targets
// the build under test (CLI --build / run_flow buildId) so flow files never
// hardcode a buildId and stay portable across CI runs.
//
// Every method marks an environmental failure so the engine can carry the kind
// to the CLI's exit code without replacing the original error object. Anything
// else (selector misses, assertion timeouts, and transient query blips) is
// rethrown untouched, messages verbatim either way.
export class RelayDriver implements FlowDriver {
  /**
   * The app's interface turn from the latest tree this driver read (`UiTreeResponse.interfaceTurn`). A flow's points
   * — a selector's center, or a coordinate it wrote — are in the app's upright interface, and a touch is in the
   * portrait framebuffer, so each is turned by this before it is sent. Held per driver, which is one run on one
   * session: a value from an earlier run, or from someone else's read, is never applied. Undefined turns nothing —
   * Android, an older agent, a multi-panel device.
   */
  private turn: InterfaceTurn | undefined

  constructor(
    private readonly client: RelayClient,
    private readonly sessionId: string,
    private readonly buildId?: number,
  ) {}

  private point(x: number, y: number): [number, number] {
    return toFramePoint(this.turn, [x, y])
  }

  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (e) {
      if (isEnvironmentFailure(e)) throw markEnvironmentFailure(e as Error)
      throw e
    }
  }

  async queryUITree(signal?: AbortSignal) {
    const { elements, interfaceTurn } = await this.guard(() => this.client.queryUITreeWithTurn(this.sessionId, signal))
    this.turn = interfaceTurn
    return elements
  }

  tap(x: number, y: number): Promise<void> {
    const [fx, fy] = this.point(x, y)
    return this.guard(() => this.client.tap(this.sessionId, fx, fy))
  }

  swipe(from: [number, number], to: [number, number], durationMs: number) {
    return this.guard(() => this.client.swipe(this.sessionId, this.point(...from), this.point(...to), durationMs))
  }

  inputText(text: string): Promise<void> {
    return this.guard(() => this.client.typeText(this.sessionId, text))
  }

  pressKey(code: string): Promise<void> {
    return this.guard(() => this.client.pressKey(this.sessionId, code))
  }

  openUrl(url: string) { return this.guard(() => this.client.openUrl(this.sessionId, url)) }

  pressButton(name: string): Promise<void> {
    return this.guard(() => this.client.pressButton(this.sessionId, name))
  }

  longPress(x: number, y: number, durationMs: number): Promise<void> {
    const [fx, fy] = this.point(x, y)
    return this.guard(() => this.client.longPress(this.sessionId, fx, fy, durationMs))
  }

  /**
   * `unsupported` is a product reason everywhere else — it names the test's own request, a misspelt key — but a pinch
   * refused as unsupported is Android's adb fallback, the backend a device lands on without a pointer channel. That is
   * the device, not the app, so it is the environment's here and only here.
   */
  async pinch(start: PinchFingers, end: PinchFingers, durationMs: number): Promise<void> {
    try {
      const turned = (f: PinchFingers): PinchFingers => [this.point(...f[0]), this.point(...f[1])]
      await this.guard(() => this.client.pinch(this.sessionId, turned(start), turned(end), durationMs))
    } catch (e) {
      if (e instanceof InputRefusedError && e.reason === 'unsupported') throw markEnvironmentFailure(e)
      throw e
    }
  }

  /**
   * Turn the device, then read which way the app now stands. The device's chrome answers before the app has
   * finished turning, so a single read could keep the old turn for a coordinate step that follows: read until two in
   * a row agree, for at most `TURN_SETTLE_MS`. Best effort: a read that fails leaves the last value, and the step still
   * passes.
   *
   * **A read with no turn means one of two things**, and which is decided before the loop. Where no turn is expected —
   * Android, whose tree and touch share a space, so nothing this run read said otherwise — it ends the loop on the
   * first read, which on Android costs a second of uiautomator. Where one is (an iOS chrome, or a turn already read this
   * run) it is a turn caught mid-way: the runner answers 0 when its two reads of the app disagree, and taking that as
   * the answer left the next coordinate step untransformed in exactly the window this loop exists for. Those reads are
   * passed over. An iOS agent too old to report a turn reads none for the whole budget and ends with none, as before.
   */
  async setOrientation(orientation: 'portrait' | 'landscape', timeoutMs: number): Promise<void> {
    await this.guard(() => this.client.setOrientation(this.sessionId, orientation, timeoutMs))
    const chrome = await this.client.chrome(this.sessionId, 1).catch(() => null)
    const expected = this.turn !== undefined || (chrome !== null && 'framePng' in chrome)
    const until = Date.now() + TURN_SETTLE_MS
    let previous: InterfaceTurn | null = null
    while (Date.now() < until) {
      let read: InterfaceTurn | undefined
      try {
        read = (await this.client.queryUITreeWithTurn(this.sessionId, AbortSignal.timeout(Math.max(1, until - Date.now())))).interfaceTurn
      } catch {
        return
      }
      if (read === undefined) {
        if (!expected) {
          this.turn = undefined
          return
        }
      } else {
        this.turn = read
        if (read === previous) return
        previous = read
      }
      await new Promise((r) => setTimeout(r, TURN_SETTLE_POLL_MS))
    }
  }

  setPosture(posture: 'folded' | 'unfolded', timeoutMs: number): Promise<void> {
    return this.guard(() => this.client.setPosture(this.sessionId, posture, timeoutMs))
  }

  chrome(timeoutMs: number): Promise<ChromePayload | null> {
    return this.guard(() => this.client.chrome(this.sessionId, timeoutMs))
  }

  async launchApp(options?: LaunchOptions): Promise<LaunchApplied | undefined> {
    const buildId = this.buildId
    if (buildId === undefined) {
      throw new EnvironmentStepError('launchApp needs a build under test — pass --build <id> (CLI) or buildId (run_flow)')
    }
    return this.guard(() => this.client.launchApp(this.sessionId, buildId, options))
  }

  clearState(appId: string) { return this.guard(() => this.client.clearState(this.sessionId, appId)) }

  screenshot(signal?: AbortSignal) { return this.guard(() => this.client.screenshot(this.sessionId, signal)) }
}
