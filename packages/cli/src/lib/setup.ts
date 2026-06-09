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

export async function runSetupAndroid(): Promise<SetupStepResult[]> {
  const results: SetupStepResult[] = []
  const brew = await checkAndFixHomebrew()
  results.push(brew)
  results.push(checkAndFixAdb(brew.ok))
  results.push(await checkAndFixAndroidStudio(brew.ok))
  results.push(checkAndFixEmulator())
  return results
}

export async function runSetupIos(): Promise<SetupStepResult[]> {
  const results: SetupStepResult[] = []
  results.push(await checkAndFixHomebrew())
  const xcode = await checkAndFixXcode()
  results.push(xcode)
  results.push(checkXcodeActivation(xcode.ok))
  results.push(checkAndFixSimulator())
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
  await text({ message: 'Press Enter to open the App Store…' })
  spawnSync('open', [`macappstores://apps.apple.com/app/xcode/id497799835`], { stdio: 'ignore' })
  await text({ message: 'Install Xcode, then press Enter to continue…' })
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

// 설치됨 ≠ 사용 가능: active developer dir / 라이선스 / first-launch를 점검(sudo 작업은 안내만).
function checkXcodeActivation(xcodeInstalled: boolean): SetupStepResult {
  if (!xcodeInstalled) {
    return { label: 'Xcode activation', ok: false, warn: true, detail: 'Install Xcode first.' }
  }
  let dir = ''
  try {
    dir = execSync('xcode-select -p', { encoding: 'utf8', stdio: 'pipe' }).trim()
  } catch {
    // active dir 미설정 — 아래 안내
  }
  if (!dir.includes('Xcode.app')) {
    return {
      label: 'Xcode command-line tools',
      ok: false,
      warn: true,
      detail: `Active developer dir points away from Xcode. Run: sudo xcode-select -s ${XCODE_DEVELOPER_DIR}`,
    }
  }
  try {
    execSync('xcodebuild -version', { stdio: 'pipe' })
    return { label: 'Xcode ready', ok: true }
  } catch {
    return {
      label: 'Xcode setup',
      ok: false,
      warn: true,
      detail: 'Finish Xcode setup: sudo xcodebuild -license accept && xcodebuild -runFirstLaunch',
    }
  }
}

function checkAndFixSimulator(): SetupStepResult {
  try {
    const raw = execSync('xcrun simctl list devices --json', { encoding: 'utf8', stdio: 'pipe' })
    const data = JSON.parse(raw) as {
      devices: Record<string, Array<{ name: string; state: string; udid: string }>>
    }
    const all = Object.values(data.devices).flat()
    const booted = all.find((d) => d.state === 'Booted')
    if (booted) {
      return { label: `Simulator booted: ${booted.name}`, ok: true }
    }
    const candidate = all.find((d) => d.state === 'Shutdown')
    if (candidate) {
      execSync(`xcrun simctl boot ${candidate.udid}`, { stdio: 'pipe' })
      return { label: `Simulator booted: ${candidate.name}`, ok: true }
    }
    return {
      label: 'Simulator',
      ok: false,
      warn: true,
      detail: 'No simulators available. Open Xcode to install a simulator runtime.',
    }
  } catch {
    return {
      label: 'Simulator',
      ok: false,
      warn: true,
      detail: 'Could not query simulators. Finish Xcode setup first.',
    }
  }
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

function checkAndFixEmulator(): SetupStepResult {
  // resolveAdb()로 해석한 경로를 쓴다. 직전 단계에서 PATH에 등록했어도 현재 프로세스
  // PATH엔 반영되지 않으므로 'adb'를 그대로 부르면 오탐이 난다.
  const adb = resolveAdb()
  if (!adb) {
    return {
      label: 'No running emulator',
      ok: false,
      warn: true,
      detail: 'adb not found. Install/configure adb first, then start an AVD.',
    }
  }
  try {
    const out = execSync(`"${adb.path}" devices`, { encoding: 'utf8', stdio: 'pipe' })
    const lines = out.trim().split('\n').slice(1).filter(Boolean)
    if (lines.some((l) => l.startsWith('emulator-'))) {
      return { label: 'Emulator running', ok: true }
    }
  } catch {
    // adb 실행 실패 — 아래 힌트로
  }
  let hint = 'Start an AVD from Android Studio > Device Manager'
  try {
    const first = execSync('emulator -list-avds', { encoding: 'utf8', stdio: 'pipe' })
      .trim()
      .split('\n')[0]
      ?.trim()
    if (first) hint = `Start an AVD: emulator @${first} (or Android Studio > Device Manager)`
  } catch {
    // emulator 미설치 — 일반 힌트 유지
  }
  return { label: 'No running emulator', ok: false, warn: true, detail: hint }
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
