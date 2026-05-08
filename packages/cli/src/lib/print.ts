const R = '\x1b[0m'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'
const GREEN = '\x1b[32m'
const RED = '\x1b[31m'

export function banner(type: 'success' | 'error', title: string, lines: string[] = []): void {
  const color = type === 'success' ? GREEN : RED
  const icon = type === 'success' ? '✓' : '✗'
  const contentWidth = Math.max(title.length + 5, ...lines.map((l) => l.length + 2), 40)
  const bar = '─'.repeat(contentWidth)

  console.log()
  console.log(`${color}${BOLD}  ┌${bar}┐${R}`)
  console.log(`${color}${BOLD}  │  ${icon}  ${title.padEnd(contentWidth - 5)}│${R}`)
  console.log(`${color}${BOLD}  └${bar}┘${R}`)
  for (const line of lines) {
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
