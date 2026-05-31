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
    // v0.5.0 기준 aarch64-apple-darwin 없음 — x86_64로 통일 (Rosetta 2 실행)
    return `${base}/rathole-x86_64-apple-darwin.zip`
  }
  const a = arch === 'arm64' || arch === 'aarch64' ? 'aarch64' : 'x86_64'
  // aarch64는 musl, x86_64는 gnu
  const suffix = a === 'aarch64' ? 'unknown-linux-musl' : 'unknown-linux-gnu'
  return `${base}/rathole-${a}-${suffix}.zip`
}

function fetchZip(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const follow = (u: string, redirectCount = 0) => {
      if (redirectCount > 5) { reject(new Error('Too many redirects')); return }
      https.get(u, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume() // 이전 response body 소비 (socket hang 방지)
          follow(res.headers.location, redirectCount + 1)
          return
        }
        if (res.statusCode !== 200) {
          res.resume()
          reject(new Error(`Failed to download rathole: HTTP ${res.statusCode}`))
          return
        }
        const total = parseInt(res.headers['content-length'] ?? '0', 10)
        let downloaded = 0
        process.stdout.write(`  Downloading rathole (0%)`)
        res.on('data', (chunk: Buffer) => {
          downloaded += chunk.length
          if (total > 0) {
            const pct = Math.floor((downloaded / total) * 100)
            process.stdout.write(`\r  Downloading rathole (${pct}%)`)
          }
        })
        const ws = fs.createWriteStream(dest)
        res.pipe(ws)
        ws.on('finish', () => {
          process.stdout.write('\r  Downloading rathole (100%)\n')
          resolve()
        })
        ws.on('error', reject)
        res.on('error', reject)
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
