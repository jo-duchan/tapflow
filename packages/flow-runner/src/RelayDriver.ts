import type { RelayClient } from './RelayClient.js'
import { SocketFlowDriver, type SentTouch } from './SocketFlowDriver.js'

/** `SocketFlowDriver` over a `RelayClient`: the Node host the CLI and `run_flow` drive a session with. */
export class RelayDriver extends SocketFlowDriver {
  constructor(client: RelayClient, sessionId: string, buildId?: number, onInput?: (touch: SentTouch) => void) {
    super(client, sessionId, buildId, onInput)
  }
}
