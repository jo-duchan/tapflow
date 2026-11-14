import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'

/** The device side: `SimctlWrapper`'s two calls. */
export interface AppAccessibilityHost {
  readAppAccessibility(udid: string): Promise<boolean | null>
  writeAppAccessibility(udid: string, value: boolean | null): Promise<void>
}

/**
 * App accessibility on a simulator a person Flow Capture records, and what it was before (record-time observation,
 * `.work` plan P1). With it on, SwiftUI and React Native build the accessibility nodes the app observer names a touch
 * by; off, a SwiftUI touch names nothing (P0, measured on iOS 26.5: Food Truck, Sample SwiftUI/UIKit, a React Native
 * app). Its cost was measured as none: frames over 25 ms during flings 5.3–5.6 % off, 5.5–6.3 % on.
 *
 * **The setting persists on the device**, which is why it was left off in #1162: an agent that dies cannot restore it.
 * So turning it on writes a marker on the host first, with the value it replaces, and the marker is what puts it
 * back — at the next boot that is not recorded, at a shutdown, and for a booted device when the agent starts. A value
 * already on is someone else's: nothing is marked and nothing is restored. The same shape as `LeanStore`.
 */
export class AppAccessibility {
  constructor(
    private readonly host: AppAccessibilityHost,
    private readonly root = '/private/var/tmp/tapflow-app-accessibility',
  ) {}

  /** On for `udid`, marked so it can be put back. Before an app launches: a running app keeps what it started with. */
  async enable(udid: string): Promise<void> {
    if (!this.marked(udid)) {
      const prior = await this.host.readAppAccessibility(udid)
      if (prior === true) return
      mkdirSync(this.root, { recursive: true, mode: 0o700 })
      atomicWrite(this.markerPath(udid), JSON.stringify({ prior }) + '\n')
    }
    await this.host.writeAppAccessibility(udid, true)
  }

  /** Put back what the marker recorded, then drop the marker. Nothing marked is nothing to do. */
  async restore(udid: string): Promise<void> {
    if (!this.marked(udid)) return
    let prior: boolean | null = null
    try {
      const v = (JSON.parse(readFileSync(this.markerPath(udid), 'utf8')) as { prior?: unknown }).prior
      prior = typeof v === 'boolean' ? v : null
    } catch { /* unreadable: the key is removed, as on a device nothing had set */ }
    await this.host.writeAppAccessibility(udid, prior)
    rmSync(this.markerPath(udid), { force: true })
  }

  /** Every device a marker names: what an agent that died left on. */
  markedDevices(): string[] {
    try {
      return readdirSync(this.root).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -'.json'.length))
    } catch {
      return []
    }
  }

  private marked(udid: string): boolean { return existsSync(this.markerPath(udid)) }
  // A udid comes from the relay's payload and names a file here: nothing but a udid's characters gets that far.
  private markerPath(udid: string): string {
    if (!/^[A-Za-z0-9-]+$/.test(udid)) throw new Error(`not a device id: ${JSON.stringify(udid)}`)
    return join(this.root, `${udid}.json`)
  }
}

function atomicWrite(path: string, body: string): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, body, { mode: 0o600 })
  renameSync(tmp, path)
}
