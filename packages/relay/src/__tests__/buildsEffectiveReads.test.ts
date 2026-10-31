import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

/**
 * **A floor, not a fence** (contributing/test-and-guard-coverage.md). A build's version and build number in use are
 * made in one place, the `builds_effective` view (migration 022, #1084). A query that reads them from `builds` gets the
 * file's values and silently ignores what a person set. This finds such a query by its text; the runtime tests in
 * buildOverride.test.ts are what show every route returns the value in use.
 *
 * It reads SQL in string and template literals, so a JS property read (`row.version_name`) is not SQL and passes.
 */

const SRC = path.join(import.meta.dirname, '..')

/** Reads the file's own values on purpose: an override equal to them is stored as none. */
const ALLOWED = ['SELECT status_label, version_name, build_number FROM builds WHERE id = ?']

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) return e.name === '__tests__' ? [] : sourceFiles(full)
    return e.name.endsWith('.ts') ? [full] : []
  })
}

function sqlLiterals(text: string): string[] {
  return [...text.matchAll(/`[^`]*`|'[^'\n]*'/g)].map((m) => m[0])
}

describe('builds are read through builds_effective (#1084)', () => {
  const literals = sourceFiles(SRC).flatMap((f) => sqlLiterals(fs.readFileSync(f, 'utf8')).map((sql) => ({ f: path.relative(SRC, f).split(path.sep).join('/'), sql })))  // `/` on Windows too

  it('reads no version or build number straight from builds', () => {
    // A statement that joins the view may still read ids or platforms from `builds` in a subquery (the apps list
    // does), so one that names the view is taken as reading its versions from it. That is the floor's blind spot: a
    // statement that joins both and takes its version from `builds` passes.
    const offenders = literals.filter(({ sql }) =>
      /\b(FROM|JOIN)\s+builds\b(?!_)/i.test(sql) && !/\bbuilds_effective\b/.test(sql) &&
      (/\b(version_name|build_number)\b/.test(sql) || /\*\s+FROM\s+builds\b(?!_)/i.test(sql)) &&
      !ALLOWED.some((a) => sql.includes(a)))
    expect(offenders.map(({ f, sql }) => `${f}: ${sql.replace(/\s+/g, ' ').slice(0, 120)}`)).toEqual([])
  })

  // Without this, a scanner that matched nothing would pass the test above.
  it('sees the reads that do go through the view', () => {
    const viaView = literals.filter(({ sql }) => /\b(FROM|JOIN)\s+builds_effective\b/i.test(sql))
    expect(new Set(viaView.map(({ f }) => f))).toEqual(new Set(['api/builds.ts', 'api/apps.ts', 'api/runs.ts']))
  })
})
