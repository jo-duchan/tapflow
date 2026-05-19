import { execFile, spawn } from 'child_process'
import { promisify } from 'util'
import { createLogger } from '@tapflow/agent-core'

const execFileAsync = promisify(execFile)
const logger = createLogger('android-agent:emulator')

function getAdbPath(): string {
  if (process.env['ADB_PATH']) return process.env['ADB_PATH']
  const androidHome = process.env['ANDROID_HOME']
  if (!androidHome) throw new Error('ANDROID_HOME not set')
  return `${androidHome}/platform-tools/adb`
}

function getEmulatorPath(): string {
  const androidHome = process.env['ANDROID_HOME']
  if (!androidHome) {
    throw new Error(
      'ANDROID_HOME not set. Install Android SDK and set the environment variable.\n' +
      'Example: export ANDROID_HOME=$HOME/Library/Android/sdk',
    )
  }
  return `${androidHome}/emulator/emulator`
}

export class EmulatorLauncher {
  launch(avdName: string): void {
    const proc = spawn(getEmulatorPath(), ['-avd', avdName, '-no-audio', '-no-snapshot', '-no-window', '-gpu', 'host'], {
      detached: true,
      stdio: 'ignore',
    })
    proc.on('error', (err) => logger.error(`emulator launch failed: ${err.message}`))
    proc.unref()
  }

  async findSerial(avdName: string, timeoutMs = 30_000): Promise<string> {
    const adb = getAdbPath()
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
      try {
        const { stdout } = await execFileAsync(adb, ['devices'])
        const serials = stdout
          .split('\n')
          .slice(1)
          .map((l) => l.split('\t'))
          .filter(([s, state]) => s?.startsWith('emulator-') && state?.trim() === 'device')
          .map(([s]) => s.trim())

        for (const serial of serials) {
          const { stdout: name } = await execFileAsync(adb, [
            '-s', serial, 'emu', 'avd', 'name',
          ])
          if (name.split('\n')[0].trim() === avdName) return serial
        }
      } catch { /* not ready yet */ }

      await new Promise((r) => setTimeout(r, 2_000))
    }

    throw new Error(`Could not find emulator serial for AVD "${avdName}" within ${timeoutMs / 1000}s`)
  }

  async waitForBoot(serial: string, timeoutMs = 120_000): Promise<void> {
    const adb = getAdbPath()

    // Wait for device to appear in ADB
    await execFileAsync(adb, ['-s', serial, 'wait-for-device'])

    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        const { stdout } = await execFileAsync(adb, [
          '-s', serial, 'shell', 'getprop', 'sys.boot_completed',
        ])
        if (stdout.trim() === '1') return
      } catch { /* not ready */ }
      await new Promise((r) => setTimeout(r, 3_000))
    }

    throw new Error(`Emulator ${serial} did not finish booting within ${timeoutMs / 1000}s`)
  }
}
