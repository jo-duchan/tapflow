import fs from 'fs'
import path from 'path'
import { z } from 'zod'
import { createLogger } from '@tapflowio/agent-core'

const logger = createLogger('relay:config')

const DEV_DEFAULT_SECRET = 'tapflow-dev-secret-change-in-production'

const tunnelSchema = z.object({
  provider: z.enum(['rathole']),
  serverAddr: z.string().min(1),
  publicUrl: z.string().min(1),
})

const configSchema = z.object({
  local: z.object({
    port: z.number().int().min(1).max(65535),
    dataDir: z.string().min(1),
    wsBackpressureBytes: z.number().int().min(1),
  }),
  relay: z.object({
    url: z.string().nullable(),
  }),
  tunnel: tunnelSchema.nullable(),
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
  },
  relay: {
    url: null,
  },
  tunnel: null,
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
    },
    relay: {
      url: file.relay?.url || null,
    },
    tunnel: file.tunnel != null
      ? { provider: file.tunnel.provider as 'rathole', serverAddr: file.tunnel.serverAddr ?? '', publicUrl: file.tunnel.publicUrl ?? '' }
      : null,
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

function loadJwtSecret(): string {
  if (process.env.JWT_SECRET !== undefined) {
    if (process.env.JWT_SECRET.length < 32) {
      logger.error('config error: JWT_SECRET — must be at least 32 characters')
      process.exit(1)
    }
    return process.env.JWT_SECRET
  }
  logger.warn('JWT_SECRET is using the dev default — set a strong secret in production')
  return DEV_DEFAULT_SECRET
}

export const config = load()
export const jwtSecret = loadJwtSecret()
