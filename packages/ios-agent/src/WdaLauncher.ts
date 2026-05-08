import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const TAPFLOW_DIR = join(homedir(), '.tapflow')
export const WDA_DIR = join(TAPFLOW_DIR, 'wda')
export const WDA_PID_FILE = join(TAPFLOW_DIR, 'wda.pid')
export const WDA_XCTESTRUN_CACHE = join(WDA_DIR, 'WebDriverAgent.xctestrun')

export class WdaNotInstalledError extends Error {
  constructor() {
    super('WebDriverAgent not found. Run `tapflow wda install` to set it up.')
  }
}

const XCODEBUILD_ERROR_MAP: Array<[RegExp, string]> = [
  [/Code signing is required/, 'code signing 오류: 시뮬레이터는 서명이 필요 없습니다. CODE_SIGN_IDENTITY="" 확인.'],
  [/No such scheme/, 'scheme을 찾을 수 없습니다. WebDriverAgentRunner scheme이 존재하는지 확인하세요.'],
  [/No provisioning profile/, '프로비저닝 프로파일 오류: 시뮬레이터 빌드에서는 불필요합니다.'],
  [/xcode-select/, 'Xcode 커맨드라인 도구 미설치. `xcode-select --install`을 실행하세요.'],
]

export interface WdaLaunchOptions {
  udid: string
  port?: number
  xctestrunPath?: string
}

export class WdaLauncher {
  readonly port: number
  private readonly udid: string
  private readonly xctestrunPath: string | undefined
  private process: ChildProcess | null = null

  constructor(opts: WdaLaunchOptions) {
    this.udid = opts.udid
    this.port = opts.port ?? 8100
    this.xctestrunPath = opts.xctestrunPath
  }

  async ensureRunning(): Promise<void> {
    if (await this.isHealthy()) return

    mkdirSync(WDA_DIR, { recursive: true })

    const xctestrun = this.resolveXctestrun()
    if (!xctestrun) throw new WdaNotInstalledError()

    this.spawnXcodebuild(xctestrun)
    await this.pollHealth(30_000)
    this.writePid()
  }

  stop(): void {
    this.process?.kill()
    this.process = null
    try { rmSync(WDA_PID_FILE) } catch { /* already gone */ }
  }

  async isHealthy(): Promise<boolean> {
    try {
      const res = await fetch(`http://localhost:${this.port}/status`, {
        signal: AbortSignal.timeout(1_000),
      })
      return res.ok
    } catch {
      return false
    }
  }

  private resolveXctestrun(): string | null {
    const candidates = [
      this.xctestrunPath,
      process.env['WDA_PATH'],
      WDA_XCTESTRUN_CACHE,
    ]
    return candidates.find((p): p is string => !!p && existsSync(p)) ?? null
  }

  private spawnXcodebuild(xctestrunPath: string): void {
    this.process = spawn(
      'xcodebuild',
      [
        'test-without-building',
        '-xctestrun', xctestrunPath,
        '-destination', `platform=iOS Simulator,id=${this.udid}`,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    )

    this.process.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      for (const [pattern, msg] of XCODEBUILD_ERROR_MAP) {
        if (pattern.test(text)) {
          console.error(`[wda] ${msg}`)
          return
        }
      }
    })
  }

  private async pollHealth(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await this.isHealthy()) return
      await new Promise((r) => setTimeout(r, 500))
    }
    this.stop()
    throw new Error(`WDA did not respond within ${timeoutMs / 1000}s`)
  }

  private writePid(): void {
    if (this.process?.pid) {
      writeFileSync(WDA_PID_FILE, String(this.process.pid))
    }
  }
}
