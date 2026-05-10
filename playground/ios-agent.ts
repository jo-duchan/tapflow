import { IOSAgent } from '@tapflow/ios-agent'

const RELAY = process.env['RELAY_URL'] ?? 'ws://localhost:3000'

// Accept --device <name|udid> argument
const deviceArgIdx = process.argv.indexOf('--device')
const deviceArg = deviceArgIdx >= 0 ? process.argv[deviceArgIdx + 1] : undefined

const agent = new IOSAgent()

const devices = await agent.listDevices()
console.log('Available simulators:')
devices.forEach((d) => console.log(` · [${d.status}] ${d.name} (${d.id})`))

let target = deviceArg
  ? devices.find((d) => d.name === deviceArg || d.id === deviceArg)
  : devices.find((d) => d.status === 'booted')

if (deviceArg && !target) {
  console.error(`\nDevice not found: ${deviceArg}`)
  process.exit(1)
}

if (target && target.status !== 'booted') {
  console.log(`\nBooting ${target.name}…`)
  await agent.boot(target.id)
}

if (!target) {
  console.log('\nNo booted simulator — waiting for boot request from dashboard.')
}

console.log(`\nConnecting to relay: ${RELAY}`)
await agent.connect(RELAY)
console.log(`iOS Agent connected${target ? ` — streaming ${target.name}` : ' — awaiting boot request'}`)
