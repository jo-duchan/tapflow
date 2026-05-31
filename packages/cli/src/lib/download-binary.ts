import { spawn } from 'child_process'
import fs from 'fs'
import https from 'https'
import os from 'os'
import path from 'path'

export const RATHOLE_VERSION = 'v0.5.0'

const CACHE_DIR = path.join(os.homedir(), '.tapflow', 'bin')

type Platform = 'darwin' | 'linux'

function normalizeArch(arch: string): string {
  if (arch === 'arm64' || arch === 'aarch64') return 'arm64'
  return 'x64'
}

export function cachedBinaryPath(platform: Platform, arch: string): string {
  const a = platform === 'linux'
    ? (arch === 'arm64' || arch === 'aarch64' ? 'aarch64' : 'x86_64')
    : normalizeArch(arch)
  return path.join(CACHE_DIR, `rathole-${platform}-${a}`)
}

function releaseUrl(platform: Platform, arch: string): string {
  const base = `https://github.com/rathole-org/rathole/releases/download/${RATHOLE_VERSION}`
  if (platform === 'darwin') {
    const a = arch === 'arm64' || arch === 'aarch64' ? 'aarch64' : 'x86_64'
    return `${base}/rathole-${a}-apple-darwin.zip`
  }
  const a = arch === 'arm64' || arch === 'aarch64' ? 'aarch64' : 'x86_64'
  return `${base}/rathole-${a}-unknown-linux-musl.zip`
}

function fetchZip(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const follow = (u: string) => {
      https.get(u, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          follow(res.headers.location)
          return
        }
        if (res.statusCode !== 200) {
          reject(new Error(`Failed to download rathole: HTTP ${res.statusCode}`))
          return
        }
        const ws = fs.createWriteStream(dest)
        res.pipe(ws)
        ws.on('finish', resolve)
        ws.on('error', reject)
      }).on('error', reject)
    }
    follow(url)
  })
}

export function extractZip(zipPath: string, outPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const outDir = path.dirname(outPath)
    fs.mkdirSync(outDir, { recursive: true })
    const proc = spawn('unzip', ['-o', '-j', zipPath, 'rathole', '-d', outDir])
    let stderr = ''
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
    proc.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`unzip failed (code ${code}): ${stderr}`))
        return
      }
      // unzip extracts as 'rathole', rename to target path
      const extracted = path.join(outDir, 'rathole')
      if (extracted !== outPath) {
        fs.renameSync(extracted, outPath)
      }
      fs.chmodSync(outPath, 0o755)
      resolve(outPath)
    })
  })
}

export async function downloadBinary(platform: Platform, arch: string): Promise<string> {
  const dest = cachedBinaryPath(platform, arch)
  if (fs.existsSync(dest)) return dest

  fs.mkdirSync(path.dirname(dest), { recursive: true })

  const url = releaseUrl(platform, arch)
  const zipPath = `${dest}.zip`

  try {
    await fetchZip(url, zipPath)
    await extractZip(zipPath, dest)
  } finally {
    try { fs.unlinkSync(zipPath) } catch { /* already gone */ }
  }

  return dest
}
