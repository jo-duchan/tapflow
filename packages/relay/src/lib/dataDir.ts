import fs from 'fs'
import path from 'path'

export const LEGACY_DATA_DIR = '.tapflow-data'
export const UNIFIED_DATA_DIR = path.join('.tapflow', 'data')

export interface DefaultDataDir {
  dataDir: string
  // true → resolved to the legacy .tapflow-data/ as a read-only fallback (run `tapflow migrate data-dir`)
  usingLegacy: boolean
}

// Read-only resolution of the default data dir. The relay never MOVES anything — that is the job of
// `tapflow migrate data-dir`. It prefers the unified .tapflow/data/, but if that does not exist yet
// and a legacy .tapflow-data/ does, it keeps reading the legacy dir so an un-migrated default install
// is not silently reset to empty. The caller warns when usingLegacy is true.
export function resolveDefaultDataDir(cwd: string): DefaultDataDir {
  const target = path.join(cwd, UNIFIED_DATA_DIR)
  if (fs.existsSync(target)) return { dataDir: target, usingLegacy: false }
  const legacy = path.join(cwd, LEGACY_DATA_DIR)
  if (fs.existsSync(legacy)) return { dataDir: legacy, usingLegacy: true }
  return { dataDir: target, usingLegacy: false }
}
