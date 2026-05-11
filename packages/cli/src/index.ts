import { cac } from 'cac'
import { cmdDoctor } from './commands/doctor.js'
import { cmdDevices } from './commands/devices.js'
import { cmdBoot } from './commands/boot.js'
import { cmdStart } from './commands/start.js'
import { cmdReset } from './commands/reset.js'

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

cli.help()
cli.version('0.1.0')
cli.parse()
