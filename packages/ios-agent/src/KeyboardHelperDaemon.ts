import { spawn, type ChildProcess } from 'child_process'
import { createInterface } from 'readline'
import { join } from 'path'
import { createLogger } from '@tapflowio/agent-core'

const logger = createLogger('ios-agent:keyboard-helper')

const BINARY = join(import.meta.dirname, '..', 'bin', 'keyboard-helper')

interface Pending {
  resolve: () => void
  reject: (e: Error) => void
}

export class KeyboardHelperDaemon {
  private proc: ChildProcess | null = null
  private pending: Pending | null = null
  private queue: Array<{ cmd: string } & Pending> = []
  private draining = false

  show(udid: string): Promise<void> { return this.enqueue(`show ${udid}`) }
  hide(udid: string): Promise<void> { return this.enqueue(`hide ${udid}`) }

  stop(): void {
    this.proc?.kill()
    this.proc = null
    const err = new Error('keyboard-helper daemon stopped')
    this.pending?.reject(err)
    this.pending = null
    for (const item of this.queue) item.reject(err)
    this.queue = []
    this.draining = false
  }

  private enqueue(cmd: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.queue.push({ cmd, resolve, reject })
      this.drain()
    })
  }

  private drain(): void {
    if (this.draining || this.queue.length === 0) return
    this.draining = true
    const item = this.queue.shift()!
    this.pending = { resolve: item.resolve, reject: item.reject }
    this.ensureStarted()
    if (!this.proc?.stdin?.writable) {
      const err = new Error('keyboard-helper stdin not writable')
      this.pending.reject(err)
      this.pending = null
      this.draining = false
      this.drain()
      return
    }
    this.proc.stdin.write(item.cmd + '\n')
  }

  private ensureStarted(): void {
    if (this.proc !== null) return
    const proc = spawn(BINARY, ['--daemon'], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.proc = proc

    const rl = createInterface({ input: proc.stdout! })
    rl.on('line', (line) => {
      const pending = this.pending
      this.pending = null
      this.draining = false
      if (!pending) return
      if (line.startsWith('ok')) {
        pending.resolve()
      } else {
        pending.reject(new Error(line.replace(/^err\s*/, '') || 'keyboard-helper error'))
      }
      this.drain()
    })

    proc.stderr?.on('data', (d: Buffer) => {
      logger.error(d.toString().trim())
    })

    proc.on('exit', (code) => {
      logger.error(`exited with code ${code ?? 'null'}`)
      this.proc = null
      // reject any in-flight pending (rl 'line' won't fire after exit)
      const pending = this.pending
      this.pending = null
      this.draining = false
      if (pending) {
        pending.reject(new Error(`keyboard-helper exited with code ${code}`))
        this.drain()
      }
    })

    proc.on('error', (e) => {
      logger.error(`spawn error: ${e.message}`)
      this.proc = null
      const pending = this.pending
      this.pending = null
      this.draining = false
      if (pending) {
        pending.reject(e)
        this.drain()
      }
    })
  }
}
