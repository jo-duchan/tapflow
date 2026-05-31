import fs from 'fs'
import path from 'path'
import { select, text, isCancel, cancel } from '@clack/prompts'
import { banner } from '../lib/print.js'

export interface InitConfigOptions {
  tunnel?: string
  force?: boolean
}

const BASE_CONFIG = {
  local: { port: 4000, dataDir: '.tapflow-data' },
  relay: { url: '' },
  smtp: { host: '', port: 587, secure: false, user: '', pass: '' },
}

type TunnelConfig =
  | { provider: 'tailscale'; publicUrl?: string }
  | { provider: 'rathole'; serverAddr: string; publicUrl: string; ssh: { host: string; user: string; keyPath: string } | null }

function addToGitignore(dir: string, entry: string): 'created' | 'appended' | 'already-present' {
  const gitignorePath = path.join(dir, '.gitignore')
  if (fs.existsSync(gitignorePath)) {
    const content = fs.readFileSync(gitignorePath, 'utf-8')
    if (content.split('\n').some((line) => line.trim() === entry)) return 'already-present'
    const separator = content.endsWith('\n') ? '' : '\n'
    fs.appendFileSync(gitignorePath, `${separator}\n# tapflow runtime data\n${entry}\n`, 'utf-8')
    return 'appended'
  }
  fs.writeFileSync(gitignorePath, `# tapflow runtime data\n${entry}\n`, 'utf-8')
  return 'created'
}

async function promptTunnel(): Promise<TunnelConfig | null> {
  const provider = await select({
    message: 'Tunnel provider',
    options: [
      { value: 'none', label: 'None', hint: 'local only' },
      { value: 'tailscale', label: 'Tailscale', hint: 'recommended — E2E encrypted, no VPS required' },
      { value: 'rathole', label: 'rathole', hint: 'VPS required' },
    ],
  })

  if (isCancel(provider)) { cancel('Cancelled.'); process.exit(0) }
  if (provider === 'tailscale') return { provider: 'tailscale' }
  if (provider !== 'rathole') return null

  const serverAddr = await text({
    message: 'VPS server address',
    placeholder: 'example.com:2333',
    validate: (v) => !v?.trim() ? 'Required' : undefined,
  })
  if (isCancel(serverAddr)) { cancel('Cancelled.'); process.exit(0) }

  const publicUrl = await text({
    message: 'Public URL',
    placeholder: 'https://example.com',
    validate: (v) => !v?.trim() ? 'Required' : undefined,
  })
  if (isCancel(publicUrl)) { cancel('Cancelled.'); process.exit(0) }

  const sshHost = await text({
    message: 'SSH host',
    placeholder: 'example.com  (leave blank to skip)',
  })
  if (isCancel(sshHost)) { cancel('Cancelled.'); process.exit(0) }

  let ssh: { host: string; user: string; keyPath: string } | null = null
  if (sshHost && sshHost.trim()) {
    const sshUser = await text({
      message: 'SSH user',
      placeholder: 'ubuntu',
      defaultValue: 'ubuntu',
    })
    if (isCancel(sshUser)) { cancel('Cancelled.'); process.exit(0) }

    const sshKeyPath = await text({
      message: 'SSH key path',
      placeholder: '~/.ssh/id_ed25519',
      defaultValue: '~/.ssh/id_ed25519',
    })
    if (isCancel(sshKeyPath)) { cancel('Cancelled.'); process.exit(0) }

    ssh = { host: sshHost.trim(), user: sshUser || 'ubuntu', keyPath: sshKeyPath || '~/.ssh/id_ed25519' }
  }

  return { provider: 'rathole', serverAddr: serverAddr.trim(), publicUrl: publicUrl.trim(), ssh }
}

export async function cmdInitConfig(opts: InitConfigOptions): Promise<void> {
  const configPath = path.join(process.cwd(), 'tapflow.config.json')

  if (fs.existsSync(configPath) && !opts.force) {
    banner('error', 'ALREADY INITIALIZED', [
      'tapflow.config.json already exists.',
      'Use --force to overwrite.',
    ])
    process.exit(1)
  }

  const SUPPORTED = ['tailscale', 'rathole']
  if (opts.tunnel && !SUPPORTED.includes(opts.tunnel)) {
    banner('error', 'INVALID TUNNEL', [
      `Unknown tunnel provider: "${opts.tunnel}". Supported: tailscale, rathole`,
    ])
    process.exit(1)
  }

  let tunnel: TunnelConfig | null = null

  if (opts.tunnel === 'tailscale') {
    tunnel = { provider: 'tailscale' }
  } else if (opts.tunnel === 'rathole') {
    tunnel = { provider: 'rathole', serverAddr: '', publicUrl: '', ssh: null }
  } else if (process.stdin.isTTY) {
    tunnel = await promptTunnel()
  }

  const configOut = tunnel != null ? { ...BASE_CONFIG, tunnel } : BASE_CONFIG
  try {
    fs.writeFileSync(configPath, JSON.stringify(configOut, null, 2) + '\n', 'utf-8')
  } catch (err) {
    banner('error', 'WRITE FAILED', [
      `Could not write tapflow.config.json: ${err instanceof Error ? err.message : String(err)}`,
    ])
    process.exit(1)
  }

  const gitignoreUpdated = addToGitignore(process.cwd(), '.tapflow-data/')

  const lines: string[] = ['tapflow.config.json created.']
  if (gitignoreUpdated === 'created') lines.push('.gitignore created (.tapflow-data/ added).')
  else if (gitignoreUpdated === 'appended') lines.push('.tapflow-data/ added to .gitignore.')
  if (tunnel?.provider === 'rathole' && (!tunnel.serverAddr || !tunnel.publicUrl)) {
    lines.push('Fill in tunnel.serverAddr and tunnel.publicUrl in tapflow.config.json.')
  }
  if (tunnel) lines.push(`Tunnel: ${tunnel.provider}`)
  lines.push('Next: tapflow start')

  banner('success', 'CONFIG CREATED', lines)
}
