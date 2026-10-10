import path from 'path'
import { getDb } from '../db.js'
import { unlinkSafe } from './uploads.js'
import { resolveBuildFile } from './buildFiles.js'

/** Where a build's dependents keep their files. All three are this install's, not the stored paths'. */
export interface BuildFileDirs {
  uploadsDir: string
  recordingsDir: string
  runScreenshotsDir: string
}

const SQLITE_MAX_PARAMS = 999

function chunked<T>(arr: T[]): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < arr.length; i += SQLITE_MAX_PARAMS) chunks.push(arr.slice(i, i + SQLITE_MAX_PARAMS))
  return chunks
}

/**
 * Delete builds together with every row that points at them, then their files.
 *
 * **One path for both ways a build goes**, the daily purge and deleting its app. They had drifted: the purge
 * removed recordings first, and app deletion removed nothing — so an app with a recorded build failed its
 * delete on the recordings foreign key (`foreign_keys = ON`), and one without left every build file on disk.
 * Run records are a third dependent, and adding them to one path only would have rebuilt the same drift.
 *
 * Rows go in one transaction and files after it commits: a failed transaction leaves rows pointing at files
 * that still exist, where the opposite order could leave rows pointing at nothing. `alsoInTransaction` runs
 * inside it, for a caller whose own delete (the app row) must land with the builds or not at all.
 */
export function deleteBuildsWithDependents(
  buildIds: number[],
  dirs: BuildFileDirs,
  alsoInTransaction: () => void = () => {},
): void {
  const db = getDb()
  const chunks = chunked(buildIds)
  const select = <R>(sql: (ph: string) => string): R[] =>
    chunks.flatMap((chunk) => db.prepare(sql(chunk.map(() => '?').join(','))).all(...chunk) as R[])

  const builds = select<{ file_path: string }>((ph) => `SELECT file_path FROM builds WHERE id IN (${ph})`)
  const recordings = select<{ filename: string }>((ph) => `SELECT filename FROM recordings WHERE build_id IN (${ph})`)
  const screenshots = select<{ screenshot_file: string }>((ph) => `
    SELECT f.screenshot_file FROM flow_run_flows f JOIN flow_runs r ON r.seq = f.run_seq
    WHERE r.build_id IN (${ph}) AND f.screenshot_file IS NOT NULL`)

  db.transaction(() => {
    for (const chunk of chunks) {
      const ph = chunk.map(() => '?').join(',')
      db.prepare(`DELETE FROM recordings WHERE build_id IN (${ph})`).run(...chunk)
      // `flow_run_flows` goes with its run (ON DELETE CASCADE).
      db.prepare(`DELETE FROM flow_runs WHERE build_id IN (${ph})`).run(...chunk)
      db.prepare(`DELETE FROM builds WHERE id IN (${ph})`).run(...chunk)
    }
    alsoInTransaction()
  })()

  for (const { filename } of recordings) unlinkSafe(path.join(dirs.recordingsDir, filename), 'recording')
  for (const { screenshot_file } of screenshots) unlinkSafe(path.join(dirs.runScreenshotsDir, screenshot_file), 'run screenshot')
  for (const { file_path } of builds) {
    const found = resolveBuildFile(file_path, dirs.uploadsDir)
    if (found !== null) unlinkSafe(found, 'build')
  }
}
