import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { z } from 'zod'
import { createLogger } from '@tapflowio/agent-core'
import { parseTrustedProxies } from './clientAddress.js'

const logger = createLogger('relay:config')

const tunnelSshSchema = z.object({
  host: z.string().min(1),
  user: z.string().min(1),
  keyPath: z.string().optional(),
})

const ratholeTunnelSchema = z.object({
  provider: z.literal('rathole'),
  serverAddr: z.string().min(1),
  publicUrl: z.string().min(1),
  ssh: tunnelSshSchema.nullable(),
})

const tailscaleTunnelSchema = z.object({
  provider: z.literal('tailscale'),
  publicUrl: z.string().optional(),
})

const tunnelSchema = z.discriminatedUnion('provider', [ratholeTunnelSchema, tailscaleTunnelSchema])

// LAN HTTPS (issue #232) — secure context용 TLS 종단 설정. 골격: v1은 LAN 가지만 구현.
// 비밀(DNS API 토큰)은 config 파일이 아니라 env에서 읽는다(예: CLOUDFLARE_API_TOKEN).
const importCertTlsSchema = z.object({
  mode: z.literal('import-cert'),
  certPath: z.string().min(1),
  keyPath: z.string().min(1),
})

const byoApiTokenTlsSchema = z.object({
  mode: z.literal('byo-api-token'),
  domain: z.string().min(1),
  dnsProvider: z.enum(['cloudflare', 'desec']),
})

const tlsSchema = z.discriminatedUnion('mode', [byoApiTokenTlsSchema, importCertTlsSchema])

const configSchema = z.object({
  local: z.object({
    port: z.number().int().min(1).max(65535),
    dataDir: z.string().min(1),
    wsBackpressureBytes: z.number().int().min(1),
    trustedProxies: z.array(z.string()),
  }),
  relay: z.object({
    url: z.string().nullable(),
  }),
  tunnel: tunnelSchema.nullable(),
  tls: tlsSchema.nullable(),
  smtp: z.object({
    host: z.string(),
    port: z.number().int().min(1).max(65535),
    secure: z.boolean(),
    user: z.string(),
    pass: z.string(),
    from: z.string(),
  }),
})

export type TapflowConfig = z.infer<typeof configSchema>

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] }

const DEFAULTS = {
  local: {
    port: 4000,
    dataDir: '.tapflow-data',
    wsBackpressureBytes: 1_048_576,
    trustedProxies: [],
  },
  relay: {
    url: null,
  },
  tunnel: null,
  tls: null,
  smtp: {
    host: '',
    port: 587,
    secure: false,
    user: '',
    pass: '',
    from: 'tapflow <noreply@tapflow.local>',
  },
} satisfies TapflowConfig

function resolveDataDir(raw: string): string {
  return path.isAbsolute(raw) ? raw : path.join(process.cwd(), raw)
}

