import { AgentRegistry } from '@tapflow/agent-core'
import { AndroidAgent } from '@tapflow/android-agent'

const RELAY = process.env.RELAY_URL ?? 'ws://localhost:3000'

AgentRegistry.register('android', AndroidAgent)

const agent = new AndroidAgent()
await agent.connect({ relay: RELAY })

const devices = await agent.listDevices()
console.log('Available emulators:')
devices.forEach((d) => console.log(` · ${d.name} (${d.id})`))

console.log(`\nAndroid Agent connected → ${RELAY}`)
