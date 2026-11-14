import { randomUUID } from 'crypto'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { PlatformError, MAX_CLIPBOARD_BYTES } from '@tapflowio/agent-core'
import type { LaunchOptions } from '@tapflowio/protocol'
import { hasLaunchOptions } from '@tapflowio/protocol/launch'
import { iosLaunchArgv, simctlChildEnv } from './launchArgs.js'

const execFileAsync = promisify(execFile)
const ROTATION_HELPER  = join(import.meta.dirname, '..', 'bin', 'rotation-helper')

// Language code → iOS AppleKeyboards entry string with hw=Automatic.
// hw=Automatic lets iOS switch the hardware layout when the input source changes via LANG1/CapsLock.
// hw=Korean (previous approach) locked the hardware layout to Korean regardless of active input source,
// which caused the toggle HUD to appear but not actually change key output.
const LANG_KEYBOARD_MAP: Record<string, string> = {
  ko:   'ko_KR@sw=Korean;hw=Automatic',
  ja:   'ja_JP@sw=Japanese-Kana;hw=Automatic',
  zh:   'zh_Hans_CN@sw=ChineseSimplified-Pinyin;hw=Automatic',
  fr:   'fr_FR@sw=French;hw=Automatic',
  de:   'de_DE@sw=German;hw=Automatic',
  es:   'es_ES@sw=Spanish;hw=Automatic',
  it:   'it_IT@sw=Italian;hw=Automatic',
  pt:   'pt_BR@sw=Portuguese;hw=Automatic',
  ru:   'ru_RU@sw=Russian;hw=Automatic',
  ar:   'ar@sw=Arabic;hw=Automatic',
  th:   'th_TH@sw=Thai;hw=Automatic',
}

function langToKeyboard(lang: string): string {
  const code = lang.split('-')[0].toLowerCase()
  return LANG_KEYBOARD_MAP[code] ?? 'en_US@sw=QWERTY;hw=Automatic'
}


// A hung pasteboard call must not strand the caller: the read path holds a sentinel on the
// device until it finishes, so "never returns" would leave the device clipboard destroyed.
const CLIPBOARD_CMD_TIMEOUT_MS = 5_000
// A field read waits on this, and a capture snapshot waits 1 s for a field read, so it is bounded below that: a read
// takes about 0.41 s (measured, 5 of 5). Bounded as a whole too, since the runner retries after restarting the service.
const KEYBOARD_READ_TIMEOUT_MS = 800
// `launchctl list`, asked when the app observer gets no answer in its 1.5 s: 0.3 s measured (5 of 5). The relay waits
// 5 s for the read, and every later read on the device queues behind this one, so it is bounded within that. A timeout
// reads as running (not judged), never as gone.
const APP_RUNNING_TIMEOUT_MS = 2_000
// A run reset's device-wide commands take about a second each (measured: keychain 1.0 s, privacy 0.5 s, location 0.5 s).
// A command this bound kills does not land later, which is why iOS needs nothing like Android's pending `pm clear` wait:
// measured on iOS 26.5 by killing `simctl uninstall` and `simctl keychain reset` mid-flight, each either finished before
// the kill or never happened, nothing changed in the 3 s after, and an install or keychain add sent right after the kill
// survived — CoreSimulatorService runs a device's requests in order.
const RESET_CMD_TIMEOUT_MS = 10_000
// An install copies the whole bundle, so it grows with the app where the reset's other commands do not.
const REINSTALL_TIMEOUT_MS = 30_000
// `Booted` appears in `simctl list` before the system services are up: `bootstatus` took 6–28 s more on an iOS 26.5
// simulator. A reset sent in that gap reaches tccd and securityd before they serve.
const BOOT_STATUS_TIMEOUT_MS = 60_000

// The rotation helper's `mach_msg` waits with no timeout, and rotations are queued one behind another
// (#910), so one that never returns would hold every later rotation — and the boot that waits on one.
const ROTATE_TIMEOUT_MS = 5_000

// simctl failures reach a user-facing toast. Node's first line is "Command failed: <argv>",
// which says nothing and echoes the device UDID, so prefer any other line. When there is none
// (e.g. the timeout path, where stderr is empty) fall back to a plain description rather than
// the argv line this exists to drop.
export function firstLine(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  const lines = msg.split('\n').map((l) => l.trim()).filter(Boolean)
  return lines.find((l) => !l.startsWith('Command failed:')) ?? 'the simulator did not respond'
}

