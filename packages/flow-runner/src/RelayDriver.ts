import type { FlowDriver, PinchFingers } from './engine.js'
import type { ChromePayload, LaunchApplied, LaunchOptions } from '@tapflowio/protocol'
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
  constructor(
    private readonly client: RelayClient,
    private readonly sessionId: string,
    private readonly buildId?: number,
  ) {}

  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (e) {
      if (isEnvironmentFailure(e)) throw markEnvironmentFailure(e as Error)
      throw e
    }
  }

  queryUITree(signal?: AbortSignal) { return this.guard(() => this.client.queryUITree(this.sessionId, signal)) }

  tap(x: number, y: number): Promise<void> {
    return this.guard(() => this.client.tap(this.sessionId, x, y))
  }

  swipe(from: [number, number], to: [number, number], durationMs: number) {
    return this.guard(() => this.client.swipe(this.sessionId, from, to, durationMs))
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
    return this.guard(() => this.client.longPress(this.sessionId, x, y, durationMs))
  }

  /**
   * `unsupported` is a product reason everywhere else — it names the test's own request, a misspelt key — but a pinch
   * refused as unsupported is Android's adb fallback, the backend a device lands on without a pointer channel. That is
   * the device, not the app, so it is the environment's here and only here.
   */
  async pinch(start: PinchFingers, end: PinchFingers, durationMs: number): Promise<void> {
    try {
      await this.guard(() => this.client.pinch(this.sessionId, start, end, durationMs))
    } catch (e) {
      if (e instanceof InputRefusedError && e.reason === 'unsupported') throw markEnvironmentFailure(e)
      throw e
    }
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
