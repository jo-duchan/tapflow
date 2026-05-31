import { text, password, isCancel, cancel } from '@clack/prompts'
import { config } from '@tapflowio/relay'
import { createSpinner, banner, step } from '../lib/print.js'

export interface InitOptions {
  relay?: string
}

export async function cmdAdminInit(opts: InitOptions): Promise<void> {
  const defaultRelay = config.relay.url ?? `http://localhost:${config.local.port}`
  const baseUrl = (opts.relay ?? defaultRelay).replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://')

  const email = await text({
    message: 'Admin email',
    placeholder: 'admin@yourteam.com',
    validate: (v) => !v?.trim() ? 'Required' : undefined,
  })
  if (isCancel(email)) { cancel('Cancelled.'); process.exit(0) }

  const pw = await password({
    message: 'Password',
    validate: (v) => (v?.length ?? 0) < 8 ? 'Must be at least 8 characters' : undefined,
  })
  if (isCancel(pw)) { cancel('Cancelled.'); process.exit(0) }

  const spinner = createSpinner('Creating admin account...')
  spinner.start()

  let res: Response | null = null
  try {
    res = await fetch(`${baseUrl}/api/v1/auth/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.trim(), password: pw }),
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
  banner('success', 'Admin account created', [`Email: ${email.trim()}`])
  step(`Open ${baseUrl} to sign in`)
}
