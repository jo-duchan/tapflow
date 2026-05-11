import { spawn, type ChildProcess } from 'child_process'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { randomUUID } from 'crypto'

export class SimctlRecorder {
  private proc: ChildProcess | null = null
  private filePath: string | null = null

  start(deviceId: string): void {
    if (this.proc) throw new Error('Recording already in progress')
    const dir = path.join(os.tmpdir(), 'tapflow-recordings')
    fs.mkdirSync(dir, { recursive: true })
    const filename = `${randomUUID()}-${Date.now()}.mov`
    this.filePath = path.join(dir, filename)
    this.proc = spawn('xcrun', ['simctl', 'io', deviceId, 'recordVideo', '--codec=h264', this.filePath])
    this.proc.on('error', () => { this.cleanup() })
  }

  stop(): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.proc || !this.filePath) {
        reject(new Error('No recording in progress'))
        return
      }
      const fp = this.filePath
      this.proc.once('close', () => resolve(fp))
      this.proc.kill('SIGINT')
      this.proc = null
      this.filePath = null
    })
  }

  cleanup(): void {
    if (this.proc) {
      this.proc.kill('SIGKILL')
      this.proc = null
    }
    if (this.filePath) {
      try { fs.unlinkSync(this.filePath) } catch { /* ignore */ }
      this.filePath = null
    }
  }

  isRecording(): boolean {
    return this.proc !== null
  }
}
