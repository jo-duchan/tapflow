import fs from 'fs'

// 업로드 정리: 파일을 삭제하되 이미 없으면(ENOENT) 조용히 넘기고, 그 외 에러만 경고한다.
// builds/comments 업로드 핸들러가 거부·만료된 파일을 정리할 때 공유한다.
export function unlinkSafe(filePath: string, label: string): void {
  try {
    fs.unlinkSync(filePath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[tapflow] failed to delete ${label}`, (err as Error).message)
    }
  }
}
