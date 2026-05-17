import { runDoctorChecks, type DoctorCheck } from '../lib/doctor.js'
import { banner, step, GREEN, RED, BOLD, DIM, R } from '../lib/print.js'

function printChecks(checks: DoctorCheck[]): boolean {
  let hasFailure = false
  for (const check of checks) {
    if (check.ok) {
      console.log(`  ${GREEN}✓${R}  ${check.label}`)
    } else {
      console.log(`  ${RED}✗${R}  ${check.label}`)
      if (check.detail) console.log(`${DIM}       → ${check.detail}${R}`)
      hasFailure = true
    }
  }
  return hasFailure
}

export async function cmdDoctor(): Promise<void> {
  console.log('\ntapflow doctor\n')
  const result = await runDoctorChecks()
  let hasFailure = false

  hasFailure = printChecks(result.common) || hasFailure

  if (result.ios) {
    console.log(`\n  ${BOLD}iOS${R}`)
    hasFailure = printChecks(result.ios) || hasFailure
  }

  if (result.android) {
    console.log(`\n  ${BOLD}Android${R}`)
    hasFailure = printChecks(result.android) || hasFailure
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
