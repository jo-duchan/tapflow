import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// `packages/dashboard/lib/inboundDisposition.ts` says what the dashboard does with each of the 28
// messages a browser socket can receive. The **compiler** owns the key set: the table is written with
// `satisfies Record<BrowserInbound['type'], Disposition>`, so a message added to the wire breaks it until
// someone picks a category. Measured — adding one produced `TS1360` at the table.
//
// That leaves exactly two things a type cannot state, and they are what this file checks:
//
//  - an `{ at: 'DeviceViewer' }` entry claims a file handles the message. Nothing makes that true.
//  - an `{ ignored: '…' }` entry claims a reason exists. An empty string type-checks fine.
//
// This is a narrow, safe use of source parsing, and the reason is worth naming: **the parser does not
// decide what to check.** It is handed a complete key set by the compiler and only answers "does this
// literal appear in this file". Every parser failure in this program came from the other arrangement —
// a parser that also had to discover the set, and quietly discovered less of it (a region that ate the
// next declaration's doc comment; a body regex that skipped an interface with a blank line in it, so the
// count assertion passed *because* of the skip).

const root = join(import.meta.dirname, '../..')

/** A receiver comparing its `.type` against a message name. Tolerates either quote style and any spacing
 *  around the operator: a guard that only matches this repo's current formatting stops guarding the moment
 *  someone writes `msg.type==="x"`, and it does so silently — the same fragility as every other parser this
 *  program has had to harden. What it must still reject is a bare literal, so the `.type` and the operator
 *  are both required. */
const comparison = (type) => new RegExp(String.raw`[\w.]+\.type\s*[=!]==\s*['"]${type}['"]`)
const table = readFileSync(join(root, 'packages/dashboard/lib/inboundDisposition.ts'), 'utf8')

/** Where a name in an `at:` value lives. The table names modules, not paths. */
const FILES = {
  DeviceViewer: 'packages/dashboard/components/DeviceViewer.tsx',
  useAgentSession: 'packages/dashboard/hooks/useAgentSession.ts',
  useClipboardBridge: 'packages/dashboard/hooks/useClipboardBridge.ts',
  useNetworkControl: 'packages/dashboard/hooks/useNetworkControl.ts',
  MacResources: 'packages/dashboard/src/pages/MacResources.tsx',
}

/** Entries of the table, comments stripped so prose cannot be read as a declaration. */
function entries(src) {
  const start = src.indexOf('export const INBOUND_DISPOSITION = {')
  expect(start, 'INBOUND_DISPOSITION is gone').toBeGreaterThan(-1)
  // Stop at the table's own closing line. Slicing to end-of-file let anything entry-shaped *below* the
  // table be counted as an entry — which defeats the count below, because a key the regex skips (a
  // double-quoted one, say) can be made up for by a sibling map underneath. Measured: 28 entries with
  // `app:launch-done` absent from every other assertion, all green. Third time this program has been bitten
  // by a region parser that did not know where its region ended.
  const end = src.indexOf('} satisfies', start)
  expect(end, 'the table no longer closes with `} satisfies`').toBeGreaterThan(start)
  const body = src.slice(start, end + 1).replace(/^\s*\/\/.*$/gm, '')
  const out = new Map()
  // A value spans to the next `'…':` key or the closing `} satisfies`, so multi-line reasons survive.
  for (const m of body.matchAll(/'([^']+)': \{([\s\S]*?)\},\n(?=\s*(?:'|\}))/g)) {
    out.set(m[1], m[2])
  }
  return out
}

const table_entries = entries(table)

