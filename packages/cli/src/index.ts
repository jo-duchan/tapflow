import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { cac } from 'cac'

const __dirname = dirname(fileURLToPath(import.meta.url))
const { version } = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8')) as { version: string }
import { cmdInit } from './commands/init.js'
import { cmdDoctor } from './commands/doctor.js'
import { cmdDevices } from './commands/devices.js'
import { cmdBoot } from './commands/boot.js'
import { cmdStart } from './commands/start.js'
import { cmdRelayStart } from './commands/relay-start.js'
import { cmdAgentStart } from './commands/agent-start.js'
import { cmdReset } from './commands/reset.js'
import { cmdStatus } from './commands/status.js'
import { cmdLogs } from './commands/logs.js'

process.on('unhandledRejection', (err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})

const cli = cac('tapflow')

cli
  .command('init', 'Create the first admin account on the relay')
  .option('--relay <url>', 'Relay URL (default: http://localhost:4000)')
  .action((opts: { relay?: string }) => cmdInit(opts))

cli
  .command('doctor', 'Check system prerequisites')
  .action(() => cmdDoctor())

cli
  .command('devices', 'List available iOS simulators and Android AVDs')
  .action(() => cmdDevices())

cli
  .command('boot <name>', 'Boot a simulator by name or UDID')
  .action((name: string) => cmdBoot(name))

cli
  .command('start', 'Start relay and available agents locally (local dev shortcut)')
  .option('--platform <platform>', 'Platform to start: registered key or all (default: auto-detect)')
  .option('--device <name>', 'iOS Simulator name or UDID to use')
  .action((opts: { platform?: string; device?: string }) => cmdStart(opts))

cli
  .command('relay <subcommand>', 'Relay server commands (subcommand: start)')
  .option('--port <n>', 'Port to listen on (default: 4000)')
  .action((subcommand: string, opts: { port?: number }) => {
    if (subcommand === 'start') return cmdRelayStart(opts)
    console.error(`Unknown subcommand: relay ${subcommand}`)
    process.exit(1)
  })

cli
  .command('agent <subcommand>', 'Agent commands (subcommand: start)')
  .option('--relay <url>', 'Relay WebSocket URL (default: ws://localhost:4000)')
  .option('--platform <platform>', 'Platform to start: registered key or all (default: auto-detect)')
  .option('--device <name>', 'iOS Simulator name or UDID to use')
  .action((subcommand: string, opts: { relay?: string; platform?: string; device?: string }) => {
    if (subcommand === 'start') return cmdAgentStart(opts)
    console.error(`Unknown subcommand: agent ${subcommand}`)
    process.exit(1)
  })

cli
  .command('reset', 'Shut down all simulators')
  .action(() => cmdReset())

cli
  .command('status', 'Show connected agents, devices, and active sessions')
  .option('--relay <url>', 'Relay URL (default: ws://localhost:4000)')
  .action((opts: { relay?: string }) => cmdStatus(opts))

cli
  .command('logs', 'Show recent relay log entries')
  .option('--relay <url>', 'Relay URL (default: http://localhost:4000)')
  .option('--lines <n>', 'Number of lines to show (default: 100)', { default: 100 })
  .action((opts: { relay?: string; lines?: number }) => cmdLogs(opts))

cli.help()
cli.version(version)
cli.parse()
