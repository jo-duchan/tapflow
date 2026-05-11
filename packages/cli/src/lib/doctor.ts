import { execSync } from 'node:child_process'

export interface DoctorCheck {
  label: string
  ok: boolean
  detail?: string
}

export async function runDoctorChecks(): Promise<DoctorCheck[]> {
  return [
    checkMacOS(),
    checkXcode(),
    checkSimctl(),
    checkBootedSimulator(),
    checkNodeVersion(),
  ]
}

function checkMacOS(): DoctorCheck {
  const ok = process.platform === 'darwin'
  return {
    label: 'macOS',
    ok,
    detail: ok ? undefined : 'tapflow is macOS-only',
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
