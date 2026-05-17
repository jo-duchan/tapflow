import { execSync } from 'node:child_process'
import { banner } from '../lib/print.js'

interface SimDevice {
  udid: string
  name: string
  state: string
}

export function cmdDevices(): void {
  const sections: string[] = []

  // ── iOS ───────────────────────────────────────────────────────────────────
  try {
    const raw = execSync('xcrun simctl list devices --json', { encoding: 'utf8', stdio: 'pipe' })
    const data = JSON.parse(raw) as { devices: Record<string, SimDevice[]> }
    const all = Object.values(data.devices).flat().filter((d) => d.udid)

    const booted = all.filter((d) => d.state === 'Booted')
    const available = all.filter((d) => d.state === 'Shutdown')

    const lines: string[] = []
    if (booted.length > 0) {
      lines.push('  Booted:')
      for (const d of booted) lines.push(`    ● ${d.name}  ${d.udid}`)
    }
    if (available.length > 0) {
      lines.push('  Available:')
      for (const d of available.slice(0, 20)) lines.push(`    ○ ${d.name}  ${d.udid}`)
      if (available.length > 20) lines.push(`    … and ${available.length - 20} more`)
    }
    if (lines.length > 0) sections.push('iOS Simulators:\n' + lines.join('\n'))
  } catch {
    // xcrun not available — skip iOS section
  }

  // ── Android ───────────────────────────────────────────────────────────────
  try {
    execSync('which adb', { stdio: 'pipe' })

    const runningLines: string[] = []
    try {
      const adbOut = execSync('adb devices', { encoding: 'utf8', stdio: 'pipe' })
      const running = adbOut.trim().split('\n').slice(1).filter((l) => l.startsWith('emulator-'))
      for (const line of running) {
        const serial = line.split('\t')[0]?.trim() ?? ''
        try {
          const name = execSync(`adb -s ${serial} emu avd name`, { encoding: 'utf8', stdio: 'pipe' })
            .split('\n')[0]?.trim() ?? serial
          runningLines.push(`    ● ${name}  ${serial}`)
        } catch {
          runningLines.push(`    ● ${serial}`)
        }
      }
    } catch { /* adb devices failed */ }

    const availableLines: string[] = []
    try {
      const avdOut = execSync('emulator -list-avds', { encoding: 'utf8', stdio: 'pipe' }).trim()
      const allAvds = avdOut ? avdOut.split('\n').map((l) => l.trim()).filter(Boolean) : []
      const runningNames = runningLines.map((l) => l.split('  ')[0]?.replace('    ● ', '') ?? '')
      for (const avd of allAvds) {
        if (!runningNames.includes(avd)) availableLines.push(`    ○ ${avd}`)
      }
    } catch { /* emulator not in PATH */ }

    const lines: string[] = []
    if (runningLines.length > 0) {
      lines.push('  Running:')
      lines.push(...runningLines)
    }
    if (availableLines.length > 0) {
      lines.push('  Available:')
      lines.push(...availableLines)
    }
    if (lines.length > 0) sections.push('Android AVDs:\n' + lines.join('\n'))
  } catch {
    // adb not in PATH — skip Android section
  }

  if (sections.length === 0) {
    banner('error', 'NO DEVICES FOUND', ['Run `tapflow doctor` to diagnose your environment.'])
    return
  }

  console.log()
  console.log(sections.join('\n\n'))
  console.log()
}
