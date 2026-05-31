import { spawn, type ChildProcess } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { sshExec, scpUpload, type SshConfig } from './ssh.js'
import { downloadBinary } from './download-binary.js'
import type { TunnelPlugin } from './tunnel.js'

const REMOTE_DIR = '/tmp/tapflow'
const REMOTE_BINARY = `${REMOTE_DIR}/rathole`
const REMOTE_SERVER_TOML = `${REMOTE_DIR}/rathole-server.toml`
const REMOTE_PID_FILE = '/tmp/tapflow-rathole.pid'

function serverToml(serverAddr: string, token: string): string {
  return [
    '[server]',
    `bind_addr = "${serverAddr}"`,
    '',
    '[server.services.tapflow-relay]',
    `token = "${token}"`,
    `bind_addr = "0.0.0.0:4000"`,
  ].join('\n')
}

function clientToml(serverAddr: string, token: string, relayPort: number): string {
  return [
    '[client]',
    `remote_addr = "${serverAddr}"`,
    '',
    '[client.services.tapflow-relay]',
    `token = "${token}"`,
    `local_addr = "127.0.0.1:${relayPort}"`,
  ].join('\n')
}

export interface RatholeTunnelOptions {
  serverAddr: string
  publicUrl: string
  token: string
  ssh?: SshConfig
}

export class RatholeTunnel implements TunnelPlugin {
  name = 'rathole'
  private proc: ChildProcess | null = null
  private clientConfigPath: string | null = null
  private serverConfigPath: string | null = null
  private sshCfg: SshConfig | null = null

  constructor(private opts: RatholeTunnelOptions) {
    this.sshCfg = opts.ssh ?? null
  }

  async setupServer(): Promise<void> {
    if (!this.sshCfg) return

    const ssh = this.sshCfg

    // 원격 디렉토리 생성
    await sshExec(ssh, `mkdir -p ${REMOTE_DIR}`)

    // 기존 server 프로세스 먼저 정리 (binary 파일 잠금 해제)
    await sshExec(ssh, `kill $(cat ${REMOTE_PID_FILE} 2>/dev/null) 2>/dev/null; true`)

    // rathole binary 확인 — PATH 또는 REMOTE_BINARY 경로
    const hasRathole = await sshExec(ssh, `which rathole 2>/dev/null || ls ${REMOTE_BINARY} 2>/dev/null || echo ""`).then(
      (out) => out.length > 0,
      () => false
    )
    if (!hasRathole) {
      const vpsArch = await sshExec(ssh, 'uname -m').catch(() => 'x86_64')
      const linuxBinary = await downloadBinary('linux', vpsArch.trim())
      await scpUpload(ssh, linuxBinary, REMOTE_BINARY)
      await sshExec(ssh, `chmod +x ${REMOTE_BINARY}`)
    }

    const remoteRathole = hasRathole
      ? (await sshExec(ssh, `which rathole 2>/dev/null || echo "${REMOTE_BINARY}"`).catch(() => REMOTE_BINARY)).trim()
      : REMOTE_BINARY

    // server.toml 생성 → 업로드
    const toml = serverToml(this.opts.serverAddr, this.opts.token)
    this.serverConfigPath = path.join(os.tmpdir(), `tapflow-rathole-server-${process.pid}.toml`)
    fs.writeFileSync(this.serverConfigPath, toml, 'utf-8')
    await scpUpload(ssh, this.serverConfigPath, REMOTE_SERVER_TOML)
    await sshExec(
      ssh,
      `nohup ${remoteRathole} --server ${REMOTE_SERVER_TOML} > /tmp/tapflow-rathole.log 2>&1 & echo $! > ${REMOTE_PID_FILE}`
    )
  }

  async start(relayPort: number): Promise<{ publicUrl: string }> {
    if (!this.opts.token) throw new Error('TAPFLOW_TUNNEL_TOKEN is required for tunnel mode')
    if (!this.opts.serverAddr) throw new Error('tunnel.serverAddr is required in tapflow.config.json')

    const darwinBinary = await downloadBinary('darwin', process.arch)

    const toml = clientToml(this.opts.serverAddr, this.opts.token, relayPort)
    this.clientConfigPath = path.join(os.tmpdir(), `tapflow-rathole-client-${process.pid}.toml`)
    fs.mkdirSync(path.dirname(this.clientConfigPath), { recursive: true })
    fs.writeFileSync(this.clientConfigPath, toml, 'utf-8')

    return new Promise((resolve, reject) => {
      this.proc = spawn(darwinBinary, ['--client', this.clientConfigPath!], { stdio: ['ignore', 'ignore', 'pipe'] })
      let resolved = false

      this.proc.stderr?.on('data', (chunk: Buffer) => {
        const line = chunk.toString()
        if (!resolved && (line.includes('established') || line.includes('Tunnel') || line.includes('Connected') || line.includes('INFO'))) {
          resolved = true
          resolve({ publicUrl: this.opts.publicUrl })
        }
      })

      // stderr에 아무것도 안 나와도 프로세스가 살아있으면 연결된 것으로 간주
      setTimeout(() => {
        if (!resolved && this.proc && !this.proc.killed) {
          resolved = true
          resolve({ publicUrl: this.opts.publicUrl })
        }
      }, 3000)

      this.proc.on('exit', (code) => {
        if (!resolved) reject(new Error(`rathole process exited with code ${code}`))
      })
    })
  }

  async stop(): Promise<void> {
    if (this.proc) {
      this.proc.kill()
      this.proc = null
    }
    if (this.clientConfigPath) {
      try { fs.unlinkSync(this.clientConfigPath) } catch { /* already gone */ }
      this.clientConfigPath = null
    }
    if (this.serverConfigPath) {
      try { fs.unlinkSync(this.serverConfigPath) } catch { /* already gone */ }
      this.serverConfigPath = null
    }
    if (this.sshCfg) {
      await sshExec(this.sshCfg, `kill $(cat ${REMOTE_PID_FILE} 2>/dev/null) 2>/dev/null; rm -f ${REMOTE_PID_FILE}; true`).catch(() => {})
    }
  }
}
