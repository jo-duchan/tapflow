const DIM = '\x1b[2m'
const R = '\x1b[0m'

export async function cmdLogs(opts: { relay?: string; lines?: number }): Promise<void> {
  const base = (opts.relay ?? 'http://localhost:4000').replace(/^ws/, 'http')
  const lines = opts.lines ?? 100
  const url = `${base}/api/v1/logs?lines=${lines}`

  const res = await fetch(url).catch(() => null)

  if (!res || !res.ok) {
    console.error(`\n  \x1b[31m✗\x1b[0m  Could not reach relay at ${base}\n  Make sure tapflow is running.\n`)
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