function load(): TapflowConfig {
  let file: DeepPartial<TapflowConfig> & { local?: { jwtSecret?: unknown } } = {}

  const configPath = path.join(process.cwd(), 'tapflow.config.json')
  if (fs.existsSync(configPath)) {
    try {
      file = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as typeof file
    } catch {
      logger.warn('Failed to parse tapflow.config.json — using defaults')
    }
  }

  if (file.local != null && 'jwtSecret' in file.local) {
    logger.warn('local.jwtSecret in tapflow.config.json is deprecated — use JWT_SECRET env var instead')
  }

  const cfg: TapflowConfig = {
    local: {
      port: file.local?.port ?? DEFAULTS.local.port,
      dataDir: resolveDataDir(file.local?.dataDir ?? DEFAULTS.local.dataDir),
      wsBackpressureBytes: DEFAULTS.local.wsBackpressureBytes,
      trustedProxies: parseTrustedProxies(process.env.TAPFLOW_TRUSTED_PROXIES),
    },
    relay: {
      url: file.relay?.url || null,
    },
    tunnel: (() => {
      if (file.tunnel == null) return null
      const t = file.tunnel as { provider?: string; serverAddr?: string; publicUrl?: string; ssh?: { host?: string; user?: string; keyPath?: string } | null }
      if (t.provider === 'tailscale') {
        return { provider: 'tailscale' as const, publicUrl: t.publicUrl }
      }
      // Pass the actual provider value so zod's discriminated union rejects unknown values
      return {
        provider: t.provider as 'rathole',
        serverAddr: t.serverAddr ?? '',
        publicUrl: t.publicUrl ?? '',
        ssh: t.ssh != null
          ? { host: t.ssh.host ?? '', user: t.ssh.user ?? '', keyPath: t.ssh.keyPath }
          : null,
      }
    })(),
    tls: (() => {
      if (file.tls == null) return null
      const t = file.tls as { mode?: string; certPath?: string; keyPath?: string; domain?: string; dnsProvider?: string }
      if (t.mode === 'import-cert') {
        return { mode: 'import-cert' as const, certPath: t.certPath ?? '', keyPath: t.keyPath ?? '' }
      }
      // Pass the actual mode/provider so zod's discriminated union/enum rejects unknown values
      return {
        mode: t.mode as 'byo-api-token',
        domain: t.domain ?? '',
        dnsProvider: (t.dnsProvider ?? 'cloudflare') as 'cloudflare' | 'desec',
      }
    })(),
    smtp: {
      host: file.smtp?.host ?? DEFAULTS.smtp.host,
      port: file.smtp?.port ?? DEFAULTS.smtp.port,
      secure: file.smtp?.secure ?? DEFAULTS.smtp.secure,
      user: file.smtp?.user ?? DEFAULTS.smtp.user,
      pass: file.smtp?.pass ?? DEFAULTS.smtp.pass,
      from: file.smtp?.from ?? DEFAULTS.smtp.from,
    },
  }

  if (process.env.TAPFLOW_PORT) cfg.local.port = Number(process.env.TAPFLOW_PORT)
  if (process.env.TAPFLOW_DATA_DIR) cfg.local.dataDir = resolveDataDir(process.env.TAPFLOW_DATA_DIR)
  if (process.env.TAPFLOW_WS_BACKPRESSURE_BYTES) cfg.local.wsBackpressureBytes = Number(process.env.TAPFLOW_WS_BACKPRESSURE_BYTES)
  if (process.env.TAPFLOW_RELAY_URL) cfg.relay.url = process.env.TAPFLOW_RELAY_URL || null
  if (process.env.SMTP_HOST) cfg.smtp.host = process.env.SMTP_HOST
  if (process.env.SMTP_PORT) cfg.smtp.port = Number(process.env.SMTP_PORT)
  if (process.env.SMTP_SECURE) cfg.smtp.secure = process.env.SMTP_SECURE === 'true'
  if (process.env.SMTP_USER) cfg.smtp.user = process.env.SMTP_USER
  if (process.env.SMTP_PASS) cfg.smtp.pass = process.env.SMTP_PASS
  if (process.env.SMTP_FROM) cfg.smtp.from = process.env.SMTP_FROM

  // auto-derive from address when user is set but from was never explicitly configured
  if (cfg.smtp.user && file.smtp?.from === undefined && process.env.SMTP_FROM === undefined) {
    cfg.smtp.from = `tapflow <${cfg.smtp.user}>`
  }

  const result = configSchema.safeParse(cfg)
  if (!result.success) {
    for (const issue of result.error.issues) {
      logger.error(`config error: ${issue.path.join('.')} — ${issue.message}`)
    }
    process.exit(1)
  }

  return result.data
}

// JWT_SECRET 미설정 시: 공개된 공유 기본값 대신 per-install 시크릿을 생성·영속화한다.
// dataDir에 0600으로 저장하고 재시작 시 재사용 → 설정 없이도 위조 불가, 온보딩 friction 없음.
export function loadOrCreatePersistedSecret(dataDir: string): string {
  const secretPath = path.join(dataDir, 'jwt-secret')
  try {
    const existing = fs.readFileSync(secretPath, 'utf-8').trim()
    if (existing.length >= 32) return existing
  } catch {
    // not yet created
  }
  const secret = crypto.randomBytes(48).toString('base64url')
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(secretPath, secret, { mode: 0o600 })
  try {
    fs.chmodSync(secretPath, 0o600)
  } catch {
    // best-effort on platforms without POSIX permissions
  }
  logger.info(`Generated a per-install JWT secret at ${secretPath} (set JWT_SECRET to override)`)
  return secret
}

function loadJwtSecret(): string {
  if (process.env.JWT_SECRET !== undefined) {
    if (process.env.JWT_SECRET.length < 32) {
      logger.error('config error: JWT_SECRET — must be at least 32 characters')
      process.exit(1)
    }
    return process.env.JWT_SECRET
  }
  return loadOrCreatePersistedSecret(config.local.dataDir)
}

export const config = load()
export const jwtSecret = loadJwtSecret()
