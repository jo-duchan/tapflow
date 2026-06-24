import { execFile, spawn } from 'child_process'
import { promisify } from 'util'
import { createLogger, PlatformError, ValidationError } from '@tapflowio/agent-core'

const execFileAsync = promisify(execFile)
const logger = createLogger('android-agent:emulator')

function getAdbPath(): string {
  if (process.env['ADB_PATH']) return process.env['ADB_PATH']
  const androidHome = process.env['ANDROID_HOME']
  if (!androidHome) throw new ValidationError('ANDROID_HOME not set')
  return `${androidHome}/platform-tools/adb`
}

function getEmulatorPath(): string {
  const androidHome = process.env['ANDROID_HOME']
  if (!androidHome) {
    throw new ValidationError(
      'ANDROID_HOME not set. Install Android SDK and set the environment variable.\n' +
      'Example: export ANDROID_HOME=$HOME/Library/Android/sdk',
    )
  }
  return `${androidHome}/emulator/emulator`
}

export interface EmulatorLaunchOpts {
  // Opt-in audio output. Default false keeps `-no-audio` so the audio backend stays off and
  // the video-only path is byte-for-byte unchanged.
  audio?: boolean
}

/** Build the emulator CLI args. Pure + exported so the `-no-audio` gating is unit-testable. */
export function buildEmulatorArgs(avdName: string, grpcPort?: number, opts?: EmulatorLaunchOpts): string[] {
  const args = ['-avd', avdName]
  if (!opts?.audio) args.push('-no-audio')
  args.push('-no-snapshot', '-no-window', '-gpu', 'host')
  if (grpcPort !== undefined) args.push('-grpc', String(grpcPort))
  return args
}

export class EmulatorLauncher {
  /** `grpcPort`, when set, opens the emulator's unprotected localhost gRPC endpoint
   *  (`-grpc <port>`) for host-side screen capture + input — the same trust boundary as
   *  scrcpy's localhost ADB. Verified to work under `-no-window` headless. */
  launch(avdName: string, grpcPort?: number, opts?: EmulatorLaunchOpts): void {
    const args = buildEmulatorArgs(avdName, grpcPort, opts)
    const proc = spawn(getEmulatorPath(), args, {
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

    throw new PlatformError(`Could not find emulator serial for AVD "${avdName}" within ${timeoutMs / 1000}s`)
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

    throw new PlatformError(`Emulator ${serial} did not finish booting within ${timeoutMs / 1000}s`)
  }
}
