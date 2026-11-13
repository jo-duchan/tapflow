import fs from 'fs'
import path from 'path'

/** Free space every upload leaves on the disk it writes to, so the database and sign-in keep working. */
const DEFAULT_MIN_FREE_DISK_BYTES = 1024 * 1024 * 1024
/** How often a running upload re-checks free space. A floor of 1 GiB absorbs this much per concurrent upload. */
const RECHECK_EVERY_BYTES = 1024 * 1024

export function minFreeDiskBytes(): number {
  const v = Number(process.env.TAPFLOW_MIN_FREE_DISK_BYTES)
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_MIN_FREE_DISK_BYTES
}

/** An upload refused because writing it would take the disk below `minFreeDiskBytes()`. Answered with 507. */
export class StorageFullError extends Error {
  constructor() { super('Not enough free disk space for this upload') }
}

/**
 * Throws `StorageFullError` when `bytes` more would leave less than the floor free on the disk holding `dir`.
 *
 * Only actual free space is read, with no per-route quota: what fills a disk is every route together, and the
 * database lives on the same one by default. A filesystem that cannot be asked is not treated as full, as
 * `diskRoomFor` in runVideos.ts does: refusing every upload on an unusual mount is worse than the gap.
 */
export function assertDiskRoom(dir: string, bytes = 0): void {
  let free: number
  try {
    const st = fs.statfsSync(dir)
    free = st.bavail * st.bsize
  } catch {
    return
  }
  if (free - bytes < minFreeDiskBytes()) throw new StorageFullError()
}

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

/**
 * Writes an uploaded file to `dest`. Resolves once it is on disk; on a failed upload or write, closes the
 * writer, removes what was written and rejects.
 *
 * `stream.pipe(writer)` does neither: when busboy destroys a file's stream — a body that ends inside the
 * part — the writer stays open and the partial file stays on disk, once per failed upload.
 *
 * The rejection is marked handled here, for the case where nobody awaits it: a failed part also fails the
 * parser, whose `'error'` handler answers the request, and the route's `'finish'` never runs. A failed
 * *write* (a full disk) is different — the parser still finishes and the route awaits a rejection, so every
 * caller catches it.
 *
 * Free space is checked before the first byte and again every `RECHECK_EVERY_BYTES`, so a run of uploads stops at
 * the floor rather than at a full disk; the rejection is then a `StorageFullError`. Free space, not a count of
 * bytes in flight: what this upload wrote is already out of it, so concurrent uploads see each other's writes.
 */
export function pipeUpload(stream: NodeJS.ReadableStream, dest: string, label: string): Promise<void> {
  const dir = path.dirname(dest)
  try {
    assertDiskRoom(dir)
  } catch (err) {
    // Read the part to its end, or the parser never reaches `'finish'` and the route never answers.
    stream.resume()
    const refused = Promise.reject(err)
    refused.catch(() => {})
    return refused
  }
  const writer = fs.createWriteStream(dest)
  const written = new Promise<void>((resolve, reject) => {
    let failed = false
    let unchecked = 0
    stream.on('data', (chunk: Buffer | string) => {
      if (failed) return
      unchecked += chunk.length
      if (unchecked < RECHECK_EVERY_BYTES) return
      unchecked = 0
      try { assertDiskRoom(dir) } catch (err) { fail(err) }
    })
    const fail = (err: unknown) => {
      if (failed) return
      failed = true
      // Keep reading the upload: a part nobody reads holds the parser short of `'finish'`, so the route would
      // never answer. Unpiped first: the writer destroyed below would otherwise unpipe it on close, after this
      // resume, and leave it paused.
      stream.unpipe(writer as NodeJS.WritableStream)
      stream.resume()
      // Remove the file once the writer has closed it: Windows refuses to delete an open file, and an error
      // before the open completes would otherwise delete nothing and leave the file it then creates.
      const remove = () => { unlinkSafe(dest, label); reject(err) }
      if (writer.closed) remove()
      else { writer.once('close', remove); writer.destroy() }
    }
    writer.on('finish', resolve)
    writer.on('error', fail)
    stream.on('error', fail)
  })
  written.catch(() => {})
  stream.pipe(writer)
  return written
}
