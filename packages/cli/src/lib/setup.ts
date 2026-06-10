import { execSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { confirm, text, isCancel } from '@clack/prompts'
import { type DoctorCheck } from './doctor.js'
import { step } from './print.js'

// setup 단계 결과는 진단 결과(DoctorCheck)와 같은 형태를 쓴다.
// ok=true: 이미 OK이거나 방금 자동 수정함, warn=true: 수동 조치 필요(안내).
export type SetupStepResult = DoctorCheck

const PATH_MARKER_START = '# >>> tapflow android sdk >>>'
const PATH_MARKER_END = '# <<< tapflow android sdk <<<'
// SDK를 표준 경로에 자기완결로 고정한다(cmdline-tools·platform-tools·emulator·system-image 모두 이 아래).
const ANDROID_SDK_DIR = join(homedir(), 'Library', 'Android', 'sdk')
const XCODE_APP = '/Applications/Xcode.app'
const XCODE_APPSTORE = 'https://apps.apple.com/app/xcode/id497799835'
const XCODE_DEVELOPER_DIR = '/Applications/Xcode.app/Contents/Developer'
// Play Store 이미지는 crash 이슈가 있어 google_apis(non-playstore)를 쓴다.
const AVD_IMAGE_API = 'android-35'
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

// cmdline-tools가 SDK 안에 있고 platform-tools(adb)까지 갖춘 자기완결 상태인지.
function sdkSelfContained(): boolean {
  return existsSync(join(SDK_CMDLINE_BIN, 'sdkmanager')) && existsSync(join(ANDROID_SDK_DIR, 'platform-tools', 'adb'))
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

// sdkmanager/avdmanager 실행에 JDK가 필요하다(없으면 'Unable to locate a Java Runtime').
async function checkAndFixJdk(brewAvailable: boolean): Promise<SetupStepResult> {
  if (hasJava()) {
    return { label: 'Java (JDK)', ok: true }
  }
  if (!brewAvailable) {
    return { label: 'Java (JDK)', ok: false, detail: 'Install Homebrew first, then: brew install --cask temurin' }
  }
  if (!process.stdout.isTTY) {
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
    return { label: 'Java (JDK) installed', ok: true }
  }
  return { label: 'Java (JDK)', ok: false, detail: 'JDK install failed. Install manually: brew install --cask temurin' }
}

// Android SDK를 ~/Library/Android/sdk에 자기완결로 구성한다(Android Studio GUI 불필요).
async function checkAndFixAndroidSdk(brewAvailable: boolean, javaOk: boolean): Promise<SetupStepResult> {
  if (sdkSelfContained()) {
    const reg = registerAndroidEnv()
    return {
      label: 'Android SDK ready',
      ok: true,
      detail: reg?.added ? `Registered ANDROID_HOME/PATH in ${reg.file}.` : undefined,
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
    if (!process.stdout.isTTY) {
      return { label: 'Android SDK', ok: false, warn: true, detail: 'Run: brew install --cask android-commandlinetools (skipped in non-interactive mode)' }
    }
    console.log()
    const b = spawnSync('brew', ['install', '--cask', 'android-commandlinetools'], { stdio: 'inherit' })
    if (b.status !== 0) {
      return { label: 'Android SDK', ok: false, detail: 'Failed to install android-commandlinetools.' }
    }
    bootSdkmanager = whichSdkmanager() ?? 'sdkmanager'
  }

  if (!process.stdout.isTTY) {
    return { label: 'Android SDK', ok: false, warn: true, detail: 'Android SDK not installed (skipped in non-interactive mode).' }
  }

  // 자기완결 SDK 구성: cmdline-tools를 SDK 안에 넣어 이후 SDK 내부 바이너리만 쓰게 한다.
  console.log()
  const root = `--sdk_root=${ANDROID_SDK_DIR}`
  const licenseInput = 'y\n'.repeat(50)
  spawnSync(bootSdkmanager, [root, '--licenses'], { stdio: ['pipe', 'inherit', 'inherit'], input: licenseInput })
  const inst = spawnSync(
    bootSdkmanager,
    [root, 'cmdline-tools;latest', 'platform-tools', 'emulator', androidSystemImage()],
    { stdio: ['pipe', 'inherit', 'inherit'], input: licenseInput },
  )
  if (inst.status !== 0 || !sdkSelfContained()) {
    return { label: 'Android SDK', ok: false, detail: 'Failed to set up the Android SDK.' }
  }
  const reg = registerAndroidEnv()
  return {
    label: 'Android SDK installed',
    ok: true,
    detail: `SDK at ${ANDROID_SDK_DIR}.${reg?.added ? ` Restart your shell to pick up ANDROID_HOME/PATH (${reg.file}).` : ''}`,
  }
}

// 부팅하지 않는다 — AVD가 준비됐는지만 보장(없으면 폼팩터별 AVD 생성). 시스템 이미지는 SDK 단계에서 설치됨.
async function checkAndFixAvd(sdkOk: boolean): Promise<SetupStepResult> {
  if (!sdkOk) {
    return { label: 'AVD', ok: false, detail: 'Set up the Android SDK first.' }
  }
  const avds = listAvds()
  if (avds.length > 0) {
    return { label: `AVD ready: ${avds.length} device(s)`, ok: true }
  }
  const manualHint = 'Create an AVD with avdmanager (see Android docs).'
  if (!process.stdout.isTTY) {
    return { label: 'AVD', ok: false, warn: true, detail: `No AVD found. ${manualHint}` }
  }
  const proceed = await confirm({ message: 'No Android Virtual Device found. Create a set of AVDs now?' })
  if (isCancel(proceed) || !proceed) {
    return { label: 'AVD', ok: false, warn: true, detail: `Skipped. ${manualHint}` }
  }
  const result = createAvds()
  if (result.ok) {
    return { label: `AVDs created: ${result.created.join(', ')}`, ok: true }
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
