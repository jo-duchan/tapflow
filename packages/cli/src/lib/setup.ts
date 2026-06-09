import { execSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { confirm, isCancel } from '@clack/prompts'
import { resolveAdb, type DoctorCheck } from './doctor.js'
import { createSpinner } from './print.js'

// setup 단계 결과는 진단 결과(DoctorCheck)와 같은 형태를 쓴다.
// ok=true: 이미 OK이거나 방금 자동 수정함, warn=true: 수동 조치 필요(안내).
export type SetupStepResult = DoctorCheck

const PATH_MARKER_START = '# >>> tapflow android sdk >>>'
const PATH_MARKER_END = '# <<< tapflow android sdk <<<'
const STUDIO_APP = '/Applications/Android Studio.app'

export async function runSetupAndroid(): Promise<SetupStepResult[]> {
  const results: SetupStepResult[] = []
  const brew = checkAndFixHomebrew()
  results.push(brew)
  results.push(checkAndFixAdb(brew.ok))
  results.push(await checkAndFixAndroidStudio(brew.ok))
  results.push(checkAndFixEmulator())
  return results
}

function checkAndFixHomebrew(): SetupStepResult {
  try {
    execSync('which brew', { stdio: 'pipe' })
    return { label: 'Homebrew installed', ok: true }
  } catch {
    return {
      label: 'Homebrew',
      ok: false,
      warn: true,
      detail: 'Install Homebrew first: https://brew.sh (cannot auto-install)',
    }
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
  try {
    const out = execSync('adb devices', { encoding: 'utf8', stdio: 'pipe' })
    const lines = out.trim().split('\n').slice(1).filter(Boolean)
    if (lines.some((l) => l.startsWith('emulator-'))) {
      return { label: 'Emulator running', ok: true }
    }
  } catch {
    // adb 미설치/실패 — 아래 힌트로
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

function shellRcPath(): string {
  const shell = process.env.SHELL ?? ''
  const home = homedir()
  if (shell.includes('bash')) return join(home, '.bashrc')
  return join(home, '.zshrc') // 기본 zsh
}

function registerPathInShellRc(platformTools: string): { added: boolean; file: string } {
  const file = shellRcPath()
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : ''
  if (existing.includes(PATH_MARKER_START)) {
    return { added: false, file }
  }
  const block = `\n${PATH_MARKER_START}\nexport PATH="${platformTools}:$PATH"\n${PATH_MARKER_END}\n`
  appendFileSync(file, block)
  return { added: true, file }
}
