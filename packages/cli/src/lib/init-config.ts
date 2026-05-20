import fs from 'fs'
import path from 'path'

const DEFAULT_CONFIG = {
  server: {
    port: 4000,
    dataDir: '.tapflow',
  },
  smtp: {
    host: '',
    port: 587,
    secure: false,
    user: '',
    pass: '',
    from: 'tapflow <noreply@tapflow.local>',
  },
}

export function initConfigFile(): void {
  const configPath = path.join(process.cwd(), 'tapflow.config.json')
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n', 'utf-8')
  }
}
