import { cac } from 'cac'
import { cmdDoctor } from './commands/doctor.js'
import { cmdDevices } from './commands/devices.js'
import { cmdBoot } from './commands/boot.js'
import { cmdStart } from './commands/start.js'
import { cmdReset } from './commands/reset.js'
import { cmdStatus } from './commands/status.js'
import { cmdLogs } from './commands/logs.js'

const cli = cac('tapflow')

cli
  .command('doctor', 'Check system prerequisites')
  .action(() => cmdDoctor())

cli
  .command('devices', 'List available simulators')
  .action(() => cmdDevices())

cli
  .command('boot <name>', 'Boot a simulator by name or UDID')
  .action((name: string) => cmdBoot(name))

cli
  .command('start', 'Start relay + iOS agent (one-command setup)')
  .option('--device <name>', 'Simulator name or UDID to use')
  .option('--relay <url>', 'Relay WebSocket URL (skips local relay spawn)')
  .action((opts: { device?: string; relay?: string }) => cmdStart(opts))

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
cli.version('0.1.0')
cli.parse()
