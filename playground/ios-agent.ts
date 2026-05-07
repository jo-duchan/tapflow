import { AgentRegistry } from '@tapflow/agent-core'
import { IOSAgent } from '@tapflow/ios-agent'

const RELAY = process.env.RELAY_URL ?? 'ws://localhost:3000'

AgentRegistry.register('ios', IOSAgent)

const agent = new IOSAgent()
await agent.connect({ relay: RELAY })

const devices = await agent.listDevices()
console.log('Available simulators:')
devices.forEach((d) => console.log(` · ${d.name} (${d.id})`))

console.log(`\niOS Agent connected → ${RELAY}`)
