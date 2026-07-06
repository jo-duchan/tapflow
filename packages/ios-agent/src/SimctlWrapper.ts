import { randomUUID } from 'crypto'
import { execFile, spawn } from 'child_process'
import { promisify } from 'util'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { PlatformError } from '@tapflowio/agent-core'

const execFileAsync = promisify(execFile)
const ROTATION_HELPER  = join(import.meta.dirname, '..', 'bin', 'rotation-helper')

// Language code → iOS AppleKeyboards entry string with hw=Automatic.
// hw=Automatic lets iOS switch the hardware layout when the input source changes via LANG1/CapsLock.
// hw=Korean (previous approach) locked the hardware layout to Korean regardless of active input source,
// which caused the toggle HUD to appear but not actually change key output.
const LANG_KEYBOARD_MAP: Record<string, string> = {
  ko:   'ko_KR@sw=Korean;hw=Automatic',
  ja:   'ja_JP@sw=Japanese-Kana;hw=Automatic',
  zh:   'zh_Hans_CN@sw=ChineseSimplified-Pinyin;hw=Automatic',
  fr:   'fr_FR@sw=French;hw=Automatic',
  de:   'de_DE@sw=German;hw=Automatic',
  es:   'es_ES@sw=Spanish;hw=Automatic',
  it:   'it_IT@sw=Italian;hw=Automatic',
  pt:   'pt_BR@sw=Portuguese;hw=Automatic',
  ru:   'ru_RU@sw=Russian;hw=Automatic',
  ar:   'ar@sw=Arabic;hw=Automatic',
  th:   'th_TH@sw=Thai;hw=Automatic',
}

function langToKeyboard(lang: string): string {
  const code = lang.split('-')[0].toLowerCase()
  return LANG_KEYBOARD_MAP[code] ?? 'en_US@sw=QWERTY;hw=Automatic'
}
import type { Device, DeviceStatus } from '@tapflowio/agent-core'
import { defaultRunner, type SimctlRunner } from './simctl.js'
import { KeyboardHelperDaemon } from './KeyboardHelperDaemon.js'

interface SimctlDevice {
  udid: string
  name: string
  state: string
  isAvailable: boolean
  deviceTypeIdentifier?: string
}

interface SimctlListOutput {
  devices: Record<string, SimctlDevice[]>
}

function toDeviceStatus(state: string): DeviceStatus {
  if (state === 'Booted') return 'booted'
  if (state === 'Shutdown') return 'shutdown'
  return 'unknown'
}

// "com.apple.CoreSimulator.SimRuntime.iOS-18-3" → "iOS 18.3"
function parseOsVersion(runtimeKey: string): string | undefined {
  const m = runtimeKey.match(/\.([A-Za-z]+)-(\d+(?:-\d+)*)$/)
  if (!m) return undefined
  return `${m[1]} ${m[2].replace(/-/g, '.')}`
}

// A device's data dir can vanish from disk (e.g. an Xcode/macOS update pruned its
// runtime) while simctl still lists it as available — `boot` then fails with this
// signature only. Matched conservatively (text only) so a healthy device is never erased.
export function isDeviceMissingError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { message?: unknown; stderr?: unknown }
  const text = [e.message, e.stderr].filter((s): s is string => typeof s === 'string').join(' ')
  return /cannot be located on disk|data is no longer present/i.test(text)
}

export class SimctlWrapper {
  private readonly kbd = new KeyboardHelperDaemon()

  constructor(private readonly runner: SimctlRunner = defaultRunner) {}

  async listDevices(): Promise<Device[]> {
    const output = await this.runner.exec('list', 'devices', '--json')
    const parsed: SimctlListOutput = JSON.parse(output)
    const devices: Device[] = []

    for (const [runtimeKey, runtimeDevices] of Object.entries(parsed.devices)) {
      const osVersion = parseOsVersion(runtimeKey)
      for (const d of runtimeDevices) {
        if (!d.isAvailable) continue
        devices.push({
          id: d.udid,
          name: d.name,
          platform: 'ios',
          status: toDeviceStatus(d.state),
          typeId: d.deviceTypeIdentifier,
          osVersion,
        })
      }
    }

    return devices
  }

  async boot(deviceId: string): Promise<void> {
    try {
      await this.runner.exec('boot', deviceId)
    } catch (err: unknown) {
      const stderr = (err as { stderr?: string }).stderr ?? ''
      // already booted is not an error
      if (stderr.includes('Unable to boot device in current state: Booted')) return
      throw err
    }
    // Xcode 14+ auto-opens Simulator.app on `simctl boot`.
    // Quitting kills the simulator runtime, so just hide the app window instead.
    execFile('osascript', ['-e', 'tell application "Simulator" to set visible to false'], () => {})
  }

  async shutdown(deviceId: string): Promise<void> {
    await this.runner.exec('shutdown', deviceId)
  }

  async erase(deviceId: string): Promise<void> {
    await this.runner.exec('erase', deviceId)
  }

  async uninstallApp(bundleId: string): Promise<void> {
    await this.runner.exec('uninstall', 'booted', bundleId)
  }

