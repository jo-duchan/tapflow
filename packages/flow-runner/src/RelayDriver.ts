import type { RelayClient } from './RelayClient.js'
import { SocketFlowDriver, type SentTouch } from './SocketFlowDriver.js'

/** `SocketFlowDriver` over a `RelayClient`: the Node host `tapflow flow run` drives a session with. */
export class RelayDriver extends SocketFlowDriver {
  constructor(
    private readonly relay: RelayClient,
    private readonly session: string,
    buildId?: number,
    onInput?: (touch: SentTouch) => void,
  ) {
    super(relay, session, buildId, onInput)
  }

  /**
   * A run's screenshots — the screen a flow failed on, or ended on — are asked for as JPEG: a large screen's PNG (an
   * iPhone Air on a map, 5.4 MB) went past the relay's 5 MB cap and the run kept none (2026-11-22). The agent may answer
   * PNG (an older Android agent); whoever stores it reads the bytes.
   */
  override screenshot(signal?: AbortSignal) {
    return this.guard(() => this.relay.screenshot(this.session, signal, 'jpeg'))
  }
}
