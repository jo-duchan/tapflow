import { execSync } from 'node:child_process'
import { IOSAgent } from '@tapflowio/ios-agent'
import { banner, createSpinner, step } from './print.js'

export async function resolveAndBootIOSDevice(deviceFilter?: string): Promise<IOSAgent> {
  const agent = new IOSAgent()
  const devices = await agent.listDevices()

  if (deviceFilter) {
    const match = devices.find((d) => d.name === deviceFilter || d.id === deviceFilter)
    if (!match) {
      banner('error', 'DEVICE NOT FOUND', [
        `"${deviceFilter}" does not match any simulator.`,
        'Run `tapflow devices` to see available simulators.',
      ])
      process.exit(1)
    }
    if (match.status !== 'booted') {
      const spinner = createSpinner(`Booting ${match.name}…`)
      spinner.start()
      execSync(`xcrun simctl boot ${match.id}`, { stdio: 'pipe' })
      spinner.stop(true)
    }
    step(`iOS Simulator: ${match.name}`)
  } else {
    const booted = devices.find((d) => d.status === 'booted')
    if (booted) {
      step(`iOS Simulator: ${booted.name}`)
    } else {
      const first = devices[0]
      if (!first) {
        banner('error', 'NO SIMULATOR FOUND', ['Create one in Xcode → Window → Devices and Simulators.'])
        process.exit(1)
      }
      const spinner = createSpinner(`Booting ${first.name}…`)
      spinner.start()
      execSync(`xcrun simctl boot ${first.id}`, { stdio: 'pipe' })
      spinner.stop(true)
      step(`iOS Simulator: ${first.name}`)
    }
  }

  return agent
}
