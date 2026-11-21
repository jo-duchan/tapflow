import { execFile } from 'child_process'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import path from 'path'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * The PNG in what `screencap -p` wrote, without anything ahead of it. On a device with several displays it writes a
 * warning first (#1118), so the bytes were not an image: everything a reader got was refused or broken. Only the text
 * is cut; which display was captured is still the device's choice (#1118 keeps that). Bytes with no PNG in them are
 * returned as they are, for whatever reads them to refuse.
 */
export function withoutLeadingText(buf: Buffer): Buffer {
  const at = buf.indexOf(PNG_SIGNATURE)
  return at > 0 ? buf.subarray(at) : buf
}

/** How long a conversion may take: a run's last-screen capture has 5 s in all, and screencap comes first. */
const SIPS_TIMEOUT_MS = 3000
/** JPEG quality: a screenshot read as evidence, not compared to a pixel. A 1260×2736 map: 5.4 MB → 1.3 MB. */
const QUALITY = 85

export type RunFile = (file: string, args: string[], timeoutMs: number) => Promise<void>

const runFile: RunFile = (file, args, timeoutMs) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout: timeoutMs }, (err) => (err ? reject(err) : resolve()))
})

/**
 * A screenshot as JPEG, made with macOS's own `sips` — `screencap` writes PNG only. Null when it cannot be made (no
 * `sips` off macOS, a timeout, output that is not a JPEG): the caller then answers with the PNG it has, saying so, since
 * a request's format is a preference (protocol `ScreenshotRequest`, #508). Its own temp directory per call, so two at
 * once never share a file.
 */
export async function toJpeg(png: Buffer, run: RunFile = runFile): Promise<Buffer | null> {
  let dir: string | null = null
  try {
    dir = await fs.mkdtemp(path.join(tmpdir(), 'tapflow-shot-'))
    const input = path.join(dir, 'in.png')
    const output = path.join(dir, 'out.jpg')
    await fs.writeFile(input, png)
    await run('/usr/bin/sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', String(QUALITY), input, '--out', output], SIPS_TIMEOUT_MS)
    const jpeg = await fs.readFile(output)
    return jpeg[0] === 0xff && jpeg[1] === 0xd8 ? jpeg : null
  } catch {
    return null
  } finally {
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
