import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

function getAdbPath(): string {
  if (process.env['ADB_PATH']) return process.env['ADB_PATH']
  const androidHome = process.env['ANDROID_HOME']
  if (!androidHome) {
    throw new Error(
      'ADB not found. Set ANDROID_HOME or ADB_PATH environment variable.\n' +
      'Example: export ANDROID_HOME=$HOME/Library/Android/sdk',
    )
  }
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

export interface AdbRunner {
  exec(...args: string[]): Promise<string>
  execBinary(...args: string[]): Promise<Buffer>
  listAvds(): Promise<string[]>
}

export const defaultRunner: AdbRunner = {
  async exec(...args: string[]): Promise<string> {
    const { stdout } = await execFileAsync(getAdbPath(), args)
    return stdout
  },
  async execBinary(...args: string[]): Promise<Buffer> {
    const { stdout } = await execFileAsync(getAdbPath(), args, { encoding: 'buffer' })
    return stdout
  },
  async listAvds(): Promise<string[]> {
    try {
      const { stdout } = await execFileAsync(getEmulatorPath(), ['-list-avds'])
      return stdout.split('\n').map((l) => l.trim()).filter(Boolean)
    } catch {
      return []
    }
  },
}
