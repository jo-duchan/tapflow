import { execSync, spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync, readdirSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join, win32 } from 'node:path'
import { LeanStore } from '@tapflowio/ios-agent'
import { androidSdkCandidates as hostSdkCandidates, findOnPath, hostExecutableName } from '@tapflowio/agent-core/utils'
import {
  isFilterEnforcing, isNetFilterCurrent, isNewer, readNetFilterState, removalSteps, shellQuote, shippedHookPath,
} from './net-filter.js'
import { activeDeveloperDir, findXcodeApp, selectedXcodeApp } from './xcode.js'

/**
 * How long any one probe may take before `doctor` treats it as unanswerable.
 *
 * Every call below is a read, wrapped in a `catch` that reports "cannot tell". Without a timeout a
 * hung `simctl` or a wedged `adb` hangs the whole command instead — and the machines where one of
 * these hangs are exactly the machines someone runs `doctor` on.
 */
const PROBE_TIMEOUT_MS = 10_000

export interface DoctorCheck {
  label: string
  ok: boolean
  warn?: boolean
  detail?: string
}

export interface DoctorResult {
  common: DoctorCheck[]
  ios: DoctorCheck[] | null
  android: DoctorCheck[] | null
}

// platform: 'ios' | 'android' 지정 시 해당 플랫폼만. 없으면 자동(iOS는 macOS에서만, Android은 항상).
export async function runDoctorChecks(platform?: string, opts: { lean?: boolean } = {}): Promise<DoctorResult> {
  const isMac = process.platform === 'darwin'
  const wantIos = platform === 'ios' || (!platform && isMac)
  const wantAndroid = platform === 'android' || !platform

  return {
    common: [checkNodeVersion(), await checkPort(4000)],
    ios: wantIos ? buildIosChecks(isMac, opts.lean ?? false) : null,
    android: wantAndroid ? [...buildAndroidChecks(resolveAdb()), checkAndroidLeanMode(opts.lean ?? false)] : null,
  }
}

function buildIosChecks(isMac: boolean, lean: boolean): DoctorCheck[] {
  if (!isMac) {
    return [{ label: 'iOS', ok: false, warn: true, detail: 'iOS testing requires macOS.' }]
  }
  // Without an Xcode, or with one but no developer directory at all, xcodebuild/xcrun are not called:
  // either way the shims would raise the Command Line Tools install dialog. The second case is a
  // bundle `xcode-select` does not fall back to on its own, such as `Xcode-27.0.0.app` from `xcodes`
  // on a Mac that has never selected one.
  //
  // **넷필터 체크는 이 조기 반환에도 붙는다.** 확장은 Xcode와 무관하게 설치·활성될 수 있고, 이 경로가
  // 체크를 빠뜨리면 Xcode 없는 맥에서는 넷필터 상태를 물어볼 방법이 아예 없다. 설계 리뷰가 "체크
  // 추가는 배열에 객체를 넣는 일"이라는 전제를 반환 경로가 셋이라는 사실로 반박했다.
  const xcodeApp = findXcodeApp()
  if (!xcodeApp || activeDeveloperDir() === null) {
    return [
      xcodeApp ? notSelected(xcodeApp) : {
        label: 'Xcode',
        ok: false,
        detail: 'Install Xcode from https://developer.apple.com/xcode/ or the Mac App Store. Or run: tapflow setup ios',
      },
      ...buildNetFilterChecks(),
      checkNetworkHook(),
      // **`checkHookSymbols` is deliberately NOT here**, unlike the two above it. It runs `xcrun`, and
      // the comment at the top of this branch is the reason the branch exists: on a Mac with no
      // Xcode, `xcrun` pops the Command Line Tools install dialog out of a diagnostic command. The
      // netfilter checks belong because they are filesystem reads; this one is not.
      //
      // Nothing is lost by its absence: without Xcode there is no simulator SDK to read, so its
      // answer here could only ever have been "cannot tell".
    ]
  }
  // Read once and shared: both checks below need the list, and each read is an `xcrun` round trip.
  const simulators = listSimulators()
  return [checkXcode(xcodeApp), checkSimctl(), checkBootedSimulator(simulators), ...buildNetFilterChecks(), checkNetworkHook(), checkHookSymbols(), checkLeanMode(lean, simulators)]
}

