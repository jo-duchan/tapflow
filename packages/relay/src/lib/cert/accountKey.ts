import fs from 'fs'
import path from 'path'

// ACME 계정 키를 디스크에 캐시한다. 매 발급마다 새 키로 새 LE 계정을 등록하면
// Accounts-per-IP 한도(3h/10)에 닿을 수 있으므로 재사용한다. 키 파일은 0600.
export async function loadOrCreateAccountKey(filePath: string, create: () => Promise<string>): Promise<string> {
  try {
    return fs.readFileSync(filePath, 'utf-8')
  } catch {
    // not yet created
  }
  const key = await create()
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, key, { mode: 0o600 })
  try {
    fs.chmodSync(filePath, 0o600)
  } catch {
    // best-effort on platforms without POSIX permissions
  }
  return key
}
