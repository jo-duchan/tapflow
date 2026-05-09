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
  [/Code signing is required/, 'Code signing error: not required for simulator builds. Check CODE_SIGN_IDENTITY="".'],
  [/No such scheme/, 'Scheme not found. Make sure the WebDriverAgentRunner scheme exists in your project.'],
  [/No provisioning profile/, 'Provisioning profile error: not required for simulator builds.'],
  [/xcode-select/, 'Xcode command-line tools not installed. Run `xcode-select --install`.'],
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

  private stderrLines: string[] = []

  private spawnXcodebuild(xctestrunPath: string): void {
    this.stderrLines = []
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
      this.stderrLines.push(...text.split('\n').filter(Boolean))
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

    const hint = this.extractHint()
    const msg = hint
      ? `WDA did not respond within ${timeoutMs / 1000}s\n  Hint: ${hint}`
      : `WDA did not respond within ${timeoutMs / 1000}s\n  Run \`tapflow wda install\` to rebuild, or check \`xcodebuild\` output manually.`
    throw new Error(msg)
  }

  private extractHint(): string | null {
    // Check known patterns first
    for (const [pattern, msg] of XCODEBUILD_ERROR_MAP) {
      if (this.stderrLines.some((l) => pattern.test(l))) return msg
    }
    // Surface the first error-looking line from stderr
    const errorLine = this.stderrLines.find((l) => /error:|failed|cannot/.test(l.toLowerCase()))
    return errorLine?.trim() ?? null
  }

  private writePid(): void {
    if (this.process?.pid) {
      writeFileSync(WDA_PID_FILE, String(this.process.pid))
    }
  }
}