// `simctl launch` writes a header line ending in a colon before each reason ("An error was encountered
// processing the command (…):", "Underlying error (…):"), so `firstLine` would show the header. The
// launch reason is the first line that is neither the argv nor a header.
export function launchFailureReason(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  const lines = msg.split('\n').map((l) => l.trim()).filter(Boolean)
  return lines.find((l) => !l.startsWith('Command failed:') && !l.endsWith(':')) ?? firstLine(e)
}
import type { Device, DeviceStatus } from '@tapflowio/agent-core'
import type { FormFactor } from '@tapflowio/protocol'
import { defaultRunner, OutputTooLargeError, type SimctlRunner } from './simctl.js'
import { KeyboardHelperDaemon } from './KeyboardHelperDaemon.js'
import { parseIntegratedScreens, countIntegratedPanels, typePanels, type IntegratedScreen, type TypePanel } from './panels.js'

interface SimctlDevice {
  udid: string
  name: string
  state: string
  isAvailable: boolean
  deviceTypeIdentifier?: string
}

interface SimctlListOutput {
  devices: Record<string, SimctlDevice[]>
}

function toDeviceStatus(state: string): DeviceStatus {
  if (state === 'Booted') return 'booted'
  if (state === 'Shutdown') return 'shutdown'
  return 'unknown'
}

// "com.apple.CoreSimulator.SimRuntime.iOS-18-3" → "iOS 18.3"
function parseOsVersion(runtimeKey: string): string | undefined {
  const m = runtimeKey.match(/\.([A-Za-z]+)-(\d+(?:-\d+)*)$/)
  if (!m) return undefined
  return `${m[1]} ${m[2].replace(/-/g, '.')}`
}

// A device's data dir can vanish from disk (e.g. an Xcode/macOS update pruned its
// runtime) while simctl still lists it as available — `boot` then fails with this
// signature only. Matched conservatively (text only) so a healthy device is never erased.
export function isDeviceMissingError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { message?: unknown; stderr?: unknown }
  const text = [e.message, e.stderr].filter((s): s is string => typeof s === 'string').join(' ')
  return /cannot be located on disk|data is no longer present/i.test(text)
}

/** The device clipboard held more than `MAX_CLIPBOARD_BYTES`. The app did copy — we just cannot
 *  carry it — so a caller mid-handshake must NOT restore over it. */
export class ClipboardTooLargeError extends PlatformError {}

/** Bounds the device-type lookup in `formFactorsByType`. Generous: it runs once per connect. */
const DEVICE_TYPES_TIMEOUT_MS = 10_000
const IO_ENUMERATE_TIMEOUT_MS = 10_000
const PLUTIL_TIMEOUT_MS = 5_000

/** A plist as JSON, the way `plutil` converts it. Injectable so tests never read the host's device types. */
export type PlistReader = (path: string) => Promise<unknown>
const defaultPlistReader: PlistReader = async (path) =>
  JSON.parse((await execFileAsync('plutil', ['-convert', 'json', '-o', '-', path], { timeout: PLUTIL_TIMEOUT_MS })).stdout)

export class SimctlWrapper {
  private readonly kbd = new KeyboardHelperDaemon()

  constructor(
    private readonly runner: SimctlRunner = defaultRunner,
    private readonly readPlist: PlistReader = defaultPlistReader,
  ) {}

  /**
   * `timeoutMs` bounds the underlying `xcrun simctl list`. Left off everywhere except the boot poll:
   * a blanket timeout would fail a legitimately slow call, which is the reason `SimctlExecOpts.timeoutMs`
   * is per-call in the first place.
   */
  async listDevices(timeoutMs?: number): Promise<Device[]> {
    const output = timeoutMs === undefined
      ? await this.runner.exec('list', 'devices', '--json')
      : await this.runner.execWithOpts({ timeoutMs }, 'list', 'devices', '--json')
    const parsed: SimctlListOutput = JSON.parse(output)
    const devices: Device[] = []

    for (const [runtimeKey, runtimeDevices] of Object.entries(parsed.devices)) {
      const osVersion = parseOsVersion(runtimeKey)
      for (const d of runtimeDevices) {
        if (!d.isAvailable) continue
        devices.push({
          id: d.udid,
          name: d.name,
          platform: 'ios',
          status: toDeviceStatus(d.state),
          typeId: d.deviceTypeIdentifier,
          osVersion,
        })
      }
    }

    return devices
  }

