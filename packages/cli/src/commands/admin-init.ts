import * as readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { config } from '@tapflowio/relay'
import { createSpinner, banner, step } from '../lib/print.js'

export interface InitOptions {
  relay?: string
}

function readPassword(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const rl = readline.createInterface({ input, output })
    return rl.question(prompt).then((v) => { rl.close(); return v.trim() })
  }
  return new Promise((resolve) => {
    process.stdout.write(prompt)
    const chars: string[] = []
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.setEncoding('utf8')
    const onData = (ch: string) => {
      if (ch === '\r' || ch === '\n') {
        process.stdin.setRawMode(false)
        process.stdin.pause()
        process.stdin.removeListener('data', onData)
        process.stdout.write('\n')
        resolve(chars.join(''))
      } else if (ch === '') {
        process.stdout.write('\n')
        process.exit(0)
      } else if (ch === '' || ch === '\b') {
        if (chars.length > 0) {
          chars.pop()
          process.stdout.write('\b \b')
        }
      } else if (ch >= ' ') {
        chars.push(ch)
        process.stdout.write('*')
      }
    }
    process.stdin.on('data', onData)
  })
}

export async function cmdAdminInit(opts: InitOptions): Promise<void> {
  const defaultRelay = config.relay.url ?? `http://localhost:${config.local.port}`
  const baseUrl = (opts.relay ?? defaultRelay).replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://')

  const rl = readline.createInterface({ input, output })
  const email = (await rl.question('  ? Admin email: ')).trim()
  rl.close()

  const password = await readPassword('  ? Password: ')

  if (!email) {
    banner('error', 'INVALID INPUT', ['Email is required.'])
    process.exit(1)
  }
  if (!password || password.length < 8) {
    banner('error', 'INVALID INPUT', ['Password must be at least 8 characters.'])
    process.exit(1)
  }

  const spinner = createSpinner('Creating admin account...')
  spinner.start()

  let res: Response | null = null
  try {
    res = await fetch(`${baseUrl}/api/v1/auth/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
  } catch {
    spinner.stop(false)
    banner('error', 'Could not connect to relay', [
      `Relay not found at ${baseUrl}`,
      'Run tapflow start first, then tapflow admin init.',
    ])
    process.exit(1)
  }

  if (!res.ok) {
    spinner.stop(false)
    let errorMsg: string | undefined
    try {
      const ct = res.headers.get('content-type') ?? ''
      if (ct.includes('application/json')) {
        const data = await res.json() as { error?: string }
        errorMsg = data.error
      }
    } catch { /* non-JSON body — ignore */ }
    if (res.status === 403) {
      banner('error', 'Already initialized', [
        'An admin account already exists.',
        'Use Settings → Team in the dashboard to manage users.',
      ])
    } else {
      banner('error', 'Failed to create admin', [errorMsg ?? `HTTP ${res.status}`])
    }
    process.exit(1)
  }

  spinner.stop(true)
  banner('success', 'Admin account created', [`Email: ${email}`])
  step(`Open ${baseUrl} to sign in`)
}
