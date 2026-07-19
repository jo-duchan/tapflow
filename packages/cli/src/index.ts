import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { cac } from 'cac'

const __dirname = dirname(fileURLToPath(import.meta.url))
const { version } = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8')) as { version: string }
import { cmdInitConfig } from './commands/init.js'
import { cmdAdminInit } from './commands/admin-init.js'
import { cmdDoctor } from './commands/doctor.js'
import { cmdSetup } from './commands/setup.js'
import { cmdDevices } from './commands/devices.js'
import { cmdBoot } from './commands/boot.js'
import { cmdStart } from './commands/start.js'
import { cmdRelayStart } from './commands/relay-start.js'
import { cmdAgentStart } from './commands/agent-start.js'
import { cmdReset } from './commands/reset.js'
import { cmdStatus } from './commands/status.js'
import { cmdLogs } from './commands/logs.js'
import { cmdFlowRun, type FlowRunOptions } from './commands/flow-run.js'
import { cmdMigrateDataDir } from './commands/migrate.js'

process.on('unhandledRejection', (err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})

const cli = cac('tapflow')

cli
  .command('init', 'Scaffold tapflow.config.json interactively')
  .option('--tunnel <provider>', 'Tunnel provider: tailscale or rathole')
  .option('--force', 'Overwrite existing tapflow.config.json')
  .action((opts: { tunnel?: string; force?: boolean }) => cmdInitConfig(opts))

cli
  .command('admin <subcommand>', 'Admin account commands (subcommand: init)')
  .option('--relay <url>', 'Relay URL (default: http://localhost:4000)')
  .action((subcommand: string, opts: { relay?: string }) => {
    if (subcommand === 'init') return cmdAdminInit(opts)
    console.error(`Unknown subcommand: admin ${subcommand}`)
    process.exit(1)
  })

cli
  .command('doctor [platform]', 'Check system prerequisites (ios | android; omit for all)')
  .option('--json', 'Output machine-readable JSON')
  .action((platform: string | undefined, opts: { json?: boolean }) => cmdDoctor({ ...opts, platform }))

cli
  .command('setup [platform]', 'Set up the environment (ios | android; omit to auto-detect)')
  .action((platform?: string) => cmdSetup(platform))

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
  .option('--tunnel <provider>', 'Tunnel provider to use (e.g. rathole). Requires tunnel config in tapflow.config.json')
  .action((subcommand: string, opts: { port?: number; tunnel?: string }) => {
    if (subcommand === 'start') return cmdRelayStart(opts)
    console.error(`Unknown subcommand: relay ${subcommand}`)
    process.exit(1)
  })

cli
  .command('agent <subcommand>', 'Agent commands (subcommand: start)')
  .option('--relay <url>', 'Relay WebSocket URL (default: ws://localhost:4000)')
  .option('--platform <platform>', 'Platform to start: registered key or all (default: auto-detect)')
  .option('--device <name>', 'iOS Simulator name or UDID to use')
  .option('--token <pat>', "PAT with 'agent' scope for remote relays (or TAPFLOW_AGENT_TOKEN)")
  .action((subcommand: string, opts: { relay?: string; platform?: string; device?: string; token?: string }) => {
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

cli
  .command('flow <subcommand> [...files]', 'Deterministic flow commands (subcommand: run)')
  .option('--relay <url>', 'Relay URL (default: ws://localhost:4000)')
  .option('--token <token>', 'PAT for a remote relay (or TAPFLOW_TOKEN env)')
  .option('--session <id>', 'Target session id (from tapflow status)')
  .option('--device <name>', 'Target device by name (boots it when shut down)')
  .option('--build <id>', 'Build under test — installed before the run, launched by the launchApp step')
  .option('--no-install', 'Skip installing --build before the run')
  .option('--junit <path>', 'Write a JUnit XML report')
  .option('--artifacts <dir>', 'Failure screenshot directory (default: .tapflow/artifacts)')
  .option('--timeout <seconds>', 'Default per-selector wait (default: 10)')
  .action((subcommand: string, files: string[], opts: FlowRunOptions & { build?: string | number; timeout?: string | number }) => {
    if (subcommand !== 'run') {
      console.error(`unknown flow subcommand: ${subcommand} (expected: run)`)
      process.exit(2)
    }
    return cmdFlowRun(files, {
      ...opts,
      build: opts.build !== undefined ? Number(opts.build) : undefined,
      timeout: opts.timeout !== undefined ? Number(opts.timeout) : undefined,
    })
  })

cli
  .command('migrate <subcommand>', 'Migration commands (subcommand: data-dir)')
  .action((subcommand: string) => {
    if (subcommand === 'data-dir') return cmdMigrateDataDir()
    console.error(`Unknown subcommand: migrate ${subcommand}`)
    process.exit(1)
  })

cli.help()
cli.version(version)
cli.parse()