  /**
   * Device type identifier → form factor, from `simctl list devicetypes`' `productFamily` — the one
   * listing that carries it; `list devices` does not.
   *
   * Read once per `connect()`, the only place it is used, and **never from `listDevices`**: that runs
   * inside the boot poll, whose per-call timeout is what keeps a wedged CoreSimulatorService from
   * holding the loop, and an unbounded lookup there would undo it. Bounded here for the same reason.
   * Rejects on failure; the caller falls back to its last answer, or to none.
   */
  async formFactorsByType(): Promise<Map<string, FormFactor>> {
    const out = await this.runner.execWithOpts({ timeoutMs: DEVICE_TYPES_TIMEOUT_MS }, 'list', 'devicetypes', '-j')
    const parsed = JSON.parse(out) as { devicetypes?: Array<{ identifier?: string; productFamily?: string }> }
    const byFamily: Record<string, FormFactor> = { iPhone: 'phone', iPad: 'tablet' }
    const map = new Map<string, FormFactor>()
    for (const t of parsed.devicetypes ?? []) {
      const f = t.productFamily && Object.hasOwn(byFamily, t.productFamily) ? byFamily[t.productFamily] : undefined
      if (t.identifier && f) map.set(t.identifier, f)
    }
    return map
  }

  /**
   * How many integrated panels each of `typeIds` has, from its `capabilities.plist`. A type whose plist
   * cannot be read counts as one panel: that is every device type before the Duo, and a wrong "one" leaves
   * a multi-panel device on the Indigo path, which is how it behaved before this existed.
   */
  async integratedPanelCounts(typeIds: string[]): Promise<Map<string, number>> {
    const wanted = new Set(typeIds)
    const counts = new Map<string, number>()
    if (wanted.size === 0) return counts
    const out = await this.runner.execWithOpts({ timeoutMs: DEVICE_TYPES_TIMEOUT_MS }, 'list', 'devicetypes', '-j')
    const parsed = JSON.parse(out) as { devicetypes?: Array<{ identifier?: string; bundlePath?: string }> }
    await Promise.all((parsed.devicetypes ?? []).map(async (t) => {
      if (!t.identifier || !t.bundlePath || !wanted.has(t.identifier)) return
      const plist = await this.readPlist(join(t.bundlePath, 'Contents', 'Resources', 'capabilities.plist')).catch(() => null)
      counts.set(t.identifier, countIntegratedPanels(plist))
    }))
    return counts
  }

  /** The integrated panels of `typeId` — empty when the type or its plist lists none (Xcode 26). **Rejects when
   *  the plist cannot be read**, unlike `integratedPanelCounts`: `TypePanels` keeps an answer for the life of the
   *  process and drops only a rejection, so a slow `plutil` read as "no panels" stood until the agent restarted —
   *  the unfolded panel drawn a quarter off, and the panels at two scales. */
  async typePanels(typeId: string): Promise<TypePanel[]> {
    const out = await this.runner.execWithOpts({ timeoutMs: DEVICE_TYPES_TIMEOUT_MS }, 'list', 'devicetypes', '-j')
    const parsed = JSON.parse(out) as { devicetypes?: Array<{ identifier?: string; bundlePath?: string }> }
    const type = (parsed.devicetypes ?? []).find((t) => t.identifier === typeId)
    if (!type?.bundlePath) return []
    return typePanels(await this.readPlist(join(type.bundlePath, 'Contents', 'Resources', 'capabilities.plist')))
  }

  /** The integrated panels of a booted device. Their UUIDs change on every boot, so this is read per boot. */
  async integratedScreens(udid: string): Promise<IntegratedScreen[]> {
    return parseIntegratedScreens(await this.runner.execWithOpts({ timeoutMs: IO_ENUMERATE_TIMEOUT_MS }, 'io', udid, 'enumerate'))
  }

  async boot(deviceId: string): Promise<void> {
    try {
      await this.runner.exec('boot', deviceId)
    } catch (err: unknown) {
      const stderr = (err as { stderr?: string }).stderr ?? ''
      // already booted is not an error
      if (stderr.includes('Unable to boot device in current state: Booted')) return
      throw err
    }
  }

  // `boot` returns when CoreSimulator has *accepted* the boot, and the device reaches `Booted`
  // seconds later — measured at 7.6s on an iPhone 17 Pro / iOS 26.5 (#486). A caller that announces
  // readiness on `boot` resolving is announcing something that is not yet true, which is what
  // `app install intermittently fails with "No devices are booted"` (#440) was left standing on.
  // Android has waited since the beginning (`EmulatorLauncher.waitForBoot`); this is the counterpart.
  // Exported, and read by `scripts/__tests__/bootDeadlineOutlivesAgent.test.mjs`: a client that gives up
  // before this does turns the agent's own reason into a bare timeout (#549).
  static readonly BOOT_READY_TIMEOUT_MS = 90_000
  private static readonly BOOT_POLL_INTERVAL_MS = 500
  // Bounds one reading, not the wait. `listDevices` is otherwise untimed, so a wedged
  // CoreSimulatorService makes the deadline below unreachable — the loop would sit inside a single
  // `xcrun` forever and never look at the clock again. A fixed ceiling rather than "whatever is left of
  // the deadline": the latter lets the last reading swallow the remaining 89 seconds with no retry, and
  // a healthy `simctl list` answers in well under a second, so 5s is already several times slack.
  private static readonly BOOT_POLL_READ_TIMEOUT_MS = 5_000