/**
 * The iOS network filter, in two checks — **is it working, and is it the one this tapflow expects**.
 *
 * Split because they fail for different reasons and have different remedies, and because the second
 * one is the whole point: the version that matters is the one macOS has **activated**, not the app
 * sitting in `/Applications`. On the ordinary upgrade path those two disagree — `--install` answers
 * "needs a reboot" and leaves the new app on disk with the old provider still running — and a check
 * that compared the files would report a healthy Mac while the dashboard says it is not set up.
 *
 * Everything here is `warn`, never `fail`. A session works without the filter; only iOS network
 * control does not.
 */

function buildNetFilterChecks(): DoctorCheck[] {
  const s = readNetFilterState()

  // **Both halves of "the package carries a filter".** The extension version comes from a plist
  // nested inside the same bundle, so a bundle that is there but damaged answers `null` for one and
  // not the other — and every comparison below would then be against nothing.
  if (s.shippedHost === null || s.shippedExt === null) {
    return [{
      label: 'Network filter',
      ok: false,
      warn: true,
      detail: 'This tapflow install carries no usable filter app, so iOS network control cannot be set up. Reinstalling tapflow restores it.',
    }]
  }
  if (s.installedHost === null) {
    // **Activated but no app on disk is not "not installed".** macOS keeps running an extension whose
    // container app has been deleted, so saying it is missing sends someone to reinstall — from an
    // older checkout, that replaces a filter that is working.
    if (s.activatedExt !== null) {
      return [{
        label: 'Network filter',
        ok: false,
        warn: true,
        detail: `Running ${s.activatedExt}, but the app it came from is gone from /Applications. Reinstall it from the tapflow whose version matches, or clear it: ${removalSteps().join('; ')}.`,
      }]
    }
    return [{
      label: 'Network filter',
      ok: false,
      warn: true,
      detail: 'Not installed. Run `tapflow setup ios` on a new machine, or `tapflow migrate net-filter` if tapflow was set up before this feature existed.',
    }]
  }
  if (s.activatedExt === null) {
    return [{
      label: 'Network filter',
      ok: false,
      warn: true,
      detail: 'Installed but not approved yet. Open System Settings → General → Login Items & Extensions → Network Extensions and switch tapflow on.',
    }]
  }

  // **Installed, approved and switched on are three things, and the third has no version.**
  // `systemextensionsctl` describes the system extension; `NEFilterManager.isEnabled` is a separate
  // preference, so a filter switched off leaves every version here correct and this check green over
  // a control that does not work. That state is reachable from this repo's own code: the replace
  // disables the filter before swapping the extension, and an interrupted run leaves it off.
  //
  // **It is decided here rather than inside the matching-version branch**, which is where it first
  // went and was wrong: every branch below reports this same `running` object, so a Mac that was both
  // waiting for a restart *and* switched off said "Network filter ok" and named only the restart —
  // and restarting does not turn a filter back on. The version half stays separate and still true,
  // because sending someone to an upgrade would send them somewhere that cannot help.
  const running: DoctorCheck = isFilterEnforcing()
    ? { label: 'Network filter', ok: true }
    : {
        label: 'Network filter',
        ok: false,
        warn: true,
        detail: 'Installed and approved, but switched off — nothing is filtering, so iOS network control does not work. Run: tapflow migrate net-filter',
      }
  // **The same condition the installer uses, not a second one shaped like it** (#724). Deciding this
  // on the extension alone would report a Mac whose `/Applications` app is stale as fully healthy —
  // and that app is the agent's own layer-1 path, so an older one meets flags it does not understand
  // and, on a build old enough, clears the rule instead of refusing. Green while that is true is the
  // worst answer available.
  if (isNetFilterCurrent(s)) {
    return [running, { label: 'Network filter version', ok: true }]
  }
  // Running something, but not this. Several ways that happens and they want different sentences.
  //
  // `isNewer`, not a second `Number() >`: that one answered `false` for a version neither side could
  // parse, while the installer's guard answers `true` and refuses. The two disagreeing sent the user
  // to a `migrate net-filter` that would refuse the moment they ran it.
  //
  // **The sentence names the pair that actually triggered**, which needs saying because the two
  // disjuncts are now different measurements. Reporting the extension pair for a host mismatch prints
  // two identical numbers as the evidence they differ — and under this scheme the host disjunct is
  // the one that fires most often, since a host-only release moves that number alone.
  const newerExt = isNewer(s.activatedExt, s.shippedExt)
  const newerHost = s.installedHost !== null && isNewer(s.installedHost, s.shippedHost)
  if (newerExt || newerHost) {
    return [running, {
      label: 'Network filter version',
      ok: false,
      warn: true,
      detail: newerExt
        ? `This Mac is set up for a newer tapflow — it runs extension ${s.activatedExt} and this one carries ${s.shippedExt}. Upgrade this checkout rather than reinstalling the filter.`
        : `This Mac is set up for a newer tapflow — the app in /Applications is ${s.installedHost} and this one carries ${s.shippedHost}. Upgrade this checkout rather than reinstalling the filter.`,
    }]
  }
  // The app on disk is this build's and the extension running is not: macOS finishes a replacement
  // only on restart. **Decided from the host version alone**, because both plists come out of one
  // build and the host's is unique per build — so a matching host version already says the extension
  // beside it is this build's too, without reading a third plist for it.
  if (s.installedHost === s.shippedHost) {
    return [running, {
      label: 'Network filter version',
      ok: false,
      warn: true,
      detail: `Waiting for a restart: ${s.shippedExt} is installed but the Mac is still running ${s.activatedExt}. Restart the Mac to finish.`,
    }]
  }
  // The extension is already this build's and only the app is behind — the ordinary shape of a
  // release that changed nothing but the host. macOS will skip the activation, so this costs a copy
  // and no interruption, but it has to happen: the agent runs that binary.
  if (s.activatedExt === s.shippedExt) {
    return [running, {
      label: 'Network filter version',
      ok: false,
      warn: true,
      detail: `The app in /Applications is ${s.installedHost} and this tapflow carries ${s.shippedHost}. The agent runs that binary. Run \`tapflow migrate net-filter\` to update it.`,
    }]
  }
  return [running, {
    label: 'Network filter version',
    ok: false,
    warn: true,
    detail: `The Mac runs extension ${s.activatedExt} and this tapflow carries ${s.shippedExt}. Run \`tapflow migrate net-filter\` to update it.`,
  }]
}

