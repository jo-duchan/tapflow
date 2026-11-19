import type { RelayClient } from './RelayClient.js'
import { SocketFlowDriver } from './SocketFlowDriver.js'

/** `SocketFlowDriver` over a `RelayClient`: the Node host the CLI and `run_flow` drive a session with. */
export class RelayDriver extends SocketFlowDriver {
  constructor(client: RelayClient, sessionId: string, buildId?: number) {
    super(client, sessionId, buildId)
  }
}
