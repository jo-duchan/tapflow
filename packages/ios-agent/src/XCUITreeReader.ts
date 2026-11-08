import { spawn, execFile, type ChildProcess } from 'child_process'
import { promisify } from 'util'
import { createHash, randomUUID } from 'crypto'
import { readdirSync, readFileSync, writeFileSync } from 'fs'
import { join, relative } from 'path'
import type { UIElement } from '@tapflowio/agent-core'
import type { FieldReadReason, FocusedField } from '@tapflowio/protocol'
import { createLogger, PlatformError } from '@tapflowio/agent-core'
import { parseTreeText, splitInterfaceTurn } from './xcuiTree.js'

const logger = createLogger('ios-agent:xcui-tree')
const execFileAsync = promisify(execFile)

const RUNNER_DIR = join(import.meta.dirname, '..', 'xctest-runner')
const PROJECT = join(RUNNER_DIR, 'TapflowTreeRunner.xcodeproj')
const BUILD_DIR = join(RUNNER_DIR, 'build')
const PRODUCTS_DIR = join(BUILD_DIR, 'Build', 'Products')
const STAMP_FILE = join(BUILD_DIR, 'tapflow-runner.stamp')
const SCHEME = 'TreeRunner'
// The in-simulator process the UI-test session runs as. Killing xcodebuild already ends it (measured); this covers
// an xcodebuild that dies by SIGKILL without taking it along. `dev.tapflow.treerunner.host` was named here before,
// and is never installed: `test-without-building` installs only the runner.
const RUNNER_BUNDLE = 'dev.tapflow.treerunner.uitests.xctrunner'
const READY_DEADLINE_MS = 90_000
const READY_LINE = /TAPFLOW_TREE_READY port=(\d+)/

interface RunnerHandle {
  proc: ChildProcess
  udid: string
  token: string
  // Set once the runner has announced its port and answered /health with `token`. Until then the handle only
  // marks the device as starting, so a stop can still find and kill the process.
  port?: number
}

type ReadyRunner = RunnerHandle & { port: number }

// Native-tooling boundary (xcodebuild/xcrun). Injectable so tests can mock the
// native calls without exercising the runner lifecycle / signal handling.
export interface RunnerNative {
  // What the runner would be built from now: its sources, the checked-in project and the Xcode that builds them.
  sourceStamp(): Promise<string>
  // The stamp recorded beside the built products, or undefined when there is no usable build.
  builtStamp(): string | undefined
  // Builds, then records `stamp` — only on success, so a half build is never trusted.
  build(destination: string, stamp: string): Promise<void>
  // Starts the runner on a port of the kernel's choosing. Its stdout must stay readable: the port arrives there.
  spawn(destination: string, token: string): ChildProcess
  terminateRunner(udid: string): void
}

// Everything `build-for-testing` reads from this package: the runner and host sources, the checked-in project and
// its shared scheme (xcodegen does not run at build time, so `project.yml` alone changes nothing that is built). The toolchain is part
// of it, so an Xcode upgrade rebuilds too.
export function computeRunnerStamp(runnerDir: string, toolchain: string): string {
  const hash = createHash('sha256').update(toolchain)
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, e.name)
      if (e.isDirectory()) walk(path)
      else if (e.isFile()) files.push(path)
    }
  }
  walk(join(runnerDir, 'TreeRunner'))
  walk(join(runnerDir, 'TreeHost'))
  files.push(join(runnerDir, 'TapflowTreeRunner.xcodeproj', 'project.pbxproj'))
  files.push(join(runnerDir, 'TapflowTreeRunner.xcodeproj', 'xcshareddata', 'xcschemes', 'TreeRunner.xcscheme'))
  for (const f of files.map((f) => relative(runnerDir, f)).sort()) {
    hash.update(`\0${f}\0`).update(readFileSync(join(runnerDir, f)))
  }
  return hash.digest('hex')
}