  /**
   * Polls the device list until `deviceId` reports `booted`, and returns it — so the caller sends
   * on the value it read rather than asserting one.
   *
   * **Every status other than `booted` counts as still coming up, `shutdown` included.**
   * `toDeviceStatus` collapses `Booting` into `unknown`, and this only ever runs after a `boot` was
   * accepted — `handleDeviceBoot` issues one on every path, deliberately including the one where
   * the list already said `booted`, precisely so this sentence stays true. So a `shutdown` reading
   * here is the transition not yet observed, and failing on it would race a boot that was about to
   * succeed. A draft gave `shutdown` a 3s grace instead; it was removed, because the reading it
   * would end early is indistinguishable from a slow machine's, the 3s answered no measurement, and
   * the case it was for is better removed than timed.
   *
   * **A failed reading is not a reading.** `listDevices` spawns `xcrun simctl list`, and this does
   * it up to `timeoutMs / pollIntervalMs` times where the old code did it once — every one an
   * independent chance to kill a healthy boot, during the interval when CoreSimulator is busiest.
   * Failures are swallowed and retried, and the last one is reported with the deadline so the cause
   * is not lost. Android's poll has always done this (`EmulatorLauncher.waitForBoot`); the first
   * draft of this method did not, which made the "counterpart" claim false in the one way that
   * matters.
   *
   * **And a reading has to end.** Each one is bounded by `BOOT_POLL_READ_TIMEOUT_MS`, because
   * `listDevices` is otherwise untimed: a wedged CoreSimulatorService would park the loop inside one
   * `xcrun` and the deadline below would never be consulted again. Bounding the reading is what makes
   * the deadline a deadline; swallowing the failure is what stops it ending the boot.
   *
   * `isStale` is checked every iteration. This loop outlives the boot that started it — the handler
   * is fire-and-forget, and its `bootSeq` check runs only once the wait *returns* — so a shutdown
   * arriving mid-wait would otherwise leave a poll spawning a process twice a second for the rest
   * of the deadline, against a device that is now deliberately off and therefore never converges.
   */
  async waitUntilBooted(
    deviceId: string,
    opts: {
      timeoutMs?: number
      pollIntervalMs?: number
      isStale?: () => boolean
    } = {},
  ): Promise<Device> {
    const {
      timeoutMs = SimctlWrapper.BOOT_READY_TIMEOUT_MS,
      pollIntervalMs = SimctlWrapper.BOOT_POLL_INTERVAL_MS,
      isStale,
    } = opts
    const deadline = Date.now() + timeoutMs
    let lastError: unknown = null

    for (;;) {
      if (isStale?.()) throw new PlatformError(`Boot of ${deviceId} was superseded while waiting for it to come up`)

      let device: Device | undefined
      try {
        device = (await this.listDevices(SimctlWrapper.BOOT_POLL_READ_TIMEOUT_MS)).find((d) => d.id === deviceId)
        // Cleared on every success, so the deadline blames a failed poll only when the *last* one
        // failed. Leaving it set would report a recovered-from error as the reason for the timeout.
        lastError = null
      } catch (err) {
        lastError = err
      }
      if (device?.status === 'booted') return device

      // Checked after the read, not before it, so a zero timeout still gets one look — a device that
      // is already up must not need a poll interval to be reported as up.
      if (Date.now() >= deadline) {
        const seen = lastError !== null
          ? `last poll failed: ${firstLine(lastError)}`
          : `last seen: ${device?.status ?? 'no longer listed'}`
        throw new PlatformError(`Device ${deviceId} did not finish booting within ${timeoutMs}ms (${seen})`)
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
    }
  }

  async shutdown(deviceId: string): Promise<void> {
    try {
      await this.runner.exec('shutdown', deviceId)
    } catch (err: unknown) {
      const stderr = (err as { stderr?: string }).stderr ?? ''
      // already shut down is not an error — the mirror of the guard in boot(). Without it a normal
      // teardown of an already-stopped device logs `shutdown failed`, which is indistinguishable
      // from a device that genuinely refused to stop.
      if (stderr.includes('Unable to shutdown device in current state: Shutdown')) return
      throw err
    }
  }

  async erase(deviceId: string): Promise<void> {
    await this.runner.exec('erase', deviceId)
  }

  // Every app command takes the device explicitly. `booted` — simctl's "whichever device is up"
  // alias — silently picks a different simulator whenever more than one is running, which on a
  // shared Mac is the normal case, not an edge one (#440). No default: a default is how the alias
  // would survive a refactor with every test still green.
  async uninstallApp(udid: string, bundleId: string): Promise<void> {
    await this.runner.exec('uninstall', udid, bundleId)
  }

  /** `uninstallApp` for a run reset, bounded: it gates the boot's ready, and a wedged CoreSimulatorService would hold
   *  that boot with nothing able to release it. */
  async uninstallAppForReset(udid: string, bundleId: string): Promise<void> {
    await this.runner.execWithOpts({ timeoutMs: RESET_CMD_TIMEOUT_MS }, 'uninstall', udid, bundleId)
  }

  /**
   * The app as a run's fresh install of it, without the build (#1139): the installed bundle copied aside, the app
   * uninstalled and the copy installed. Clearing its files keeps notification permission and App Group containers,
   * which only an uninstall drops — Maestro's `clearState` and Detox's `resetAppState` reinstall for the same reason.
   * Measured 0.6–0.75 s for a 47 MB app, 0.8–0.9 s with every core busy. An app that is not installed is left alone,
   * as `clearAppDataIfInstalled` leaves one.
   */
  async reinstallAppInPlace(udid: string, bundleId: string): Promise<void> {
    let bundle: string
    try {
      bundle = (await this.runner.execWithOpts({ timeoutMs: RESET_CMD_TIMEOUT_MS }, 'get_app_container', udid, bundleId, 'app')).trim()
    } catch (e) {
      if (/No such file or directory/.test(String((e as { stderr?: unknown }).stderr ?? (e as Error).message))) return
      throw e
    }
    if (!bundle.startsWith('/')) throw new PlatformError(`cannot resolve the installed bundle of ${bundleId}: ${bundle || 'empty simctl output'}`)
    const aside = await fs.mkdtemp(join(tmpdir(), 'tapflow-reinstall-'))
    try {
      const copy = join(aside, bundle.split('/').pop()!)
      await fs.cp(bundle, copy, { recursive: true, verbatimSymlinks: true })
      await this.runner.execWithOpts({ timeoutMs: RESET_CMD_TIMEOUT_MS }, 'uninstall', udid, bundleId)
      // Once more from the copy before giving up: after the uninstall it is the only one, and the finally deletes it.
      const install = () => this.runner.execWithOpts({ timeoutMs: REINSTALL_TIMEOUT_MS }, 'install', udid, copy)
      await install().catch(install).catch((e: unknown) => {
        throw new PlatformError(`${bundleId} was uninstalled and could not be installed again: ${(e as Error).message.split('\n')[0]}`)
      })
    } finally {
      await fs.rm(aside, { recursive: true, force: true }).catch(() => {})
    }
  }

  // pm-clear analog for the simulator: wipe the app's data-container contents
  // (Documents / Library / tmp) instead of uninstalling, so the installed
  // binary survives and flow-runner clearState → launchApp keeps working.
  async clearAppData(udid: string, bundleId: string, timeoutMs?: number): Promise<void> {
    const exec = (...args: string[]) => (timeoutMs === undefined ? this.runner.exec(...args) : this.runner.execWithOpts({ timeoutMs }, ...args))
    await exec('terminate', udid, bundleId).catch(() => { /* not running is fine */ })
    const out = await exec('get_app_container', udid, bundleId, 'data')
    const container = out.trim()
    if (!container.startsWith('/')) {
      throw new PlatformError(`cannot resolve data container for ${bundleId}: ${container || 'empty simctl output'}`)
    }
    for (const sub of ['Documents', 'Library', 'tmp']) {
      const dir = join(container, sub)
      const entries = await fs.readdir(dir).catch(() => [] as string[])
      await Promise.all(entries.map((e) => fs.rm(join(dir, e), { recursive: true, force: true })))
    }
  }

  /** `clearAppData` for an app that may not be installed: nothing installed is nothing to clear. Bounded, for the
   *  reason `uninstallAppForReset` gives. */
  async clearAppDataIfInstalled(udid: string, bundleId: string): Promise<void> {
    try {
      await this.clearAppData(udid, bundleId, RESET_CMD_TIMEOUT_MS)
    } catch (e) {
      // simctl's answer for an app that is not installed (`NSPOSIXErrorDomain, code=2`). Anything else is a failure.
      if (/No such file or directory/.test(String((e as { stderr?: unknown }).stderr ?? (e as Error).message))) return
      throw e
    }
  }

  /** Waits until the device's system services are up, not only `Booted` in the device list. */
  async waitForBootStatus(udid: string): Promise<void> {
    await this.runner.execWithOpts({ timeoutMs: BOOT_STATUS_TIMEOUT_MS }, 'bootstatus', udid)
  }

  /** Every keychain item on the device. Roots added with `keychain add-root-cert` stay trusted (measured). */
  async resetKeychain(udid: string): Promise<void> {
    await this.runner.execWithOpts({ timeoutMs: RESET_CMD_TIMEOUT_MS }, 'keychain', udid, 'reset')
  }

  /** Every app's grants for the services simctl names (`simctl help privacy`); notifications are not one of them. */
  async resetPrivacy(udid: string): Promise<void> {
    await this.runner.execWithOpts({ timeoutMs: RESET_CMD_TIMEOUT_MS }, 'privacy', udid, 'reset', 'all')
  }

  async clearLocation(udid: string): Promise<void> {
    await this.runner.execWithOpts({ timeoutMs: RESET_CMD_TIMEOUT_MS }, 'location', udid, 'clear')
  }

  async installApp(udid: string, appPath: string): Promise<void> {
    await this.runner.exec('install', udid, appPath)
  }

  // Returns the launched app's host PID (`simctl launch` prints "<bundleId>: <pid>"), or null if it
  // can't be parsed. The audiotap-helper taps this PID; non-audio callers ignore it.
  //
  // With options, a running app is terminated first: `simctl launch` on a running bundle returns the existing pid and
  // starts nothing, so the arguments would reach no process. Without them a running app is only brought forward, as
  // it always was.
  async launchApp(udid: string, bundleId: string, options?: LaunchOptions): Promise<number | null> {
    const out = hasLaunchOptions(options)
      ? await this.runner.execWithOpts(
        { env: simctlChildEnv(options?.env) },
        'launch', '--terminate-running-process', udid, bundleId, ...iosLaunchArgv(options?.arguments),
      )
      : await this.runner.exec('launch', udid, bundleId)
    const m = out.match(/:\s*(\d+)\s*$/)
    return m ? Number(m[1]) : null
  }

  async openUrl(deviceId: string, url: string): Promise<void> {
    await this.runner.exec('openurl', deviceId, url)
  }

  async setPasteboard(deviceId: string, text: string): Promise<void> {
    try {
      await this.runner.execWithOpts(
        { input: text, timeoutMs: CLIPBOARD_CMD_TIMEOUT_MS },
        'pbcopy', deviceId,
      )
    } catch (e) {
      // This reaches a user-facing toast, and the raw text is multi-line and echoes the argv.
      throw new PlatformError(`Could not write the device clipboard: ${firstLine(e)}`)
    }
  }

  // Read the device pasteboard. Returned verbatim — no trim, since a trailing newline can be
  // part of the copied text. `maxBuffer` is where the clipboard size ceiling is actually
  // enforced for iOS: exceeding it rejects rather than buffering unboundedly, so callers do
  // not re-check the length (a second check there would be unreachable). simctl's own failures are noisy multi-line
  // strings that end up in a user-facing toast, so they are condensed here.
  async getPasteboard(deviceId: string): Promise<string> {
    try {
      // `maxBuffer` is where the clipboard size ceiling is actually enforced for iOS: exceeding
      // it rejects rather than buffering without bound, so callers do not re-check the length.
      return await this.runner.execWithOpts(
        { timeoutMs: CLIPBOARD_CMD_TIMEOUT_MS, maxBuffer: MAX_CLIPBOARD_BYTES },
        'pbpaste', deviceId,
      )
    } catch (e) {
      const message = `Could not read the device clipboard: ${firstLine(e)}`
      throw e instanceof OutputTooLargeError ? new ClipboardTooLargeError(message) : new PlatformError(message)
    }
  }

  async screenshot(udid: string, format: 'png' | 'jpeg' = 'png'): Promise<Buffer> {
    const ext = format === 'jpeg' ? 'jpg' : 'png'
    const tmpPath = `${tmpdir()}/tapflow-${randomUUID()}.${ext}`
    try {
      await this.runner.exec('io', udid, 'screenshot', '--type', format, tmpPath)
      return await fs.readFile(tmpPath)
    } finally {
      await fs.unlink(tmpPath).catch(() => {})
    }
  }

  // Reads AppleLanguages from the simulator's Global Domain and rewrites AppleKeyboards
  // so each entry uses hw=Automatic. This lets iOS switch hardware key layout when the
  // user toggles the input source (via LANG1/CapsLock), fixing the iOS 15+ bug where
  // hw=Korean locks the hardware layout regardless of the active input source.
  async syncKeyboardsFromLanguages(udid: string): Promise<void> {
    let languages: string[]
    try {
      const out = await this.runner.exec('spawn', udid, 'defaults', 'read', '-g', 'AppleLanguages')
      // Output: (\n    "ko-KR",\n    "en-US"\n)
      languages = [...out.matchAll(/"([^"]+)"/g)].map((m) => m[1])
    } catch {
      languages = []
    }
    if (languages.length === 0) return

    // Always include English as a fallback so the English QWERTY keyboard is available.
    const hasEnglish = languages.some((l) => l.toLowerCase().startsWith('en'))
    const allLangs = hasEnglish ? languages : [...languages, 'en-US']

    const keyboards = [...new Set([...allLangs.map(langToKeyboard), 'emoji@sw=Emoji'])]

    await this.runner.exec('spawn', udid, 'defaults', 'write', '-g', 'AppleKeyboards', '-array', ...keyboards)

    await this.restartKeyboardDaemon(udid)
  }

  /**
   * Put the device's keyboard language back to its first keyboard (#1134). The language a person switched to — Caps
   * Lock on a device with two keyboards — is stored as `KeyboardLastUsed` and `KeyboardsCurrentAndNext` in
   * `com.apple.keyboard.preferences` (found by diffing the simulator's preferences across a Caps Lock press, iOS 26.4),
   * not in `AppleKeyboards`, whose order does not reset it. Written, then the keyboard daemon restarted; a running app
   * keeps its language until it is launched again (measured both ways).
   */
  async resetKeyboardLanguage(udid: string, timeoutMs?: number): Promise<void> {
    await this.setKeyboardLanguage(udid, undefined, timeoutMs)
  }

  /**
   * Put the device's keyboard in `keyboard` — an `AppleKeyboards` entry, as `keyboardLanguage` reads it — or in its
   * first when absent, the way `resetKeyboardLanguage` does (#1135: a replay starts from the recording's keyboard).
   * `false` when the device has no such keyboard, and nothing is written.
   */
  async setKeyboardLanguage(udid: string, keyboard?: string, timeoutMs?: number): Promise<boolean> {
    // Bounded as a whole by `timeoutMs` when given (a run's reset budget): each call gets what is left of it, so up to
    // five calls cannot take five budgets. Unbounded otherwise, as these always were.
    const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs
    const exec = (...args: string[]) => this.execBy(deadline, ...args)
    const out = await exec('spawn', udid, 'defaults', 'read', '-g', 'AppleKeyboards')
    const keyboards = [...out.matchAll(/"([^"]+)"/g)].map((m) => m[1]!)
    const target = keyboard ?? keyboards[0]
    if (!target || !keyboards.includes(target)) return false
    const next = keyboards.find((k) => k !== target && !k.startsWith('emoji')) ?? target
    // Already so: the daemon is not restarted. A restart right after another one (a run reset's, then a replay's
    // keyboard-set) took 10.3 s, against 0.37 s cold (measured, iOS 26.5), and Match paid it on every run. Both keys must
    // say so: the daemon writes `KeyboardLastUsed` when a person switches language (Caps Lock), so a device left with it
    // and the list disagreeing (measured: ko and en, typing in ko) is restarted.
    // Not repaired by this: prefs written and the restart that followed them failed (its errors are swallowed) leave the
    // daemon behind the prefs, and the next set now skips. Reaching it needs the budget to run out between the writes
    // and the restart.
    const prefs = await exec('spawn', udid, 'defaults', 'read', 'com.apple.keyboard.preferences').catch(() => '')
    if (keyboardPrefsAre(prefs, [target, target, next])) return true
    await exec('spawn', udid, 'defaults', 'write', 'com.apple.keyboard.preferences', 'KeyboardLastUsed', target)
    await exec('spawn', udid, 'defaults', 'write', 'com.apple.keyboard.preferences', 'KeyboardsCurrentAndNext', '-array', target, target, next)
    await this.restartKeyboardDaemon(udid, deadline)
    return true
  }

  /** The keyboard the device types with now (`KeyboardLastUsed`, an `AppleKeyboards` entry), or `undefined` before any
   *  was used or when it cannot be read. */
  async keyboardLanguage(udid: string): Promise<string | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const out = await Promise.race([
      this.runner
        .execWithOpts({ timeoutMs: KEYBOARD_READ_TIMEOUT_MS }, 'spawn', udid, 'defaults', 'read', 'com.apple.keyboard.preferences', 'KeyboardLastUsed')
        .catch(() => ''),
      new Promise<string>((resolve) => { timer = setTimeout(() => resolve(''), KEYBOARD_READ_TIMEOUT_MS) }),
    ]).finally(() => clearTimeout(timer))
    const value = out.trim()
    return value === '' ? undefined : value
  }

