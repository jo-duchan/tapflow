import { execSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { confirm, text, isCancel } from '@clack/prompts'
import { resolveAdb, type DoctorCheck } from './doctor.js'
import { createSpinner, step } from './print.js'

// setup 단계 결과는 진단 결과(DoctorCheck)와 같은 형태를 쓴다.
// ok=true: 이미 OK이거나 방금 자동 수정함, warn=true: 수동 조치 필요(안내).
export type SetupStepResult = DoctorCheck

const PATH_MARKER_START = '# >>> tapflow android sdk >>>'
const PATH_MARKER_END = '# <<< tapflow android sdk <<<'
const STUDIO_APP = '/Applications/Android Studio.app'
const XCODE_APP = '/Applications/Xcode.app'
const XCODE_APPSTORE = 'https://apps.apple.com/app/xcode/id497799835'
const XCODE_DEVELOPER_DIR = '/Applications/Xcode.app/Contents/Developer'
const AVD_NAME = 'tapflow'
const ANDROID_SYSTEM_IMAGE = 'system-images;android-35;google_apis;arm64-v8a'
const AVD_DEVICE = 'pixel_7'

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

export async function runSetupAndroid(): Promise<SetupStepResult[]> {
  const results: SetupStepResult[] = []
  const brew = await checkAndFixHomebrew()
  results.push(brew)
  results.push(checkAndFixAdb(brew.ok))
  results.push(await checkAndFixAndroidStudio(brew.ok))
  results.push(await checkAndFixAvd())
  return results
}

export async function runSetupIos(): Promise<SetupStepResult[]> {
  const results: SetupStepResult[] = []
  results.push(await checkAndFixHomebrew())
  const xcode = await checkAndFixXcode()
  results.push(xcode)
  results.push(await checkXcodeActivation(xcode.ok))
  results.push(await checkAndFixSimulator())
  return results
}

async function checkAndFixXcode(): Promise<SetupStepResult> {
  if (existsSync(XCODE_APP)) {
    return { label: 'Xcode installed', ok: true }
  }
  // Xcode는 App Store에서만 설치 가능 — CLI가 직접 설치할 수 없다.
  if (!process.stdout.isTTY) {
    return {
      label: 'Xcode',
      ok: false,
      warn: true,
      detail: `Install Xcode from the App Store: ${XCODE_APPSTORE}`,
    }
  }
  step('Xcode can only be installed from the App Store.')
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
  if (existsSync(XCODE_APP)) {
    return { label: 'Xcode installed', ok: true }
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
  const selectHint = `Run: sudo xcode-select -s ${XCODE_DEVELOPER_DIR}`

  // 1. active developer dir이 Xcode를 가리키게
  let dir = ''
  try {
    dir = execSync('xcode-select -p', { encoding: 'utf8', stdio: 'pipe' }).trim()
  } catch {
    // 미설정 — 아래에서 조치
  }
  if (!dir.includes('Xcode.app')) {
    if (!process.stdout.isTTY) {
      return { label: 'Xcode command-line tools', ok: false, warn: true, detail: selectHint }
    }
    const ok = await runSudo('Set Xcode as the active developer directory (needs sudo)?', [
      ['xcode-select', '-s', XCODE_DEVELOPER_DIR],
    ])
    if (!ok) {
      return { label: 'Xcode command-line tools', ok: false, warn: true, detail: selectHint }
    }
  }

  // 2. license / first-launch
  if (isXcodeReady()) {
    return { label: 'Xcode ready', ok: true }
  }
  const finishHint = 'Finish Xcode setup: sudo xcodebuild -license accept && sudo xcodebuild -runFirstLaunch'
  if (!process.stdout.isTTY) {
    return { label: 'Xcode setup', ok: false, warn: true, detail: finishHint }
  }
  const ok = await runSudo('Accept the Xcode license and run first launch (needs sudo)?', [
    ['xcodebuild', '-license', 'accept'],
    ['xcodebuild', '-runFirstLaunch'],
  ])
  if (ok && isXcodeReady()) {
    return { label: 'Xcode ready', ok: true }
  }
  return { label: 'Xcode setup', ok: false, warn: true, detail: finishHint }
}

// 부팅하지 않는다 — 시뮬 런타임/디바이스가 준비됐는지만 보장(없으면 런타임 설치).
async function checkAndFixSimulator(): Promise<SetupStepResult> {
  if (hasIosDevice()) {
    return { label: 'Simulator ready', ok: true }
  }
  const hint = 'No simulator runtime. Run: xcodebuild -downloadPlatform iOS (or install one in Xcode).'
  if (!process.stdout.isTTY) {
    return { label: 'Simulator', ok: false, warn: true, detail: hint }
  }
  const proceed = await confirm({ message: 'No iOS simulator found. Download the iOS simulator runtime?' })
  if (isCancel(proceed) || !proceed) {
    return { label: 'Simulator', ok: false, warn: true, detail: `Skipped. ${hint}` }
  }
  console.log()
  const r = spawnSync('xcodebuild', ['-downloadPlatform', 'iOS'], { stdio: 'inherit' })
  if (r.status === 0 && hasIosDevice()) {
    return { label: 'Simulator runtime installed', ok: true }
  }
  return { label: 'Simulator', ok: false, warn: true, detail: 'Could not prepare a simulator. Open Xcode to install a runtime.' }
}

// eval "$(...)"로 감싸 명령 치환 결과(설치 스크립트)가 word splitting 없이 단일 평가되게 한다.
const HOMEBREW_INSTALL =
  'eval "$(/usr/bin/curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'

async function checkAndFixHomebrew(): Promise<SetupStepResult> {
  try {
    execSync('which brew', { stdio: 'pipe' })
    return { label: 'Homebrew installed', ok: true }
  } catch {
    // 미설치 — 아래에서 확인 후 설치
  }
  // 원격 스크립트 자동 실행은 명시적 동의가 있을 때만. 비대화형이면 안내만.
  if (!process.stdout.isTTY) {
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

function checkAndFixAdb(brewAvailable: boolean): SetupStepResult {
  const adb = resolveAdb()

  // 1. PATH에 있음
  if (adb?.inPath) {
    return { label: `adb in PATH: ${adb.path}`, ok: true }
  }

  // 2. 표준 SDK 위치엔 있지만 PATH에 없음 → shell rc에 등록
  if (adb) {
    const platformTools = dirname(adb.path)
    const registered = registerPathInShellRc(platformTools)
    if (!registered) {
      return {
        label: 'adb (not in PATH)',
        ok: false,
        warn: true,
        detail: `adb found at ${adb.path} but your shell ($SHELL) isn't auto-configurable. Add to your shell config: export PATH="${platformTools}:$PATH"`,
      }
    }
    if (registered.added) {
      return {
        label: 'adb added to PATH',
        ok: true,
        detail: `Added ${platformTools} to PATH in ${registered.file}. Restart your shell or run: source ${registered.file}`,
      }
    }
    return {
      label: 'adb PATH already configured',
      ok: true,
      detail: `${platformTools} already registered in ${registered.file}`,
    }
  }

  // 3. 어디에도 없음 → brew 설치
  if (!brewAvailable) {
    return {
      label: 'adb',
      ok: false,
      warn: true,
      detail: 'Install Homebrew first, then: brew install android-platform-tools',
    }
  }
  const spinner = createSpinner('Installing android-platform-tools via Homebrew…')
  spinner.start()
  const r = spawnSync('brew', ['install', 'android-platform-tools'], { stdio: 'pipe' })
  spinner.stop(r.status === 0)
  if (r.status === 0) {
    return { label: 'adb installed via Homebrew', ok: true }
  }
  return {
    label: 'adb',
    ok: false,
    warn: true,
    detail: 'brew install android-platform-tools failed. Install manually.',
  }
}

async function checkAndFixAndroidStudio(brewAvailable: boolean): Promise<SetupStepResult> {
  if (existsSync(STUDIO_APP)) {
    return { label: 'Android Studio installed', ok: true }
  }
  if (!brewAvailable) {
    return {
      label: 'Android Studio',
      ok: false,
      warn: true,
      detail: 'Install from https://developer.android.com/studio',
    }
  }
  // 대용량(~1GB+)이라 확인 후 설치. 비대화형이면 안내만.
  if (!process.stdout.isTTY) {
    return {
      label: 'Android Studio',
      ok: false,
      warn: true,
      detail: 'Run: brew install --cask android-studio (skipped in non-interactive mode)',
    }
  }
  const proceed = await confirm({ message: 'Install Android Studio (~1GB) via Homebrew?' })
  if (isCancel(proceed) || !proceed) {
    return {
      label: 'Android Studio',
      ok: false,
      warn: true,
      detail: 'Skipped. Run: brew install --cask android-studio',
    }
  }
  const spinner = createSpinner('Installing Android Studio via Homebrew…')
  spinner.start()
  const r = spawnSync('brew', ['install', '--cask', 'android-studio'], { stdio: 'pipe' })
  spinner.stop(r.status === 0)
  if (r.status === 0) {
    return { label: 'Android Studio installed via Homebrew', ok: true }
  }
  return {
    label: 'Android Studio',
    ok: false,
    warn: true,
    detail: 'brew install --cask android-studio failed. Install manually.',
  }
}

// 부팅하지 않는다 — AVD가 하나라도 준비됐는지만 보장(없으면 시스템 이미지 + AVD 생성).
async function checkAndFixAvd(): Promise<SetupStepResult> {
  const avds = listAvds()
  if (avds.length > 0) {
    return { label: `AVD ready: ${avds[0]}`, ok: true }
  }
  const manualHint = 'Create an AVD in Android Studio > Device Manager.'
  if (!process.stdout.isTTY) {
    return { label: 'AVD', ok: false, warn: true, detail: `No AVD found. ${manualHint}` }
  }
  const proceed = await confirm({
    message: 'No Android Virtual Device found. Create one now? (downloads a system image)',
  })
  if (isCancel(proceed) || !proceed) {
    return { label: 'AVD', ok: false, warn: true, detail: `Skipped. ${manualHint}` }
  }
  const created = createAvd()
  if (created.ok) {
    return { label: `AVD created: ${created.name}`, ok: true }
  }
  return { label: 'AVD', ok: false, warn: true, detail: created.detail ?? manualHint }
}

function listAvds(): string[] {
  try {
    const out = execSync('emulator -list-avds', { encoding: 'utf8', stdio: 'pipe' }).trim()
    return out ? out.split('\n').map((l) => l.trim()).filter(Boolean) : []
  } catch {
    return []
  }
}

function resolveAndroidSdk(): string | null {
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    join(homedir(), 'Library', 'Android', 'sdk'), // macOS
    join(homedir(), 'Android', 'Sdk'), // Linux
  ]
  for (const c of candidates) {
    if (c && existsSync(c)) return c
  }
  return null
}

function createAvd(): { ok: boolean; name?: string; detail?: string } {
  const sdk = resolveAndroidSdk()
  if (!sdk) {
    return { ok: false, detail: 'Android SDK not found. Install it via Android Studio.' }
  }
  const bin = join(sdk, 'cmdline-tools', 'latest', 'bin')
  const sdkmanager = join(bin, 'sdkmanager')
  const avdmanager = join(bin, 'avdmanager')
  if (!existsSync(sdkmanager) || !existsSync(avdmanager)) {
    return {
      ok: false,
      detail: 'Android command-line tools not found. Install "Android SDK Command-line Tools" in Android Studio > SDK Manager.',
    }
  }
  console.log()
  // 시스템 이미지 설치 (라이선스는 'y' 입력으로 동의)
  const img = spawnSync(sdkmanager, [ANDROID_SYSTEM_IMAGE], { stdio: 'inherit', input: 'y\n' })
  if (img.status !== 0) {
    return { ok: false, detail: `Failed to install ${ANDROID_SYSTEM_IMAGE}.` }
  }
  // AVD 생성 ('custom hardware profile?'에 'no' 입력)
  const create = spawnSync(
    avdmanager,
    ['create', 'avd', '-n', AVD_NAME, '-k', ANDROID_SYSTEM_IMAGE, '-d', AVD_DEVICE, '--force'],
    { stdio: 'inherit', input: 'no\n' },
  )
  if (create.status !== 0) {
    return { ok: false, detail: 'avdmanager create failed.' }
  }
  return { ok: true, name: AVD_NAME }
}

// 자동 등록을 지원하는 셸의 rc 경로. 그 외 셸은 null(수동 안내).
function shellRcPath(): string | null {
  const shell = process.env.SHELL ?? ''
  const home = homedir()
  if (shell.includes('zsh')) return join(home, '.zshrc')
  if (shell.includes('bash')) return join(home, '.bashrc')
  return null
}

function registerPathInShellRc(platformTools: string): { added: boolean; file: string } | null {
  const file = shellRcPath()
  if (!file) return null
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : ''
  if (existing.includes(PATH_MARKER_START)) {
    return { added: false, file }
  }
  const block = `\n${PATH_MARKER_START}\nexport PATH="${platformTools}:$PATH"\n${PATH_MARKER_END}\n`
  appendFileSync(file, block)
  return { added: true, file }
}
