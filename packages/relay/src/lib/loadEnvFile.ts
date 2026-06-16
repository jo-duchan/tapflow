import fs from 'fs'
import path from 'path'

// #287 — DNS/ACME 자격 증명을 gitignore된 <dataDir>/.env 에서 로드한다.
// shell export 는 세션 한정이라 재시작/새 터미널/서비스 매니저에서 토큰이 사라진다. 이 파일은
// jwt-secret·tls/account.pem 처럼 .tapflow-data/ 안에 영속화되는 비밀과 같은 위치에 둔다.
// Node 의 loadEnvFile 은 이미 설정된 process.env 를 덮어쓰지 않으므로 ambient 가 항상 우선한다.
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