const defaultNative: RunnerNative = {
  async sourceStamp() {
    const { stdout } = await execFileAsync('xcodebuild', ['-version'], { timeout: 30_000 })
    return computeRunnerStamp(RUNNER_DIR, stdout)
  },
  builtStamp() {
    // test-without-building needs the .xctestrun, not just the .app — gate on it.
    try {
      if (!readdirSync(PRODUCTS_DIR).some((f) => f.endsWith('.xctestrun'))) return undefined
      return readFileSync(STAMP_FILE, 'utf8').trim()
    } catch {
      return undefined
    }
  },
  async build(destination, stamp) {
    await execFileAsync(
      'xcodebuild',
      ['build-for-testing', '-project', PROJECT, '-scheme', SCHEME, '-destination', destination, '-derivedDataPath', BUILD_DIR, '-quiet'],
      { timeout: 300_000, maxBuffer: 64 * 1024 * 1024 },
    )
    writeFileSync(STAMP_FILE, stamp)
  },
  spawn(destination, token) {
    // No `-quiet`: it also silences the test's own output, and the READY line is how the port arrives. The
    // `TEST_RUNNER_` prefix is what makes xcodebuild hand a variable to the runner (it strips the prefix); without
    // it nothing arrives.
    return spawn(
      'xcodebuild',
      ['test-without-building', '-project', PROJECT, '-scheme', SCHEME, '-destination', destination, '-derivedDataPath', BUILD_DIR],
      {
        env: { ...process.env, TEST_RUNNER_TAPFLOW_TREE_PORT: '0', TEST_RUNNER_TAPFLOW_TREE_TOKEN: token },
        stdio: ['ignore', 'pipe', 'ignore'],
        detached: true,
      },
    )
  },
  terminateRunner(udid) {
    execFile('xcrun', ['simctl', 'terminate', udid, RUNNER_BUNDLE], () => { /* best-effort */ })
  },
}

function refused(e: unknown): boolean {
  return (e as { cause?: { code?: string } }).cause?.code === 'ECONNREFUSED'
}

async function answers(port: number, token: string): Promise<boolean> {
  try {
    const r = await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(1000) })
    return r.ok && (await r.text()).trim() === token
  } catch {
    return false
  }
}

// Drives the resident XCUITest tree runners, one per simulator: builds the runner once, launches it per device
// (staying resident), and queries GET /tree over the simulator-shared loopback. Replaces the AXUIElement path
// (UITreeReader), which required a Simulator.app window.
export class XCUITreeReader {
  private readonly runners = new Map<string, RunnerHandle>()
  private readonly starting = new Map<string, Promise<ReadyRunner>>()
  private building?: Promise<void>
  private stamp?: Promise<string>
  // A launch compares the generation it began with before it spawns, because `test-without-building` boots a
  // shut-down simulator and would power a device back up right after someone shut it down. A device's count is
  // never deleted: a count that restarted at 0 would match a launch that began before it was cleared. `epoch` is
  // stop()'s share, so stopping everything also cancels a device that is only building and holds no handle yet.
  private readonly generations = new Map<string, number>()
  private epoch = 0

  constructor(private readonly native: RunnerNative = defaultNative) {}

  private destination(udid: string): string {
    // No arch — xcodebuild resolves it (arm64 on Apple Silicon, x86_64 on Intel).
    return `platform=iOS Simulator,id=${udid}`
  }

  private generation(udid: string): string {
    return `${this.epoch}/${this.generations.get(udid) ?? 0}`
  }

  private bumpGeneration(udid: string): void {
    this.generations.set(udid, (this.generations.get(udid) ?? 0) + 1)
  }

  private async ensureBuilt(udid: string): Promise<void> {
    // Once per process: a stamp that changed while runners serve (a source edited under a running agent) must not
    // rebuild the products they are executing.
    const stamping = (this.stamp ??= this.native.sourceStamp())
    // Every caller goes through the catch below, the ones that joined a build another device started included:
    // with a runner per device, two first reads at once are the normal case, and the raw xcodebuild error is
    // its whole log.
    const building = (this.building ??= (async () => {
      const stamp = await stamping
      if (this.native.builtStamp() === stamp) return
      logger.info('building tree runner (first run, or its sources or Xcode changed — cached afterwards)...')
      await this.native.build(this.destination(udid), stamp)
      logger.info('tree runner built')
    })())
    try {
      await building
    } catch (e) {
      if (this.stamp === stamping) this.stamp = undefined
      throw new PlatformError(
        `failed to build the UI-tree runner — ensure Xcode and an iOS simulator runtime are installed (xcode-select -p): ${(e as Error).message.slice(0, 300)}`,
      )
    } finally {
      if (this.building === building) this.building = undefined
    }
  }

