import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sources } from './sourceFiles.mjs'

// `mcp-server` and `flow-runner` each declare what they do with all 29 messages a browser socket can
// receive. The compiler owns the key set (`satisfies Record<BrowserInbound['type'], Disposition>`), so this
// file checks the two things a type cannot: that a `does` entry corresponds to real code, and that an
// `ignored` entry corresponds to none.
//
// **The second half is what the dashboard's equivalent lacks**, and it is the reason these tables can say
// more than that one. There, an entry claiming `ignored` while the message quietly starts being handled is
// invisible. Here it fails.
//
// Two things were measured before this predicate was written, and both would have made a naive port wrong:
//
//  - **The clients compare `m['type']`, not `m.type`.** The dashboard's regex is `[\w.]+\.type …`, so a
//    direct port reports every handled message as unhandled.
//  - **The four lifecycle messages are `case` labels**, not comparisons — `switch (msg['type'])` in both
//    files. A predicate that only accepts `===` reports working code as missing, which is the failure
//    direction that gets a check deleted rather than fixed.
//
// And the thing that is *not* relaxed: **it must be a comparison or a label, never mere presence.** The
// dashboard's own test records what presence certified — `error` listed as handled in a component with no
// branch for it, made green by three unrelated `'error'` strings, while the message really was dropped.
// These two files quote literals in prose constantly (`device:shutdown-error` appears in three consecutive
// comments in `client.ts`), so presence here would be weaker still. Comments are stripped first, which is
// also what lets an `ignored` entry explain itself in the source without falsifying its own claim.

const root = join(import.meta.dirname, '../..')

/** Two shapes mean the message is read. `settles` is the bookkeeping majority — a symmetric request/reply
 *  pair whose value is just the method — and `does` is the handful that do more than settle one request.
 *  Splitting them is why the tables can be skimmed: the prose that is left is prose someone needs. */
const HANDLED = /\b(settles|does):/

const PACKAGES = [
  { name: '@tapflowio/mcp-server', dir: 'packages/mcp-server/src' },
  { name: '@tapflowio/flow-runner', dir: 'packages/flow-runner/src' },
]

/** Every source file under the package's `src` except the table itself — a handler moving to another file
 *  must keep the table honest, and an `ignored` claim has to be false the moment *any* file reads the
 *  message.
 *
 *  **The walk comes from `sourceFiles.mjs`**, which is the rule `checksWalkDisk` enforces and which this
 *  file broke on its first run: a hand-rolled `sources()` here is a second enumeration under a name that
 *  check does not know, and #522 is the record of what a second enumeration cost — a listing built from
 *  `git ls-files` reports nothing about the newly created file a completeness check exists to look at. */
const scanned = (dir) => sources(dir).filter((f) => !f.endsWith('inboundDisposition.ts'))

/** Source with comments blanked, preserving line count so nothing downstream can drift. */
const code = (path) =>
  readFileSync(join(root, path), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n')

/** A receiver acting on this literal: a comparison against `.type` or `['type']`, or a `switch` label.
 *  Quote style and spacing are both tolerated — a guard that only matches today's formatting stops
 *  guarding the moment someone reformats, and does it silently. */
const receives = (type) => {
  const lit = `['"]${type.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`
  return new RegExp(
    String.raw`(?:[\w.]+\.type|\w+\[['"]type['"]\])\s*[=!]==\s*${lit}` + '|' + String.raw`case\s+${lit}\s*:`,
  )
}

/** Entries of a table, stopping at its own closing line. Slicing to end-of-file once let anything
 *  entry-shaped *below* a table count as an entry, which defeats the count. */
function entries(src) {
  const start = src.indexOf('export const INBOUND_DISPOSITION = {')
  expect(start, 'INBOUND_DISPOSITION is gone').toBeGreaterThan(-1)
  const end = src.indexOf('} satisfies', start)
  expect(end, 'the table no longer closes with `} satisfies`').toBeGreaterThan(start)
  const body = src.slice(start, end + 1).replace(/^\s*\/\/.*$/gm, '')
  const out = new Map()
  for (const m of body.matchAll(/'([^']+)': \{([\s\S]*?)\},\n(?=\s*(?:'|\}))/g)) out.set(m[1], m[2])
  return out
}

