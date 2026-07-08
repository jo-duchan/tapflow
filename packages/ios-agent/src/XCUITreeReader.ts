import { spawn, execFile, type ChildProcess } from 'child_process'
import { promisify } from 'util'
import { existsSync } from 'fs'
import { join } from 'path'
import type { UIElement } from '@tapflowio/agent-core'
import { createLogger, PlatformError } from '@tapflowio/agent-core'
import { parseTreeText } from './xcuiTree.js'

const logger = createLogger('ios-agent:xcui-tree')
const execFileAsync = promisify(execFile)

const RUNNER_DIR = join(import.meta.dirname, '..', 'xctest-runner')
const PROJECT = join(RUNNER_DIR, 'TapflowTreeRunner.xcodeproj')
const BUILD_DIR = join(RUNNER_DIR, 'build')
// build-for-testing writes this; its presence marks the runner as built (cached
// across sessions — the first UI-tree query pays the build, later ones reuse it).
const BUILT_APP = join(BUILD_DIR, 'Build', 'Products', 'Debug-iphonesimulator', 'TreeRunner-Runner.app')
const SCHEME = 'TreeRunner'
const DEFAULT_PORT = 22087

interface RunnerHandle {
  proc: ChildProcess
  udid: string
  port: number
}

// Drives the resident XCUITest tree runner: builds it once, launches it (staying
// resident), and queries GET /tree over the simulator-shared localhost. Replaces
// the AXUIElement path (UITreeReader), which required a Simulator.app window.
export class XCUITreeReader {
  private runner?: RunnerHandle
  private building?: Promise<void>

  private destination(udid: string): string {
    return `platform=iOS Simulator,id=${udid},arch=arm64`
  }

  private async ensureBuilt(udid: string): Promise<void> {
    if (existsSync(BUILT_APP)) return
    if (this.building) return this.building
    this.building = (async () => {
      logger.info('building tree runner (first run — cached afterwards)...')
      await execFileAsync(
        'xcodebuild',
        ['build-for-testing', '-project', PROJECT, '-scheme', SCHEME, '-destination', this.destination(udid), '-derivedDataPath', BUILD_DIR, '-quiet'],
        { timeout: 300_000, maxBuffer: 64 * 1024 * 1024 },
      )
      logger.info('tree runner built')
    })()
    try {
      await this.building
    } finally {
      this.building = undefined
    }
  }

  private async ensureRunner(udid: string): Promise<RunnerHandle> {
    if (this.runner && this.runner.udid === udid && this.runner.proc.exitCode === null && !this.runner.proc.killed) {
      return this.runner
    }
    this.stop()
    await this.ensureBuilt(udid)
    const port = DEFAULT_PORT
    const proc = spawn(
      'xcodebuild',
      ['test-without-building', '-project', PROJECT, '-scheme', SCHEME, '-destination', this.destination(udid), '-derivedDataPath', BUILD_DIR, '-quiet'],
      { env: { ...process.env, TAPFLOW_TREE_PORT: String(port) }, stdio: 'ignore' },
    )
    proc.on('error', (e) => logger.error('tree runner process error:', e.message))
    const handle: RunnerHandle = { proc, udid, port }
    this.runner = handle
    await this.waitReady(port, proc)
    return handle
  }

  private async waitReady(port: number, proc: ChildProcess): Promise<void> {
    for (let i = 0; i < 90; i++) {
      if (proc.exitCode !== null || proc.killed) {
        this.runner = undefined
        throw new PlatformError('tree runner exited before becoming ready — check Xcode/simulator state')
      }
      try {
        const r = await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(1000) })
        if (r.ok) return
      } catch {
        /* not listening yet */
      }
      await new Promise((r) => setTimeout(r, 1000))
    }
    this.stop()
    throw new PlatformError('tree runner did not become ready within 90s')
  }

  async read(udid: string, bundleId: string): Promise<UIElement[]> {
    if (!bundleId) throw new PlatformError('UI tree query needs a foreground app — launch an app first')
    const { port } = await this.ensureRunner(udid)
    let text: string
    try {
      const r = await fetch(`http://localhost:${port}/tree?bundleId=${encodeURIComponent(bundleId)}`, { signal: AbortSignal.timeout(10_000) })
      if (!r.ok) throw new PlatformError(`tree runner returned HTTP ${r.status} for ${bundleId}`)
      text = await r.text()
    } catch (e) {
      if (e instanceof PlatformError) throw e
      throw new PlatformError(`UI tree query failed: ${(e as Error).message}`)
    }
    return parseTreeText(text)
  }

  stop(): void {
    if (this.runner) {
      this.runner.proc.kill()
      this.runner = undefined
    }
  }
}