/**
 * The other half of iOS network control, and until now nothing looked at it.
 *
 * The filter cuts the traffic; this library is what tells the app it is offline. Losing it produces
 * the worst-shaped failure in the feature — dyld ignores a `DYLD_INSERT_LIBRARIES` path that is not
 * there without a word, so the app runs unhooked and the agent never receives a verdict. The control
 * then asks the tester to launch an app through tapflow — which they have already done, and will go
 * on being asked for as long as the session lasts.
 *
 * A warning rather than a failure, matching the filter's checks: a session works without it and only
 * iOS network control does not.
 */
/**
 * The symbols the injected library rebinds, and where this Xcode says they live.
 *
 * **A copy, and the copy is the point rather than a shortcut.** The list lives in
 * `packages/ios-agent/src/network-hook.m`'s `wanted[]`, which this package does not ship — and it
 * cannot be read back out of the shipped dylib either: three of the four are resolved with
 * `dlsym(RTLD_DEFAULT, name)`, so they are C string literals rather than import entries, and only
 * `getaddrinfo` appears in its symbol table at all (measured). So the two lists are kept in step by
 * `scripts/__tests__/hookSymbolsChecked.test.mjs`, which reads `wanted[]` and fails when they differ.
 */
/**
 * Nine, from two tables in `network-hook.m` — four path hooks and five reachability hooks. The
 * second set is all-or-none separately from the first, but a symbol a new Xcode stops exporting takes
 * it down just the same, and this list is the only thing that says so before a tester finds out by
 * launching an app.
 *
 * **Nothing but quoted names goes between the brackets.** `hookSymbolsChecked.test.mjs` counts the
 * entries by splitting on commas as a cross-check against its own regex, so a comment containing one
 * makes the two disagree and fails the build — which is the check working, and is why this note is
 * out here.
 */
