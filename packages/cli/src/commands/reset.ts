import { execSync } from 'node:child_process'
import * as readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { banner, step } from '../lib/print.js'

export async function cmdReset(): Promise<void> {
  const rl = readline.createInterface({ input, output })
  const answer = await rl.question(
    'This will shut down all simulators and emulators (no data loss). Continue? [y/N] ',
  )
  rl.close()

  if (!answer.trim().toLowerCase().startsWith('y')) {
    console.log('\n  Aborted.\n')
    return
  }

  // iOS
  if (process.platform === 'darwin') {
    try {
      execSync('xcrun simctl shutdown all', { stdio: 'pipe' })
      step('iOS: all simulators shut down.')
    } catch {
      step('iOS: no simulators to shut down.')
    }
  }

  // Android
  try {
    execSync('which adb', { stdio: 'pipe' })
    const out = execSync('adb devices', { encoding: 'utf8', stdio: 'pipe' })
    const emulators = out.trim().split('\n').slice(1)
      .filter((l) => l.startsWith('emulator-'))
      .map((l) => l.split('\t')[0]?.trim() ?? '')
      .filter(Boolean)

    if (emulators.length === 0) {
      step('Android: no running emulators.')
    } else {
      for (const serial of emulators) {
        try {
          execSync(`adb -s ${serial} emu kill`, { stdio: 'pipe' })
          step(`Android: ${serial} shut down.`)
        } catch {
          step(`Android: could not shut down ${serial}.`)
        }
      }
    }
  } catch { /* adb not available */ }

  banner('success', 'RESET COMPLETE')
}