  private runnerAlive(h: RunnerHandle | undefined): h is RunnerHandle {
    // `signalCode` too: a runner killed from outside (by signal) keeps `exitCode` null and `killed` false, and
    // without it every read went on asking a dead port for as long as the agent ran.
    return !!h && h.proc.exitCode === null && h.proc.signalCode === null && !h.proc.killed
  }

  private ready(h: RunnerHandle | undefined): h is ReadyRunner {
    return this.runnerAlive(h) && h.port !== undefined
  }

  private async ensureRunner(udid: string): Promise<ReadyRunner> {
    // Serialize concurrent callers for one device so we never double-spawn or hand back an un-ready runner.
    // A loop, not one wait: two callers that both waited out a failed launch would otherwise both start their own.
    // Other devices are never touched.
    for (;;) {
      const held = this.runners.get(udid)
      if (this.ready(held)) return held
      const pending = this.starting.get(udid)
      if (!pending) break
      const h = await pending.catch(() => undefined)
      if (h && this.ready(h) && this.runners.get(udid) === h) return h
    }
    const starting = this.launchRunner(udid)
    this.starting.set(udid, starting)
    try {
      return await starting
    } finally {
      if (this.starting.get(udid) === starting) this.starting.delete(udid)
    }
  }

  /**
   * Start the runner before anything asks for a tree, for a device an automation client just booted. A cold
   * start is about 3 s on a running simulator and 8–9 s right after a boot (iOS 26.5), and on the first query
   * that time is spent inside the step's selector timeout (10 s by default). Manual sessions are not warmed:
   * they never read the tree, and a runner costs about 650 MB per device.
   *
   * Each device has its own runner, so warming one never touches another's. A read during the warm-up waits on
   * the same launch.
   */
  warm(udid: string): void {
    if (this.starting.has(udid)) return
    const held = this.runners.get(udid)
    let generation = this.generation(udid)
    // A runner already serving this device may have died with a simulator shut down outside tapflow, while its
    // xcodebuild lingers for up to a minute and still looks alive: ask it before keeping it. Dropping it here is
    // this warm-up's own doing, so it moves the generation this warm-up compares against.
    const check = this.ready(held)
      ? answers(held.port, held.token).then((ok) => {
        // Only a drop of its own moves the generation it compares against. A probe that failed because the
        // device was shut down (or the agent stopped) meanwhile must leave that stop standing.
        if (!ok && this.runners.get(udid) === held) {
          this.dropRunner(udid, held)
          generation = this.generation(udid)
        }
      })
      : Promise.resolve()
    check.then(() => {
      // The device may have been shut down while the probe was out.
      if (this.generation(udid) !== generation) return
      return this.ensureRunner(udid)
    }).catch((e: Error) => {
      // Stopped on purpose (the device was shut down mid-start) is not a fault worth sending anyone to Xcode for.
      if (this.generation(udid) !== generation) logger.debug(`tree runner warm-up for ${udid} cancelled: ${e.message}`)
      else logger.warn(`tree runner warm-up for ${udid} failed; the first query will try again: ${e.message}`)
    })
  }

  private async launchRunner(udid: string): Promise<ReadyRunner> {
    const stale = this.runners.get(udid)
    if (stale) this.dropRunner(udid, stale)
    const generation = this.generation(udid)
    await this.ensureBuilt(udid)
    if (this.generation(udid) !== generation) throw new PlatformError('tree runner start cancelled — the runner was stopped while it was being built')
    // No await between the check above and registering the handle, so a stop always finds what it must kill.
    const token = randomUUID()
    const proc = this.native.spawn(this.destination(udid), token)
    proc.on('error', (e) => logger.error('tree runner process error:', e.message))
    const handle: RunnerHandle = { proc, udid, token }
    this.runners.set(udid, handle)
    const port = await this.waitReady(handle)
    // Stopped while it was coming up: its xcodebuild takes seconds to exit, and until then the runner still answers.
    if (this.runners.get(udid) !== handle) throw new PlatformError('tree runner start cancelled — the runner was stopped while it was starting')
    handle.port = port
    return handle as ReadyRunner
  }

