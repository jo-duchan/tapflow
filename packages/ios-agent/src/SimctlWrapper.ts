import { randomUUID } from 'crypto'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'

const execFileAsync = promisify(execFile)

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
import type { Device, DeviceStatus } from '@tapflow/agent-core'
import { defaultRunner, type SimctlRunner } from './simctl.js'

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

export class SimctlWrapper {
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
  }

  async shutdown(deviceId: string): Promise<void> {
    await this.runner.exec('shutdown', deviceId)
  }

  async uninstallApp(bundleId: string): Promise<void> {
    await this.runner.exec('uninstall', 'booted', bundleId)
  }

  async installApp(appPath: string): Promise<void> {
    await this.runner.exec('install', 'booted', appPath)
  }

  async launchApp(bundleId: string): Promise<void> {
    await this.runner.exec('launch', 'booted', bundleId)
  }

  async screenshot(): Promise<Buffer> {
    const tmpPath = `${tmpdir()}/tapflow-${randomUUID()}.png`
    try {
      await this.runner.exec('io', 'booted', 'screenshot', tmpPath)
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

  async rotate(_udid: string, orientation: 'portrait' | 'landscapeLeft' | 'landscapeRight' | 'portraitUpsideDown'): Promise<void> {
    // xcrun simctl io does not support rotate; use Simulator.app keyboard shortcut via AppleScript
    const goClockwise = orientation === 'landscapeRight' || orientation === 'portraitUpsideDown'
    const keyCode = goClockwise ? 124 : 123   // 124=Right Arrow, 123=Left Arrow
    await execFileAsync('osascript', [
      '-e', 'tell application "Simulator" to activate',
      '-e', `tell application "System Events" to key code ${keyCode} using {command down}`,
    ])
  }

  // Cached so we only run the slow path (menu navigation) once per agent lifetime.
  private connectHwKbdEnabled = false

  private async sendToggleKey(): Promise<void> {
    await execFileAsync('osascript', [
      '-e', 'tell application "Simulator" to activate',
      '-e', 'delay 0.05',
      '-e', 'tell application "System Events" to keystroke "k" using {command down}',
    ])
  }

  async showSoftwareKeyboard(_udid: string): Promise<void> {
    if (this.connectHwKbdEnabled) {
      return this.sendToggleKey()
    }
    // "Toggle Software Keyboard" is grayed out when "Connect Hardware Keyboard" is OFF.
    // Check enabled state of the toggle item directly (more reliable than reading AXMenuItemMarkChar,
    // which can return missing value instead of "" on some macOS versions).
    await execFileAsync('osascript', [
      '-e', 'tell application "Simulator" to activate',
      '-e', 'tell application "System Events"',
      '-e', '  repeat until frontmost of process "Simulator"',
      '-e', '    delay 0.05',
      '-e', '  end repeat',
      '-e', '  tell process "Simulator"',
      '-e', '    tell menu "Keyboard" of menu item "Keyboard" of menu "I/O" of menu bar 1',
      '-e', '      if not (enabled of menu item "Toggle Software Keyboard") then',
      '-e', '        click menu item "Connect Hardware Keyboard"',
      '-e', '        delay 0.05',
      '-e', '      end if',
      '-e', '      click menu item "Toggle Software Keyboard"',
      '-e', '    end tell',
      '-e', '  end tell',
      '-e', 'end tell',
    ])
    this.connectHwKbdEnabled = true
  }

  async hideSoftwareKeyboard(_udid: string): Promise<void> {
    // ConnectHardwareKeyboard stays ON between show/hide cycles — no menu navigation needed.
    await this.sendToggleKey()
  }
}
