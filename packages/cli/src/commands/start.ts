import { execSync } from 'node:child_process'
import { RelayServer } from '@tapflow/relay'
import { IOSAgent } from '@tapflow/ios-agent'

export interface StartOptions {
  device?: string
  relay?: string
}

export async function cmdStart(opts: StartOptions): Promise<void> {
  const relayUrl = opts.relay ?? 'ws://localhost:3000'

  if (!opts.relay) {
    const server = new RelayServer({ port: 3000 })
    await server.start()
    console.log('Relay started on ws://localhost:3000')
  }

  const agent = new IOSAgent({ wda: { autoStart: true } })

  const devices = await agent.listDevices()
  let targetId: string | undefined

  if (opts.device) {
    const target = devices.find((d) => d.name === opts.device || d.id === opts.device)
    if (!target) {
      console.error(`Device not found: ${opts.device}`)
      console.error('Run `tapflow devices` to see available simulators.')
      process.exit(1)
    }
    if (target.status !== 'booted') {
      console.log(`Booting ${target.name}…`)
      execSync(`xcrun simctl boot ${target.id}`, { stdio: 'pipe' })
    }
    targetId = target.id
  } else {
    const booted = devices.find((d) => d.status === 'booted')
    if (!booted) {
      const first = devices[0]
      if (!first) {
        console.error('No simulators found. Create one in Xcode.')
        process.exit(1)
      }
      console.log(`No booted simulator found. Booting ${first.name}…`)
      execSync(`xcrun simctl boot ${first.id}`, { stdio: 'pipe' })
      targetId = first.id
    } else {
      targetId = booted.id
    }
  }

  console.log(`Connecting agent to relay: ${relayUrl}`)
  await agent.connect(relayUrl)
  console.log('Agent connected. Press Ctrl+C to stop.\n')

  process.on('SIGINT', () => {
    agent.disconnect()
    process.exit(0)
  })
}
