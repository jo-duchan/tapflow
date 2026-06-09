import { runSetupAndroid, type SetupStepResult } from '../lib/setup.js'
import { GREEN, RED, YELLOW, DIM, R } from '../lib/print.js'

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

export async function cmdSetup(platform: string): Promise<void> {
  if (platform === 'android') {
    console.log('\ntapflow setup android\n')
    printResults(await runSetupAndroid())
    console.log()
    return
  }

  console.error(`Unknown or unsupported platform: ${platform}. Supported: android`)
  process.exit(1)
}
