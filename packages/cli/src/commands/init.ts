import fs from 'fs'
import path from 'path'
import { select, text, isCancel, cancel } from '@clack/prompts'
import { dnsProviders } from '@tapflowio/relay'
import { banner, warn } from '../lib/print.js'

export interface InitConfigOptions {
  tunnel?: string
  force?: boolean
}

// dataDir omitted so it defaults to .tapflow/data; not pinning it lets an upgrade use the relay's read-only legacy fallback, keeping `tapflow migrate data-dir` conflict-free.
const BASE_CONFIG = {
  local: { port: 4000 },
  relay: { url: '' },
  smtp: { host: '', port: 587, secure: false, user: '', pass: '' },
}

type TunnelConfig =
  | { provider: 'tailscale'; publicUrl?: string }
  | { provider: 'rathole'; serverAddr: string; publicUrl: string; ssh: { host: string; user: string; keyPath: string } | null }

type TlsConfig =
  | { mode: 'byo-api-token'; domain: string; dnsProvider: string }
  | { mode: 'import-cert'; certPath: string; keyPath: string }

function isInsideGitRepo(dir: string): boolean {
  let current = dir
  while (true) {
    if (fs.existsSync(path.join(current, '.git'))) return true
    const parent = path.dirname(current)
    if (parent === current) return false
    current = parent
  }
}

// Ignore only the runtime subdirs of .tapflow/ — .tapflow/flows/ stays committed.
function addToGitignore(dir: string, entries: string[]): 'created' | 'appended' | 'already-present' {
  const gitignorePath = path.join(dir, '.gitignore')
  if (fs.existsSync(gitignorePath)) {
    const content = fs.readFileSync(gitignorePath, 'utf-8')
    const present = new Set(content.split('\n').map((line) => line.trim()))
    // A `**/`-prefixed glob (how the monorepo root ignores these) already covers the exact entry.
    const missing = entries.filter((e) => !present.has(e) && !present.has(`**/${e}`))
    if (missing.length === 0) return 'already-present'
    const separator = content.endsWith('\n') ? '' : '\n'
    fs.appendFileSync(gitignorePath, `${separator}\n# tapflow runtime data\n${missing.join('\n')}\n`, 'utf-8')
    return 'appended'
  }
  fs.writeFileSync(gitignorePath, `# tapflow runtime data\n${entries.join('\n')}\n`, 'utf-8')
  return 'created'
}

// #287 — 자격 증명 env 파일을 빈 값 템플릿으로 스캠폴드(사용자가 토큰 붙여넣음). 기존 값은 보존, 누락 키만 추가.
function scaffoldEnvFile(dataDir: string, envVars: string[]): 'created' | 'appended' | 'already-present' {
  const envPath = path.join(dataDir, '.env')
  fs.mkdirSync(dataDir, { recursive: true })
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf-8')
    const present = new Set(
      content.split('\n').map((l) => l.split('=')[0]?.trim()).filter(Boolean),
    )
    const missing = envVars.filter((v) => !present.has(v))
    if (missing.length === 0) return 'already-present'
    const separator = content.endsWith('\n') || content === '' ? '' : '\n'
    fs.appendFileSync(envPath, `${separator}${missing.map((v) => `${v}=`).join('\n')}\n`, 'utf-8')
    return 'appended'
  }
  const header = '# tapflow DNS/ACME credentials — do not commit. Paste each token after the =.\n'
  fs.writeFileSync(envPath, header + envVars.map((v) => `${v}=`).join('\n') + '\n', { mode: 0o600 })
  try {
    fs.chmodSync(envPath, 0o600)
  } catch {
    // best-effort on platforms without POSIX permissions
  }
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

