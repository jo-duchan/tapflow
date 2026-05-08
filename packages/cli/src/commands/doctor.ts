import { runDoctorChecks } from '../lib/doctor'

const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const DIM = '\x1b[2m'
const R = '\x1b[0m'

export async function cmdDoctor(): Promise<void> {
  console.log('\ntapflow doctor\n')
  const checks = await runDoctorChecks()
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

  console.log()
  if (hasFailure) {
    console.log(`  ${RED}Some checks failed.${R} Fix the issues above before running \`tapflow start\`.`)
    process.exit(1)
  } else {
    console.log(`  ${GREEN}All checks passed.${R}`)
  }
  console.log()
}