  // The runner announces its port on stdout once it is listening. Resolves with it, or rejects when the process
  // exits first or the deadline passes. The listener stays for the life of the process: an undrained pipe would
  // block the runner once its buffer filled.
  private readPort(handle: RunnerHandle, deadline: number): Promise<number> {
    return new Promise((resolve, reject) => {
      let pending = ''
      let settled = false
      const settle = (err: Error | undefined, port?: number): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        handle.proc.off('exit', onExit)
        if (err) reject(err)
        else resolve(port as number)
      }
      const onExit = (): void => settle(new PlatformError('tree runner exited before becoming ready — check Xcode/simulator state'))
      const timer = setTimeout(() => settle(new PlatformError('tree runner did not become ready in time')), Math.max(0, deadline - Date.now()))
      handle.proc.stdout?.on('data', (chunk: Buffer | string) => {
        if (settled) return
        // A chunk boundary can split the line, so keep the unfinished tail.
        pending += chunk.toString()
        const m = READY_LINE.exec(pending)
        if (m) settle(undefined, Number(m[1]))
        else pending = pending.slice(pending.lastIndexOf('\n') + 1)
      })
      handle.proc.once('exit', onExit)
      if (!this.runnerAlive(handle)) onExit()
    })
  }

  private async waitReady(handle: RunnerHandle): Promise<number> {
    const deadline = Date.now() + READY_DEADLINE_MS
    try {
      const port = await this.readPort(handle, deadline)
      // A runner built before the port was chosen this way prints the port it was given, which is now 0.
      if (port === 0) throw new PlatformError('tree runner is out of date (announced port 0) — remove xctest-runner/build to rebuild it')
      // A clock, not an iteration count: a refused connection fails at once, so the count would set the cap
      // through the sleep below.
      while (Date.now() < deadline) {
        if (!this.runnerAlive(handle)) throw new PlatformError('tree runner exited before becoming ready — check Xcode/simulator state')
        try {
          const r = await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(1000) })
          if (r.ok) {
            // Anything else answering is not the runner we started, and its tree would be another simulator's.
            if ((await r.text()).trim() === handle.token) return port
            throw new PlatformError(`port ${port} is answered by another tree runner — not reading from it`)
          }
        } catch (e) {
          if (e instanceof PlatformError) throw e
          /* not listening yet */
        }
        await new Promise((r) => setTimeout(r, 250))
      }
      throw new PlatformError('tree runner did not become ready in time')
    } catch (e) {
      this.dropRunner(handle.udid, handle)
      throw e
    }
  }

  async read(udid: string, bundleId: string): Promise<UIElement[]> {
    return (await this.readWithTurn(udid, bundleId)).elements
  }

  /** The tree with the app's interface turn the runner read beside it (`UiTreeResponse.interfaceTurn`). */
  async readWithTurn(udid: string, bundleId: string): Promise<{ elements: UIElement[]; interfaceTurn?: 0 | 90 | 180 | 270 }> {
    if (!bundleId) throw new PlatformError('UI tree query needs a foreground app — launch an app first')
    const handle = await this.ensureRunner(udid)
    let text: string
    try {
      const r = await fetch(`http://localhost:${handle.port}/tree?bundleId=${encodeURIComponent(bundleId)}`, { signal: AbortSignal.timeout(10_000) })
      if (!r.ok) throw new PlatformError(`tree runner returned HTTP ${r.status} for ${bundleId}`)
      text = await r.text()
    } catch (e) {
      if (e instanceof PlatformError) throw e
      // Nothing listening: the runner died (with its simulator, shut down outside tapflow) while xcodebuild lingers,
      // so `runnerAlive` still says yes. Drop it, or every read until xcodebuild exits fails the same way. A timeout
      // is not this: a runner on a screen that never goes idle is slow, not gone.
      if (refused(e)) this.dropRunner(udid, handle)
      throw new PlatformError(`UI tree query failed: ${(e as Error).message}`)
    }
    // Guard against a garbage / wrong-bundleId body silently parsing to an empty
    // tree — consumers must see an error, never a false "screen has no elements".
    // Load-bearing for launch readiness too: while a launched app is still starting the runner answers a "not found"
    // query chain, and this error is what tells flow-runner's `launchApp` the screen is not up yet (see agent-core's
    // `DeviceAgent.launchApp`). Turning it into an empty tree would make every launch read as ready at once.
    const { body, interfaceTurn } = splitInterfaceTurn(text)
    if (!body.includes('Element subtree:') && !body.includes('Application,')) {
      throw new PlatformError(`tree runner returned an unexpected response for ${bundleId} — is the app running in the foreground?`)
    }
    const elements = parseTreeText(body)
    return interfaceTurn === undefined ? { elements } : { elements, interfaceTurn }
  }

  /**
   * The keyboard-focused text field (#1135), from the runner's `/field`: the value as the app holds it, unquoted and
   * whole, where the tree's `value:` is cut at 18 characters (measured). A secure field comes back without one. The
   * body is a field's contents, typed or filled in: it is parsed and returned, never logged.
   */
  async readField(udid: string, bundleId: string): Promise<{ field: FocusedField | null; reason?: FieldReadReason }> {
    if (!bundleId) return { field: null, reason: 'no-app' }
    const handle = await this.ensureRunner(udid)
    let body: unknown
    try {
      const r = await fetch(`http://localhost:${handle.port}/field?bundleId=${encodeURIComponent(bundleId)}`, { signal: AbortSignal.timeout(5_000) })
      if (!r.ok) return { field: null, reason: 'failed' }
      body = await r.json()
    } catch (e) {
      if (refused(e)) this.dropRunner(udid, handle)
      return { field: null, reason: 'failed' }
    }
    return toFocusedField(body)
  }

  // Drop one device's runner, if `handle` is still the one it holds. Every fault path goes through here rather than
  // stop(): one device's dead runner must not take the others down with it.
  private dropRunner(udid: string, handle: RunnerHandle): void {
    if (this.runners.get(udid) !== handle) return
    this.runners.delete(udid)
    this.bumpGeneration(udid)
    this.killHandle(handle)
  }

  // Stop every device's runner, including launches still building (agent shutdown).
  stop(): void {
    this.epoch++
    for (const handle of this.runners.values()) this.killHandle(handle)
    this.runners.clear()
  }

  // Stop this device's runner, or the launch starting one for it — on device shutdown and before an erase.
  stopIfDevice(udid: string): void {
    this.bumpGeneration(udid)
    const handle = this.runners.get(udid)
    if (!handle) return
    this.runners.delete(udid)
    this.killHandle(handle)
  }

  private killHandle(handle: RunnerHandle): void {
    const { proc, udid } = handle
    const pid = proc.pid
    // detached spawn → the child leads its own group; kill the whole group.
    try {
      if (pid) process.kill(-pid, 'SIGTERM')
      else proc.kill('SIGTERM')
    } catch {
      /* already gone */
    }
    // The in-simulator runner is not in that group; ending xcodebuild normally ends it, and this covers the case
    // where it does not.
    this.native.terminateRunner(udid)
    // SIGKILL fallback if SIGTERM did not take.
    const timer = setTimeout(() => {
      try {
        if (pid) process.kill(-pid, 'SIGKILL')
      } catch {
        /* gone */
      }
    }, 3000)
    timer.unref?.()
  }
}