// LAN(=no tunnel) HTTPS 선택. WebCodecs(빠른 영상)는 secure context(HTTPS)에서만 동작.
// 도메인 없으면 Standard(HTTP/WASM)로 충분히 동작하므로 강요하지 않는다.
async function promptTls(): Promise<TlsConfig | null> {
  const perf = await select({
    message: 'Streaming performance',
    options: [
      { value: 'standard', label: 'Standard', hint: 'HTTP, software decode — instant, no domain needed' },
      { value: 'high', label: 'Smooth', hint: 'HTTPS, hardware decode (WebCodecs) — needs a domain' },
    ],
  })
  if (isCancel(perf)) { cancel('Cancelled.'); process.exit(0) }
  if (perf !== 'high') return null

  const method = await select({
    message: 'Certificate method',
    options: [
      ...dnsProviders.list().map((p) => ({ value: p.name, label: p.label, hint: p.hint })),
      { value: 'import', label: 'Existing certificate', hint: 'bring your own cert & key files' },
    ],
  })
  if (isCancel(method)) { cancel('Cancelled.'); process.exit(0) }

  if (method === 'import') {
    const certPath = await text({
      message: 'Certificate path (fullchain PEM)',
      placeholder: '/path/to/fullchain.pem',
      validate: (v) => (!v?.trim() ? 'Required' : undefined),
    })
    if (isCancel(certPath)) { cancel('Cancelled.'); process.exit(0) }
    const keyPath = await text({
      message: 'Private key path (PEM)',
      placeholder: '/path/to/privkey.pem',
      validate: (v) => (!v?.trim() ? 'Required' : undefined),
    })
    if (isCancel(keyPath)) { cancel('Cancelled.'); process.exit(0) }
    return { mode: 'import-cert', certPath: certPath.trim(), keyPath: keyPath.trim() }
  }

  const domain = await text({
    message: 'Domain for tapflow (its A record points to this Mac on the LAN)',
    placeholder: 'tap.yourcompany.com',
    validate: (v) => (!v?.trim() ? 'Required' : undefined),
  })
  if (isCancel(domain)) { cancel('Cancelled.'); process.exit(0) }
  return { mode: 'byo-api-token', domain: domain.trim(), dnsProvider: method }
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

  // HTTPS(WebCodecs)는 LAN(=no tunnel) 경로에서만 위저드로 묻는다. tailscale/rathole의 HTTPS는 후속.
  let tls: TlsConfig | null = null
  if (tunnel == null && process.stdin.isTTY) {
    tls = await promptTls()
  }

  const configOut = {
    ...BASE_CONFIG,
    ...(tunnel != null ? { tunnel } : {}),
    ...(tls != null ? { tls } : {}),
  }
  try {
    fs.writeFileSync(configPath, JSON.stringify(configOut, null, 2) + '\n', 'utf-8')
  } catch (err) {
    banner('error', 'WRITE FAILED', [
      `Could not write tapflow.config.json: ${err instanceof Error ? err.message : String(err)}`,
    ])
    process.exit(1)
  }

  // Legacy .tapflow-data/ moves only via `tapflow migrate data-dir`; until then don't scaffold a fresh .tapflow/data/ (it would trap that command with a both-dirs conflict).
  const hasLegacyDataDir = fs.existsSync(path.join(process.cwd(), '.tapflow-data'))

  // byo-api-token: 토큰 재export 없이 재시작 가능하도록 자격 증명 env 파일을 스캠폴드(빈 변수명만 작성).
  let envScaffold: 'created' | 'appended' | 'already-present' | 'skipped' = 'skipped'
  if (tls?.mode === 'byo-api-token' && !hasLegacyDataDir) {
    const envVars = dnsProviders.get(tls.dnsProvider)?.envVars ?? []
    try {
      envScaffold = scaffoldEnvFile(path.join(process.cwd(), '.tapflow', 'data'), envVars)
    } catch (err) {
      warn(`Could not write .tapflow/data/.env: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  let gitignoreUpdated: 'created' | 'appended' | 'already-present' | 'skipped' = 'skipped'
  if (isInsideGitRepo(process.cwd())) {
    // Ignore the legacy dir too while it awaits migration, so its secrets aren't committed meanwhile.
    const ignoreEntries = ['.tapflow/data/', '.tapflow/artifacts/']
    if (hasLegacyDataDir) ignoreEntries.push('.tapflow-data/')
    try {
      gitignoreUpdated = addToGitignore(process.cwd(), ignoreEntries)
    } catch (err) {
      warn(`Could not update .gitignore: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const lines: string[] = ['tapflow.config.json created.']
  if (gitignoreUpdated === 'created') lines.push('.gitignore created (.tapflow/ runtime dirs added).')
  else if (gitignoreUpdated === 'appended') lines.push('.tapflow/ runtime dirs added to .gitignore.')
  if (tunnel?.provider === 'rathole' && (!tunnel.serverAddr || !tunnel.publicUrl)) {
    lines.push('Fill in tunnel.serverAddr and tunnel.publicUrl in tapflow.config.json.')
  }
  if (tunnel) lines.push(`Tunnel: ${tunnel.provider}`)
  if (tls?.mode === 'byo-api-token') {
    const envVars = dnsProviders.get(tls.dnsProvider)?.envVars.join(', ') ?? 'the provider credentials'
    lines.push(`HTTPS: ${tls.dnsProvider} DNS-01 for ${tls.domain}.`)
    if (!hasLegacyDataDir) {
      if (envScaffold === 'created' || envScaffold === 'appended') {
        lines.push(`Paste ${envVars} into .tapflow/data/.env (the relay reads it on start).`)
      } else {
        lines.push(`Set ${envVars} (the relay auto-publishes the A record on start).`)
      }
    }
  } else if (tls?.mode === 'import-cert') {
    lines.push('HTTPS: import-cert. Ensure the cert/key paths exist on this Mac.')
  }
  if (hasLegacyDataDir) {
    lines.push('Legacy .tapflow-data/ found — run `tapflow migrate data-dir` first, then add any DNS tokens to .tapflow/data/.env.')
  }
  lines.push('Next: tapflow start')

  banner('success', 'CONFIG CREATED', lines)
}
