import { config } from '@tapflowio/relay'
import { DIM, RED, R } from '../lib/print.js'

export async function cmdLogs(opts: { relay?: string; lines?: number }): Promise<void> {
  const defaultRelay = config.relay.url ?? `http://localhost:${config.local.port}`
  const base = (opts.relay ?? defaultRelay).replace(/^ws/, 'http')
  const lines = opts.lines ?? 100
  const url = `${base}/api/v1/logs?lines=${lines}`

  const res = await fetch(url).catch(() => null)

  if (!res || !res.ok) {
    console.error(`\n  ${RED}✗${R}  Could not reach relay at ${base}\n  Make sure tapflow is running.\n`)
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
