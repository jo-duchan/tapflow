import { execSync, spawnSync } from 'node:child_process'
import {
  installNetFilter, followThroughApproval, offerApprovalUpFront, APPROVAL_PATH, INSTALL_STAGE_MESSAGE, isFilterEnforcing,
  isNetFilterCurrent, readNetFilterState, removalSteps, shellQuote, CONFIRM_DEADLINE_MS, NET_FILTER_APP,
  type InstallOptions,
} from './net-filter.js'
import { existsSync, readFileSync, appendFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { confirm, text, isCancel } from '@clack/prompts'
import { requestAudioPermission, isAudioSupported } from '@tapflowio/ios-agent'
import { resolveAdb, type DoctorCheck } from './doctor.js'
import { step } from './print.js'
import { terminalApprovalDeps } from './approval-prompt.js'
import { isInteractive } from './interactive.js'
import { findXcodeApp, selectedXcodeApp, DEFAULT_XCODE_APP } from './xcode.js'
import { runSetupAndroidWindows, realWindowsDeps } from './setup-android-windows.js'

// SetupStepResult = DoctorCheck + optional state (found/created/repaired); ok is untouched so doctor is unaffected.
export type SetupStepState = 'found' | 'created' | 'repaired'
export type SetupStepResult = DoctorCheck & { state?: SetupStepState }

const PATH_MARKER_START = '# >>> tapflow android sdk >>>'
const PATH_MARKER_END = '# <<< tapflow android sdk <<<'
// SDK를 표준 경로에 자기완결로 고정한다(cmdline-tools·platform-tools·emulator·system-image 모두 이 아래).
const ANDROID_SDK_DIR = join(homedir(), 'Library', 'Android', 'sdk')
const XCODE_APPSTORE = 'https://apps.apple.com/app/xcode/id497799835'
// Play Store 이미지는 crash 이슈가 있어 google_apis(non-playstore)를 쓴다.
const AVD_IMAGE_API = 'android-35'
// Needed for apk metadata extraction (aapt). Pinned to match the system image API (android-35).
const ANDROID_BUILD_TOOLS = '35.0.0'
// 폼팩터별로 해상도가 골고루 분포하도록 4종. device id는 SDK마다 다르므로 후보 중 가용한 첫 id 선택.
const AVD_SPECS: { name: string; deviceCandidates: string[] }[] = [
  { name: 'tapflow-compact', deviceCandidates: ['pixel_5', 'pixel_4a', 'pixel_4'] },
  { name: 'tapflow-phone', deviceCandidates: ['pixel_7', 'pixel_6', 'pixel'] },
  { name: 'tapflow-large', deviceCandidates: ['pixel_7_pro', 'pixel_6_pro', 'pixel_4_xl'] },
  { name: 'tapflow-tablet', deviceCandidates: ['pixel_tablet', 'pixel_c', 'Nexus 10'] },
]

function androidSystemImage(): string {
  const abi = process.arch === 'arm64' ? 'arm64-v8a' : 'x86_64'
  return `system-images;${AVD_IMAGE_API};google_apis;${abi}`
}

function androidSystemImageDir(): string {
  return join(ANDROID_SDK_DIR, ...androidSystemImage().split(';'))
}

// 디바이스 부팅은 하지 않는다 — QA Session 접속 시 relay가 on-demand로 부팅한다.
// setup은 "부팅 가능한 디바이스/AVD가 준비된 상태"까지만 보장한다.

// confirm 후 sudo 명령들을 순차 실행(stdio 상속 → sudo가 비번 프롬프트를 직접 처리).
async function runSudo(message: string, commands: string[][]): Promise<boolean> {
  const proceed = await confirm({ message })
  if (isCancel(proceed) || !proceed) return false
  console.log()
  for (const args of commands) {
    const r = spawnSync('sudo', args, { stdio: 'inherit' })
    if (r.status !== 0) return false
  }
  return true
}

function isXcodeReady(): boolean {
  try {
    execSync('xcodebuild -version', { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

function hasIosDevice(): boolean {
  try {
    const raw = execSync('xcrun simctl list devices --json', { encoding: 'utf8', stdio: 'pipe' })
    const data = JSON.parse(raw) as { devices: Record<string, unknown[]> }
    return Object.values(data.devices).some((arr) => arr.length > 0)
  } catch {
    return false
  }
}

export interface SetupOptions {
  /**
   * `tapflow setup --yes`. Only the Windows Android flow reads it, and only for its own
   * download/install/create-AVD prompts; macOS, Linux, iOS and the network filter ignore it.
   */
  assumeYes?: boolean
}

export async function runSetupAndroid(opts: SetupOptions = {}): Promise<SetupStepResult[]> {
  // Windows has no Homebrew: winget/Temurin zip, Google's cmdline-tools zip, then the same SDK
  // packages and AVD set as below (setup-android-windows.ts). macOS and Linux are unchanged.
  if (process.platform === 'win32') return runSetupAndroidWindows(realWindowsDeps({ assumeYes: opts.assumeYes }))
  const results: SetupStepResult[] = []
  const brew = await checkAndFixHomebrew()
  results.push(brew)
  const jdk = await checkAndFixJdk(brew.ok)
  results.push(jdk)
  const sdk = await checkAndFixAndroidSdk(brew.ok, jdk.ok)
  results.push(sdk)
  results.push(await checkAndFixAvd(sdk.ok))
  return results
}

// sdkmanager/avdmanager는 SDK 위치를 ANDROID_HOME으로 알아야 한다(자기완결 SDK 기준).
function androidEnv(): NodeJS.ProcessEnv {
  return { ...process.env, ANDROID_HOME: ANDROID_SDK_DIR, ANDROID_SDK_ROOT: ANDROID_SDK_DIR }
}

const SDK_CMDLINE_BIN = join(ANDROID_SDK_DIR, 'cmdline-tools', 'latest', 'bin')

// Whether the SDK is self-contained: cmdline-tools inside the SDK, plus platform-tools (adb) and build-tools (aapt).
// Without build-tools (aapt), apk metadata extraction fails and builds are stored with no bundleId → not self-contained.
function sdkSelfContained(): boolean {
  return (
    existsSync(join(SDK_CMDLINE_BIN, 'sdkmanager')) &&
    existsSync(join(ANDROID_SDK_DIR, 'platform-tools', 'adb')) &&
    existsSync(join(ANDROID_SDK_DIR, 'emulator', 'emulator')) &&
    hasBuildToolsAapt() &&
    existsSync(androidSystemImageDir())
  )
}

// Any build-tools version with aapt is enough — same bar as the relay's findAapt and `tapflow doctor`.
// (setup still installs the pinned ANDROID_BUILD_TOOLS on a fresh SDK; an existing 34.x is not churned.)
function hasBuildToolsAapt(): boolean {
  const dir = join(ANDROID_SDK_DIR, 'build-tools')
  if (!existsSync(dir)) return false
  try {
    return readdirSync(dir).some((v) => existsSync(join(dir, v, 'aapt')))
  } catch {
    return false
  }
}

function hasJava(): boolean {
  try {
    execSync('/usr/libexec/java_home', { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

function whichSdkmanager(): string | null {
  try {
    const p = execSync('which sdkmanager', { encoding: 'utf8', stdio: 'pipe' }).trim()
    return p || null
  } catch {
    return null
  }
}

export async function runSetupIos(): Promise<SetupStepResult[]> {
  const results: SetupStepResult[] = []
  results.push(await checkAndFixHomebrew())
  const xcode = await checkAndFixXcode()
  results.push(xcode)
  results.push(await checkXcodeActivation(xcode.ok))
  results.push(await checkAndFixSimulator())
  results.push(await checkAndFixAudioPermission())
  results.push(await setUpNetFilter())
  return results
}

/**
 * The iOS network filter — the one part of the offline toggle a user has to install on the Mac.
 *
 * **Shares its whole implementation with `tapflow migrate net-filter`.** The two exist for different
 * people — this one for a first run, that one for an install that predates the feature — and a second
 * copy of the install logic is how those two answers drift apart. Everything below is presentation.
 *
 * An approval nobody gives, and a reboot, land as **pending**, so setup ends with `SETUP INCOMPLETE`
 * and names them. That is correct rather than unfortunate: until the extension is approved, iOS
 * network control does not work. It is also rare — the host binary waits two minutes for the
 * approval, and past that `followThroughApproval` offers the approval screen and finishes the install
 * once the switch is on, so the common path here is a plain success.
 *
 * **Asked for, like every other install in this file.** Written synchronously, this was the one step
 * that skipped the `isInteractive()` + `confirm()` its siblings all use — and it is the step that installs a
 * system extension seeing every flow the Mac attributes to a simulator, so it is the last one that
 * should install unasked. macOS puts its own approval dialog after this, but that dialog arrives with
 * no warning of what asked for it.
 */
function netFilterSkipped(): SetupStepResult {
  return {
    label: 'Network filter',
    ok: true,
    warn: true,
    detail: 'Skipped — iOS network control stays off until `tapflow migrate net-filter` installs it.',
  }
}

async function setUpNetFilter(): Promise<SetupStepResult> {
  // Asking about an install that would do nothing is noise, so the no-op case answers before the
  // prompt.
  //
  // **Both halves of the installer's condition, not just the version one.** This used to call
  // `isNetFilterCurrent` alone and describe itself as "the installer's own comparison, not a second
  // copy of it" — true when written, and false the moment `installNetFilter` started requiring the
  // filter to be running as well. A Mac left with a disabled filter matches on every version, so the
  // half that was missing is exactly the half that would have sent it to the install that repairs it.
  if (process.platform === 'darwin') {
    // **Reported here as well, because this probe is the one most people wait on.** It is the same
    // `systemextensionsctl` plus three `defaults read` that `installNetFilter` reports `checking`
    // for — bounded at 10s each — and on a Mac that is already set up this branch *returns*, so the
    // installer's own report is never reached and the step sat silent for up to 40 seconds.
    //
    // A Mac that needs work prints the line twice, once here and once inside the installer. That is
    // two probes and therefore two honest reports; the duplicate probe is older than this change and
    // is not fixed here.
    step(INSTALL_STAGE_MESSAGE.checking)
    if (isNetFilterCurrent(readNetFilterState()) && isFilterEnforcing()) {
      return { label: 'Network filter', ok: true, state: 'found' }
    }
  }
  if (process.platform === 'darwin') {
    if (!isInteractive()) {
      return {
        label: 'Network filter',
        ok: false,
        warn: true,
        detail: 'Run: tapflow migrate net-filter (skipped in non-interactive mode)',
      }
    }
    const proceed = await confirm({
      message: 'Install the tapflow network filter? It is a macOS system extension, needed for iOS network control, and macOS will ask you to approve it.',
    })
    if (isCancel(proceed) || !proceed) return netFilterSkipped()
  }
  // Printed as the install runs, ahead of the results list this runner prints when every step is
  // done — the same place the audio step already writes from.
  //
  // Reached only past the prompt above, so both ends are a terminal and the `interactive` check
  // inside the approval step agrees — the two read the same rule now. It stays because the approval
  // flow is also reached from `migrate net-filter`, which has no prompt in front of it.
  // A second question rather than a longer first one: the first is whether to install at all, this one
  // is whether to put a window on the screen and what switching the filter on costs.
  const deps = terminalApprovalDeps()
  const offer = await offerApprovalUpFront(deps)
  // The same answer as declining the install above: nothing has changed yet, and the step says how to
  // install it later.
  if (offer === 'cancelled') return netFilterSkipped()
  const installOpts: InstallOptions = {
    onProgress: (s) => step(INSTALL_STAGE_MESSAGE[s]), openApprovalSheet: offer === 'accepted',
  }
  let outcome = installNetFilter(installOpts)
  if (outcome.status === 'needs-approval') {
    outcome = await followThroughApproval(outcome, deps, installOpts, offer)
  }
  switch (outcome.status) {
    case 'installed':
      return { label: 'Network filter', ok: true, state: 'created' }
    case 'already-current':
      return { label: 'Network filter', ok: true, state: 'found' }
    case 'not-macos':
      // Reachable: `tapflow setup ios` runs this runner whatever the host is.
      return { label: 'Network filter', ok: true, warn: true, detail: 'macOS only — nothing to install here.' }
    case 'no-artifact':
      return {
        label: 'Network filter',
        ok: false,
        warn: true,
        detail: 'This tapflow install carries no usable filter app, so iOS network control cannot be set up. Reinstalling tapflow restores it.',
      }
    case 'installed-unconfirmed':
      // Installed, so setup did its job; unverified, so it must not report a clean state. `doctor ios`
      // asks the same question from the same place, which is why it is the thing to run next.
      return {
        label: 'Network filter',
        ok: false,
        warn: true,
        detail: `Installed, but no filter reported itself as running within ${CONFIRM_DEADLINE_MS / 1000} seconds. Check with \`tapflow doctor ios\`; if new connections on this Mac have stopped, run \`${NET_FILTER_APP}/Contents/MacOS/TapflowNetFilter --off\` to take the filter out of the path.`,
      }
    case 'refused-host-unknown':
      // The extension is enforcing and the app it came from is gone, so nothing says whether this
      // Mac's host binary is newer than the one here. Setup does not guess: it would be replacing a
      // working install for someone who is not at this keyboard.
      return {
        label: 'Network filter',
        ok: false,
        warn: true,
        detail: `Left alone — extension ${outcome.activated} is running but /Applications/TapflowNetFilter.app is gone, so tapflow cannot tell whether this Mac's filter is newer than this one. Reinstall from the tapflow whose version matches, or clear it: ${removalSteps().join('; ')}.`,
      }
    case 'refused-downgrade':
      // Not a failure of this machine: it is set up for a newer tapflow than this one.
      return {
        label: 'Network filter',
        ok: true,
        warn: true,
        detail: `Left alone — this Mac runs ${outcome.installed} and this tapflow carries ${outcome.shipped}. Upgrading this checkout is the fix; reinstalling the filter would break the newer one.`,
      }
    case 'refused-devices-busy':
      // Setup is not the place to force it: someone running `setup ios` is preparing a Mac, not
      // repairing one, and the devices in the list may be another person's session.
      if (outcome.filterLeftDisabled !== undefined) {
        // **After an approval this is not a skip.** The install has run; what was refused is switching
        // the filter on. A Mac left with it off has no iOS network control, and that is not `ok`.
        return {
          label: 'Network filter',
          ok: !outcome.filterLeftDisabled,
          warn: true,
          detail: `Approved, but not switched on — that drops connections this Mac has open, and these are running: ${outcome.busy.join(', ')}.${outcome.filterLeftDisabled ? ' The filter is switched OFF until then.' : ''} Stop them, then: tapflow migrate net-filter`,
        }
      }
      return {
        label: 'Network filter',
        ok: true,
        warn: true,
        detail: `Skipped — replacing it interrupts every new connection on this Mac, and these are running: ${outcome.busy.join(', ')}. Stop them, then: tapflow migrate net-filter`,
      }
    case 'needs-approval':
      return {
        label: 'Network filter',
        ok: false,
        warn: true,
        // The same instruction as `migrate`'s banner: whatever brought it here — the offer declined or
        // no switch within the wait — the filter is off, and a run after approving is what turns it on.
        detail: outcome.filterLeftDisabled
          ? `Installed, waiting for approval — and the filter is switched off until then. Open ${APPROVAL_PATH}, switch tapflow on, then run \`tapflow migrate net-filter\` to switch the filter on.`
          : `Installed, waiting for approval. Open ${APPROVAL_PATH}, switch tapflow on, then run \`tapflow migrate net-filter\`.`,
      }
    case 'needs-reboot':
      return {
        label: 'Network filter',
        ok: false,
        warn: true,
        detail: 'Installed. Restart the Mac to finish replacing the previous version — until then the old one keeps running.',
      }
    case 'failed':
      return {
        label: 'Network filter',
        ok: false,
        detail: outcome.filterLeftDisabled
          ? `The install did not finish (exit ${outcome.code}): ${outcome.detail}. The filter is switched OFF — your network works, iOS network control does not. Run \`tapflow migrate net-filter\` to turn it back on.`
          : `The install did not finish (exit ${outcome.code}): ${outcome.detail}`,
      }
  }
}

// iOS audio output (on by default) captures the simulator via a Core Audio process tap, which needs a
// one-time audio-recording TCC grant. `tapflow agent start` also primes it, but offering it here lets
// the operator grant it during setup. macOS 14.2+. Never fail setup over this opt-in extra.
async function checkAndFixAudioPermission(): Promise<SetupStepResult> {
  if (!isAudioSupported()) {
    return { label: 'Audio output', ok: true, warn: true, detail: 'Requires macOS 14.2+ — iOS audio output unavailable on this host.' }
  }
  if (!isInteractive()) {
    return { label: 'Audio permission', ok: true, warn: true, detail: '`tapflow agent start` will prompt for the audio-capture permission.' }
  }
  const proceed = await confirm({ message: 'Grant audio-capture permission now? (audio is on by default; one-time macOS prompt)' })
  if (isCancel(proceed) || !proceed) {
    return { label: 'Audio permission', ok: true, warn: true, detail: 'Skipped — `tapflow agent start` will prompt instead.' }
  }
  step('A macOS audio-recording prompt will appear — click Allow.')
  try {
    requestAudioPermission() // blocks until the prompt is answered (open -W)
  } catch (e) {
    return { label: 'Audio permission', ok: true, warn: true, detail: `Could not launch the permission helper (${e instanceof Error ? e.message : String(e)}); audio output may be unavailable.` }
  }
  return { label: 'Audio permission requested', ok: true, state: 'created' }
}

async function checkAndFixXcode(): Promise<SetupStepResult> {
  if (findXcodeApp()) {
    return { label: 'Xcode installed', ok: true, state: 'found' }
  }
  // The CLI cannot install Xcode. It comes from the App Store or from developer.apple.com as a .xip.
  if (!isInteractive()) {
    return {
      label: 'Xcode',
      ok: false,
      warn: true,
      detail: `Install Xcode from the App Store: ${XCODE_APPSTORE}`,
    }
  }
  step('tapflow cannot install Xcode itself. Get it from the App Store, or from https://developer.apple.com/xcode/.')
  const openPrompt = await text({ message: 'Press Enter to open the App Store…' })
  if (isCancel(openPrompt)) {
    return {
      label: 'Xcode',
      ok: false,
      warn: true,
      detail: 'Cancelled. Install Xcode from the App Store and re-run `tapflow setup ios`.',
    }
  }
  spawnSync('open', ['macappstores://apps.apple.com/app/xcode/id497799835'], { stdio: 'ignore' })
  const continuePrompt = await text({ message: 'Install Xcode, then press Enter to continue…' })
  if (isCancel(continuePrompt)) {
    return {
      label: 'Xcode',
      ok: false,
      warn: true,
      detail: 'Cancelled. Re-run `tapflow setup ios` after installing Xcode.',
    }
  }
  if (findXcodeApp()) {
    return { label: 'Xcode installed', ok: true, state: 'created' }
  }
  return {
    label: 'Xcode',
    ok: false,
    warn: true,
    detail: 'Xcode not detected yet. Re-run `tapflow setup ios` after installing.',
  }
}

// 설치됨 ≠ 사용 가능: active developer dir / 라이선스 / first-launch. sudo 조치를 동의 후 직접 실행.
async function checkXcodeActivation(xcodeInstalled: boolean): Promise<SetupStepResult> {
  if (!xcodeInstalled) {
    return { label: 'Xcode activation', ok: false, warn: true, detail: 'Install Xcode first.' }
  }
  const developerDir = `${findXcodeApp() ?? DEFAULT_XCODE_APP}/Contents/Developer`
  const selectHint = `Run: sudo xcode-select -s ${shellQuote(developerDir)}`
  // 이번 실행에서 sudo로 재구성한 적이 있으면 found가 아니라 repaired로 보고한다.
  let repaired = false

  // 1. Point the active developer dir into an Xcode bundle, whatever the bundle is named.
  if (!selectedXcodeApp()) {
    if (!isInteractive()) {
      return { label: 'Xcode command-line tools', ok: false, warn: true, detail: selectHint }
    }
    const ok = await runSudo('Set Xcode as the active developer directory (needs sudo)?', [
      ['xcode-select', '-s', developerDir],
    ])
    if (!ok) {
      return { label: 'Xcode command-line tools', ok: false, warn: true, detail: selectHint }
    }
    repaired = true
  }

  // 2. license / first-launch
  if (isXcodeReady()) {
    return { label: 'Xcode ready', ok: true, state: repaired ? 'repaired' : 'found' }
  }
  const finishHint = 'Finish Xcode setup: sudo xcodebuild -license accept && sudo xcodebuild -runFirstLaunch'
  if (!isInteractive()) {
    return { label: 'Xcode setup', ok: false, warn: true, detail: finishHint }
  }
  const ok = await runSudo('Accept the Xcode license and run first launch (needs sudo)?', [
    ['xcodebuild', '-license', 'accept'],
    ['xcodebuild', '-runFirstLaunch'],
  ])
  if (ok && isXcodeReady()) {
    return { label: 'Xcode ready', ok: true, state: 'repaired' }
  }
  return { label: 'Xcode setup', ok: false, warn: true, detail: finishHint }
}

// 부팅하지 않는다 — 시뮬 런타임/디바이스가 준비됐는지만 보장(없으면 런타임 설치).
async function checkAndFixSimulator(): Promise<SetupStepResult> {
  if (hasIosDevice()) {
    return { label: 'Simulator ready', ok: true, state: 'found' }
  }
  const hint = 'No simulator runtime. Run: xcodebuild -downloadPlatform iOS (or install one in Xcode).'
  if (!isInteractive()) {
    return { label: 'Simulator', ok: false, warn: true, detail: hint }
  }
  const proceed = await confirm({ message: 'No iOS simulator found. Download the iOS simulator runtime?' })
  if (isCancel(proceed) || !proceed) {
    return { label: 'Simulator', ok: false, warn: true, detail: `Skipped. ${hint}` }
  }
  console.log()
  const r = spawnSync('xcodebuild', ['-downloadPlatform', 'iOS'], { stdio: 'inherit' })
  if (r.status === 0 && hasIosDevice()) {
    return { label: 'Simulator runtime installed', ok: true, state: 'created' }
  }
  return { label: 'Simulator', ok: false, warn: true, detail: 'Could not prepare a simulator. Open Xcode to install a runtime.' }
}

// eval "$(...)"로 감싸 명령 치환 결과(설치 스크립트)가 word splitting 없이 단일 평가되게 한다.
const HOMEBREW_INSTALL =
  'eval "$(/usr/bin/curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'

async function checkAndFixHomebrew(): Promise<SetupStepResult> {
  try {
    execSync('which brew', { stdio: 'pipe' })
    return { label: 'Homebrew installed', ok: true, state: 'found' }
  } catch {
    // 미설치 — 아래에서 확인 후 설치
  }
  // 원격 스크립트 자동 실행은 명시적 동의가 있을 때만. 비대화형이면 안내만.
  if (!isInteractive()) {
    return {
      label: 'Homebrew',
      ok: false,
      warn: true,
      detail: 'Install Homebrew: https://brew.sh (skipped in non-interactive mode)',
    }
  }
  const proceed = await confirm({
    message: 'Homebrew not found. Install it now via the official script? (may prompt for sudo)',
  })
  if (isCancel(proceed) || !proceed) {
    return { label: 'Homebrew', ok: false, warn: true, detail: 'Skipped. Install Homebrew: https://brew.sh' }
  }
  console.log()
  const r = spawnSync('/bin/bash', ['-c', HOMEBREW_INSTALL], { stdio: 'inherit' })
  if (r.status === 0) {
    // 방금 설치한 brew는 현재 프로세스 PATH에 아직 없을 수 있다(셸 재시작 전).
    return {
      label: 'Homebrew installed',
      ok: true,
      state: 'created',
      detail: "If later steps can't find brew, open a new terminal and re-run tapflow setup.",
    }
  }
  return {
    label: 'Homebrew',
    ok: false,
    warn: true,
    detail: 'Homebrew install failed. Install manually: https://brew.sh',
  }
}

// sdkmanager/avdmanager 실행에 JDK가 필요하다(없으면 'Unable to locate a Java Runtime').
async function checkAndFixJdk(brewAvailable: boolean): Promise<SetupStepResult> {
  if (hasJava()) {
    return { label: 'Java (JDK)', ok: true, state: 'found' }
  }
  if (!brewAvailable) {
    return { label: 'Java (JDK)', ok: false, detail: 'Install Homebrew first, then: brew install --cask temurin' }
  }
  if (!isInteractive()) {
    return { label: 'Java (JDK)', ok: false, warn: true, detail: 'Run: brew install --cask temurin (skipped in non-interactive mode)' }
  }
  const proceed = await confirm({
    message: 'A JDK is required for the Android SDK tools. Install Temurin now? (may prompt for sudo)',
  })
  if (isCancel(proceed) || !proceed) {
    return { label: 'Java (JDK)', ok: false, warn: true, detail: 'Skipped. Install: brew install --cask temurin' }
  }
  console.log()
  const r = spawnSync('brew', ['install', '--cask', 'temurin'], { stdio: 'inherit' })
  if (r.status === 0 && hasJava()) {
    return { label: 'Java (JDK) installed', ok: true, state: 'created' }
  }
  return { label: 'Java (JDK)', ok: false, detail: 'JDK install failed. Install manually: brew install --cask temurin' }
}

// Android SDK를 ~/Library/Android/sdk에 자기완결로 구성한다(Android Studio GUI 불필요).
async function checkAndFixAndroidSdk(brewAvailable: boolean, javaOk: boolean): Promise<SetupStepResult> {
  if (sdkSelfContained()) {
    const adb = resolveAdb()
    const reg = registerAndroidEnv()
    const needsLiveShellRefresh = Boolean(reg && !reg.added && adb && !adb.inPath)
    const detail = reg && (reg.added || needsLiveShellRefresh) ? newShellHint(reg.file) : undefined
    return {
      label: 'Android SDK ready',
      ok: true,
      state: reg?.added ? 'repaired' : 'found',
      detail,
    }
  }
  if (!javaOk) {
    return { label: 'Android SDK', ok: false, detail: 'Install a JDK first (Android SDK tools need Java).' }
  }

  // 부트스트랩 sdkmanager 확보: SDK 내부 → PATH(brew) → brew 설치
  let bootSdkmanager = existsSync(join(SDK_CMDLINE_BIN, 'sdkmanager'))
    ? join(SDK_CMDLINE_BIN, 'sdkmanager')
    : whichSdkmanager()
  if (!bootSdkmanager) {
    if (!brewAvailable) {
      return { label: 'Android SDK', ok: false, detail: 'Install Homebrew first, then: brew install --cask android-commandlinetools' }
    }
    if (!isInteractive()) {
      return { label: 'Android SDK', ok: false, warn: true, detail: 'Run: brew install --cask android-commandlinetools (skipped in non-interactive mode)' }
    }
    console.log()
    const b = spawnSync('brew', ['install', '--cask', 'android-commandlinetools'], { stdio: 'inherit' })
    if (b.status !== 0) {
      return { label: 'Android SDK', ok: false, detail: 'Failed to install android-commandlinetools.' }
    }
    bootSdkmanager = whichSdkmanager() ?? 'sdkmanager'
  }

  if (!isInteractive()) {
    return { label: 'Android SDK', ok: false, warn: true, detail: 'Android SDK not installed (skipped in non-interactive mode).' }
  }

  // 자기완결 SDK 구성: cmdline-tools를 SDK 안에 넣어 이후 SDK 내부 바이너리만 쓰게 한다.
  console.log()
  const root = `--sdk_root=${ANDROID_SDK_DIR}`
  const licenseInput = 'y\n'.repeat(50)
  spawnSync(bootSdkmanager, [root, '--licenses'], { stdio: ['pipe', 'inherit', 'inherit'], input: licenseInput })
  const inst = spawnSync(
    bootSdkmanager,
    [root, 'cmdline-tools;latest', 'platform-tools', 'emulator', `build-tools;${ANDROID_BUILD_TOOLS}`, androidSystemImage()],
    { stdio: ['pipe', 'inherit', 'inherit'], input: licenseInput },
  )
  if (inst.status !== 0 || !sdkSelfContained()) {
    return { label: 'Android SDK', ok: false, detail: 'Failed to set up the Android SDK.' }
  }
  const reg = registerAndroidEnv()
  return {
    label: 'Android SDK installed',
    ok: true,
    state: 'created',
    detail: `SDK at ${ANDROID_SDK_DIR}.${reg?.added ? ` ${newShellHint(reg.file)}` : ''}`,
  }
}

// env가 rc에 있지만 현재 쉘엔 반영 안 된 경우의 안내. cmdSetup이 이 문구('new terminal')를 감지해 배너 뒤에 강조한다.
function newShellHint(file: string): string {
  const shell = file.endsWith('.zshrc') ? 'zsh' : file.endsWith('.bashrc') ? 'bash' : '$SHELL'
  return `ANDROID_HOME/PATH is configured in ${file} — open a new terminal (or run: exec ${shell}) to use them.`
}

// 부팅하지 않는다 — AVD가 준비됐는지만 보장(없으면 폼팩터별 AVD 생성). 시스템 이미지는 SDK 단계에서 설치됨.
async function checkAndFixAvd(sdkOk: boolean): Promise<SetupStepResult> {
  if (!sdkOk) {
    return { label: 'AVD', ok: false, detail: 'Set up the Android SDK first.' }
  }
  const avds = listAvds()
  if (avds.length > 0) {
    return { label: `AVD ready: ${avds.length} device(s)`, ok: true, state: 'found' }
  }
  const manualHint = 'Create an AVD with avdmanager (see Android docs).'
  if (!isInteractive()) {
    return { label: 'AVD', ok: false, warn: true, detail: `No AVD found. ${manualHint}` }
  }
  const proceed = await confirm({ message: 'No Android Virtual Device found. Create a set of AVDs now?' })
  if (isCancel(proceed) || !proceed) {
    return { label: 'AVD', ok: false, warn: true, detail: `Skipped. ${manualHint}` }
  }
  const result = createAvds()
  if (result.ok) {
    return { label: `AVDs created: ${result.created.join(', ')}`, ok: true, state: 'created' }
  }
  return { label: 'AVD', ok: false, warn: true, detail: result.detail ?? manualHint }
}

function listAvds(): string[] {
  const emulator = join(ANDROID_SDK_DIR, 'emulator', 'emulator')
  if (!existsSync(emulator)) return []
  try {
    const r = spawnSync(emulator, ['-list-avds'], { encoding: 'utf8', env: androidEnv() })
    const out = (r.stdout ?? '').trim()
    return out ? out.split('\n').map((l) => l.trim()).filter(Boolean) : []
  } catch {
    return []
  }
}

function createAvds(): { ok: boolean; created: string[]; detail?: string } {
  const avdmanager = join(SDK_CMDLINE_BIN, 'avdmanager')
  if (!existsSync(avdmanager)) {
    return { ok: false, created: [], detail: 'Android cmdline-tools not found in the SDK.' }
  }
  const image = androidSystemImage()
  // 폼팩터별로 가용한 device id를 골라 AVD 생성. ('custom hardware profile?'에 'no')
  const available = listDeviceIds(avdmanager)
  const created: string[] = []
  console.log()
  for (const spec of AVD_SPECS) {
    const device = spec.deviceCandidates.find((d) => available.includes(d))
    if (!device) continue
    const r = spawnSync(
      avdmanager,
      ['create', 'avd', '-n', spec.name, '-k', image, '-d', device, '--force'],
      { stdio: ['pipe', 'inherit', 'inherit'], input: 'no\n', env: androidEnv() },
    )
    if (r.status === 0) created.push(spec.name)
  }
  if (created.length === 0) {
    return { ok: false, created, detail: 'Could not create any AVD.' }
  }
  return { ok: true, created }
}

function listDeviceIds(avdmanager: string): string[] {
  try {
    const r = spawnSync(avdmanager, ['list', 'device'], { encoding: 'utf8', env: androidEnv() })
    const out = r.stdout ?? ''
    const ids: string[] = []
    for (const m of out.matchAll(/id:\s*\d+\s+or\s+"([^"]+)"/g)) {
      if (m[1]) ids.push(m[1])
    }
    return ids
  } catch {
    return []
  }
}

// 자동 등록을 지원하는 셸의 rc 경로. 그 외 셸은 null(수동 안내).
function shellRcPath(): string | null {
  const shell = process.env.SHELL ?? ''
  const home = homedir()
  if (shell.includes('zsh')) return join(home, '.zshrc')
  if (shell.includes('bash')) return join(home, '.bashrc')
  return null
}

// ANDROID_HOME + platform-tools/emulator PATH를 rc에 멱등 등록(마커 블록).
function registerAndroidEnv(): { added: boolean; file: string } | null {
  const file = shellRcPath()
  if (!file) return null
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : ''
  if (existing.includes(PATH_MARKER_START)) {
    return { added: false, file }
  }
  const block =
    `\n${PATH_MARKER_START}\n` +
    `export ANDROID_HOME="${ANDROID_SDK_DIR}"\n` +
    `export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"\n` +
    `${PATH_MARKER_END}\n`
  appendFileSync(file, block)
  return { added: true, file }
}
