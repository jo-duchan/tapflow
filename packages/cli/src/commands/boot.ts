import { execSync } from 'node:child_process'

export async function cmdBoot(nameOrUdid: string): Promise<void> {
  const raw = execSync('xcrun simctl list devices --json', { encoding: 'utf8', stdio: 'pipe' })
  const data = JSON.parse(raw) as {
    devices: Record<string, Array<{ udid: string; name: string; state: string }>>
  }
  const all = Object.values(data.devices).flat()
  const target = all.find(
    (d) => d.udid === nameOrUdid || d.name === nameOrUdid,
  )

  if (!target) {
    console.error(`Device not found: ${nameOrUdid}`)
    console.error('Run `tapflow devices` to see available simulators.')
    process.exit(1)
  }

  if (target.state === 'Booted') {
    console.log(`${target.name} is already booted.`)
    return
  }

  console.log(`Booting ${target.name}…`)
  execSync(`xcrun simctl boot ${target.udid}`, { stdio: 'inherit' })
  console.log(`${target.name} booted.`)
}
