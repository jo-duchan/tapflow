import { execSync } from 'node:child_process'

export interface DoctorCheck {
  label: string
  ok: boolean
  detail?: string
}

export interface DoctorResult {
  common: DoctorCheck[]
  ios: DoctorCheck[] | null
  android: DoctorCheck[] | null
}

export async function runDoctorChecks(): Promise<DoctorResult> {
  const isMac = process.platform === 'darwin'
  const adbPath = resolveAdb()

  return {
    common: [checkNodeVersion()],
    ios: isMac ? [checkXcode(), checkSimctl(), checkBootedSimulator()] : null,
    android: adbPath !== null ? [checkAdb(adbPath), checkBootedAvd()] : null,
  }
}

function checkXcode(): DoctorCheck {
  try {
    const out = execSync('xcodebuild -version', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
    const version = out.split('\n')[0]?.replace('Xcode ', '') ?? ''
    return { label: `Xcode ${version}`, ok: true }
  } catch {
    return {
      label: 'Xcode',
      ok: false,
      detail: 'Not installed. Install Xcode from the App Store.',
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
      detail: 'Run `xcode-select --install` to install command-line tools.',
    }
  }
}

function checkBootedSimulator(): DoctorCheck {
  try {
    const raw = execSync('xcrun simctl list devices --json', { encoding: 'utf8', stdio: 'pipe' })
    const data = JSON.parse(raw) as { devices: Record<string, Array<{ name: string; state: string }>> }
    const booted = Object.values(data.devices)
      .flat()
      .find((d) => d.state === 'Booted')
    if (booted) {
      return { label: `Simulator booted: ${booted.name}`, ok: true }
    }
    return {
      label: 'Simulator',
      ok: false,
      detail: 'No booted simulator. Run `tapflow boot <name>` or open Simulator.app.',
    }
  } catch {
    return { label: 'Simulator', ok: false, detail: 'Could not query simulators.' }
  }
}

function checkNodeVersion(): DoctorCheck {
  const version = process.version
  const [, major] = version.match(/^v(\d+)/) ?? []
  const ok = Number(major) >= 20
  return {
    label: `Node ${version}`,
    ok,
    detail: ok ? undefined : 'Node ≥ 20 required.',
  }
}

function resolveAdb(): string | null {
  try {
    const path = execSync('which adb', { encoding: 'utf8', stdio: 'pipe' }).trim()
    return path || null
  } catch {
    return null
  }
}

function checkAdb(path: string): DoctorCheck {
  return { label: `adb found: ${path}`, ok: true }
}

function checkBootedAvd(): DoctorCheck {
  try {
    const out = execSync('adb devices', { encoding: 'utf8', stdio: 'pipe' })
    const lines = out.trim().split('\n').slice(1).filter(Boolean)
    const emulator = lines.find((l) => l.startsWith('emulator-'))
    if (!emulator) {
      return {
        label: 'AVD',
        ok: false,
        detail: 'No running emulator. Start an AVD from Android Studio or `emulator @<avd>`.',
      }
    }

    const serial = emulator.split('\t')[0]?.trim() ?? ''
    try {
      const avdName = execSync(`adb -s ${serial} emu avd name`, { encoding: 'utf8', stdio: 'pipe' })
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
