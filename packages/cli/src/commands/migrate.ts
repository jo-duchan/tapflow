import { banner } from '../lib/print.js'
import { migrateDataDir } from '../lib/migrate-data-dir.js'

// `tapflow migrate data-dir` — one-shot move of a legacy .tapflow-data/ into the unified .tapflow/data/.
export function cmdMigrateDataDir(): void {
  const result = migrateDataDir(process.cwd())
  switch (result.status) {
    case 'migrated': {
      const lines = ['Moved .tapflow-data/ → .tapflow/data/.']
      if (result.configUpdated) lines.push('Repointed local.dataDir in tapflow.config.json.')
      if (result.gitignoreUpdated) lines.push('Added the runtime paths to .gitignore.')
      lines.push('Start tapflow as usual: tapflow start')
      banner('success', 'DATA DIRECTORY MIGRATED', lines)
      return
    }
    case 'noop-already':
      banner('success', 'ALREADY MIGRATED', ['.tapflow/data/ is in place and no legacy .tapflow-data/ remains.'])
      return
    case 'noop-no-legacy':
      banner('success', 'NOTHING TO MIGRATE', ['No legacy .tapflow-data/ found in this directory.'])
      return
    case 'conflict':
      banner('error', 'MIGRATION BLOCKED', [
        'Both .tapflow-data/ (legacy) and .tapflow/data/ exist.',
        'Reconcile by hand — keep the directory with your real data, remove the other, then re-run.',
      ])
      process.exit(1)
      break
    case 'exdev':
      banner('error', 'CROSS-FILESYSTEM MOVE', [
        '.tapflow-data/ and .tapflow/data/ are on different filesystems, so an atomic move is not possible.',
        'Move it by hand: mv .tapflow-data .tapflow/data',
        'Then set local.dataDir to .tapflow/data in tapflow.config.json if it was pinned to the old path.',
      ])
      process.exit(1)
      break
  }
}