describe('inbound disposition', () => {
  it('parsed every entry — 36, the browser-inbound surface', () => {
    // The compiler already refuses a missing key, so this is not the coverage assertion; it is the
    // parser's own honesty check. Without it the two assertions below pass on an empty map.
    // 29 as of #542: `device:shutdown-error` gave the shutdown pair the failure member it lacked.
    // 36 with the four `watch:*` replies.
    expect(table_entries.size).toBe(36)
  })

  it('every entry is exactly one of at / ignored', () => {
    const bad = []
    for (const [type, value] of table_entries) {
      const hasAt = /\bat:/.test(value)
      const hasIgnored = /\bignored:/.test(value)
      if (hasAt === hasIgnored) bad.push(`${type}: at=${hasAt} ignored=${hasIgnored}`)
    }
    expect(bad).toEqual([])
  })

  it('a file named in `at` actually handles that message', () => {
    const missing = []
    const unknown = []
    for (const [type, value] of table_entries) {
      const at = value.match(/at:\s*'([^']+)'/)
      if (!at) continue
      for (const name of at[1].split(',').map((n) => n.trim())) {
        const path = FILES[name]
        if (!path) { unknown.push(`${type}: ${name}`); continue }
        const src = readFileSync(join(root, path), 'utf8')
        // A *receive branch*, not the literal anywhere in the file. `includes` certified a false claim
        // that shipped in this table's first version: `error` was listed as handled in `SessionList` (since
        // deleted, #584), which had no branch for it — three unrelated `'error'` strings (a `Record<string, 'booting' |
        // 'error'>`, an assignment, a comparison) made it green, and the message really was being dropped
        // there. Deleting a genuine branch and leaving the literal in a comment passed too.
        // Any receiver's own name, not just `msg` — `useClipboardBridge` correlates by requestId and reads
        // `reply.type === 'clipboard:error'`. What must not pass is a bare literal: a comment, a `send()`
        // argument, or an unrelated string that happens to equal a message name.
        // A comparison of some receiver's `.type` against this literal — either direction. `useClipboardBridge`
        // reads `reply.type === 'clipboard:error'` and narrows to `clipboard:data` with `!==`, and both are
        // handling. What must not pass is a bare literal: a comment, a `send()` argument, or an unrelated
        // string that happens to equal a message name.
        if (!comparison(type).test(src)) {
          missing.push(`${type} has no \`<msg>.type\` comparison against '${type}' in ${name}`)
        }
      }
    }
    expect(unknown, 'a name in `at` that this check cannot resolve to a file').toEqual([])
    expect(missing).toEqual([])
  })

  it('a module that handles a message is named in its `at`', () => {
    // The reverse direction, and the table has no way to notice it on its own. `at` is not obliged to be
    // complete: a component that starts comparing `.type` against a message does not break anything, so
    // the entry silently becomes a partial answer to "where is this handled". That happened inside this
    // PR — `SessionList` gained a `session:joined` branch and the entry still named two files.
    const stale = []
    for (const [name, path] of Object.entries(FILES)) {
      const src = readFileSync(join(root, path), 'utf8').replace(/^\s*\/\/.*$/gm, '')
      for (const m of src.matchAll(/[\w.]+\.type\s*[=!]==\s*['"]([^'"]+)['"]/g)) {
        const value = table_entries.get(m[1])
        if (!value) continue                        // not a browser-inbound type (outbound, local unions)
        const at = value.match(/at:\s*'([^']+)'/)
        const named = at ? at[1].split(',').map((n) => n.trim()) : []
        if (!named.includes(name)) stale.push(`${m[1]} is handled in ${name}, which its \`at\` does not name`)
      }
    }
    expect([...new Set(stale)]).toEqual([])
  })

  it('an ignored message states a reason, and the reason is a sentence', () => {
    const thin = []
    for (const [type, value] of table_entries) {
      const m = value.match(/ignored:\s*([\s\S]*)$/)
      if (!m) continue
      // Concatenated string literals are one reason; take their contents.
      const text = [...m[1].matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((x) => x[1]).join(' ').trim()
      // 40 characters is not a style rule — it is the line between a reason and a label. "not needed"
      // type-checks and tells the next reader nothing, which is the state this table replaced.
      if (text.length < 40) thin.push(`${type}: ${JSON.stringify(text)}`)
    }
    expect(thin).toEqual([])
  })

  it('the ignored messages are the ones a decision put there', () => {
    // Pinned so that "handled" quietly becoming "ignored" is a decision someone makes here, in a diff,
    // rather than a branch that got deleted. Growing this list is allowed; doing it silently is not.
    const ignored = [...table_entries].filter(([, v]) => /\bignored:/.test(v)).map(([t]) => t).sort()
    expect(ignored).toEqual([
      'app:clear-state-done',
      'app:clear-state-error',
      'input:done',
      'input:type-done',
      'input:type-error',
      // `network:state` and `network:error` were here, with a note saying they would become `at:`
      // when the viewer landed. It has, and they did — which is the whole point of writing "no branch
      // yet" down rather than leaving an absent branch to speak for itself.
      'session:deviceInfo',
      // No page watches yet. Like `network:*` above, these become `at:` when the AI session page lands
      // and sends `watch:start` — written down so that arriving is a diff, not a branch nobody noticed.
      'watch:ended',
      'watch:holder-left',
      'watch:refused',
      'watch:started',
    ])
  })
})
