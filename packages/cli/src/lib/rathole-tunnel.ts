import { spawn, type ChildProcess } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { dirname } from 'path'
import type { TunnelPlugin } from './tunnel.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

function ratholeBinary(): string {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  return path.join(__dirname, '..', '..', 'bin', `rathole-darwin-${arch}`)
}

export interface RatholeTunnelOptions {
  serverAddr: string
  publicUrl: string
  token: string
}

export class RatholeTunnel implements TunnelPlugin {
  name = 'rathole'
  private proc: ChildProcess | null = null
  private configPath: string | null = null

  constructor(private opts: RatholeTunnelOptions) {}

  async start(relayPort: number): Promise<{ publicUrl: string }> {
    if (!this.opts.token) throw new Error('TAPFLOW_TUNNEL_TOKEN is required for tunnel mode')
    if (!this.opts.serverAddr) throw new Error('tunnel.serverAddr is required in tapflow.config.json')

    const toml = [
      '[client]',
      `remote_addr = "${this.opts.serverAddr}"`,
      '',
      '[client.services.tapflow-relay]',
      `token = "${this.opts.token}"`,
      `local_addr = "127.0.0.1:${relayPort}"`,
    ].join('\n')

    this.configPath = path.join(os.tmpdir(), `tapflow-rathole-${process.pid}.toml`)
    fs.mkdirSync(path.dirname(this.configPath), { recursive: true })
    fs.writeFileSync(this.configPath, toml, 'utf-8')

    return new Promise((resolve, reject) => {
      this.proc = spawn(ratholeBinary(), ['--client', this.configPath!], { stdio: ['ignore', 'ignore', 'pipe'] })

      this.proc.stderr?.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('Tunnel started') || chunk.toString().includes('Connected')) {
          resolve({ publicUrl: this.opts.publicUrl })
        }
      })

      this.proc.on('exit', (code) => {
        reject(new Error(`rathole process exited with code ${code}`))
      })
    })
  }

  async stop(): Promise<void> {
    if (this.proc) {
      this.proc.kill()
      this.proc = null
    }
    if (this.configPath) {
      try { fs.unlinkSync(this.configPath) } catch { /* already gone */ }
      this.configPath = null
    }
  }
}