const HOOK_SYMBOLS = [
  'getaddrinfo', 'nw_path_get_status', 'nw_path_monitor_set_update_handler', 'nw_path_monitor_set_queue',
  'SCNetworkReachabilityGetFlags', 'SCNetworkReachabilitySetCallback', 'SCNetworkReachabilitySetDispatchQueue',
  'SCNetworkReachabilityScheduleWithRunLoop', 'SCNetworkReachabilityUnscheduleFromRunLoop',
]

/** The SDK stubs that between them declare everything the hook needs. */
const SDK_STUBS = [
  'usr/lib/libSystem.tbd',
  'System/Library/Frameworks/Network.framework/Network.tbd',
  'System/Library/Frameworks/SystemConfiguration.framework/SystemConfiguration.tbd',
]

/**
 * **Does this Xcode still export what the hook rebinds** (#629).
 *
 * The install is all-or-none and each entry begins with `dlsym(RTLD_DEFAULT, name)`, so one symbol
 * removed or renamed by a new Xcode takes the whole feature down — and a tester finds out by launching
 * an app and reading a dead control. This is the half of that which can be answered by reading.
 *
 * **Reading, and nothing else.** No simulator is booted, installed to or launched into, and no
 * environment is written. `doctor` diagnoses prerequisites; the version of this that ran a probe app
 * inside a simulator was refused for that reason, and because on this product's model a booted
 * simulator is usually somebody's live session. #629 carries the argument.
 *
 * What it therefore does **not** answer: whether rebinding still works once the symbols are found.
 * That is settled at runtime, where the verdict file already reports it.
 */
function checkHookSymbols(): DoctorCheck {
  let sdk: string
  try {
    sdk = execSync('xcrun --sdk iphonesimulator --show-sdk-path', {
      encoding: 'utf8', stdio: 'pipe', timeout: PROBE_TIMEOUT_MS,
    }).trim()
  } catch {
    // `checkXcode` on this path already reports an unconfigured Xcode, so this says only what it
    // could not do rather than diagnosing the cause a second time in different words.
    return { label: 'Network hook symbols', ok: false, warn: true, detail: 'Skipped — no iOS simulator SDK to read.' }
  }

  // **All of them or none**, because the two files partition the symbols between them: `getaddrinfo`
  // is declared only in `libSystem.tbd` and the three `nw_path_*` only in `Network.tbd`. With one file
  // missing, three symbols read as absent — and the message below would tell someone their Xcode had
  // dropped them and ask them to file a bug about it. A layout this does not recognise is "cannot
  // tell", never "removed".
  const stubs = SDK_STUBS.map((rel) => join(sdk, rel))
  let declared: string
  try {
    if (!stubs.every((p) => existsSync(p))) throw new Error('layout')
    // Wrapped like every other probe in this file, for the reason its header gives: a read that throws
    // between the check and the open — an SDK replaced mid-update — would reject the whole command and
    // take the Android section down with it.
    declared = stubs.map((p) => readFileSync(p, 'utf8')).join('\n')
  } catch {
    return {
      label: 'Network hook symbols',
      ok: false,
      warn: true,
      detail: `Could not read the export lists under ${sdk}, so whether this Xcode still provides them is unknown.`,
    }
  }

  const missing = HOOK_SYMBOLS.filter((sym) => !new RegExp(`\\b_${sym}\\b`).test(declared))

  if (missing.length > 0) {
    return {
      label: 'Network hook symbols',
      ok: false,
      warn: true,
      detail: `The SDK at ${sdk} does not declare ${missing.join(', ')}. The injected library needs all of them, so iOS network control would fail once an app is launched. Please report this with your Xcode version.`,
    }
  }
  // **What this does and does not say.** It read the SDK; the library is injected into a process
  // running against a *simulator runtime*, and a Mac usually has several — measured here: one SDK
  // (26.5) against six runtimes back to 17.2. A symbol the SDK declares can still be absent from an
  // older runtime, and the match is target-blind besides: `libSystem.tbd` is a multi-document file
  // whose macOS/Catalyst documents are visible to this regex. So this is evidence that the symbols
  // have not been withdrawn, not a guarantee that a given session will find them — which is why the
  // label says what was read.
  return { label: `Network hook symbols (${sdk.split('/').pop()})`, ok: true }
}

