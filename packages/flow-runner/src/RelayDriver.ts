import type { FlowDriver } from './engine.js'
import type { RelayClient } from './RelayClient.js'

// Binds the engine's device surface to one relay session. launchApp targets
// the build under test (CLI --build / run_flow buildId) so flow files never
// hardcode a buildId and stay portable across CI runs.
export class RelayDriver implements FlowDriver {
  constructor(
    private readonly client: RelayClient,
    private readonly sessionId: string,
    private readonly buildId?: number,
  ) {}

  queryUITree() { return this.client.queryUITree(this.sessionId) }

  async tap(x: number, y: number): Promise<void> {
    this.client.tap(this.sessionId, x, y)
  }

  swipe(from: [number, number], to: [number, number], durationMs: number) {
    return this.client.swipe(this.sessionId, from, to, durationMs)
  }

  inputText(text: string): Promise<void> {
    return this.client.typeText(this.sessionId, text)
  }

  async pressKey(code: string): Promise<void> {
    this.client.pressKey(this.sessionId, code)
  }

  openUrl(url: string) { return this.client.openUrl(this.sessionId, url) }

  async launchApp(): Promise<void> {
    if (this.buildId === undefined) {
      throw new Error('launchApp needs a build under test — pass --build <id> (CLI) or buildId (run_flow)')
    }
    await this.client.launchApp(this.sessionId, this.buildId)
  }

  clearState(appId: string) { return this.client.clearState(this.sessionId, appId) }

  screenshot() { return this.client.screenshot(this.sessionId) }
}
