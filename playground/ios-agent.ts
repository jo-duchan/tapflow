import { IOSAgent } from '@tapflow/ios-agent'

const RELAY = process.env.RELAY_URL ?? 'ws://localhost:3000'

const agent = new IOSAgent()

const devices = await agent.listDevices()
console.log('Available simulators:')
devices.forEach((d) => console.log(` · [${d.status}] ${d.name} (${d.id})`))

const booted = devices.find((d) => d.status === 'booted')
if (!booted) {
  console.log('\nNo booted simulator found. Boot one first:')
  console.log('  xcrun simctl boot <device-id>')
  process.exit(1)
}

console.log(`\nConnecting to relay: ${RELAY}`)
await agent.connect(RELAY)
console.log(`iOS Agent connected — streaming ${booted.name}`)