  // Restart the keyboard daemon so it picks up the new settings. `com.apple.TextInput.kbd` in the foreground user
  // domain on iOS 26.4 (measured), where `system/com.apple.kbd`, used until #1134, does not exist and failed in silence.
  // The old name is still tried when the new one fails, for an older runtime nobody has measured. Errors are ignored —
  // changes take effect on the next text field focus if the daemon isn't running yet.
  private async restartKeyboardDaemon(udid: string, deadline?: number): Promise<void> {
    for (const service of ['user/foreground/com.apple.TextInput.kbd', 'system/com.apple.kbd']) {
      try {
        await this.execBy(deadline, 'spawn', udid, 'launchctl', 'kickstart', '-k', service)
        return
      } catch { /* try the next name */ }
    }
  }

  /** A simctl call that ends by `deadline` (epoch ms), or unbounded without one. */
  private execBy(deadline: number | undefined, ...args: string[]): Promise<string> {
    if (deadline === undefined) return this.runner.exec(...args)
    return this.runner.execWithOpts({ timeoutMs: Math.max(1, deadline - Date.now()) }, ...args)
  }

  async rotate(udid: string, orientation: 'portrait' | 'landscapeLeft' | 'landscapeRight' | 'portraitUpsideDown'): Promise<void> {
    await execFileAsync(ROTATION_HELPER, [orientation, udid], { timeout: ROTATE_TIMEOUT_MS })
  }

