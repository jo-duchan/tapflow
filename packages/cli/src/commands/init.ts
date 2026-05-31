import fs from 'fs'
import path from 'path'
import * as readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
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

async function promptTunnel(): Promise<TunnelConfig | null> {
  const rl = readline.createInterface({ input, output })
  process.stdout.write('\n  Tunnel provider:\n  [1] none (local only)\n  [2] tailscale (recommended)\n  [3] rathole (VPS)\n')
  const choice = (await rl.question('  Select [1-3]: ')).trim()
  rl.close()

  if (choice === '2') return { provider: 'tailscale' }
  if (choice !== '3') return null

  const rl2 = readline.createInterface({ input, output })
  const serverAddr = (await rl2.question('  VPS server address (e.g. example.com:2333): ')).trim()
  const publicUrl = (await rl2.question('  Public URL (e.g. https://example.com): ')).trim()
  const sshHost = (await rl2.question('  SSH host (leave blank to skip): ')).trim()
  let ssh: { host: string; user: string; keyPath: string } | null = null
  if (sshHost) {
    const sshUser = (await rl2.question('  SSH user [ubuntu]: ')).trim() || 'ubuntu'
    const sshKeyPath = (await rl2.question('  SSH key path [~/.ssh/id_ed25519]: ')).trim() || '~/.ssh/id_ed25519'
    ssh = { host: sshHost, user: sshUser, keyPath: sshKeyPath }
  }
  rl2.close()
  return { provider: 'rathole', serverAddr, publicUrl, ssh }
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
    tunnel = {
      provider: 'rathole',
      serverAddr: '',
      publicUrl: '',
      ssh: null,
    }
  } else if (process.stdin.isTTY) {
    tunnel = await promptTunnel()
  }

  const configOut = tunnel != null ? { ...BASE_CONFIG, tunnel } : BASE_CONFIG
  fs.writeFileSync(configPath, JSON.stringify(configOut, null, 2) + '\n', 'utf-8')

  const lines: string[] = ['tapflow.config.json created.']
  if (tunnel?.provider === 'rathole' && !tunnel.serverAddr) {
    lines.push('Fill in tunnel.serverAddr and tunnel.publicUrl in tapflow.config.json.')
  }
  if (tunnel) lines.push(`Tunnel: ${tunnel.provider}`)
  lines.push('Next: tapflow start')

  banner('success', 'CONFIG CREATED', lines)
}
