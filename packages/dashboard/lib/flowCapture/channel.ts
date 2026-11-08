import type { BrowserToRelay, UIElement } from '@tapflowio/protocol'
import type { InterfaceTurn } from '@tapflowio/protocol/screen'
import {
  parseUITreeResponse, RelayClosedError, RelayHttpError, SessionChannel, type RelayMsg, type SessionDevice,
} from '@tapflowio/flow-runner/browser'
import type { CaptureTap } from './tap'

/**
 * A GET with the cookie whose rejection — no connection, or a deadline's abort — is a `RelayHttpError` with status 0, as
 * `RelayClient` makes it. Thrown as it came, a read cut off at its deadline was not transient to `treeQueryFailure`, and
 * the settle wait stopped the whole replay on "signal timed out" instead of going on with the last read it had.
 */
async function get(path: string, what: string, signal?: AbortSignal): Promise<Response> {
  try {
    return await fetch(path, { credentials: 'include', ...(signal ? { signal } : {}) })
  } catch (e) {
    throw new RelayHttpError(`${what} failed: ${(e as Error).message}`, 0, { cause: e })
  }
}

/**
 * flow-runner's session semantics over the dashboard's own socket (#1125): the same waiters, gestures and acks
 * `tapflow flow run` uses, so a flow verified here behaves as it will in CI. Built inside the dialog's chunk — the
 * viewer hands over a `CaptureTap` that imports none of this.
 */
export class DashboardSessionChannel extends SessionChannel {
  private readonly detach: Array<() => void> = []

  // `viewer`, not `tap`: `SessionChannel.tap` is the gesture.
  constructor(private readonly viewer: CaptureTap) {
    super()
    // The chrome and postures came at the join and the boot, before this channel existed.
    this.seed(viewer.sessionId, viewer.chrome(), viewer.postures())
    this.detach.push(viewer.subscribe((msg) => this.dispatch(msg as unknown as RelayMsg)))
    this.detach.push(viewer.onConnectionLost(() => this.connectionLost('the connection to the relay closed')))
  }

  protected send(msg: BrowserToRelay): void {
    // The socket drops what it cannot send; the channel's contract is to throw, so a request fails now instead of
    // waiting out its deadline for an answer to a message that never left.
    if (!this.viewer.send(msg)) throw new RelayClosedError('the connection to the relay is not open')
  }

  /** Stop listening. Waiters still pending are failed as on a lost connection. */
  close(): void {
    for (const off of this.detach.splice(0)) off()
    this.connectionLost('the capture dialog closed')
  }

  /** The tree with the app's turn, over the browser's fetch and cookie; failures judged as `RelayClient` judges them. */
  async queryUITreeWithTurn(sessionId: string, signal?: AbortSignal): Promise<{ elements: UIElement[]; interfaceTurn?: InterfaceTurn }> {
    try {
      const res = await get(`/api/v1/sessions/${sessionId}/ui-tree`, 'ui-tree query', signal)
      if (!res.ok) throw new RelayHttpError(`ui-tree query failed: ${res.status}`, res.status)
      return parseUITreeResponse(await res.json())
    } catch (e) {
      throw this.treeQueryFailure(sessionId, e)
    }
  }

  async queryUITree(sessionId: string, signal?: AbortSignal): Promise<UIElement[]> {
    return (await this.queryUITreeWithTurn(sessionId, signal)).elements
  }

  /** A JPEG: the relay's default is a full-size PNG, one to three megabytes a step. */
  async screenshot(sessionId: string, signal?: AbortSignal): Promise<Uint8Array> {
    const res = await get(`/api/v1/sessions/${sessionId}/screenshot?format=jpeg`, 'screenshot', signal)
    if (!res.ok) throw new RelayHttpError(`screenshot failed: ${res.status}`, res.status)
    return new Uint8Array(await res.arrayBuffer())
  }
}

/** The channel is the device: it has the reads `SocketFlowDriver` needs beside the inputs. */
export function sessionDevice(channel: DashboardSessionChannel): SessionDevice {
  return channel
}
