import fs from 'fs'
import path from 'path'

// gitignore된 <dataDir>/.env 에서 자격 증명(JWT_SECRET·SMTP·DNS/ACME 토큰 등)을 로드한다.
// config.load()가 secret을 읽기 전에 호출되어 .env가 모든 비밀의 기본 경로가 된다(#287에서 시작).
// process.loadEnvFile 은 기존 process.env 값을 안 덮으므로 ambient(셸) 가 항상 우선.
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
