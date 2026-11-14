import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
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

  // One change at a time per device: a restore that ran while an enable's write was still out would read the marker,
  // put the prior value back and drop the marker, and the late write would leave it on with nothing to undo it.
  private readonly chains = new Map<string, Promise<unknown>>()

  private serial<T>(udid: string, work: () => Promise<T>): Promise<T> {
    const next = (this.chains.get(udid) ?? Promise.resolve()).catch(() => undefined).then(work)
    this.chains.set(udid, next)
    void next.finally(() => { if (this.chains.get(udid) === next) this.chains.delete(udid) }).catch(() => undefined)
    return next
  }

  /** On for `udid`, marked so it can be put back. Before an app launches: a running app keeps what it started with. */
  enable(udid: string): Promise<void> { return this.serial(udid, () => this.enableNow(udid)) }

  /** Put back what the marker recorded, then drop the marker. Nothing marked is nothing to do. */
  restore(udid: string): Promise<void> { return this.serial(udid, () => this.restoreNow(udid)) }

  private async enableNow(udid: string): Promise<void> {
    if (!this.marked(udid)) {
      const prior = await this.host.readAppAccessibility(udid)
      if (prior === true) return
      this.ownRoot()
      atomicWrite(this.markerPath(udid), JSON.stringify({ prior }) + '\n')
    }
    await this.host.writeAppAccessibility(udid, true)
  }

  private async restoreNow(udid: string): Promise<void> {
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

  /**
   * The marker directory, ours and private. `/private/var/tmp` is writable by every user on the Mac: one made there by
   * someone else, or a symlink, could forge a marker's prior value or point a write elsewhere, so it is refused.
   */
  private ownRoot(): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    const st = lstatSync(this.root)
    if (!st.isDirectory() || st.isSymbolicLink() || (process.getuid && st.uid !== process.getuid())) {
      throw new Error(`refusing the app accessibility marker directory ${this.root}: not a directory this user owns`)
    }
    chmodSync(this.root, 0o700)
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
  // Exclusive, so a file (or symlink) left at the temporary name is never written through.
  rmSync(tmp, { force: true })
  writeFileSync(tmp, body, { mode: 0o600, flag: 'wx' })
  renameSync(tmp, path)
}
