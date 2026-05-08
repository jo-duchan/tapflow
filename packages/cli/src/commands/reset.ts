import { execSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import * as readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { WDA_PID_FILE } from '../lib/tapflow-dir'
import { checkWdaProcess } from '../lib/doctor'

export async function cmdReset(): Promise<void> {
  const rl = readline.createInterface({ input, output })
  const answer = await rl.question(
    'This will stop WDA and shut down all simulators. Continue? [y/N] ',
  )
  rl.close()

  if (!answer.trim().toLowerCase().startsWith('y')) {
    console.log('Aborted.')
    return
  }

  const { running, pid } = checkWdaProcess()
  if (running && pid) {
    try {
      process.kill(pid, 'SIGTERM')
      console.log('WDA stopped.')
    } catch {
      console.warn('Could not stop WDA process.')
    }
  }

  if (existsSync(WDA_PID_FILE)) {
    rmSync(WDA_PID_FILE)
  }

  try {
    execSync('xcrun simctl shutdown all', { stdio: 'pipe' })
    console.log('All simulators shut down.')
  } catch {
    console.warn('Could not shut down simulators.')
  }

  console.log('Reset complete.')
}
