import { config, assertInstallDir } from '@tapflowio/relay'
import { DIM, RED, R } from '../lib/print.js'

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
    console.error(`\n  ${RED}✗${R}  Could not reach relay at ${base}\n  Make sure tapflow is running.\n`)
    process.exit(1)
  }
  if (res.status === 403) {
    console.error(
      `\n  ${RED}✗${R}  Relay at ${base} only serves logs to its own host.\n` +
      `  On the relay machine run \`tapflow logs --relay http://localhost:${config.local.port}\`,\n` +
      '  or read its output there (terminal, journalctl, `docker compose logs`).\n',
    )
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
