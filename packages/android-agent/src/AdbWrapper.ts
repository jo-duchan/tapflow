import type { Device } from '@tapflowio/agent-core'
import { parseCornerRadius, parseDisplayMetrics, type DisplayMetrics } from './displayMetrics.js'
import { PlatformError, ValidationError, createLogger } from '@tapflowio/agent-core'
import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { defaultRunner, type AdbRunner } from './adb.js'
import type { LaunchOptions } from '@tapflowio/protocol'
import { hasLaunchOptions } from '@tapflowio/protocol/launch'
import { androidLaunchExtras } from './launchExtras.js'

const logger = createLogger('android-agent:adb-wrapper')

// The tree dump that reads a screen which never goes idle (`uidump/src/.../TreeDump.java`, built by
// `scripts/build-uidump.sh`). Resolved from `dist/` and `src/` alike.
const UIDUMP_JAR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin/tapflow-uidump.jar')
// How long the dump waits for the screen to go quiet before reading it anyway. `uiautomator dump` asks for a second
// of quiet and fails after ten; this asks for 300 ms and reads the screen as it is after a second.
const UIDUMP_IDLE_MS = 1000
const UIDUMP_TIMEOUT_SEC = 4

// Encode text for `adb shell input text`: space → %s, literal % → \% (so a
// user's "%s" isn't re-expanded to a space), and backslash-escape the other
// characters the device shell would interpret. Exported for tests.
export function encodeAdbInputText(text: string): string {
  return text.replace(/[ %()<>|&;*\\"'`$#~]/g, (c) => (c === ' ' ? '%s' : `\\${c}`))
}

const NO_FILE = '__TAPFLOW_NO_FILE__'

// Play Store images fill /data on their own as Google apps update in the background, so this is
// usually not the build's fault — but any image can fill up, so the message does not blame them.
const STORAGE_FULL_MESSAGE =
  'Device storage is full. Turn on Full reset and pick the device again; this erases all its data. ' +
  "For a larger partition, raise disk.dataPartition.size in the AVD's config.ini first. " +
  'On Play Store images, background updates to Google apps fill storage over time.'

/** An install refused for lack of space on the device. Its own class so a caller can reclaim and retry. */
export class StorageFullError extends ValidationError {
  constructor(options?: ErrorOptions) {
    super(STORAGE_FULL_MESSAGE, options)
    this.name = 'StorageFullError'
  }
}

// How long `am start -W` may wait for the launched app's first frame, and the resolve call before it: together under
// MCP's 15 s launch deadline, with room for a monkey fallback.
const AM_START_WAIT_SEC = 10
const RESOLVE_WAIT_SEC = 3

/** Each adb call of a device list re-read (#1085). `adb devices` answers in about 10 ms and `emu avd name` and `getprop`
 *  in well under a second; this is only there so a wedged emulator cannot hold the re-read for ever. */
const PEEK_CALL_TIMEOUT_MS = 10_000

export class AdbWrapper {
  // avdId ("avd:<name>") → ADB serial ("emulator-5554")
  private readonly serialMap = new Map<string, string>()
  // Per serial: whether the tree dump jar is on the device (one push per agent run), and devices whose image lacks
  // the classes it needs, which go straight to `uiautomator dump` from then on.
  private readonly uidumpPushed = new Map<string, Promise<string | undefined>>()
  private readonly uidumpUnsupported = new Set<string>()
  private uidumpDevicePath?: string
  // One dump at a time per device: both dumps connect a UiAutomation, and a second one connecting while the first is
  // up fails ("UiAutomationService … already registered", measured 2 of 3 with three at once). A dashboard read during
  // a flow's is enough to get there.
  private readonly dumpQueue = new Map<string, Promise<unknown>>()

  constructor(private readonly runner: AdbRunner = defaultRunner) {}

  getSerial(avdId: string): string | undefined {
    return this.serialMap.get(avdId)
  }

  setSerial(avdId: string, serial: string): void {
    this.serialMap.set(avdId, serial)
  }

  clearSerial(avdId: string): void {
    this.serialMap.delete(avdId)
  }

  async listDevices(): Promise<Device[]> {
    const [avdNames, bootedMap] = await Promise.all([
      this.runner.listAvds(),
      this.getBootedAvdMap(),
    ])

    // Sync serial map
    for (const [serial, avdName] of bootedMap) {
      this.serialMap.set(`avd:${avdName}`, serial)
    }
    // Remove stale serials (emulator was killed externally)
    const bootedAvdNames = new Set(bootedMap.values())
    for (const [avdId] of this.serialMap) {
      if (!bootedAvdNames.has(avdId.replace('avd:', ''))) {
        this.serialMap.delete(avdId)
      }
    }

    return this.describe(avdNames, bootedMap)
  }

  /**
   * The same list as `listDevices`, without syncing `serialMap` (#1085). That sync is part of how a boot learns which
   * emulator it launched, and a re-read every 30 s running into a boot's own bookkeeping would move it under it. Each
   * serial here comes from this read's `adb devices` instead.
   */
  async peekDevices(): Promise<Device[]> {
    // Bounded, unlike the boot path: the watcher runs one read at a time, so a read stuck on a wedged emulator's
    // console or an offline device's shell would otherwise stop every later re-read for the life of the agent.
    const run = (...args: string[]) => this.runner.execBounded?.(PEEK_CALL_TIMEOUT_MS, ...args) ?? this.runner.exec(...args)
    const [avdNames, bootedMap] = await Promise.all([
      this.runner.listAvds(),
      this.getBootedAvdMap(run),
    ])
    return this.describe(avdNames, bootedMap, run)
  }

  private async describe(
    avdNames: string[],
    bootedMap: Map<string, string>,
    run: (...args: string[]) => Promise<string> = (...args) => this.runner.exec(...args),
  ): Promise<Device[]> {
    const serialOf = new Map([...bootedMap].map(([serial, avdName]) => [avdName, serial]))
    const devices: Device[] = []
    for (const avdName of avdNames) {
      const avdId = `avd:${avdName}`
      const serial = serialOf.get(avdName)
      const isBooted = Boolean(serial)

      let osVersion: string | undefined
      if (isBooted && serial) {
        osVersion = await run('-s', serial, 'shell', 'getprop', 'ro.build.version.release').then((o) => o.trim(), () => undefined)
        if (osVersion) osVersion = `Android ${osVersion}`
      }

      devices.push({
        id: avdId,
        name: avdName,
        platform: 'android',
        status: isBooted ? 'booted' : 'shutdown',
        osVersion,
      })
    }

    return devices
  }

  private async getBootedAvdMap(
    run: (...args: string[]) => Promise<string> = (...args) => this.runner.exec(...args),
  ): Promise<Map<string, string>> {
    const result = new Map<string, string>()
    try {
      const output = await run('devices')
      const serials = output
        .split('\n')
        .slice(1)
        .map((l) => l.split('\t'))
        .filter(([serial, state]) => serial?.startsWith('emulator-') && state?.trim() === 'device')
        .map(([serial]) => serial.trim())

      await Promise.all(
        serials.map(async (serial) => {
          const avdName = await run('-s', serial, 'emu', 'avd', 'name')
            .then((o) => o.split('\n')[0].trim())
            .catch(() => null)
          if (avdName) result.set(serial, avdName)
        }),
      )
    } catch { /* adb server not running */ }
    return result
  }

  async getScreenSize(serial: string): Promise<{ width: number; height: number }> {
    const output = await this.runner.exec('-s', serial, 'shell', 'wm', 'size')
    // "Physical size: 1080x2400"
    const m = output.match(/(\d+)x(\d+)/)
    if (!m) throw new PlatformError(`Cannot parse screen size from: ${output}`)
    return { width: parseInt(m[1], 10), height: parseInt(m[2], 10) }
  }

  /** The display's natural size, what it is currently showing, and the rotation between them.
   *  See `parseDisplayMetrics` for why neither `wm size` nor the emulator's own rotation field is
   *  enough on its own. */
  async getDisplayMetrics(serial: string): Promise<DisplayMetrics | null> {
    const out = await this.runner.exec('-s', serial, 'shell', 'dumpsys', 'window', 'displays')
    return parseDisplayMetrics(out)
  }

  /** The rounded-corner radius, in device pixels, of the panel with these natural dimensions.
   *  See `parseCornerRadius` for why this is read rather than measured off the frame, and why it
   *  is pixels rather than a fraction. */
  async getCornerRadius(serial: string, width: number, height: number): Promise<number | null> {
    const out = await this.runner.exec('-s', serial, 'shell', 'dumpsys', 'display')
    return parseCornerRadius(out, width, height)
  }

  /** Raw `cmd device_state print-states` — the postures this device offers, if any. */
  async printDeviceStates(serial: string): Promise<string> {
    return this.runner.exec('-s', serial, 'shell', 'cmd', 'device_state', 'print-states')
  }

  /** Raw `cmd device_state state` — the posture the device is in. */
  async deviceState(serial: string): Promise<string> {
    return this.runner.exec('-s', serial, 'shell', 'cmd', 'device_state', 'state')
  }

  /**
   * Put the device into a posture, through the **emulator console** rather than the guest.
   *
   * `cmd device_state` changes only Android's framework state: the emulator goes on rendering the
   * screen it had, so the gRPC capture keeps streaming the unfolded panel while the guest believes
   * it is shut. Measured on a Pixel 9 Pro Fold — after `cmd device_state state 0` the stream was
   * still 2152x2076, and `Image.format.foldedDisplay` was null. `adb emu posture` moves the
   * emulator itself: the stream becomes 2424x1080 and `foldedDisplay` fills in.
   *
   * `identifier` is an emulator posture id (1 closed, 2 half-opened, 3 opened), not a
   * `cmd device_state` one — the two vocabularies do not line up, which is what `postures.ts` maps.
   */
  async setPosture(serial: string, identifier: string): Promise<void> {
    const out = await this.runner.exec('-s', serial, 'emu', 'posture', identifier)
    // The console answers `KO: <reason>` on a refusal with a zero exit code, so the text is the
    // only signal that the device did not move.
    if (/^KO\b/m.test(out)) throw new PlatformError(`emu posture ${identifier} refused: ${out.trim()}`)
  }

  // pm clear prints "Failed" with exit code 0 (e.g. unknown package), so the
  // output must be checked — a silent no-op would break flow-runner clearState.
  async clearAppData(serial: string, packageName: string): Promise<void> {
    const out = await this.runner.exec('-s', serial, 'shell', 'pm', 'clear', packageName)
    if (!out.includes('Success')) {
      throw new PlatformError(`pm clear failed for ${packageName}: ${out.trim() || 'unknown error'}`)
    }
  }

  /** `clearAppData` for an app that may not be installed: nothing installed is nothing to clear. `pm path` prints
   *  `package:<path>` for an installed package, and exits 1 with no output for one that is not. **Only that is "not
   *  installed"**: an offline device or a PackageManager not yet serving fails too, and reading those as nothing to
   *  clear would report a reset that never happened. */
  async clearAppDataIfInstalled(serial: string, packageName: string): Promise<void> {
    let path: string
    try {
      path = await this.runner.exec('-s', serial, 'shell', 'pm', 'path', packageName)
    } catch (e) {
      const { code, stdout, stderr } = e as { code?: unknown; stdout?: unknown; stderr?: unknown }
      if (code === 1 && !String(stdout ?? '').trim() && !String(stderr ?? '').trim()) return
      throw e
    }
    if (!path.includes('package:')) return
    await this.clearAppData(serial, packageName)
  }

  /**
   * Whether the device is in airplane mode — tapflow's network on/off (#607).
   *
   * `cmd connectivity airplane-mode` with **no argument** is the read; there is no `get`
   * subcommand, and asking for one prints the service's help text. Measured on API 34.
   *
   * `settings get global airplane_mode_on` answers the same thing as 1/0, and is deliberately not
   * used: keeping the read and the write in one command family means an image that lacks one lacks
   * the other, so the two cannot disagree about whether this device is supported.
   */
  async airplaneMode(serial: string): Promise<boolean> {
    const out = (await this.runner.exec(
      '-s', serial, 'shell', 'cmd', 'connectivity', 'airplane-mode',
    )).trim()
    if (out === 'enabled') return true
    if (out === 'disabled') return false
    // Anything else is the help text or a future wording — **not** "off". Reporting an unreadable
    // answer as online is the false negative this whole path is written to avoid.
    throw new PlatformError(`Cannot read airplane mode state from: ${out || '(empty)'}`)
  }

  /**
   * Put the device in airplane mode, or take it out, and report what it observed.
   *
   * **Returns rather than throwing when the state cannot be confirmed, and that is the whole
   * contract.** The write happens first and the read second, so a failure after the write is a
   * device that has probably already changed — and a caller that cannot tell "the command failed"
   * from "the command landed and I could not confirm it" has no choice but to guess. Guessing here
   * means reporting an offline device as online, which is the one outcome this feature must never
   * produce: a tester signs off offline behaviour they never saw, and the bug goes to the app.
   *
   * A write that fails **does** throw: the device is unchanged and the caller's own before-state is
   * still true, so there is nothing here it needs to be told.
   *
   * - `{ confirmed: true, offline }` — wrote and read it back.
   * - `{ confirmed: false, offline }` — the read disagreed. `offline` is what the **device** said;
   *   the command was accepted and had no effect.
   *
   *   This line used to add "which is what an image that does not really support this looks like",
   *   and the test below contradicts it in the same file: an image that does not know the subcommand
   *   **answers non-zero and throws from the write**, so it never reaches this branch. What does
   *   reach it has not been measured, so the branch is named by what was observed and not by a cause.
   * - `{ confirmed: false, offline: <requested> }` — the read failed outright. The write was
   *   accepted, so the requested value is the best evidence there is; it is not a default.
   *
   * **The last two are the same shape, and the value is what tells them apart** — a caller comparing
   * `offline` against what it asked for learns which of the two it got, and that is the only place
   * that distinction exists. It is load-bearing: `AndroidAgent.classifyWrite` reads it to decide
   * between `unsupported-device` (the device answered and had not moved) and `state-unconfirmed`
   * (nothing was observed). Returning the requested value in the disagreement branch would collapse
   * them. Neither is a claim about permanence — see the members' own docs for why.
   */
  async setAirplaneMode(serial: string, on: boolean): Promise<{ confirmed: boolean; offline: boolean }> {
    await this.runner.exec(
      '-s', serial, 'shell', 'cmd', 'connectivity', 'airplane-mode', on ? 'enable' : 'disable',
    )
    try {
      const actual = await this.airplaneMode(serial)
      return { confirmed: actual === on, offline: actual }
    } catch {
      return { confirmed: false, offline: on }
    }
  }

  async installApp(serial: string, apkPath: string): Promise<void> {
    try {
      await this.runner.exec('-s', serial, 'install', '-r', apkPath)
    } catch (e) {
      const stderr = (e as { stderr?: string }).stderr?.trim()
      if (stderr) {
        // Judged without adb's "failed to install <path>:" prefix: the path ends in the uploaded
        // build's name, so a build called `fix-ENOSPC.apk` would otherwise read as a full device.
        // Cut by the path we passed rather than up to the first colon, which a build name may contain.
        const prefix = `adb: failed to install ${apkPath}:`
        const reported = stderr.startsWith(prefix)
          ? stderr.slice(prefix.length).trimStart()
          : stderr.replace(/^adb: failed to install [^:]+:\s*/, '')
        // Before the Failure match, which would reduce INSUFFICIENT_STORAGE to a bare code. ENOSPC
        // is not observed, only expected: a write that runs out after the size pre-check passed. The
        // partition cannot be grown without a wipe on a metadata-encrypted user build (tried both
        // config.ini and `qemu-img resize`), so once `StorageReclaim` has freed what it can, the
        // advice is a reset.
        if (/not enough space|INSUFFICIENT_STORAGE|No space left on device|ENOSPC/i.test(reported)) {
          throw new StorageFullError({ cause: e })
        }
        // "Failure [INSTALL_FAILED_...]" → show just the code
        const failureMatch = stderr.match(/Failure\s*\[(.+?)\]/)
        if (failureMatch) throw new ValidationError(failureMatch[1])
        // Strip "adb: failed to install <path>:" prefix and stack trace
        const stripped = reported
          .replace(/\s+at\s+[\w$.]+\([\w.]+:\d+\)[\s\S]*$/, '')
          .trim()
        throw new ValidationError(stripped || stderr)
      }
      throw new ValidationError((e as Error).message, { cause: e })
    }
  }

  /**
   * Launch the app the way the launcher does, and return once its first frame is drawn (`am start -W`). Monkey
   * returns before the app even has focus (measured 0.2–0.36 s against 0.5–0.9 s), so a step sent right after the
   * reply could reach the launcher instead. Monkey stays as the fallback, and its error text is what a failure says.
   */
  async launchApp(serial: string, packageName: string, options?: LaunchOptions, defaultsOnly = false): Promise<LaunchOptions | undefined> {
    // Resolved once and reused by whichever launch follows, so a default that falls back costs no second resolve.
    let resolved: { component: string | undefined } | undefined
    if (hasLaunchOptions(options)) {
      if (!defaultsOnly) {
        await this.launchFresh(serial, packageName, options!)
        return options
      }
      // The relay's per-app defaults, none of them asked for by the caller: what this device cannot take is left out
      // rather than failing a launch that works without it. A caller's own options fail in `launchFresh` instead.
      resolved = { component: await this.launcherComponent(serial, packageName) }
      const deliverable = deliverableDefaults(packageName, options!, resolved.component)
      if (deliverable) {
        await this.launchFresh(serial, packageName, deliverable, resolved.component)
        return deliverable
      }
    }
    const component = resolved ? resolved.component : await this.launcherComponent(serial, packageName)
    if (component && await this.startAndWait(serial, component)) return undefined
    await this.launchWithMonkey(serial, packageName)
    return undefined
  }

  /**
   * A launch carrying arguments (#1047). Three differences from the plain one, each so that the arguments are applied
   * or the launch fails, never a launch without them:
   * - `env` is refused: Android gives an app's process no environment from outside.
   * - No monkey fallback: monkey cannot carry intent extras. A package with no single launcher activity fails here.
   * - `-S` stops the app first in the same command, since a running app would only be brought forward and its intent
   *   never re-read; and the two `Activity not started` warnings, which the plain launch counts as launched, fail.
   */
  private async launchFresh(serial: string, packageName: string, options: LaunchOptions, resolved?: string): Promise<void> {
    if (Object.keys(options.env ?? {}).length > 0) {
      throw new ValidationError('env is iOS-only: Android has no way to set an app\'s environment. Pass it in arguments instead, read from the intent extras')
    }
    const component = resolved ?? await this.launcherComponent(serial, packageName)
    if (!component) {
      throw new ValidationError(`Could not find a single launcher activity for ${packageName}, so the launch arguments cannot be delivered`)
    }
    let out: string
    try {
      out = await this.runner.exec(
        '-s', serial, 'shell', 'timeout', String(AM_START_WAIT_SEC), 'am', 'start', '-S', '-W',
        '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER', '-f', '0x10200000', '-n', component,
        ...androidLaunchExtras(options.arguments),
        '2>&1',
      )
    } catch (e) {
      out = (e as { stdout?: string }).stdout ?? ''
      // Not `cause: e`: node's message and `cmd` carry the whole argv, argument values included, and the cause is
      // what the agent logs. stderr says why without them.
      if (!out.includes('Starting: Intent')) {
        throw new PlatformError('adb did not finish the launch', { cause: new Error((e as { stderr?: string }).stderr?.trim() || 'no output') })
      }
    }
    const lines = out.split('\n').map((l) => l.trim())
    const failed = lines.find((l) => l.startsWith('Error') || l.startsWith('Exception') || l.startsWith('Warning: Activity not started'))
    if (failed) throw new PlatformError(failed)
  }

  // The launcher activity as `pkg/class`, or undefined. Only that exact shape is taken: with two launcher activities
  // the answer is the system chooser (`android/com.android.internal.app.ResolverActivity`), "No activity found" when
  // there is none, and older images have no `cmd package`. A `$` (an inner class) is refused too, because `adb shell`
  // hands the line to the device shell unquoted. Monkey handles every one of those.
  private async launcherComponent(serial: string, packageName: string): Promise<string | undefined> {
    try {
      // Bounded like the launch below, so a busy package manager cannot spend MCP's 15 s launch deadline here.
      const out = await this.runner.exec(
        '-s', serial, 'shell', 'timeout', String(RESOLVE_WAIT_SEC), 'cmd', 'package', 'resolve-activity', '--brief',
        '-c', 'android.intent.category.LAUNCHER', packageName,
      )
      const last = out.split('\n').map((l) => l.trim()).filter(Boolean).pop()
      const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      return last && new RegExp(`^${escaped}/[\\w.]+$`).test(last) ? last : undefined
    } catch {
      return undefined
    }
  }

  // True once the launch went out. The flags are the launcher's own (NEW_TASK | RESET_TASK_IF_NEEDED, as monkey sets
  // them), so a running app comes forward on the screen it was on rather than gaining a new activity on top. The exit
  // status says little — `am start` exits 0 on some errors, and forwarding it depends on the image — so the output
  // decides: only an `Error` line means nothing started. `Warning: … brought to the front` (already running) and
  // `Status: timeout` (slow, but started) are launches. `-W` waits for the first frame, which can be never (an app
  // that does not draw, a locked screen) while the dashboard's launch has no deadline of its own: the device-side
  // `timeout` bounds it, and running out counts as launched, since the intent was delivered.
  private async startAndWait(serial: string, component: string): Promise<boolean> {
    let out: string
    try {
      out = await this.runner.exec(
        '-s', serial, 'shell', 'timeout', String(AM_START_WAIT_SEC), 'am', 'start', '-W',
        '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER', '-f', '0x10200000', '-n', component,
        // Measured on API 36: errors go to stdout and the exit status is 0. Folded in on the device for an image that
        // writes them to stderr, which this runner does not return.
        '2>&1',
      )
    } catch (e) {
      out = (e as { stdout?: string }).stdout ?? ''
      if (!out.includes('Starting: Intent')) return false
    }
    return !out.split('\n').some((l) => l.trim().startsWith('Error'))
  }

  private async launchWithMonkey(serial: string, packageName: string): Promise<void> {
    // monkey reserves 2% of its events for system keys, and on a device with no physical system
    // keys — an emulator whose AVD profile has hw.mainKeys=no, as Pixel profiles do — it aborts
    // with exit 251 before sending any event, the launch included ("SYS_KEYS has no physical keys
    // but with factor 2.0%"). Options must precede the count: monkey stops parsing at it.
    try {
      await this.runner.exec(
        '-s', serial, 'shell', 'monkey', '--pct-syskeys', '0',
        '-p', packageName, '-c', 'android.intent.category.LAUNCHER', '1',
      )
    } catch (e) {
      // The reason reaches a dashboard toast. Node's message leads with the argv — the host's SDK path
      // and the serial — and monkey echoes its own arguments on stderr, so keep only a line that says
      // something: monkey's `** ` diagnostics or adb's own error. A package with no launchable activity
      // leaves neither, because monkey prints that verdict to stdout — but its argument echo (`args: [`)
      // shows it ran. Without the echo, monkey may never have run at all.
      const lines = (e as Error).message.split('\n').map((l) => l.trim())
      const said = lines.find((l) => l.startsWith('** ') || l.startsWith('adb:') || l.startsWith('error:'))
      const ran = lines.some((l) => l.startsWith('args: ['))
      const reason = said?.replace(/^\*\* /, '')
        ?? (ran ? `No launchable activity found for ${packageName}` : 'adb did not finish the launch')
      throw new PlatformError(reason, { cause: e })
    }
  }

  async openUrl(serial: string, url: string): Promise<void> {
    await this.runner.exec('-s', serial, 'shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', url)
  }

  async screenshot(serial: string): Promise<Buffer> {
    return this.runner.execBinary('-s', serial, 'exec-out', 'screencap', '-p')
  }

  /**
   * The screen's UI hierarchy as `uiautomator dump` XML.
   *
   * `uiautomator dump` waits for a second of quiet and fails after ten on a screen that never settles (measured: a
   * running stopwatch, 2 of 2 after 11 s), so every selector step there failed. The tree dump jar reads the same
   * classes with the wait bounded and not fatal (a running stopwatch: 2.0 s, 4 of 4; a still screen: 1.3 s against
   * 2.05 s; same XML).
   * `uiautomator dump` stays the fallback: for a device whose image lacks those classes (remembered), or when the jar
   * cannot be pushed or produced no XML. A dump with no XML is an explicit `PlatformError`, never a silent empty tree.
   */
  async dumpUiHierarchy(serial: string, timeoutSec = 10): Promise<string> {
    const previous = this.dumpQueue.get(serial) ?? Promise.resolve()
    const mine = previous.catch(() => {}).then(() => this.dumpNow(serial, timeoutSec))
    this.dumpQueue.set(serial, mine)
    try {
      return await mine
    } finally {
      if (this.dumpQueue.get(serial) === mine) this.dumpQueue.delete(serial)
    }
  }

  private async dumpNow(serial: string, timeoutSec: number): Promise<string> {
    if (!this.uidumpUnsupported.has(serial)) {
      const jar = await this.pushUidump(serial)
      if (jar) {
        const output = await this.runner.exec(
          '-s', serial, 'exec-out',
          `CLASSPATH=${jar}:/system/framework/uiautomator.jar`,
          // Its own work is bounded (the idle wait, then a second at most for a window), so a short cap: with
          // `uiautomator dump` after it, the two must fit the relay's 15 s tree deadline.
          'timeout', String(Math.min(timeoutSec, UIDUMP_TIMEOUT_SEC)), 'app_process', '/system/bin', 'dev.tapflow.uidump.TreeDump', '/dev/tty', String(UIDUMP_IDLE_MS),
        ).catch((e: unknown) => (e as { stdout?: string }).stdout ?? '')
        const xml = hierarchyXml(output)
        if (xml) return xml
        // `exec-out` does not carry the exit status, so the marker is what says the image is the problem.
        if (output.includes('TAPFLOW_UIDUMP_UNSUPPORTED')) {
          this.uidumpUnsupported.add(serial)
          logger.warn(`tree dump unsupported on ${serial}, using uiautomator dump: ${output.trim().slice(0, 200)}`)
        } else {
          // The jar may be gone: a wiped emulator comes back on the same serial with an empty /data/local/tmp. Push
          // again next time rather than fall back for the rest of the agent's life.
          this.uidumpPushed.delete(serial)
        }
      }
    }
    return this.dumpWithUiautomator(serial, timeoutSec)
  }

  // The jar's path on the device, named by its content so a device never runs a stale one; undefined if it cannot be
  // pushed (the dump then falls back). Once per serial for the agent's life.
  private pushUidump(serial: string): Promise<string | undefined> {
    let pushed = this.uidumpPushed.get(serial)
    if (!pushed) {
      pushed = (async () => {
        try {
          this.uidumpDevicePath ??= `/data/local/tmp/tapflow-uidump-${createHash('sha256').update(readFileSync(UIDUMP_JAR)).digest('hex').slice(0, 12)}.jar`
          await this.runner.exec('-s', serial, 'push', UIDUMP_JAR, this.uidumpDevicePath)
          return this.uidumpDevicePath
        } catch (e) {
          logger.warn(`could not push the tree dump to ${serial}, using uiautomator dump: ${(e as Error).message.slice(0, 200)}`)
          return undefined
        }
      })()
      this.uidumpPushed.set(serial, pushed)
    }
    return pushed
  }

  // uiautomator waits for an idle window, so screens with continuous animation
  // can block forever — the device-side toybox `timeout` kills the dump and we
  // surface an explicit error instead of hanging (never a silent empty tree).
  private async dumpWithUiautomator(serial: string, timeoutSec: number): Promise<string> {
    const output = await this.runner.exec(
      '-s', serial, 'exec-out',
      'timeout', String(timeoutSec), 'uiautomator', 'dump', '/dev/tty',
    )
    const xml = hierarchyXml(output)
    if (!xml) {
      const detail = output.trim().slice(0, 200)
      throw new PlatformError(
        `uiautomator dump produced no XML within ${timeoutSec}s` +
        (detail ? ` (${detail})` : '') +
        ' — screens with continuous animation block the dump; retry on a settled screen',
      )
    }
    return xml
  }

  // rotation is an Android user_rotation value (0=portrait, 3=canonical landscape home-left/punch-right).
  // `wm user-rotation lock` over legacy `settings put system user_rotation`: the latter is silently
  // ignored on newer Android (API 35+) — the display never rotates, only a rotation-suggestion appears.
  // wm user-rotation locks regardless of auto-rotate and works on API 34 through 37 alike.
  async setRotation(serial: string, rotation: 0 | 1 | 2 | 3): Promise<void> {
    await this.runner.exec('-s', serial, 'shell', 'wm', 'user-rotation', 'lock', String(rotation))
  }

  /**
   * The rotation lock `setRotation` writes: `free` when the device auto-rotates, else the locked
   * quarter. Read with the same command family, so an image that lacks one lacks the other. The
   * output is `free` or `lock 3`, measured on API 34.
   */
  async getUserRotation(serial: string): Promise<{ mode: 'free' } | { mode: 'lock'; rotation: 0 | 1 | 2 | 3 }> {
    const out = (await this.runner.exec('-s', serial, 'shell', 'wm', 'user-rotation')).trim()
    if (out === 'free') return { mode: 'free' }
    const lock = /^lock ([0-3])$/.exec(out)
    if (lock) return { mode: 'lock', rotation: Number(lock[1]) as 0 | 1 | 2 | 3 }
    // An answer this cannot read is not "free": the caller would leave a landscape lock in place.
    throw new PlatformError(`Cannot read the rotation lock from: ${out || '(empty)'}`)
  }

  /** Let Android rotate with the device again (`wm user-rotation free`): what an AVD comes with. */
  async freeRotation(serial: string): Promise<void> {
    await this.runner.exec('-s', serial, 'shell', 'wm', 'user-rotation', 'free')
  }

  /**
   * How far an emulator's body is turned clockwise, from the **console's** accelerometer — no gRPC, so it
   * reads a device streaming over scrcpy too. Gravity is +9.81 on the axis pointing up (measured): upright
   * reads y+, a quarter clockwise x−, upside down y−, a quarter anticlockwise x+. Null when the reading is
   * not one of those — lying flat, or an answer this cannot parse.
   */
  async readBodyRotation(serial: string): Promise<0 | 90 | 180 | 270 | null> {
    const out = await this.runner.exec('-s', serial, 'emu', 'sensor', 'get', 'acceleration')
    const m = /acceleration\s*=\s*(-?[\d.e+-]+):(-?[\d.e+-]+):(-?[\d.e+-]+)/.exec(out)
    if (!m) return null
    const [x, y] = [Number(m[1]), Number(m[2])]
    if (Math.max(Math.abs(x), Math.abs(y)) < 7) return null
    if (Math.abs(y) >= Math.abs(x)) return y > 0 ? 0 : 180
    return x < 0 ? 90 : 270
  }

  /** Turn an emulator's body a quarter clockwise (`emu rotate`) — relative, so the caller reads before and after. */
  async rotateBodyClockwise(serial: string): Promise<void> {
    const out = await this.runner.exec('-s', serial, 'emu', 'rotate')
    if (/^KO\b/m.test(out)) throw new PlatformError(`emu rotate refused: ${out.trim()}`)
  }

  async sendInput(serial: string, ...args: string[]): Promise<void> {
    await this.runner.exec('-s', serial, 'shell', 'input', ...args)
  }

  // `adb shell input text` runs in the device shell, which splits on spaces and
  // interprets shell metacharacters — encode spaces as %s and backslash-escape
  // the rest. ASCII only (the `input text` command can't emit arbitrary
  // Unicode without a custom IME); non-ASCII is dropped with a thrown error so
  // callers don't silently believe it typed.
  async inputText(serial: string, text: string): Promise<void> {
    if (/[^\x20-\x7e]/.test(text)) {
      throw new PlatformError('Android input text supports ASCII only — non-ASCII characters require a custom IME (not supported)')
    }
    await this.runner.exec('-s', serial, 'shell', 'input', 'text', encodeAdbInputText(text))
  }

  async sendKeyEvent(serial: string, keyCode: string): Promise<void> {
    await this.runner.exec('-s', serial, 'shell', 'input', 'keyevent', keyCode)
  }

  /**
   * Presses the keys together, holding each until the last is down — the only adb form that carries a
   * meta state, since `keyevent` sends every key on its own. Answers false where `input` has no such
   * command (Android below 13): it prints its usage and the shell still exits 0, so the output is the
   * only sign that nothing was pressed. That output goes to stderr, which the runner drops, hence the
   * redirect — interpreted by the device's shell, not ours. Exit 0 was measured on API 28 only; an
   * `input` that exits non-zero instead rejects with the same text on the error's `stdout`, and is the
   * same answer rather than a failed dispatch.
   */
  async sendKeyCombination(serial: string, keyCodes: string[]): Promise<boolean> {
    const unknown = (out: unknown) => typeof out === 'string' && /Unknown command/.test(out)
    try {
      return !unknown(await this.runner.exec('-s', serial, 'shell', 'input', 'keycombination', ...keyCodes, '2>&1'))
    } catch (e) {
      if (unknown((e as { stdout?: unknown } | null)?.stdout)) return false
      throw e
    }
  }

  /**
   * Enabled and disabled package names, for Lean mode. Disabled is **every package minus the enabled
   * ones**, not `-d`: a `-d` read that came back empty would say a disabled app is gone, and a
   * missing app is one Lean mode stops tracking. Both reads must name `android`, or neither is trusted.
   */
  async packageStates(serial: string): Promise<{ enabled: Set<string>; disabled: Set<string> }> {
    const list = async (...flag: string[]) => new Set(
      (await this.runner.exec('-s', serial, 'shell', 'pm', 'list', 'packages', ...flag))
        .split('\n').map((l) => l.trim()).filter((l) => l.startsWith('package:')).map((l) => l.slice('package:'.length)),
    )
    const all = await list()
    const enabled = await list('-e')
    if (!all.has('android') || !enabled.has('android')) throw new PlatformError('pm gave no usable package list yet')
    return { enabled, disabled: new Set([...all].filter((p) => !enabled.has(p))) }
  }

  /** `pm` prints its errors with exit code 0, so "new state" in the output is what says it took. */
  async setPackageEnabled(serial: string, pkg: string, enabled: boolean): Promise<void> {
    const out = await this.runner.exec('-s', serial, 'shell', 'pm', enabled ? 'enable' : 'disable-user', '--user', '0', pkg)
    if (!out.includes('new state')) throw new PlatformError(`pm ${enabled ? 'enable' : 'disable-user'} ${pkg} failed: ${out.trim() || 'no output'}`)
  }

  /** Whether an installed package runs an update from /data/app rather than its /system version. */
  async hasSystemUpdates(serial: string, pkg: string): Promise<boolean> {
    const out = await this.runner.exec('-s', serial, 'shell', 'pm', 'path', pkg)
    return out.split('\n').some((l) => l.trim().startsWith('package:/data/app/'))
  }

  /**
   * Roll a system app back to its /system version. `pm` exits 1 here even when it succeeds —
   * measured on API 35, with and without an update to remove — so its output is what says it took.
   */
  async uninstallSystemUpdates(serial: string, pkg: string): Promise<void> {
    let out: string
    try {
      out = await this.runner.exec('-s', serial, 'shell', 'pm', 'uninstall-system-updates', pkg)
    } catch (e) {
      out = (e as { stdout?: string }).stdout ?? ''
      if (!out.includes('Success')) throw new PlatformError(`pm uninstall-system-updates ${pkg} failed: ${(e as Error).message}`, { cause: e })
    }
    if (!out.includes('Success')) throw new PlatformError(`pm uninstall-system-updates ${pkg} failed: ${out.trim() || 'no output'}`)
  }

  /** A file's contents, or `null` when it does not exist — told apart from an empty file. */
  async readDeviceFile(serial: string, path: string): Promise<string | null> {
    const out = await this.runner.exec('-s', serial, 'shell', `if [ -f ${path} ]; then cat ${path}; else echo ${NO_FILE}; fi`)
    return out.trim() === NO_FILE ? null : out.replace(/\r?\n$/, '')
  }

  /**
   * Written to a temp file, renamed into place and synced, so an `emu kill` right after cannot leave
   * half a file or one still in the guest's page cache. Base64, so the content never meets the shell.
   */
  async writeDeviceFile(serial: string, path: string, content: string): Promise<void> {
    const b64 = Buffer.from(content).toString('base64')
    await this.runner.exec('-s', serial, 'shell', `echo ${b64} | base64 -d > ${path}.tmp && mv ${path}.tmp ${path} && sync`)
  }

  async removeDeviceFile(serial: string, path: string): Promise<void> {
    await this.runner.exec('-s', serial, 'shell', `rm -f ${path} && sync`)
  }

  async shutdown(serial: string): Promise<void> {
    await this.runner.exec('-s', serial, 'emu', 'kill')
  }

  async pkill(serial: string, pattern: string): Promise<void> {
    await this.runner.exec('-s', serial, 'shell', 'pkill', '-f', pattern)
  }
}

// The XML document in a dump's output, without the status lines around it; undefined when it is missing or cut off.
function hierarchyXml(output: string): string | undefined {
  const start = output.indexOf('<?xml') >= 0 ? output.indexOf('<?xml') : output.indexOf('<hierarchy')
  const end = output.lastIndexOf('</hierarchy>')
  return start < 0 || end < 0 ? undefined : output.slice(start, end + '</hierarchy>'.length)
}

// The part of the relay's defaults `launchFresh` can deliver, or undefined when none of it can. A relay that knows this
// agent has no `launch-env` sends no env default, so env here means a relay that checked less.
function deliverableDefaults(packageName: string, options: LaunchOptions, component: string | undefined): LaunchOptions | undefined {
  if (Object.keys(options.env ?? {}).length > 0) console.warn(`[tapflow] ${packageName}: env defaults left out — Android cannot set an app's environment`)
  if (Object.keys(options.arguments ?? {}).length === 0) return undefined
  if (!component) {
    console.warn(`[tapflow] ${packageName}: no single launcher activity, so its launch defaults were left out and the app launched without them`)
    return undefined
  }
  return { arguments: options.arguments }
}
