#!/usr/bin/env node
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

try {
  if (!process.stdout.isTTY) process.exit(0)
  if (process.env.CI) process.exit(0)
  if (process.env.npm_config_global !== 'true') process.exit(0)

  const __dirname = dirname(fileURLToPath(import.meta.url))
  const { version } = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'))

  const R = '\x1b[0m'
  const BOLD = '\x1b[1m'
  const DIM = '\x1b[2m'
  const GREEN = '\x1b[32m'

  const title = `tapflow v${version} installed successfully`
  const width = Math.max(title.length + 5, 50)
  const bar = '─'.repeat(width)

  console.log()
  console.log(`${GREEN}${BOLD}  ┌${bar}┐${R}`)
  console.log(`${GREEN}${BOLD}  │  ✓  ${title.padEnd(width - 5)}│${R}`)
  console.log(`${GREEN}${BOLD}  └${bar}┘${R}`)
  console.log()
  console.log(`${DIM}     Next steps:${R}`)
  console.log(`${DIM}       tapflow doctor        check system prerequisites${R}`)
  console.log(`${DIM}       tapflow init          create your first admin account${R}`)
  console.log(`${DIM}       tapflow start         start relay + agent${R}`)
  console.log()
  console.log(`${DIM}     Docs: https://github.com/jo-duchan/tapflow${R}`)
  console.log()
} catch {
  process.exit(0)
}
