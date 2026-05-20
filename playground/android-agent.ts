import { AndroidAgent } from '@tapflowio/android-agent'

const RELAY = process.env['RELAY_URL'] ?? 'ws://localhost:4000'

const agent = new AndroidAgent()

const shutdown = () => { agent.disconnect(); process.exit(0) }
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)

const devices = await agent.listDevices()
console.log(`Found ${devices.length} emulators`)
devices.forEach((d) => console.log(` · [${d.status}] ${d.name} (${d.id})`))

console.log(`\nConnecting to relay: ${RELAY}`)

const MAX_RETRIES = 10
const RETRY_DELAY_MS = 2000
for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
  try {
    await agent.connect(RELAY)
    break
  } catch (e) {
    if (attempt === MAX_RETRIES) throw e
    console.log(`Relay not ready, retrying in ${RETRY_DELAY_MS / 1000}s… (${attempt}/${MAX_RETRIES})`)
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS))
  }
}

console.log('Android Agent connected')