function checkNetworkHook(): DoctorCheck {
  const hook = shippedHookPath()
  if (hook === null) {
    return {
      label: 'Network hook',
      ok: false,
      warn: true,
      detail: 'Missing from this tapflow install. An app cannot be told it is offline without it, so iOS network control stays off. Reinstalling tapflow restores it.',
    }
  }
  try {
    accessSync(hook, constants.R_OK)
  } catch {
    return {
      label: 'Network hook',
      ok: false,
      warn: true,
      detail: `Found at ${hook} but cannot be read, so it cannot be injected. Reinstalling tapflow restores it.`,
    }
  }
  return { label: 'Network hook', ok: true }
}

// adb가 없어도 섹션을 숨기지 않고 진단을 노출한다(Android를 세팅하려는 사용자가 볼 수 있도록).
// iOS(Xcode / simctl / Simulator)와 대칭: Android SDK / adb / AVD.
function buildAndroidChecks(adb: AdbResolution | null): DoctorCheck[] {
  return [checkAndroidSdk(), checkAdbStatus(adb), checkAaptAvailable(), checkAvdAvailable()]
}

// ANDROID_HOME, ANDROID_SDK_ROOT, then the host's default SDK location — %LOCALAPPDATA%\Android\Sdk on
// Windows (#1100). Shared with the agent and the relay's findAapt, so all three agree.
function androidSdkCandidates(): string[] {
  return hostSdkCandidates()
}

function androidSdkDir(): string | null {
  for (const c of androidSdkCandidates()) {
    if (existsSync(join(c, 'cmdline-tools', 'latest', 'bin', hostExecutableName('sdkmanager')))) return c
  }
  return null
}

function checkAndroidSdk(): DoctorCheck {
  const dir = androidSdkDir()
  if (dir) {
    return { label: `Android SDK: ${dir}`, ok: true }
  }
  return { label: 'Android SDK', ok: false, detail: 'Android SDK not found. Run: tapflow setup android' }
}

// apk metadata extraction (aapt dump badging) needs build-tools. Without it, .apk uploads are stored
// with no bundleId and app matching breaks (ghost builds / wrong-app merges). Diagnosed separately from SDK/adb/AVD.
function checkAaptAvailable(): DoctorCheck {
  // Scan the SDK candidates directly (not via androidSdkDir), so build-tools is found even when
  // cmdline-tools/sdkmanager is absent — matching the relay's findAapt.
  for (const c of androidSdkCandidates()) {
    const aapt = findAaptInSdk(c)
    if (aapt) return { label: `aapt (build-tools): ${aapt}`, ok: true }
  }
  return {
    label: 'aapt (build-tools)',
    ok: false,
    warn: true,
    detail: 'Android build-tools not found — targeted .apk uploads (with app_id) will be rejected; untargeted uploads are filed under __unknown__. Run: tapflow setup android',
  }
}

function findAaptInSdk(sdkDir: string): string | null {
  const buildToolsDir = join(sdkDir, 'build-tools')
  if (!existsSync(buildToolsDir)) return null
  try {
    for (const v of readdirSync(buildToolsDir)) {
      const aapt = join(buildToolsDir, v, hostExecutableName('aapt'))
      if (existsSync(aapt)) return aapt
    }
  } catch {
    return null
  }
  return null
}

function checkAdbStatus(adb: AdbResolution | null): DoctorCheck {
  if (!adb) {
    // 미설치는 iOS(Xcode)와 동일하게 fail(✗)로 — setup으로 해결 가능함을 안내.
    return { label: 'adb', ok: false, detail: 'adb not found. Run: tapflow setup android' }
  }
  if (adb.inPath) {
    return checkAdb(adb.path)
  }
  return {
    label: 'adb (not in PATH)',
    ok: false,
    warn: true,
    detail: process.platform === 'win32'
      ? `adb found at ${adb.path} but not in PATH. Add ${win32.dirname(adb.path)} to your user PATH (Environment Variables), open a new terminal, then re-run tapflow doctor`
      : `adb found at ${adb.path} but not in PATH. Open a new terminal or run: exec $SHELL, then re-run tapflow doctor`,
  }
}

