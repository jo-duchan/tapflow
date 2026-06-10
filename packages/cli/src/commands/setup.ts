import { confirm, isCancel } from '@clack/prompts'
import { runSetupAndroid, runSetupIos, type SetupStepResult } from '../lib/setup.js'
import { resolveAdb } from '../lib/doctor.js'
import { warn, banner, step, BOLD, GREEN, RED, YELLOW, DIM, R } from '../lib/print.js'

const RUNNERS: Record<string, () => Promise<SetupStepResult[]>> = {
  ios: runSetupIos,
  android: runSetupAndroid,
}

// 인자 없이 실행 시 환경을 보고 가능한 플랫폼을 고른다.
// macOS면 iOS, adb가 있으면 Android 자동. adb가 없어도 TTY면 Android 세팅 의향을 묻는다.
async function detectPlatforms(): Promise<string[]> {
  const platforms: string[] = []
  if (process.platform === 'darwin') platforms.push('ios')
  if (resolveAdb() !== null) {
    platforms.push('android')
  } else if (process.platform === 'darwin' && process.stdout.isTTY) {
    const also = await confirm({ message: 'Also set up Android? (adb not found)' })
    if (!isCancel(also) && also) platforms.push('android')
  }
  return platforms
}

function printResults(results: SetupStepResult[]): void {
  for (const r of results) {
    if (r.ok) {
      console.log(`  ${GREEN}✓${R}  ${r.label}`)
      if (r.detail) console.log(`${DIM}       ${r.detail}${R}`)
    } else if (r.warn) {
      console.log(`  ${YELLOW}⚠${R}  ${r.label}`)
      if (r.detail) console.log(`${DIM}       → ${r.detail}${R}`)
    } else {
      console.log(`  ${RED}✗${R}  ${r.label}`)
      if (r.detail) console.log(`${DIM}       → ${r.detail}${R}`)
    }
  }
}

export async function cmdSetup(platform?: string): Promise<void> {
  let targets: string[]
  if (platform) {
    if (!RUNNERS[platform]) {
      warn(`Unknown or unsupported platform: ${platform}. Supported: ios, android`)
      process.exit(1)
    }
    targets = [platform]
  } else {
    targets = await detectPlatforms()
    if (targets.length === 0) {
      warn('No supported platform detected. Run: tapflow setup ios | android')
      return
    }
  }

  // 각 플랫폼 실행 후, 마지막에 relay/agent READY 톤의 요약 배너로 준비 상태를 알린다.
  const summary: string[] = []
  let allReady = true
  let needsNewShell = false
  for (const t of targets) {
    console.log(`\n${BOLD}tapflow setup ${t}${R}\n`)
    const results = await RUNNERS[t]()
    printResults(results)
    if (results.some((r) => r.detail?.includes('new terminal'))) needsNewShell = true
    const pending = results.filter((r) => !r.ok)
    if (pending.length === 0) {
      summary.push(`${t}: ready`)
    } else {
      allReady = false
      summary.push(`${t}: incomplete — ${pending.map((r) => r.label).join(', ')}`)
    }
  }
  banner(allReady ? 'success' : 'error', allReady ? 'SETUP COMPLETE' : 'SETUP INCOMPLETE', summary)

  // env를 방금 등록했으면 현재 쉘엔 반영 안 됨 → 새 터미널 안내(doctor가 PATH 경고를 내지 않도록).
  if (needsNewShell) {
    step('Open a new terminal (or run: exec $SHELL), then `tapflow doctor` to verify — ANDROID_HOME/PATH was just added to your shell config.')
  }
}
