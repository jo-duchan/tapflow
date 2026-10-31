import type { DeviceReport } from '@tapflowio/protocol'

/** How often an agent re-reads its device list (#1085). Measured on a MacBook with 95 simulators: `simctl list` costs
 *  0.11–0.23 s and about 0.1 s of CPU, so this is about 0.3% of a core. */
export const DEVICE_REREAD_MS = 30_000

export interface DeviceListWatcherOptions {
  /** The list this agent would offer now — filtered and described exactly as at registration. Throwing means "not
   *  known this time", never "no devices". */
  read: () => Promise<DeviceReport[]>
  /** Sends `agent:devices` with this list. */
  send: (devices: DeviceReport[]) => void
  onReadError?: (e: unknown) => void
  intervalMs?: number
}

/**
 * Re-reads an agent's device list on a timer and sends it whole when it changed, so a simulator or emulator added or
 * deleted on the Mac reaches the relay without an agent restart (#1085). Started only for a relay that announced
 * `'device-updates'`, with the list the register carried as the baseline.
 *
 * What counts as a change is narrower than "different", and each exclusion is a value the relay keeps for itself:
 * - `status` is not compared. The relay tracks boots from `device:ready` and shutdowns.
 * - `serviceTier` is not compared, for the same reason.
 * - A version going from a value to none is not a change. An Android emulator that is not running reports none, and
 *   its version has not changed.
 *
 * And a device leaves the list only on the second read in a row without it. A read taken while CoreSimulator or adb
 * is restarting can miss a device that is still there, and removing it would give it a new session when it returns.
 * A device that appears is sent on the first read.
 */
export class DeviceListWatcher {
  private sent: DeviceReport[] = []
  private missingOnce = new Set<string>()
  private timer: ReturnType<typeof setInterval> | null = null
  private reading = false
  /** Bumped by `start` and `stop`, so a read that outlives either is dropped instead of sent on a newer connection. */
  private generation = 0
  private readonly intervalMs: number

  constructor(private readonly options: DeviceListWatcherOptions) {
    this.intervalMs = options.intervalMs ?? DEVICE_REREAD_MS
  }

  start(baseline: DeviceReport[]): void {
    this.stop()
    this.sent = baseline
    this.timer = setInterval(() => { void this.tick() }, this.intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    this.generation++
    if (this.timer) { clearInterval(this.timer); this.timer = null }
    this.missingOnce.clear()
    // `reading` is left as it is: a read still pending from the last connection holds the next one back too, or a
    // wedged `simctl` would gain another read per reconnect. Its result is dropped by the generation check.
  }

  /** One read. Public so a test can drive it without waiting out the interval. */
  async tick(): Promise<void> {
    // One read at a time: a `simctl list` stuck on a wedged CoreSimulator must not stack another behind it.
    if (this.reading || this.timer === null) return
    const generation = this.generation
    this.reading = true
    let read: DeviceReport[]
    try {
      read = await this.options.read()
    } catch (e) {
      if (generation === this.generation) this.options.onReadError?.(e)
      return
    } finally {
      this.reading = false
    }
    if (generation !== this.generation) return

    const now = new Map(read.map((d) => [d.id, d]))
    const next: DeviceReport[] = [...read]
    for (const prev of this.sent) {
      if (now.has(prev.id)) {
        this.missingOnce.delete(prev.id)
        continue
      }
      if (this.missingOnce.has(prev.id)) {
        this.missingOnce.delete(prev.id)
        continue
      }
      // First read without it: keep it as it was, and decide on the next one.
      this.missingOnce.add(prev.id)
      next.push(prev)
    }

    if (!changed(this.sent, next)) return
    // The baseline keeps a version the read no longer carries, so its absence stays a non-change next time too.
    const before = new Map(this.sent.map((d) => [d.id, d]))
    this.sent = next.map((d) => (d.osVersion === undefined && before.get(d.id)?.osVersion !== undefined
      ? { ...d, osVersion: before.get(d.id)!.osVersion }
      : d))
    this.options.send(next)
  }
}

function changed(sent: DeviceReport[], next: DeviceReport[]): boolean {
  if (sent.length !== next.length) return true
  const before = new Map(sent.map((d) => [d.id, d]))
  return next.some((d) => {
    const prev = before.get(d.id)
    if (!prev) return true
    if (prev.name !== d.name || prev.formFactor !== d.formFactor) return true
    return d.osVersion !== undefined && d.osVersion !== prev.osVersion
  })
}