function notSelected(xcodeApp: string): DoctorCheck {
  return {
    label: 'Xcode',
    ok: false,
    detail: `Xcode is installed but xcode-select is not configured. Run: sudo xcode-select -s ${shellQuote(`${xcodeApp}/Contents/Developer`)}`,
  }
}

function checkXcode(xcodeApp: string): DoctorCheck {
  try {
    const out = execSync('xcodebuild -version', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: PROBE_TIMEOUT_MS })
    const version = out.split('\n')[0]?.replace('Xcode ', '') ?? ''
    return { label: `Xcode ${version}`, ok: true }
  } catch {
    // Already selected and still failing is almost always the licence or first launch, which is
    // what `setup ios` finishes in the same state. Re-selecting it would change nothing.
    if (selectedXcodeApp() === xcodeApp) {
      return {
        label: 'Xcode',
        ok: false,
        detail: 'Xcode is selected but not set up. Run: sudo xcodebuild -license accept && sudo xcodebuild -runFirstLaunch',
      }
    }
    return notSelected(xcodeApp)
  }
}

function checkSimctl(): DoctorCheck {
  try {
    execSync('xcrun simctl list --json', { stdio: 'pipe', timeout: PROBE_TIMEOUT_MS })
    return { label: 'xcrun simctl', ok: true }
  } catch {
    return {
      label: 'xcrun simctl',
      ok: false,
      detail: 'Run: xcode-select --install',
    }
  }
}

// 부팅은 QA Session 접속 시 relay가 on-demand로 한다 — 미부팅은 정상, 디바이스 존재만 확인.
type Simulator = { name: string; state: string; udid: string }

/** Every simulator simctl knows, or null when it could not be asked. */
function listSimulators(): Simulator[] | null {
  try {
    const raw = execSync('xcrun simctl list devices --json', { encoding: 'utf8', stdio: 'pipe', timeout: PROBE_TIMEOUT_MS })
    const data = JSON.parse(raw) as { devices: Record<string, Simulator[]> }
    return Object.values(data.devices).flat()
  } catch {
    return null
  }
}

function checkBootedSimulator(allDevices: Simulator[] | null): DoctorCheck {
  if (!allDevices) {
    return { label: 'Simulator', ok: false, detail: 'Could not query simulators. Is Xcode installed?' }
  }
  if (allDevices.length === 0) {
    return { label: 'Simulator', ok: false, warn: true, detail: 'No simulator available. Run: tapflow setup ios' }
  }
  const booted = allDevices.find((d) => d.state === 'Booted')
  return {
    label: booted ? `Simulator: ${booted.name} (booted)` : `Simulator available (${allDevices.length})`,
    ok: true,
  }
}

/**
 * Reports, never fixes: `agent.lean` is the switch. A device counts as lean while its marker is there,
 * which is from the agent booting it until the agent shuts it down — and past that when a run ended
 * without the shutdown, until the next connect puts it back.
 */
