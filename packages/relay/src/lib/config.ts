import fs from 'fs'
import path from 'path'
import { createLogger } from '@tapflow/agent-core'

const logger = createLogger('relay:config')

export interface TapflowConfig {
  server: {
    port: number
    dataDir: string
    jwtSecret: string
  }
  smtp: {
    host: string
    port: number
    secure: boolean
    user: string
    pass: string
    from: string
  }
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] }

const DEFAULTS = {
  server: {
    port: 4000,
    dataDir: '.tapflow',
    jwtSecret: 'tapflow-dev-secret-change-in-production',
  },
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
  let file: DeepPartial<TapflowConfig> = {}

  const configPath = path.join(process.cwd(), 'tapflow.config.json')
  if (fs.existsSync(configPath)) {
    try {
      file = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as DeepPartial<TapflowConfig>
    } catch {
      logger.warn('Failed to parse tapflow.config.json — using defaults')
    }
  }

  const cfg: TapflowConfig = {
    server: {
      port: file.server?.port ?? DEFAULTS.server.port,
      dataDir: resolveDataDir(file.server?.dataDir ?? DEFAULTS.server.dataDir),
      jwtSecret: file.server?.jwtSecret ?? DEFAULTS.server.jwtSecret,
    },
    smtp: {
      host: file.smtp?.host ?? DEFAULTS.smtp.host,
      port: file.smtp?.port ?? DEFAULTS.smtp.port,
      secure: file.smtp?.secure ?? DEFAULTS.smtp.secure,
      user: file.smtp?.user ?? DEFAULTS.smtp.user,
      pass: file.smtp?.pass ?? DEFAULTS.smtp.pass,
      from: file.smtp?.from ?? DEFAULTS.smtp.from,
    },
  }

  // env vars override config file (useful for Docker / CI)
  if (process.env.TAPFLOW_PORT) cfg.server.port = Number(process.env.TAPFLOW_PORT)
  if (process.env.TAPFLOW_DATA_DIR) cfg.server.dataDir = resolveDataDir(process.env.TAPFLOW_DATA_DIR)
  if (process.env.JWT_SECRET) cfg.server.jwtSecret = process.env.JWT_SECRET
  if (process.env.SMTP_HOST) cfg.smtp.host = process.env.SMTP_HOST
  if (process.env.SMTP_PORT) cfg.smtp.port = Number(process.env.SMTP_PORT)
  if (process.env.SMTP_SECURE) cfg.smtp.secure = process.env.SMTP_SECURE === 'true'
  if (process.env.SMTP_USER) cfg.smtp.user = process.env.SMTP_USER
  if (process.env.SMTP_PASS) cfg.smtp.pass = process.env.SMTP_PASS
  if (process.env.SMTP_FROM) cfg.smtp.from = process.env.SMTP_FROM

  return cfg
}

export const config = load()
