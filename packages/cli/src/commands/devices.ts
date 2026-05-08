import { execSync } from 'node:child_process'

interface SimDevice {
  udid: string
  name: string
  state: string
  deviceTypeIdentifier?: string
}

export function cmdDevices(): void {
  let raw: string
  try {
    raw = execSync('xcrun simctl list devices --json', { encoding: 'utf8', stdio: 'pipe' })
  } catch {
    console.error('Failed to list simulators. Is Xcode installed?')
    process.exit(1)
  }

  const data = JSON.parse(raw) as { devices: Record<string, SimDevice[]> }
  const all = Object.entries(data.devices)
    .flatMap(([runtime, devices]) => devices.map((d) => ({ ...d, runtime })))
    .filter((d) => d.udid)

  if (all.length === 0) {
    console.log('No simulators found.')
    return
  }

  const booted = all.filter((d) => d.state === 'Booted')
  const available = all.filter((d) => d.state === 'Shutdown')

  if (booted.length > 0) {
    console.log('Booted:')
    for (const d of booted) {
      console.log(`  ● ${d.name}  ${d.udid}`)
    }
    console.log()
  }

  console.log('Available:')
  for (const d of available.slice(0, 20)) {
    console.log(`  ○ ${d.name}  ${d.udid}`)
  }
  if (available.length > 20) {
    console.log(`  … and ${available.length - 20} more`)
  }
}