  /**
   * Make the status bar read as a device with no service, or hand it back (#607).
   *
   * **Never on its own.** This changes pixels and nothing else, so a device showing no bars while
   * its app still loads is the exact false result the network feature exists to prevent — which is
   * why the only caller is `SimulatorNetwork`, where it goes with the two layers that do the work.
   *
   * `clear` removes **every** override, not only the three set here; there is no per-key release.
   * That is correct today because these are the only overrides tapflow sets, and it is the thing to
   * check first if a later feature starts overriding the clock or the battery.
   */
  async setStatusBarOffline(udid: string, offline: boolean): Promise<void> {
    if (!offline) {
      await this.runner.exec('status_bar', udid, 'clear')
      return
    }
    await this.runner.exec(
      'status_bar', udid, 'override',
      '--dataNetwork', 'hide',
      '--wifiMode', 'failed',
      '--cellularMode', 'notSupported',
    )
  }

  /**
   * Set an environment variable for **every process the simulator starts from now on** (#607).
   *
   * That breadth is the delivery mechanism, not an accident: the dylib this arms has to reach the
   * app's WebView helpers, and `WebKit.Networking` is a sibling process under `launchd_sim` rather
   * than a child of the app, so the per-launch `SIMCTL_CHILD_…` convention never reaches it. The
   * dylib's own bundle-id gate is what keeps it from touching SpringBoard and the rest.
   *
   * **Processes already running do not see it.** dyld reads the environment at process start, so
   * anything that has to be armed must be set before the app is launched, not after.
   */
  async setSimulatorEnv(udid: string, name: string, value: string): Promise<void> {
    await this.runner.exec('spawn', udid, 'launchctl', 'setenv', name, value)
  }

