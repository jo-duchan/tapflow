import fs from 'fs'
import path from 'path'

// #287 — gitignore된 <dataDir>/.env 에서 DNS/ACME 자격 증명을 로드(loadEnvFile 은 기존 값을 안 덮으므로 ambient 우선).
export function loadDataDirEnv(dataDir: string): string | null {
  const envPath = path.join(dataDir, '.env')
  if (!fs.existsSync(envPath)) return null
  try {
    process.loadEnvFile(envPath)
    return envPath
  } catch {
    // 손상된 파일은 무시 — 자격 증명이 없으면 cert 발급 시점에 명확히 실패한다.
    return null
  }
}
