const R = '\x1b[0m'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'
const GREEN = '\x1b[32m'
const RED = '\x1b[31m'

const MAX_WIDTH = 72

function wrap(line: string, maxWidth: number): string[] {
  if (line.length <= maxWidth) return [line]
  const chunks: string[] = []
  for (let i = 0; i < line.length; i += maxWidth) {
    chunks.push(line.slice(i, i + maxWidth))
  }
  return chunks
}

export function banner(type: 'success' | 'error', title: string, lines: string[] = []): void {
  const color = type === 'success' ? GREEN : RED
  const icon = type === 'success' ? '✓' : '✗'
  const wrappedLines = lines.flatMap((l) => wrap(l, MAX_WIDTH))
  const contentWidth = Math.min(
    MAX_WIDTH,
    Math.max(title.length + 5, ...wrappedLines.map((l) => l.length + 2), 40),
  )
  const bar = '─'.repeat(contentWidth)

  console.log()
  console.log(`${color}${BOLD}  ┌${bar}┐${R}`)
  console.log(`${color}${BOLD}  │  ${icon}  ${title.padEnd(contentWidth - 5)}│${R}`)
  console.log(`${color}${BOLD}  └${bar}┘${R}`)
  for (const line of wrappedLines) {
    console.log(`${DIM}     ${line}${R}`)
  }
  console.log()
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

export function createSpinner(msg: string) {
  let frame = 0
  let id: ReturnType<typeof setInterval> | null = null

  return {
    start() {
      process.stdout.write(`\n  ${SPINNER_FRAMES[0]}  ${msg}`)
      id = setInterval(() => {
        frame = (frame + 1) % SPINNER_FRAMES.length
        process.stdout.write(`\r  ${SPINNER_FRAMES[frame]}  ${msg}`)
      }, 80)
    },
    stop(ok: boolean) {
      if (id) clearInterval(id)
      const icon = ok ? `${GREEN}✓${R}` : `${RED}✗${R}`
      process.stdout.write(`\r  ${icon}  ${msg}\n`)
    },
  }
}

export function step(msg: string): void {
  console.log(`  ${DIM}→${R}  ${msg}`)
}