describe('both clients declare what they do with every browser-inbound message', () => {
  // **The predicate is checked before it is trusted.** Relaxing it to bare presence, or dropping the `case`
  // arm, leaves every assertion below green — the tables are correct today, so a weaker predicate has no
  // offender to miss. Measured: both mutations survived until these two tests existed. What they hold is the
  // strictness itself, which is the only part of this file that decides whether it catches anything.
  it('a receiver is a comparison or a label, and prose is not one', () => {
    const r = () => receives('device:shutdown-error')
    // The three shapes that are real code, all of which appear in these two packages.
    expect(r().test("if (msg['type'] === 'device:shutdown-error') return")).toBe(true)
    expect(r().test('if (m.type !== "device:shutdown-error") return')).toBe(true)
    expect(r().test("      case 'device:shutdown-error': {")).toBe(true)
    // And the two that certified a false claim in the dashboard's first version.
    expect(r().test('// answers device:shutdown-error when it cannot dispatch'), 'prose is not a receiver')
      .toBe(false)
    expect(r().test("const label = 'device:shutdown-error'"), 'a bare string is not a receiver').toBe(false)
  })

  it('comments really are removed before the source is judged', () => {
    // Not a fixture: this is the file that made it necessary. `client.ts` names `device:shutdown-error` in
    // three consecutive comments above the branch that reads it, so a check reading raw source would pass
    // on the prose alone if the branch were deleted.
    const path = 'packages/mcp-server/src/client.ts'
    const raw = readFileSync(join(root, path), 'utf8')
    const count = (t, lit) => (t.match(new RegExp(lit, 'g')) ?? []).length
    expect(count(raw, 'device:shutdown-error')).toBeGreaterThan(count(code(path), 'device:shutdown-error'))
  })

  for (const { name, dir } of PACKAGES) {
    describe(name, () => {
      const table = entries(readFileSync(join(root, dir, 'inboundDisposition.ts'), 'utf8'))
      const src = scanned(dir).map(code).join('\n')

      it('parsed every entry — 36, the browser-inbound surface', () => {
        // The compiler already refuses a missing key, so this is the parser's honesty check rather than
        // the coverage one. Pinned from the measurement: 29 as of #542, which added `device:shutdown-error`;
        // 32 by the next count, and 36 once the four `watch:*` replies arrived.
        expect(table.size).toBe(36)
      })

      it('every entry is exactly one of settles / does / ignored', () => {
        const bad = []
        for (const [type, value] of table) {
          const has = [/\bsettles:/, /\bdoes:/, /\bignored:/].filter((r) => r.test(value)).length
          if (has !== 1) bad.push(type)
        }
        expect(bad).toEqual([])
      })

      it('a handled entry names a message this package actually receives', () => {
        const missing = [...table]
          .filter(([, v]) => HANDLED.test(v))
          .filter(([type]) => !receives(type).test(src))
          .map(([type]) => type)
        expect(missing, 'declared as handled, but no comparison or case label reads it').toEqual([])
      })

      it('an `ignored` entry names a message this package really does not receive', () => {
        // The half the dashboard's check does not have. Scanned over the whole package, so a handler
        // appearing in another file — `tools.ts`, `engine.ts` — breaks the claim rather than hiding behind
        // the table naming one.
        const handled = [...table]
          .filter(([, v]) => /\bignored:/.test(v))
          .filter(([type]) => receives(type).test(src))
          .map(([type]) => type)
        expect(handled, 'declared as ignored, but something in this package reads it').toEqual([])
      })

      it('an ignored message states a reason, and the reason is a sentence', () => {
        const thin = []
        for (const [type, value] of table) {
          const m = value.match(/ignored:\s*([\s\S]*)/)
          if (!m) continue
          const prose = m[1].replace(/['"+\s]+/g, ' ').trim()
          if (prose.length < 40) thin.push(type)
        }
        expect(thin, 'an `ignored` with no real reason is the oversight this table exists to prevent').toEqual([])
      })

      it('the source scan is not quietly empty', () => {
        // Both assertions above pass on an empty `src`: nothing is found, so nothing is missing, and every
        // `ignored` claim holds vacuously. Measured floors, not round numbers — this program's parser
        // failures were all partial losses that left a non-empty result behind.
        expect(scanned(dir).length).toBeGreaterThanOrEqual(3)
        expect([...table].filter(([t, v]) => HANDLED.test(v) && receives(t).test(src)).length)
          .toBeGreaterThanOrEqual(20)
      })
    })
  }

  it('the two tables disagree, which is why they are not one file', () => {
    // If they were identical, a shared module would be right and the duplication would be waste. They are
    // not: `flow-runner` sends no shutdown, so it ignores a pair `mcp-server` settles waiters on. Asserted
    // rather than trusted, because the day they *do* converge is the day this decision should be revisited.
    const [mcp, flow] = PACKAGES.map(({ dir }) =>
      entries(readFileSync(join(root, dir, 'inboundDisposition.ts'), 'utf8')))
    const differing = [...mcp].filter(([t, v]) => HANDLED.test(v) !== HANDLED.test(flow.get(t) ?? ''))
    expect(differing.map(([t]) => t).sort()).toEqual(['device:shutdown-done', 'device:shutdown-error'])
  })
})
