import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const pkgRoot = path.resolve(__dirname, '../..')
const entry = path.resolve(__dirname, '../index.ts')
const tsx = path.resolve(pkgRoot, 'node_modules/.bin/tsx')

function run(...args: string[]) {
  return spawnSync(tsx, [entry, ...args], { encoding: 'utf-8', cwd: pkgRoot })
}

describe('CLI smoke tests', () => {
  it('tapflow --version → semver 출력, exit 0', () => {
    const { stdout, status } = run('--version')
    expect(status).toBe(0)
    expect(stdout).toMatch(/\d+\.\d+\.\d+/)
  })

  it('tapflow --help → 사용법 출력, exit 0', () => {
    const { stdout, status } = run('--help')
    expect(status).toBe(0)
    expect(stdout).toContain('tapflow')
    expect(stdout).toContain('--help')
  })
})
