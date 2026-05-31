import { spawn } from 'child_process'

export interface SshConfig {
  host: string
  user: string
  keyPath?: string
}

function sshArgs(ssh: SshConfig): string[] {
  return [
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'BatchMode=yes',
    ...(ssh.keyPath ? ['-i', ssh.keyPath] : []),
  ]
}

export function sshExec(ssh: SshConfig, cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ssh', [...sshArgs(ssh), `${ssh.user}@${ssh.host}`, cmd])
    let stdout = ''
    let stderr = ''
    proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
    proc.on('exit', (code) => {
      if (code === 0) resolve(stdout.trim())
      else reject(new Error(stderr.trim() || `ssh exited with code ${code}`))
    })
  })
}

export function scpUpload(ssh: SshConfig, localPath: string, remotePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('scp', [
      ...sshArgs(ssh),
      localPath,
      `${ssh.user}@${ssh.host}:${remotePath}`,
    ])
    let stderr = ''
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
    proc.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(stderr.trim() || `scp exited with code ${code}`))
    })
  })
}
