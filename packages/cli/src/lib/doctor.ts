import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface DoctorCheck {
  label: string
  ok: boolean
  warn?: boolean
  detail?: string
}

export interface DoctorResult {
  common: DoctorCheck[]
  ios: DoctorCheck[] | null
  android: DoctorCheck[] | null
}

export async function runDoctorChecks(): Promise<DoctorResult> {
  const isMac = process.platform === 'darwin'
  const adb = resolveAdb()

  return {
    common: [checkNodeVersion()],
    ios: isMac ? [checkXcode(), checkSimctl(), checkBootedSimulator()] : null,
    android: adb !== null ? buildAndroidChecks(adb) : null,
  }
}

function buildAndroidChecks(adb: AdbResolution): DoctorCheck[] {
  // adb가 PATH에 있으면 명령은 그대로 'adb', 표준 위치 fallback이면 절대경로로 실행
  if (adb.inPath) {
    return [checkAdb(adb.path), checkBootedAvd('adb')]
  }
  return [
    {
      label: 'adb (not in PATH)',
      ok: false,
      warn: true,
      detail: `adb found at ${adb.path} but not in PATH. Run: tapflow setup android`,
    },
    checkBootedAvd(adb.path),
  ]
}

function checkXcode(): DoctorCheck {
  try {
    const out = execSync('xcodebuild -version', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
    const version = out.split('\n')[0]?.replace('Xcode ', '') ?? ''
    return { label: `Xcode ${version}`, ok: true }
  } catch {
    if (existsSync('/Applications/Xcode.app')) {
      return {
        label: 'Xcode',
        ok: false,
        detail: 'Xcode is installed but xcode-select is not configured. Run: sudo xcode-select -s /Applications/Xcode.app/Contents/Developer',
      }
    }
    return {
      label: 'Xcode',
      ok: false,
      detail: 'Install Xcode from https://developer.apple.com/xcode/ or the Mac App Store.',
    }
  }
}

function checkSimctl(): DoctorCheck {
  try {
    execSync('xcrun simctl list --json', { stdio: 'pipe' })
    return { label: 'xcrun simctl', ok: true }
  } catch {
    return {
      label: 'xcrun simctl',
      ok: false,
      detail: 'Run: xcode-select --install',
    }
  }
}

function checkBootedSimulator(): DoctorCheck {
  try {
    const raw = execSync('xcrun simctl list devices --json', { encoding: 'utf8', stdio: 'pipe' })
    const data = JSON.parse(raw) as { devices: Record<string, Array<{ name: string; state: string; udid: string }>> }
    const allDevices = Object.values(data.devices).flat()
    const booted = allDevices.find((d) => d.state === 'Booted')
    if (booted) {
      return { label: `Simulator booted: ${booted.name}`, ok: true }
    }
    const available = allDevices.find((d) => d.state === 'Shutdown')
    const hint = available
      ? `No simulator is running. Run: tapflow boot "${available.name}"`
      : 'No simulator is running. Run: tapflow devices to see available simulators, then: tapflow boot "<name>"'
    return { label: 'Simulator', ok: false, warn: true, detail: hint }
  } catch {
    return { label: 'Simulator', ok: false, detail: 'Could not query simulators. Is Xcode installed?' }
  }
}

function checkNodeVersion(): DoctorCheck {
  const version = process.version
  const [, major] = version.match(/^v(\d+)/) ?? []
  const ok = Number(major) >= 20
  return {
    label: `Node ${version}`,
    ok,
    detail: ok ? undefined : 'Node ≥ 20 required. Install from https://nodejs.org/',
  }
}

interface AdbResolution {
  path: string
  inPath: boolean
}

function resolveAdb(): AdbResolution | null {
  try {
    const found = execSync('which adb', { encoding: 'utf8', stdio: 'pipe' }).trim()
    if (found) return { path: found, inPath: true }
  } catch {
    // PATH에 없으면 표준 SDK 위치 탐색으로 진행
  }
  for (const candidate of standardAdbPaths()) {
    if (existsSync(candidate)) return { path: candidate, inPath: false }
  }
  return null
}

function standardAdbPaths(): string[] {
  const paths: string[] = []
  if (process.env.ANDROID_HOME) paths.push(join(process.env.ANDROID_HOME, 'platform-tools', 'adb'))
  if (process.env.ANDROID_SDK_ROOT) paths.push(join(process.env.ANDROID_SDK_ROOT, 'platform-tools', 'adb'))
  const home = homedir()
  paths.push(join(home, 'Library', 'Android', 'sdk', 'platform-tools', 'adb')) // macOS
  paths.push(join(home, 'Android', 'Sdk', 'platform-tools', 'adb')) // Linux
  return paths
}

function checkAdb(path: string): DoctorCheck {
  return { label: `adb found: ${path}`, ok: true }
}

function checkBootedAvd(adbCmd: string): DoctorCheck {
  try {
    const out = execSync(`${adbCmd} devices`, { encoding: 'utf8', stdio: 'pipe' })
    const lines = out.trim().split('\n').slice(1).filter(Boolean)
    const emulator = lines.find((l) => l.startsWith('emulator-'))
    if (!emulator) {
      const hint = listAvdHint()
      return {
        label: 'AVD',
        ok: false,
        warn: true,
        detail: hint
          ? `No running emulator. Run: emulator @${hint}`
          : 'No running emulator. Start an AVD from Android Studio > Device Manager.',
      }
    }

    const serial = emulator.split('\t')[0]?.trim() ?? ''
    try {
      const avdName = execSync(`${adbCmd} -s ${serial} emu avd name`, { encoding: 'utf8', stdio: 'pipe' })
        .split('\n')[0]
        ?.trim() ?? serial
      return { label: `AVD: ${avdName}`, ok: true }
    } catch {
      return { label: `AVD: ${serial}`, ok: true }
    }
  } catch {
    return { label: 'AVD', ok: false, detail: 'Could not query running emulators.' }
  }
}

function listAvdHint(): string | null {
  try {
    const out = execSync('emulator -list-avds', { encoding: 'utf8', stdio: 'pipe' }).trim()
    return out.split('\n')[0]?.trim() || null
  } catch {
    return null
  }
}
