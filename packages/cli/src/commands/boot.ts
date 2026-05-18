import { execSync, spawn } from 'node:child_process'
import { banner, createSpinner, step } from '../lib/print.js'

export async function cmdBoot(nameOrUdid: string): Promise<void> {
  // iOS 먼저 탐색
  if (process.platform === 'darwin') {
    try {
      const raw = execSync('xcrun simctl list devices --json', { encoding: 'utf8', stdio: 'pipe' })
      const data = JSON.parse(raw) as {
        devices: Record<string, Array<{ udid: string; name: string; state: string }>>
      }
      const target = Object.values(data.devices).flat().find(
        (d) => d.udid === nameOrUdid || d.name === nameOrUdid,
      )
      if (target) {
        if (target.state === 'Booted') {
          step(`${target.name} is already booted.`)
          return
        }
        const spinner = createSpinner(`Booting iOS Simulator: ${target.name}…`)
        spinner.start()
        execSync(`xcrun simctl boot ${target.udid}`, { stdio: 'pipe' })
        spinner.stop(true)
        step(`${target.name} booted.`)
        return
      }
    } catch { /* xcrun unavailable */ }
  }

  // Android AVD 탐색
  try {
    execSync('which emulator', { stdio: 'pipe' })
    const avdList = execSync('emulator -list-avds', { encoding: 'utf8', stdio: 'pipe' })
      .trim().split('\n').map((l) => l.trim()).filter(Boolean)
    const target = avdList.find((avd) => avd === nameOrUdid)
    if (target) {
      // emulator는 실행 후 종료되지 않으므로 detached로 백그라운드 기동
      const child = spawn('emulator', [`@${target}`], { detached: true, stdio: 'ignore' })
      child.unref()
      step(`Android AVD: ${target} is starting in the background.`)
      step('Run `tapflow devices` to check boot status.')
      return
    }
  } catch { /* emulator unavailable */ }

  banner('error', 'DEVICE NOT FOUND', [
    `"${nameOrUdid}" does not match any simulator or AVD.`,
    'Run `tapflow devices` to see available devices.',
  ])
  process.exit(1)
}
