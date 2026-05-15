import { runDoctorChecks, type DoctorCheck } from '../lib/doctor.js'

const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'
const R = '\x1b[0m'

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
    console.log(`  ${RED}Some checks failed.${R} Fix the issues above before running \`tapflow start\`.`)
    process.exit(1)
  } else {
    console.log(`  ${GREEN}All checks passed.${R}`)
  }
  console.log()
}