function checkLeanMode(lean: boolean, simulators: Simulator[] | null): DoctorCheck {
  // Devices by the service tier their marker records: Lean mode's own, or `slim` from a run that asked for it.
  const byTier = new Map<string, number>()
  try {
    // The host directory outlives `simctl delete`, so a marker for a device that is gone is not counted.
    // With no list at all this counts nothing: that failure is the Simulator check's to report.
    const exists = new Set((simulators ?? []).map((d) => d.udid))
    const store = new LeanStore()
    for (const udid of store.applied().filter((u) => exists.has(u))) {
      const name = store.currentTier(udid).name
      byTier.set(name, (byTier.get(name) ?? 0) + 1)
    }
  } catch {
    // An unreadable store directory still leaves this check able to say what the setting is.
  }
  const count = [...byTier.values()].reduce((a, b) => a + b, 0)
  const noun = `${count} device${count === 1 ? '' : 's'}`
  // "1 device lean", or "2 devices: 1 lean, 1 slim" when a run left some on another tier.
  const tiers = byTier.size === 1 ? [...byTier.keys()][0]! : [...byTier].map(([name, n]) => `${n} ${name}`).join(', ')
  const devices = byTier.size === 1 ? `${noun} ${tiers}` : `${noun}: ${tiers}`
  if (lean) return { label: count > 0 ? `Lean mode (iOS): on (${devices} now)` : 'Lean mode (iOS): on', ok: true }
  if (count === 0) return { label: 'Lean mode (iOS): off', ok: true }
  return {
    label: byTier.size === 1 ? `Lean mode (iOS): off (${noun} still ${tiers})` : `Lean mode (iOS): off (${noun} still changed: ${tiers})`,
    ok: false,
    warn: true,
    // Only shut-down devices are put back on connect, and one whose marker or store cannot be read is
    // left as it is — so this says what happens next without promising it has.
    detail: 'Left by a run that ended without shutting them down. An agent puts each one back when it connects and finds it shut down; its log says so if one cannot be.',
  }
}

/**
 * The setting only: the record of which emulators are lean lives inside each emulator, where a
 * doctor cannot read it without booting them.
 */
function checkAndroidLeanMode(lean: boolean): DoctorCheck {
  return lean
    ? { label: 'Lean mode (Android): on', ok: true }
    : { label: 'Lean mode (Android): off', ok: true }
}

function checkNodeVersion(): DoctorCheck {
  const version = process.version
  const [, major] = version.match(/^v(\d+)/) ?? []
  const ok = Number(major) >= 22
  return {
    label: `Node ${version}`,
    ok,
    detail: ok ? undefined : 'Node ≥ 22 required. Install from https://nodejs.org/',
  }
}

async function checkPort(port: number): Promise<DoctorCheck> {
  const ok = await isPortAvailable(port)
  return {
    label: `Port ${port}`,
    ok,
    detail: ok ? undefined : `Port ${port} is already in use. Run: lsof -ti:${port} | xargs kill`,
  }
}

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen({ port, host: '::', ipv6Only: false })
  })
}

export interface AdbResolution {
  path: string
  inPath: boolean
}

export function resolveAdb(): AdbResolution | null {
  // Windows has no `which`; agent-core's PATH lookup stands in for it there (#1100).
  if (process.platform === 'win32') {
    const found = findOnPath('adb')
    if (found) return { path: found, inPath: true }
  } else try {
    const found = execSync('which adb', { encoding: 'utf8', stdio: 'pipe', timeout: PROBE_TIMEOUT_MS }).trim()
    if (found) return { path: found, inPath: true }
  } catch {
    // PATH에 없으면 표준 SDK 위치 탐색으로 진행
  }
  for (const candidate of standardAdbPaths()) {
    if (existsSync(candidate)) return { path: candidate, inPath: false }
  }
  return null
}

function standardAdbPaths(): string[] {
  return androidSdkCandidates().map((sdk) => join(sdk, 'platform-tools', hostExecutableName('adb')))
}

function checkAdb(path: string): DoctorCheck {
  return { label: `adb found: ${path}`, ok: true }
}

// 부팅은 relay on-demand가 한다 — AVD가 하나라도 존재하면 ok.
// iOS Simulator와 대칭: SDK/emulator 자체가 없으면 fail(✗), emulator는 있는데 AVD만 없으면 warn(⚠).
function checkAvdAvailable(): DoctorCheck {
  const dir = androidSdkDir()
  const emulator = dir ? join(dir, 'emulator', hostExecutableName('emulator')) : null
  if (!emulator || !existsSync(emulator)) {
    return { label: 'AVD', ok: false, detail: 'Android SDK/emulator not found. Run: tapflow setup android' }
  }
  try {
    const out = spawnSync(emulator, ['-list-avds'], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS }).stdout ?? ''
    const avds = out.trim() ? out.trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : []
    if (avds.length > 0) {
      return { label: `AVD available: ${avds[0]}`, ok: true }
    }
  } catch {
    // 조회 실패 — 아래 warn
  }
  return { label: 'AVD', ok: false, warn: true, detail: 'No AVD found. Run: tapflow setup android' }
}
