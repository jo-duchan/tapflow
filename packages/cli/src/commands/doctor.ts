import { runDoctorChecks } from '../lib/doctor'

export async function cmdDoctor(): Promise<void> {
  console.log('tapflow doctor\n')
  const checks = await runDoctorChecks()
  let hasFailure = false

  for (const check of checks) {
    const icon = check.ok ? '✓' : '✗'
    console.log(`  ${icon} ${check.label}`)
    if (!check.ok && check.detail) {
      console.log(`    → ${check.detail}`)
      hasFailure = true
    }
  }

  console.log()
  if (hasFailure) {
    console.log('Some checks failed. Fix the issues above before running `tapflow start`.')
    process.exit(1)
  } else {
    console.log('All checks passed.')
  }
}
