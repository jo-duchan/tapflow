import { execSync } from 'node:child_process'
import * as readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'

export async function cmdReset(): Promise<void> {
  const rl = readline.createInterface({ input, output })
  const answer = await rl.question('This will shut down all simulators. Continue? [y/N] ')
  rl.close()

  if (!answer.trim().toLowerCase().startsWith('y')) {
    console.log('Aborted.')
    return
  }

  try {
    execSync('xcrun simctl shutdown all', { stdio: 'pipe' })
    console.log('All simulators shut down.')
  } catch {
    console.warn('Could not shut down simulators.')
  }

  console.log('Reset complete.')
}
