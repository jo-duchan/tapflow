import { config, assertInstallDir } from '@tapflowio/relay'
import { DIM, RED, R } from '../lib/print.js'

function isLoopbackUrl(base: string): boolean {
  try {
    const host = new URL(base).hostname.replace(/^\[|\]$/g, '')
    return host === 'localhost' || host === '::1' || host.startsWith('127.')
  } catch {
    return false
  }
}

export async function cmdLogs(opts: { relay?: string; lines?: number }): Promise<void> {
  assertInstallDir()
  // The relay serves its log buffer to its own host only, so the default is this machine's relay —
  // not `relay.url`, which on an agent-only Mac names a remote relay that would always answer 403.
  const localRelay = `http://localhost:${config.local.port}`
  const base = (opts.relay ?? localRelay).replace(/^ws/, 'http')
  const lines = opts.lines ?? 100
  const url = `${base}/api/v1/logs?lines=${lines}`

  const res = await fetch(url).catch(() => null)

  if (!res) {
    // An install that names a remote relay and runs none here: before this release the command read
    // `relay.url`, so say why it looked here instead.
    // A loopback relay.url is this machine anyway, so pointing at "the relay host" would send the user away.
    const why = !opts.relay && config.relay.url && !isLoopbackUrl(config.relay.url.replace(/^ws/, 'http'))
      ? `\n  \`tapflow logs\` reads the relay on this machine, not relay.url (${config.relay.url}) — run it on the relay host.`
      : ''
    console.error(`\n  ${RED}✗${R}  Could not reach relay at ${base}\n  Make sure tapflow is running.${why}\n`)
    process.exit(1)
  }
  if (res.status === 403) {
    // A 403 from localhost means the relay saw this CLI as remote: a Docker relay with its port
    // published sees the host through the bridge gateway, so the host is not its own host.
    const message = isLoopbackUrl(base)
      ? `\n  ${RED}✗${R}  Relay at ${base} treated this machine as remote.\n` +
        '  If it runs in Docker, read its logs with `docker compose logs` on this host.\n' +
        '  Otherwise read its output where it runs (terminal, journalctl).\n'
      : `\n  ${RED}✗${R}  Relay at ${base} only serves logs to its own host.\n` +
        `  On the relay host run \`tapflow logs --relay http://localhost:${config.local.port}\`,\n` +
        '  or read its output there (terminal, journalctl, `docker compose logs`).\n'
    console.error(message)
    process.exit(1)
  }
  if (!res.ok) {
    console.error(`\n  ${RED}✗${R}  Relay at ${base} answered ${res.status}\n`)
    process.exit(1)
  }

  const entries: string[] = await res.json()

  if (entries.length === 0) {
    console.log(`\n  ${DIM}No log entries yet.${R}\n`)
    return
  }

  console.log()
  for (const line of entries) {
    console.log(`  ${DIM}${line}${R}`)
  }
  console.log()
}
