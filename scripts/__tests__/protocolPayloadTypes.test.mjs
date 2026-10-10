import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

// L2 of the wire-contract work (`.work/WIRE-CONTRACT-PLAN.md`). Wire payload types were declared in
// three to five packages each and had drifted in both directions: protocol lacked
// `clipboard:error`'s payload while the dashboard's `session:chrome` lacked three fields its own
// viewer reads. `@tapflowio/protocol` owns them now.
//
// **Matched by field set, never by name.** The inventory that planned this work grepped for names and
// missed two of five copies of one shape, because `mcp-server` and `flow-runner` called it
// `DeviceInfo` while protocol calls it `DeviceSummary` and the dashboard called it `AgentDevice`. A
// name-scoped check would have passed with all five standing, and would be bypassed by a rename.
//
// Source text, not an import: protocol's main entry must stay runtime-free so it erases under
// `import type` (see its AGENTS.md HOW NOT), so this cannot load the types as values. Same technique
// as `inputErrorReason.test.mjs`.

const ROOT = new URL('../..', import.meta.url).pathname
const PROTOCOL = join(ROOT, 'packages/protocol/src/index.ts')

/**
 * `interface X { … }` **and** `type X = { … }` → field names, with `?` kept so optionality is part of
 * the identity.
 *
 * Both forms, and a body that fits on one line, because a pre-PR review planted five duplicates and an
 * earlier version reported **one**: it required the `interface` keyword and a closing brace at the
 * start of a line, so a `type` alias and a single-line interface both walked past.
 *
 * The body is found by **counting braces**, not by a lazy `[\s\S]*?` to the first `}`. That version
 * truncated at the first nested object literal, so `ChromeData` was guarded as its first 6 fields
 * instead of 11 and `ChromeButton` as 5 instead of 13 — a real duplicate of either would not have
 * matched the truncated key at all. The by-name assertion below did not catch it, because a name being
 * present says nothing about its field set being complete; that is why `FIELD_COUNTS` exists.
 */
function interfaces(src) {
  const out = new Map()
  const head = /(?:export\s+)?(?:interface\s+(\w+)(?:\s+extends\s+([\w,\s]+?))?\s*|type\s+(\w+)\s*=\s*)\{/g
  for (const m of src.matchAll(head)) {
    const name = m[1] ?? m[3]
    const ext = m[2]
    // Walk from the opening brace to its match.
    let depth = 0
    let i = m.index + m[0].length - 1
    const start = i + 1
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++
      else if (src[i] === '}' && --depth === 0) break
    }
    const body = src.slice(start, i)
    const fields = []
    let d = 0
    for (const raw of body.split(/[\n;]/)) {
      const line = raw.replace(/\/\/.*/, '').trim()
      if (!line) continue
      // Only top-level members count; a nested literal's own keys are not fields of this type.
      if (d === 0) {
        const f = line.match(/^(\w+\??)\s*:/)
        if (f) fields.push(f[1])
      }
      d += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length
    }
    out.set(name, { fields, extends: ext ? ext.split(',').map((x) => x.trim()) : [] })
  }
  return out
}

/** Field set including inherited members, resolved within the same file. */
function resolved(decls, name, seen = new Set()) {
  if (seen.has(name)) return []
  seen.add(name)
  const d = decls.get(name)
  if (!d) return []
  return [...d.fields, ...d.extends.flatMap((e) => resolved(decls, e, seen))]
}

const key = (fields) => [...new Set(fields)].sort().join(',')

/**
 * Workspace members, from `pnpm-workspace.yaml` rather than a hardcoded list — a new top-level member
 * is then scanned without an edit here, which is what "every workspace member" has to mean to be true.
 */
function workspaceRoots() {
  const yaml = readFileSync(join(ROOT, 'pnpm-workspace.yaml'), 'utf8')
  const globs = [...yaml.matchAll(/^\s*-\s*'([^']+)'/gm)].map((m) => m[1])
  const roots = []
  for (const g of globs) {
    if (g.endsWith('/*')) {
      const parent = g.slice(0, -2)
      for (const entry of readdirSync(join(ROOT, parent))) roots.push([parent, entry])
    } else {
      roots.push(['.', g])
    }
  }
  return roots
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.tsx?$/.test(entry)) out.push(p)
  }
  return out
}

