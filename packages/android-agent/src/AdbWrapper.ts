import type { Device } from '@tapflowio/agent-core'
import { PlatformError, ValidationError } from '@tapflowio/agent-core'
import { defaultRunner, type AdbRunner } from './adb.js'

export class AdbWrapper {
  // avdId ("avd:<name>") → ADB serial ("emulator-5554")
  private readonly serialMap = new Map<string, string>()

  constructor(private readonly runner: AdbRunner = defaultRunner) {}

  getSerial(avdId: string): string | undefined {
    return this.serialMap.get(avdId)
  }

  setSerial(avdId: string, serial: string): void {
    this.serialMap.set(avdId, serial)
  }

  clearSerial(avdId: string): void {
    this.serialMap.delete(avdId)
  }

  async listDevices(): Promise<Device[]> {
    const [avdNames, bootedMap] = await Promise.all([
      this.runner.listAvds(),
      this.getBootedAvdMap(),
    ])

    // Sync serial map
    for (const [serial, avdName] of bootedMap) {
      this.serialMap.set(`avd:${avdName}`, serial)
    }
    // Remove stale serials (emulator was killed externally)
    const bootedAvdNames = new Set(bootedMap.values())
    for (const [avdId] of this.serialMap) {
      if (!bootedAvdNames.has(avdId.replace('avd:', ''))) {
        this.serialMap.delete(avdId)
      }
    }

    const devices: Device[] = []
    for (const avdName of avdNames) {
      const avdId = `avd:${avdName}`
      const serial = this.serialMap.get(avdId)
      const isBooted = Boolean(serial)

      let osVersion: string | undefined
      if (isBooted && serial) {
        osVersion = await this.getOsVersion(serial).catch(() => undefined)
        if (osVersion) osVersion = `Android ${osVersion}`
      }

      devices.push({
        id: avdId,
        name: avdName,
        platform: 'android',
        status: isBooted ? 'booted' : 'shutdown',
        osVersion,
      })
    }

    return devices
  }

  private async getBootedAvdMap(): Promise<Map<string, string>> {
    const result = new Map<string, string>()
    try {
      const output = await this.runner.exec('devices')
      const serials = output
        .split('\n')
        .slice(1)
        .map((l) => l.split('\t'))
        .filter(([serial, state]) => serial?.startsWith('emulator-') && state?.trim() === 'device')
        .map(([serial]) => serial.trim())

      await Promise.all(
        serials.map(async (serial) => {
          const avdName = await this.runner
            .exec('-s', serial, 'emu', 'avd', 'name')
            .then((o) => o.split('\n')[0].trim())
            .catch(() => null)
          if (avdName) result.set(serial, avdName)
        }),
      )
    } catch { /* adb server not running */ }
    return result
  }

  private async getOsVersion(serial: string): Promise<string> {
    const output = await this.runner.exec('-s', serial, 'shell', 'getprop', 'ro.build.version.release')
    return output.trim()
  }

  async getScreenSize(serial: string): Promise<{ width: number; height: number }> {
    const output = await this.runner.exec('-s', serial, 'shell', 'wm', 'size')
    // "Physical size: 1080x2400"
    const m = output.match(/(\d+)x(\d+)/)
    if (!m) throw new PlatformError(`Cannot parse screen size from: ${output}`)
    return { width: parseInt(m[1], 10), height: parseInt(m[2], 10) }
  }

  // pm clear prints "Failed" with exit code 0 (e.g. unknown package), so the
  // output must be checked — a silent no-op would break flow-runner clearState.
  async clearAppData(serial: string, packageName: string): Promise<void> {
    const out = await this.runner.exec('-s', serial, 'shell', 'pm', 'clear', packageName)
    if (!out.includes('Success')) {
      throw new PlatformError(`pm clear failed for ${packageName}: ${out.trim() || 'unknown error'}`)
    }
  }

  async installApp(serial: string, apkPath: string): Promise<void> {
    try {
      await this.runner.exec('-s', serial, 'install', '-r', apkPath)
    } catch (e) {
      const stderr = (e as { stderr?: string }).stderr?.trim()
      if (stderr) {
        // "Failure [INSTALL_FAILED_...]" → show just the code
        const failureMatch = stderr.match(/Failure\s*\[(.+?)\]/)
        if (failureMatch) throw new ValidationError(failureMatch[1])
        // Strip "adb: failed to install <path>:" prefix and stack trace
        const stripped = stderr
          .replace(/^adb: failed to install [^:]+:\s*/, '')
          .replace(/\s+at\s+[\w$.]+\([\w.]+:\d+\)[\s\S]*$/, '')
          .trim()
        throw new ValidationError(stripped || stderr)
      }
      throw new ValidationError((e as Error).message, { cause: e })
    }
  }

  async launchApp(serial: string, packageName: string): Promise<void> {
    await this.runner.exec(
      '-s', serial, 'shell', 'monkey',
      '-p', packageName, '-c', 'android.intent.category.LAUNCHER', '1',
    )
  }

  async openUrl(serial: string, url: string): Promise<void> {
    await this.runner.exec('-s', serial, 'shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', url)
  }

  async screenshot(serial: string): Promise<Buffer> {
    return this.runner.execBinary('-s', serial, 'exec-out', 'screencap', '-p')
  }

  // uiautomator waits for an idle window, so screens with continuous animation
  // can block forever — the device-side toybox `timeout` kills the dump and we
  // surface an explicit error instead of hanging (never a silent empty tree).
  async dumpUiHierarchy(serial: string, timeoutSec = 10): Promise<string> {
    const output = await this.runner.exec(
      '-s', serial, 'exec-out',
      'timeout', String(timeoutSec), 'uiautomator', 'dump', '/dev/tty',
    )
    const start = output.indexOf('<?xml') >= 0 ? output.indexOf('<?xml') : output.indexOf('<hierarchy')
    const end = output.lastIndexOf('</hierarchy>')
    if (start < 0 || end < 0) {
      const detail = output.trim().slice(0, 200)
      throw new PlatformError(
        `uiautomator dump produced no XML within ${timeoutSec}s` +
        (detail ? ` (${detail})` : '') +
        ' — screens with continuous animation block the dump; retry on a settled screen',
      )
    }
    return output.slice(start, end + '</hierarchy>'.length)
  }

  // rotation is an Android user_rotation value (0=portrait, 3=canonical landscape home-left/punch-right).
  // `wm user-rotation lock` over legacy `settings put system user_rotation`: the latter is silently
  // ignored on newer Android (API 35+) — the display never rotates, only a rotation-suggestion appears.
  // wm user-rotation locks regardless of auto-rotate and works on API 34 through 37 alike.
  async setRotation(serial: string, rotation: 0 | 1 | 2 | 3): Promise<void> {
    await this.runner.exec('-s', serial, 'shell', 'wm', 'user-rotation', 'lock', String(rotation))
  }

  async sendInput(serial: string, ...args: string[]): Promise<void> {
    await this.runner.exec('-s', serial, 'shell', 'input', ...args)
  }

  async sendKeyEvent(serial: string, keyCode: string): Promise<void> {
    await this.runner.exec('-s', serial, 'shell', 'input', 'keyevent', keyCode)
  }

  async shutdown(serial: string): Promise<void> {
    await this.runner.exec('-s', serial, 'emu', 'kill')
  }

  async pkill(serial: string, pattern: string): Promise<void> {
    await this.runner.exec('-s', serial, 'shell', 'pkill', '-f', pattern)
  }
}
