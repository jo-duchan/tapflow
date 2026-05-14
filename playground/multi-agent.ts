import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const dir = dirname(fileURLToPath(import.meta.url))
const count = parseInt(process.env['AGENT_COUNT'] ?? '3')
const prefix = process.env['AGENT_NAME_PREFIX'] ?? 'mock-mac-'

for (let i = 1; i <= count; i++) {
  const name = `${prefix}${i}`
  spawn(
    resolve(dir, '../node_modules/.bin/tsx'),
    ['--conditions=source', resolve(dir, 'mock-agent.ts')],
    {
      env: { ...process.env, MOCK_AGENT_NAME: name },
      stdio: 'inherit',
    },
  ).on('error', (e) => console.error(`[multi-agent] ${name} spawn 실패:`, e.message))
}

console.log(`[multi-agent] ${count}개 mock agent 시작 (prefix: ${prefix})`)
