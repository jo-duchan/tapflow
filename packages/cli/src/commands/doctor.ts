import { runDoctorChecks, type DoctorCheck, type DoctorResult } from '../lib/doctor.js'
import { banner, step, GREEN, RED, YELLOW, BOLD, DIM, R } from '../lib/print.js'

function printChecks(checks: DoctorCheck[]): void {
  for (const check of checks) {
    if (check.ok) {
      console.log(`  ${GREEN}✓${R}  ${check.label}`)
    } else if (check.warn) {
      console.log(`  ${YELLOW}⚠${R}  ${check.label}`)
      if (check.detail) console.log(`${DIM}       → ${check.detail}${R}`)
    } else {
      console.log(`  ${RED}✗${R}  ${check.label}`)
      if (check.detail) console.log(`${DIM}       → ${check.detail}${R}`)
    }
  }
}

// 실패 = ok가 아니면서 warn도 아닌 체크 (warn은 실패로 치지 않음)
function hasFailures(result: DoctorResult): boolean {
  const all = [...result.common, ...(result.ios ?? []), ...(result.android ?? [])]
  return all.some((c) => !c.ok && !c.warn)
}

export async function cmdDoctor(opts: { json?: boolean } = {}): Promise<void> {
  const result = await runDoctorChecks()

  if (opts.json) {
    const ok = !hasFailures(result)
    console.log(JSON.stringify({ ok, common: result.common, ios: result.ios, android: result.android }, null, 2))
    if (!ok) process.exit(1)
    return
  }

  console.log('\ntapflow doctor\n')
  const hasFailure = hasFailures(result)

  printChecks(result.common)

  if (result.ios) {
    console.log(`\n  ${BOLD}iOS${R}`)
    printChecks(result.ios)
  }

  if (result.android) {
    console.log(`\n  ${BOLD}Android${R}`)
    printChecks(result.android)
  }

  console.log()
  if (hasFailure) {
    banner('error', 'SOME CHECKS FAILED', ['Fix the issues above before running `tapflow start`.'])
    process.exit(1)
  } else {
    step('All checks passed.')
    console.log()
  }
}
