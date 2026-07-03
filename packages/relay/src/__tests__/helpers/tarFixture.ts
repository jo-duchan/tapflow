import fs from 'fs'
import path from 'path'
import zlib from 'zlib'
import { spawnSync } from 'child_process'

/**
 * 유효한 EAS 스타일 시뮬레이터 .tar.gz 를 만든다 (루트에 <appName>.app/).
 * 실제 tar 로 압축해 실전 아카이브 구조를 재현한다.
 */
export function makeAppTarGz(tmpDir: string, appName: string, plistXml: string, ext = '.tar.gz'): string {
  const appDir = path.join(tmpDir, `${appName}.app`)
  fs.mkdirSync(path.join(appDir, 'Frameworks', 'Foo.framework'), { recursive: true })
  fs.writeFileSync(path.join(appDir, 'Info.plist'), plistXml)
  // 프레임워크 내부에도 Info.plist 를 심어 최상위 선택 규칙을 검증한다.
  fs.writeFileSync(path.join(appDir, 'Frameworks', 'Foo.framework', 'Info.plist'), '<plist><dict/></plist>')
  fs.writeFileSync(path.join(appDir, appName), Buffer.from([0xcf, 0xfa, 0xed, 0xfe]))
  const out = path.join(tmpDir, `${appName}${ext}`)
  spawnSync('tar', ['-czf', out, '-C', tmpDir, `${appName}.app`])
  return out
}

// ── raw ustar builder (악성/엣지 픽스처용) ─────────────────────────────────
// 임의의 엔트리(경로 탈출, symlink 등)를 정밀하게 구성하기 위해 헤더를 직접 쓴다.

export type RawTarEntry = {
  name: string
  data?: Buffer
  /** '0'=file, '2'=symlink, '5'=dir. 기본 '0'. */
  type?: '0' | '2' | '5'
  linkname?: string
}

function tarHeader(e: RawTarEntry, size: number): Buffer {
  const buf = Buffer.alloc(512)
  buf.write(e.name.slice(0, 100), 0)
  buf.write('0000644\0', 100) // mode
  buf.write('0000000\0', 108) // uid
  buf.write('0000000\0', 116) // gid
  buf.write(size.toString(8).padStart(11, '0') + '\0', 124) // size (octal)
  buf.write('00000000000\0', 136) // mtime
  buf.write(e.type ?? '0', 156) // typeflag
  if (e.linkname) buf.write(e.linkname.slice(0, 100), 157)
  buf.write('ustar\0', 257)
  buf.write('00', 263)
  // checksum: 8 바이트를 공백으로 채운 뒤 합산.
  buf.write('        ', 148)
  let sum = 0
  for (const b of buf) sum += b
  buf.write(sum.toString(8).padStart(6, '0') + '\0 ', 148)
  return buf
}

/** 임의 엔트리로 .tar.gz Buffer 를 만든다. */
export function writeRawTarGz(entries: RawTarEntry[]): Buffer {
  const parts: Buffer[] = []
  for (const e of entries) {
    const data = e.data ?? Buffer.alloc(0)
    parts.push(tarHeader(e, data.length))
    if (data.length) {
      parts.push(data)
      const pad = (512 - (data.length % 512)) % 512
      if (pad) parts.push(Buffer.alloc(pad))
    }
  }
  parts.push(Buffer.alloc(1024)) // 두 개의 zero 블록 = 아카이브 종료
  return zlib.gzipSync(Buffer.concat(parts))
}