  // pm-clear analog for the simulator: wipe the app's data-container contents
  // (Documents / Library / tmp) instead of uninstalling, so the installed
  // binary survives and flow-runner clearState → launchApp keeps working.
  async clearAppData(bundleId: string): Promise<void> {
    await this.runner.exec('terminate', 'booted', bundleId).catch(() => { /* not running is fine */ })
    const out = await this.runner.exec('get_app_container', 'booted', bundleId, 'data')
    const container = out.trim()
    if (!container.startsWith('/')) {
      throw new PlatformError(`cannot resolve data container for ${bundleId}: ${container || 'empty simctl output'}`)
    }
    for (const sub of ['Documents', 'Library', 'tmp']) {
      const dir = join(container, sub)
      const entries = await fs.readdir(dir).catch(() => [] as string[])
      await Promise.all(entries.map((e) => fs.rm(join(dir, e), { recursive: true, force: true })))
    }
  }

  async installApp(appPath: string): Promise<void> {
    await this.runner.exec('install', 'booted', appPath)
  }

  // Returns the launched app's host PID (`simctl launch` prints "<bundleId>: <pid>"), or null if it
  // can't be parsed. The audiotap-helper taps this PID; non-audio callers ignore it.
  async launchApp(bundleId: string): Promise<number | null> {
    const out = await this.runner.exec('launch', 'booted', bundleId)
    const m = out.match(/:\s*(\d+)\s*$/)
    return m ? Number(m[1]) : null
  }

  async openUrl(deviceId: string, url: string): Promise<void> {
    await this.runner.exec('openurl', deviceId, url)
  }

  // Set the device pasteboard from stdin. Not routed through SimctlRunner
  // because pbcopy reads text from stdin, which the exec(...args) contract
  // doesn't carry — same exception as the osascript call in boot(). Used by
  // IOSAgent for input:type (pbcopy → Cmd+V paste).
  async setPasteboard(deviceId: string, text: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn('xcrun', ['simctl', 'pbcopy', deviceId])
      proc.on('error', reject)
      // stdin can emit its own 'error' if the spawn fails mid-write — an
      // unhandled stream 'error' would crash the agent, so reject instead.
      proc.stdin.on('error', reject)
      proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`simctl pbcopy exited ${code}`))))
      proc.stdin.write(text)
      proc.stdin.end()
    })
  }

  async screenshot(format: 'png' | 'jpeg' = 'png'): Promise<Buffer> {
    const ext = format === 'jpeg' ? 'jpg' : 'png'
    const tmpPath = `${tmpdir()}/tapflow-${randomUUID()}.${ext}`
    try {
      await this.runner.exec('io', 'booted', 'screenshot', '--type', format, tmpPath)
      return await fs.readFile(tmpPath)
    } finally {
      await fs.unlink(tmpPath).catch(() => {})
    }
  }

  // Reads AppleLanguages from the simulator's Global Domain and rewrites AppleKeyboards
  // so each entry uses hw=Automatic. This lets iOS switch hardware key layout when the
  // user toggles the input source (via LANG1/CapsLock), fixing the iOS 15+ bug where
  // hw=Korean locks the hardware layout regardless of the active input source.
  async syncKeyboardsFromLanguages(udid: string): Promise<void> {
    let languages: string[]
    try {
      const out = await this.runner.exec('spawn', udid, 'defaults', 'read', '-g', 'AppleLanguages')
      // Output: (\n    "ko-KR",\n    "en-US"\n)
      languages = [...out.matchAll(/"([^"]+)"/g)].map((m) => m[1])
    } catch {
      languages = []
    }
    if (languages.length === 0) return

    // Always include English as a fallback so the English QWERTY keyboard is available.
    const hasEnglish = languages.some((l) => l.toLowerCase().startsWith('en'))
    const allLangs = hasEnglish ? languages : [...languages, 'en-US']

    const keyboards = [...new Set([...allLangs.map(langToKeyboard), 'emoji@sw=Emoji'])]

    await this.runner.exec('spawn', udid, 'defaults', 'write', '-g', 'AppleKeyboards', '-array', ...keyboards)

    // Restart the keyboard daemon so it picks up the new settings immediately.
    // Errors are silently ignored — changes will take effect on next text field focus if the daemon isn't running yet.
    try {
      await this.runner.exec('spawn', udid, 'launchctl', 'kickstart', '-k', 'system/com.apple.kbd')
    } catch { /* expected on some iOS versions */ }
  }

  async rotate(udid: string, orientation: 'portrait' | 'landscapeLeft' | 'landscapeRight' | 'portraitUpsideDown'): Promise<void> {
    await execFileAsync(ROTATION_HELPER, [orientation, udid])
  }

  async showSoftwareKeyboard(udid: string): Promise<void> {
    await this.kbd.show(udid)
  }

  async hideSoftwareKeyboard(udid: string): Promise<void> {
    await this.kbd.hide(udid)
  }

  stopKeyboardDaemon(): void {
    this.kbd.stop()
  }
}