const protoSrc = readFileSync(PROTOCOL, 'utf8')
const protoDecls = interfaces(protoSrc)
/** Payload types worth guarding. Two fields is enough to be a real shape; one is a coincidence. */
// Payload shapes only. A **message** is identified by its `type` literal, not by its field set (D14 in
// the wire-contract program), and L1 turned 58 messages into interfaces — many sharing a low-arity set
// like `{type, sessionId}`. Keying those by field set would make this check report the next package
// that happens to declare `interface Foo { type: string; sessionId: string }` as re-declaring a
// protocol payload, which it is not. Measured at the time: zero such collisions existed, so this is
// removing a tripwire L1 planted rather than fixing a live failure.
// Payload shapes only, which means excluding two kinds of declaration.
//
// **Messages.** A message is identified by its `type` literal, not by its field set (D14 in the
// wire-contract program), and L1 turned 58 of them into interfaces — many sharing a low-arity set like
// `{type, sessionId}`.
//
// **Bases that messages inherit.** `SessionScoped` carries no `type`, so the first rule keeps it. Its
// shape was `{sessionId, message}` until #491 moved the prose onto each member; the reasoning below was
// measured against that pair and holds the same way for the field it kept. Measured: a plain
// `interface RelayFailure { sessionId: string; message: string }` in `mcp-server` was reported as
// re-declaring a protocol payload — and the advice this check gives ("import it from protocol instead")
// is wrong for that case. A message base is a structural fragment of the message family, not a shape a
// consumer should import.
//
// Scoped to bases of *messages*, not every base. `DeviceReport` is also extended — by `DeviceSummary`,
// which is a payload — and excluding it would drop a real shape from the guarded set. The heir having a
// `type` field is what makes its base part of the message family.
const bases = new Set(
  [...protoSrc.matchAll(/export interface (\w+) extends (\w+) \{([^}]*)\}/g)]
    .filter((m) => /^ {2}type: '/m.test(m[3]))
    .map((m) => m[2]),
)
const guarded = new Map()
for (const name of protoDecls.keys()) {
  const fields = resolved(protoDecls, name)
  if (fields.includes('type') || bases.has(name)) continue
  if (fields.length >= 2) guarded.set(key(fields), name)
}

// A local declaration that legitimately shares a shape. Each entry needs a reason, because the
// default answer is "import it from protocol instead".
const ALLOWED = new Set([
  // Same four fields as `ChromeRect`, different concept: the frame of an accessibility-tree element,
  // which has nothing to do with device chrome. Shape matching cannot tell those apart, and merging
  // them would couple the UI-tree schema to the bezel artwork. This is the known cost of matching by
  // shape instead of by name — and the cost is worth paying, since name matching missed two of five
  // copies of one shape when this work was planned.
  'agent-core:UIElementFrame',
  // `AgentSession` in mcp-server and flow-runner is `SessionInfo` minus `resources` and
  // `capabilities` — a narrower view for a client that reads neither, not a copy. Its field set
  // differs so it never matches; listed so the next reader knows it was considered rather than
  // missed.
])

describe('wire payload types are declared once, in @tapflowio/protocol', () => {
  // A count floor is the wrong assertion: 13 shapes are guarded, so losing three still passed, and
  // converting one protocol `interface` to a `type` alias used to drop it from the guard silently —
  // taking every duplicate of that shape with it. Name the ones that must be there.
  // A name being guarded says nothing about its field set being complete — which is exactly how the
  // truncating body capture hid for a round. Pin the counts of the shapes with nested literals, since
  // those are the ones a lazy match gets wrong.
  it('guards complete field sets, not truncated ones', () => {
    const count = (name) => new Set(resolved(protoDecls, name)).size
    expect(count('ChromeData')).toBe(11)
    expect(count('ChromeButton')).toBe(13)
    expect(count('DeviceSummary')).toBe(9) // 9 with `holder`, the AI client driving a device
    expect(count('SessionInfo')).toBe(5)
  })

  it('guards the payload shapes by name, so a shape cannot silently leave', () => {
    const byName = new Set(guarded.values())
    for (const name of [
      'ChromeData', 'ChromeButton', 'ChromeRect', 'AndroidButton', 'AndroidChrome',
      'AgentResources', 'SessionInfo', 'DeviceSummary', 'DeviceDetails', 'ClipboardErrorPayload',
    ]) {
      expect(byName, name).toContain(name)
    }
  })

  it('no other package re-declares a protocol payload shape', () => {
    const offenders = []
    const scanned = []
    for (const [parent, pkg] of workspaceRoots()) {
      if (pkg === 'protocol') continue
      const base = join(ROOT, parent, pkg)
      let files
      try {
        files = walk(base)
      } catch (e) {
        // Only "not a directory" is tolerated. Swallowing everything let a permission error or a
        // broken symlink skip a whole member while the test still reported green — a duplicate inside
        // it would be invisible, which defeats the point of the check.
        if (e.code === 'ENOTDIR' || e.code === 'ENOENT') continue
        throw e
      }
      scanned.push(pkg)
      for (const file of files) {
        const src = readFileSync(file, 'utf8')
        const decls = interfaces(src)
        for (const name of decls.keys()) {
          const k = key(resolved(decls, name))
          const match = guarded.get(k)
          if (match && !ALLOWED.has(`${pkg}:${name}`)) {
            offenders.push(`${file.slice(ROOT.length)} declares ${name}, same shape as protocol's ${match}`)
          }
        }
      }
    }
    // Coverage is asserted, not assumed: a member silently dropped from the walk is the other way this
    // check goes quietly useless. `playground` is named because it is the one non-`packages/` member
    // and it builds an `AgentResources` of its own.
    expect(scanned).toContain('playground')
    expect(scanned.length).toBeGreaterThanOrEqual(readdirSync(join(ROOT, 'packages')).length)
    expect(offenders).toEqual([])
  })
})
