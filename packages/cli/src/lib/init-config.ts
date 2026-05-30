import fs from 'fs'
import path from 'path'

const DEFAULT_CONFIG = {
  local: {
    port: 4000,
    dataDir: '.tapflow-data',
  },
  relay: {
    url: '',
  },
  smtp: {
    host: '',
    port: 587,
    secure: false,
    user: '',
    pass: '',
  },
}

export function initConfigFile(): void {
  const configPath = path.join(process.cwd(), 'tapflow.config.json')
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n', 'utf-8')
  }
}
