import type { BrowserToRelay, ReachResult, ReachTarget, RunResetItem, RunResetReport, UIElement } from '@tapflowio/protocol'
import type { InterfaceTurn } from '@tapflowio/protocol/screen'
import {
  newRequestId, parseUITreeResponse, reachRequest, readReachResults, RelayClosedError, RelayHttpError, SessionChannel, type RelayMsg, type SessionDevice,
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
 * How long the dialog waits for a run reset (#1139): the agent's budget (`RUN_RESET_BUDGET_MS`, 60 s), the longest step
 * that can still be running when it ends — an iOS reinstall, 10 s to find the bundle, 10 s to uninstall, 30 s to install
 * — one more step's 10 s (a pasteboard clear, Android's late `pm clear`), and room. Held to those by
 * `scripts/__tests__/bootDeadlineOutlivesAgent.test.mjs`, since a waiter that gives up first replaces the agent's report
 * with a bare timeout. Under the relay's 180 s for a request a rebind strands.
 */
const RUN_RESET_WAIT_MS = 150_000

/** What a run reset did. The protocol's report, with any item this dialog does not name kept as the agent said it. */
export type HeldResetReport = RunResetReport

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

  /**
   * Reset the session's device the way `tapflow flow run` resets one before a run (#1139): `apps` as freshly installed,
   * then the device-wide items, the network and the turn. The report says what was done; `undefined` when the agent
   * does not take the request, so the replay goes on from the app's data alone and says the device was not reset.
   * Here rather than on flow-runner's channel: only this dialog asks, and it ships inside the relay that forwards it,
   * where an older relay would drop the request without a word.
   */
  async runReset(sessionId: string, apps: string[]): Promise<HeldResetReport | undefined> {
    const requestId = newRequestId()
    this.send({ type: 'device:run-reset', sessionId, requestId, payload: { apps } })
    const msg = await this.waitFor(
      (m) => (m['type'] === 'device:run-reset-done' || m['type'] === 'device:run-reset-error') && m['requestId'] === requestId,
      RUN_RESET_WAIT_MS,
      'reset the device',
      sessionId,
    )
    if (msg['type'] === 'device:run-reset-done') return readReport(msg['report'])
    if (msg['reason'] === 'unsupported') return undefined
    throw this.failed(sessionId, typeof msg['message'] === 'string' ? msg['message'] : 'the device could not be reset')
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

  /**
   * Where touches meant for `targets` land, as the device's agent judges them (#1125), so Verify taps where CI will.
   * The relay this dialog ships in has the route; an answer it cannot use is every target `unknown`.
   */
  async reach(sessionId: string, targets: ReachTarget[], signal?: AbortSignal): Promise<ReachResult[]> {
    let res: Response
    try {
      res = await fetch(`/api/v1/sessions/${sessionId}/reach`, { ...reachRequest(targets, signal), credentials: 'include' })
    } catch (e) {
      throw this.treeQueryFailure(sessionId, new RelayHttpError(`reach query failed: ${(e as Error).message}`, 0, { cause: e }))
    }
    if (!res.ok) throw this.treeQueryFailure(sessionId, new RelayHttpError(`reach query failed: ${res.status}`, res.status))
    return readReachResults(await res.json().catch(() => null), targets.length)
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

/** An agent's report, read item by item: a malformed one counts as nothing done rather than a reset device. */
function readReport(value: unknown): HeldResetReport {
  const items = (v: unknown) => (Array.isArray(v) ? v.filter((i): i is RunResetItem => typeof i === 'string') : [])
  const r = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
  return { done: items(r['done']), failed: items(r['failed']) }
}