const READ_REASONS = new Set<string>(['no-app', 'no-focus', 'ambiguous', 'secure'])

/** The runner's `/field` answer as protocol's `FocusedField`. Anything it does not recognise is a failed read, never a
 *  field: a value is what a recording will export, so a shape this cannot vouch for must not become one. */
export function toFocusedField(body: unknown): { field: FocusedField | null; reason?: FieldReadReason } {
  if (typeof body !== 'object' || body === null) return { field: null, reason: 'failed' }
  const b = body as Record<string, unknown>
  const f = b['frame'] as Record<string, unknown> | undefined
  const frameOk = !!f && ['x', 'y', 'width', 'height'].every((k) => typeof f[k] === 'number')
  if (typeof b['identifier'] !== 'string' || !frameOk) {
    const reason = typeof b['reason'] === 'string' && READ_REASONS.has(b['reason']) ? b['reason'] as FieldReadReason : 'failed'
    return { field: null, reason }
  }
  const secure = b['type'] === 'secure'
  const field: FocusedField = {
    identifier: b['identifier'],
    placeholder: typeof b['placeholder'] === 'string' ? b['placeholder'] : '',
    frame: { x: f!['x'] as number, y: f!['y'] as number, width: f!['width'] as number, height: f!['height'] as number },
    secure,
  }
  // A secure field's value is dropped here too, whatever the runner sent.
  if (!secure && typeof b['value'] === 'string') field.value = b['value']
  return secure ? { field, reason: 'secure' } : { field }
}
