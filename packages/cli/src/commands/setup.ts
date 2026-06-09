import { runSetupAndroid, runSetupIos, type SetupStepResult } from '../lib/setup.js'
import { resolveAdb } from '../lib/doctor.js'
import { warn, BOLD, GREEN, RED, YELLOW, DIM, R } from '../lib/print.js'

const RUNNERS: Record<string, () => Promise<SetupStepResult[]>> = {
  ios: runSetupIos,
  android: runSetupAndroid,
}

// 인자 없이 실행 시 환경을 보고 가능한 플랫폼을 고른다.
function detectPlatforms(): string[] {
  const platforms: string[] = []
  if (process.platform === 'darwin') platforms.push('ios')
  if (resolveAdb() !== null) platforms.push('android')
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
    targets = detectPlatforms()
    if (targets.length === 0) {
      warn('No supported platform detected. Run: tapflow setup ios | android')
      return
    }
  }

  for (const t of targets) {
    console.log(`\n${BOLD}tapflow setup ${t}${R}\n`)
    printResults(await RUNNERS[t]())
  }
  console.log()
}
