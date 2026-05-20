import { describe, it, expect } from 'vitest'
import { spawnSync, spawn } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
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

  it('tapflow relay start → 배너 출력 후 대기 (즉시 종료하지 않음)', () => {
    return new Promise<void>((resolve, reject) => {
      const dataDir = path.join(os.tmpdir(), `tapflow-smoke-${Date.now()}`)
      const proc = spawn(tsx, [entry, 'relay', 'start', '--port', '14321'], {
        cwd: pkgRoot,
        env: { ...process.env, TAPFLOW_DATA_DIR: dataDir },
      })

      let stdout = ''
      let stderr = ''
      proc.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
      proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })

      // 즉시 종료하면 실패
      proc.on('exit', (code) => {
        if (code !== null) reject(new Error(`relay start exited early (code ${code})\n${stderr}`))
      })

      setTimeout(() => {
        proc.kill()
        try {
          expect(stdout).toContain('localhost:14321')
          resolve()
        } catch (e) {
          reject(e)
        }
      }, 2000)
    })
  }, 10_000)
})