  /** Whether `bundleId` has a process on the device: its `UIKitApplication:<bundle>[…]` job in `launchctl list`. */
  async appRunning(udid: string, bundleId: string): Promise<boolean> {
    const out = await this.runner.execWithOpts({ timeoutMs: APP_RUNNING_TIMEOUT_MS }, 'spawn', udid, 'launchctl', 'list')
    return out.split('\n').some((line) => line.includes(`UIKitApplication:${bundleId}[`) && /^\d+\s/.test(line.trim()))
  }

  async showSoftwareKeyboard(udid: string): Promise<void> {
    await this.kbd.show(udid)
  }

  async hideSoftwareKeyboard(udid: string): Promise<void> {
    await this.kbd.hide(udid)
  }

  stopKeyboardDaemon(): void {
    this.kbd.stop()
  }
}

/** Whether `defaults read com.apple.keyboard.preferences` says `list[0]` is the keyboard last used and the
 *  current-and-next list is `list`, as `setKeyboardLanguage` writes them. Anything unreadable is not. */
export function keyboardPrefsAre(prefs: string, list: readonly string[]): boolean {
  // Quoted when it holds `;` or `=`, as every keyboard name does: `"ko_KR@sw=Korean;hw=Automatic"`. The key starts a
  // line or follows `{`/`;`, so a key that merely ends in the name does not count.
  const m = /(?:^|[\s{;])KeyboardLastUsed\s*=\s*(?:"([^"]*)"|([^;\s]+));/.exec(prefs)
  const lastUsed = m?.[1] ?? m?.[2]
  const body = /(?:^|[\s{;])KeyboardsCurrentAndNext\s*=\s*\(([^)]*)\)/.exec(prefs)?.[1]
  if (lastUsed !== list[0] || body === undefined) return false
  const items = [...body.matchAll(/"([^"]*)"|([^\s,]+)/g)].map((x) => x[1] ?? x[2])
  return items.length === list.length && items.every((k, i) => k === list[i])
}
