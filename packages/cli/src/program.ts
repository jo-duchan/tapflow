import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { cac, type CAC } from 'cac'

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
import { cmdTokenSet, cmdTokenStatus } from './commands/token.js'
import { cmdReset } from './commands/reset.js'
import { cmdStatus } from './commands/status.js'
import { cmdLogs } from './commands/logs.js'
import { cmdFlowRun, secretArg, tagsArg, type FlowRunOptions, type TagsArg } from './commands/flow-run.js'
import { cmdMigrate, cmdMigrateDataDir, cmdMigrateNetFilter } from './commands/migrate.js'

/**
 * The whole command surface, built without parsing anything.
 *
 * Split from `index.ts` so a test can walk the real definition — `cli.commands` and their options —
 * rather than re-reading this file as text. `src/__tests__/cliDocsParity.test.ts` compares it with
 * `docs/reference/cli.md` in both directions. Importing this module parses no argv and installs no
 * process handlers; `index.ts` does both.
 */
export function createCli(): CAC {
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
    .command('token <subcommand>', 'Token commands (subcommand: set | status)')
    .option('--relay <url>', 'Relay URL the token is for (default: TAPFLOW_RELAY_URL, else ws://localhost:4000)')
    .action(async (subcommand: string, opts: { relay?: string }) => {
      // A prompt nobody answers (a TTY with no one on the other end) never settles, and node exits when the loop
      // empties; without this that exit is 0 with nothing stored. A normal return overwrites it.
      process.exitCode = 1
      if (subcommand === 'set') process.exitCode = await cmdTokenSet(opts)
      else if (subcommand === 'status') process.exitCode = await cmdTokenStatus(opts)
      else {
        console.error(`Unknown subcommand: token ${subcommand} (expected: set | status)`)
        process.exit(1)
      }
    })

  cli
    .command('reset', 'Shut down all simulators')
    .action(() => cmdReset())

  cli
    .command('status', 'Show connected agents, devices, and active sessions')
    .option('--relay <url>', 'Relay URL (default: ws://localhost:4000)')
    .action((opts: { relay?: string }) => cmdStatus(opts))

  cli
    .command('logs', 'Show recent relay log entries (on the relay host)')
    .option('--relay <url>', 'Relay URL on this machine (default: http://localhost:<local.port>)')
    .option('--lines <n>', 'Number of lines to show (default: 100)', { default: 100 })
    .action((opts: { relay?: string; lines?: number }) => cmdLogs(opts))

  cli
    .command('flow <subcommand> [...files]', 'Deterministic flow commands (subcommand: run)')
    .option('--relay <url>', 'Relay URL (default: ws://localhost:4000)')
    .option('--token <token>', 'PAT for a remote relay (or TAPFLOW_TOKEN env, or ~/.config/tapflow/credentials.json)')
    .option('--session <id>', "Target session id, for when --device matches more than one device (the MCP server's list_devices shows it)")
    .option('--device <name>', 'Target device by name (boots it when shut down)')
    .option('--build <id>', 'Build under test — installed before the run, launched by the launchApp step')
    .option('--no-install', 'Skip installing --build before the run')
    .option('--junit <path>', 'Write a JUnit XML report')
    .option('--artifacts <dir>', 'Failure screenshot directory (default: .tapflow/artifacts)')
    .option('--timeout <seconds>', 'Default per-selector wait (default: 10)')
    .option('--service-tier <tier>', 'Services the device boots with: stock, lean or slim (iOS 18.5+; default: the agent\'s setting)')
    .option('--keep <features>', 'Features to keep on under --service-tier (comma-separated, e.g. push,photos)')
    .option('--admission-timeout <seconds>', 'How long to wait while another device boots on the same Mac, or the Mac is over its CPU or memory limit (default: 600)')
    .option('--no-record', 'Do not record this run on the relay')
    .option('--no-reset', 'Keep what earlier runs left on the device (by default the run resets app data, keychain, privacy grants, pasteboard and location)')
    .option('--include-tags <tags>', 'Run only flows tagged with at least one of these (comma-separated)')
    .option('--exclude-tags <tags>', 'Skip flows tagged with any of these (comma-separated); wins over --include-tags')
    .option('--parallel <n>', 'Share the flows across up to n devices the relay chooses and boots (1-16)')
    .option('--platform <platform>', 'ios or android: the platform of a --parallel run without --build')
    .option('--secret <name>', 'An environment variable an inputText { secret: NAME } step may type; repeat for each')
    .action((subcommand: string, files: string[], opts: Omit<FlowRunOptions, 'includeTags' | 'excludeTags' | 'secret'> & {
      build?: string | number; timeout?: string | number; admissionTimeout?: string | number; includeTags?: TagsArg; excludeTags?: TagsArg
      parallel?: string | number; secret?: TagsArg
    }) => {
      if (subcommand !== 'run') {
        console.error(`unknown flow subcommand: ${subcommand} (expected: run)`)
        process.exit(2)
      }
      return cmdFlowRun(files, {
        ...opts,
        build: opts.build !== undefined ? Number(opts.build) : undefined,
        timeout: opts.timeout !== undefined ? Number(opts.timeout) : undefined,
        admissionTimeout: opts.admissionTimeout !== undefined ? Number(opts.admissionTimeout) : undefined,
        parallel: opts.parallel !== undefined ? Number(opts.parallel) : undefined,
        includeTags: tagsArg(opts.includeTags),
        excludeTags: tagsArg(opts.excludeTags),
        secret: secretArg(opts.secret),
      })
    })

  cli
    .command('migrate [subcommand]', 'Run every migration this install needs, or one (subcommand: data-dir | net-filter)')
    // Named for what it ignores rather than `--force`. `migrate` is one command with a positional, so
    // cac offers every option to every subcommand and the help text cannot say otherwise — a flag
    // called `--force` here would read as `init --force` does (overwrite a file) rather than as this
    // (replace a network filter while somebody is testing through it).
    .option('--ignore-running-devices', 'net-filter only: replace the filter even though devices are in use')
    .action((subcommand: string | undefined, options: { ignoreRunningDevices?: boolean }) => {
      if (subcommand === undefined) {
        // Each migration runs with its defaults here: a flag that belongs to one step would read as
        // applying to all of them.
        if (options.ignoreRunningDevices) {
          console.error('--ignore-running-devices applies to `migrate net-filter` only.')
          process.exit(1)
        }
        return cmdMigrate()
      }
      if (subcommand === 'data-dir') {
        // **Rejected rather than ignored**, for the same reason the flag is named that way: cac accepts
        // it here, and an option that silently does nothing reads as one that worked.
        if (options.ignoreRunningDevices) {
          console.error('--ignore-running-devices applies to `migrate net-filter` only.')
          process.exit(1)
        }
        return cmdMigrateDataDir()
      }
      if (subcommand === 'net-filter') {
        return cmdMigrateNetFilter({ ignoreRunningDevices: options.ignoreRunningDevices })
      }
      console.error(`Unknown subcommand: migrate ${subcommand}`)
      process.exit(1)
    })

  cli.help()
  cli.version(version)
  return cli
}
