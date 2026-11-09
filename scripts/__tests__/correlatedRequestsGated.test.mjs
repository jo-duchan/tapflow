import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

// Every browser request that declares a **required** `requestId` must be gated at the relay's door, because
// every reply it can produce declares the correlator required too — so an ungated request means the relay
// either ships a frame with an absent required field, or forwards one whose reply nobody can attribute.
// Both were live defects: `requestId: msg.requestId!` in `clipboard:error` and, one slice earlier, in
// `open-url:error`. The second was fixed and the first survived next door for a whole slice.
//
// The claim "one policy at the door" was prose in a comment until this file. It is checkable because the
// property is **presence of a gate** — unlike the echo obligation, where the property is provenance and no
// check can see it (see the note above `OpenUrlReplyBody`).
//
// The member set is **derived** from the protocol, so an eighth correlated request added later fails here
// rather than being noticed by whoever reads the comment.
//
// **Where the gate lives moved, and this file moved with it.** It used to be `isCorrelated(msg)` written
// into each `case`, or a dispatch to a handler whose parameter was narrowed to `{ requestId: string }`.
// Since #444 the door is a parse: `@tapflowio/protocol/validate` refuses a frame whose schema declares
// `requestId` before `route` ever runs. So the property to check is that each correlated request's
// **schema** demands the correlator — the same claim, one layer earlier, and now covering the empty
// string as well as the absent field without either being spelled out at a call site.
//
// Checking the schema rather than the case body is also why this survives the next refactor of the
// switch: the gate is no longer something a `case` can forget to write.

const root = join(import.meta.dirname, '../..')
const read = (p) => readFileSync(join(root, p), 'utf8')

const sourceOf = (path, src) =>
  ts.createSourceFile(path, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

/** `BrowserToRelay` members whose declaration carries a required `requestId`. */
function correlatedRequestTypes(proto) {
  const rhs = proto.match(/export type BrowserToRelay =([\s\S]*?)\n\n/)
  expect(rhs, 'BrowserToRelay is gone').not.toBeNull()
  const members = rhs[1].split('|').map((s) => s.trim()).filter(Boolean)

  const out = []
  const seen = new Set()
  // Members can be nested unions — `ClipboardRequest` is `ClipboardRead | ClipboardWrite`, and the first
  // version of this file missed both because it only looked for an `export interface` of that name. The
  // count assertion below is what caught it.
  const resolve = (name) => {
    if (seen.has(name)) return
    seen.add(name)
    const decl = proto.match(new RegExp(String.raw`^export interface ${name}(?: extends \w+)? \{([\s\S]*?)\n\}`, 'm'))
    if (decl) {
      // `requestId?: string` does not count — the point is the required ones.
      if (!/^ {2}requestId: string$/m.test(decl[1])) return
      const lit = decl[1].match(/^ {2}type: '([^']+)'/m)
      expect(lit, `${name} has no literal type`).not.toBeNull()
      out.push(lit[1])
      return
    }
    const alias = proto.match(new RegExp(String.raw`^export type ${name} =([\s\S]*?)(?=\n\n|\nexport )`, 'm'))
    if (!alias) return
    for (const n of alias[1].split('|').map((x) => x.trim()).filter(Boolean)) resolve(n)
  }
  for (const name of members) resolve(name)
  return out
}

/** Correlated requests whose declaration has no `sessionId`. */
function unaddressedTypes(proto, types) {
  return types.filter((type) => {
    const decl = proto.match(new RegExp(String.raw`^export interface \w+(?: extends \w+)? \{\n {2}type: '${type}'\n([\s\S]*?)\n\}`, 'm'))
    expect(decl, `${type}: declaration not found`).not.toBeNull()
    return !/^ {2}sessionId: string$/m.test(decl[1])
  })
}

/**
 * Correlated requests with no session, and so no address for a `bad-payload` refusal: `ParseFailure` carries the
 * session a reply goes to. Each one's schema must instead read every payload value as absent, so no payload can
 * make the door drop it — proved by parsing, in `protocol/src/__tests__/validate.test.ts`. Listed, so a new one
 * is a decision rather than a gap.
 */
const UNADDRESSED = ['device:lease']

/**
 * For each literal in the inbound schema map, the **top-level** `requestId` property of its schema.
 *
 * Parsed rather than grepped, and the difference is the whole check. A first draft matched
 * `/(^|[^.\w])requestId\b/` against the schema's source text, which passes on a `requestId` nested
 * inside a payload, on the word appearing in a comment, and — the one that matters — on an inline
 * `requestId: z.string()` written in place of the shared `.min(1)` constant. That last one is
 * invisible to every other gate in the repo: `SchemaExact` cannot see it, because `.min(1)` does not
 * change what `z.output` infers, which is exactly why it costs the tier assertions nothing. The
 * empty-string half would have gone back to being unguarded per message while the whole suite stayed
 * green, reproducing the `clipboard:error` defect this file exists for.
 *
 * Returns `null` when there is no `requestId` property, and otherwise the initializer's text.
 */
function correlatorOf(sf) {
  const out = new Map()
  const visit = (node) => {
    // **Only the inbound maps.** `ANSWERABLE` sits in the same file and is keyed by the same literals,
    // but its values are `envC('…')` calls rather than `z.object({ … })` — so a walk that read it would
    // find no `requestId` property and report every correlated request as ungated. Skipping it by name
    // rather than by shape, because "no shape I recognise" is exactly the answer a broken parser gives.
    if (
      ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) &&
      !['BROWSER_INBOUND', 'AGENT_CONSUMED', 'AGENT_FORWARDED', 'STREAM_INBOUND'].includes(node.name.text)
    ) return
    // `'app:install': z.object({ … })` — a string-literal key whose value is a call.
    if (!ts.isPropertyAssignment(node) || !ts.isStringLiteral(node.name)) return ts.forEachChild(node, visit)
    const shape = ts.isCallExpression(node.initializer) ? node.initializer.arguments[0] : undefined
    if (!shape || !ts.isObjectLiteralExpression(shape)) {
      out.set(node.name.text, { present: false, init: null })
      return ts.forEachChild(node, visit)
    }
    const prop = shape.properties.find(
      (p) =>
        (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
        p.name && ts.isIdentifier(p.name) && p.name.text === 'requestId',
    )
    out.set(node.name.text, {
      present: prop !== undefined,
      // A shorthand `requestId,` *is* the shared constant; a longhand carries its own expression.
      init: prop === undefined ? null : ts.isShorthandPropertyAssignment(prop) ? 'requestId' : prop.initializer.getText(sf),
    })
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

  const proto = read('packages/protocol/src/index.ts')
  const validatePath = 'packages/protocol/src/validate/index.ts'
  const validateSrc = read(validatePath)
  const sf = sourceOf(validatePath, validateSrc)

  const types = correlatedRequestTypes(proto)
  const bodies = correlatorOf(sf)
  const unaddressed = unaddressedTypes(proto, types)
  /** The requests a malformed payload can be answered for: they name the session the answer goes to. */
  const addressed = types.filter((t) => !unaddressed.includes(t))

  it('the requests with no session are the listed ones', () => {
    expect(unaddressed.sort()).toEqual([...UNADDRESSED].sort())
  })

  it('finds the correlated request set, derived rather than listed', () => {
    // If this drops to zero the derivation broke and every assertion below would vacuously pass — the
    // failure mode a count assertion exists for. The floor is raised as pairs land, so removing a
    // required `requestId` from a request already in the set fails here too, not only where it is used:
    // 6 after the app commands, 7 once `device:boot` joined.
    expect(types.length).toBeGreaterThanOrEqual(7)
  })

  for (const type of types) {
    it(`${type} is gated`, () => {
      const entry = bodies.get(type)
      expect(entry, `${type} has no schema in the inbound map — the door would refuse it as unknown-type`)
        .toBeDefined()

      expect(
        entry.present,
        `${type} declares a required requestId but its schema has no top-level requestId, so the door ` +
        `forwards an uncorrelatable request and the reply it produces cannot be attributed`,
      ).toBe(true)

      // The shared constant, or something that carries its `.min(1)` — and never `.optional()`.
      // Both halves matter: absence lets the request through uncorrelated, and `''` produces a reply
      // whose required correlator is present-but-empty, which every correlating consumer discards.
      expect(
        entry.init === 'requestId' || /\.min\(1\)/.test(entry.init),
        `${type}'s schema declares requestId as \`${entry.init}\`, which does not carry the non-empty ` +
        `constraint. Use the shared \`requestId\` constant — an inline z.string() accepts '' and no ` +
        `type-level assertion can see the difference.`,
      ).toBe(true)
      expect(
        /\.optional\(\)|\.nullish\(\)/.test(entry.init),
        `${type} declares a required requestId and its schema makes it optional — the two disagree, and ` +
        `the schema is the one the wire obeys`,
      ).toBe(false)
    })
  }

  // ── the three lists that must not drift apart ─────────────────────────────────────────────────
  //
  // A correlated browser request is refused at the door when its payload is wrong, and refusing it
  // without answering turns a diagnosis into a caller waiting out its deadline — which for the acked
  // inputs is worse than it sounds, since `awaitInputAck` reports silence from a never-acked session
  // as **success** (#457). So three lists have to agree, and only one of them is derived:
  //
  //   1. the correlated request set, from the protocol (above)
  //   2. `ANSWERABLE` in `protocol/src/validate/index.ts`, which decides what gets a second parse
  //   3. `refuseMalformed` in the relay, which decides which reply each one gets
  //
  // Nothing else compares them: a request missing from (2) is refused with `bad-shape` and dropped, and
  // one missing from (3) falls to a `default` that answers `input:error` — a reply whose waiter does
  // not exist for a non-input request.

  /** The literal keys of the `ANSWERABLE` map. */
  function answerableTypes(src) {
    const body = src.match(/const ANSWERABLE = \{([\s\S]*?)\n\} as const/)
    expect(body, 'ANSWERABLE is gone from protocol/src/validate').not.toBeNull()
    return new Set([...body[1].matchAll(/^\s*'([^']+)':/gm)].map((m) => m[1]))
  }

/**
 * Which reply each answerable request must be refused with.
 *
 * **Listed, where the keys above are derived, and the asymmetry is the point.** The set of answerable
 * requests is a fact about the protocol and derives from it; *which reply answers which request* is a
 * fact about consumers' waiters and derives from nothing — `mcp-server` and `flow-runner` key on the
 * pair each request declares, and the naming is not uniform enough to compute (`open-url` answers
 * `open-url:error`, not `open-url-error`; both clipboard requests answer one `clipboard:error`; the
 * four remaining inputs share `input:error`). So the keys catch a new request and this catches a
 * wrong reply, and the two assertions below need both.
 */
const EXPECTED_REPLY = {
  'device:boot': 'device:boot-error',
  'app:install': 'app:install-error',
  'app:launch': 'app:launch-error',
  'app:clear-state': 'app:clear-state-error',
  'device:keyboard-set': 'device:keyboard-set-error',
  'open-url': 'open-url:error',
  'input:type': 'input:type-error',
  'clipboard:read': 'clipboard:error',
  'clipboard:write': 'clipboard:error',
  'network:set': 'network:error',
  'input:touch:end': 'input:error',
  'input:pinch:end': 'input:error',
  'input:key': 'input:error',
  'input:button': 'input:error',
}

describe('every correlated browser request is gated at the relay door', () => {
  /**
   * `case '<type>':` → the reply literal the branch sends, or `null` for a bare `default`.
   *
   * **Pairs them, where a first draft collected labels alone** — and a label proves nothing, because
   * `sendTo` takes `RelayOutbound` and every `*-error` literal is a valid member, so the compiler is
   * indifferent to which one a case sends. Substituting `input:error` for `open-url:error`, or leaving
   * a case empty, passed that draft and every other check: `flow-runner`'s waiter keys on the
   * `open-url:*` pair, so the caller would burn its full deadline — the regression `refuseMalformed`
   * exists to prevent, reintroduced inside it.
   */
  function repliesByCase(src) {
    const body = src.match(/private refuseMalformed\([\s\S]*?\n  \}/)
    expect(body, 'refuseMalformed is gone from the relay').not.toBeNull()
    const out = new Map()
    let pending = []
    for (const line of body[0].split('\n')) {
      const label = line.match(/case '([^']+)':/)
      if (label) pending.push(label[1])
      const reply = line.match(/type: '([^']+)'/)
      if (reply) {
        // A `default:` sends without a pending label; record it under the sentinel.
        for (const l of pending.length > 0 ? pending : ['*']) out.set(l, reply[1])
        pending = []
      }
    }
    return out
  }

  it('every correlated request can be answered when its payload is refused', () => {
    const answerable = answerableTypes(validateSrc)
    expect([...addressed].filter((t) => !answerable.has(t)).sort()).toEqual([])
    expect([...answerable].filter((t) => !addressed.includes(t)).sort()).toEqual([])
  })

  it('each request is refused with the reply its own waiter reads', () => {
    const replies = repliesByCase(read('packages/relay/src/RelayServer.ts'))
    // The `default` arm covers whatever has no case of its own; it must be the input reply, since that
    // is the only one shared by more than one request without being named.
    expect(replies.get('*'), 'refuseMalformed has no default arm').toBe('input:error')
    for (const type of addressed) {
      expect(replies.get(type) ?? replies.get('*'), `${type} is refused with the wrong reply`)
        .toBe(EXPECTED_REPLY[type])
    }
    // Non-vacuous: an empty parse would make every lookup fall to the default and agree with the four
    // inputs by accident.
    expect(replies.size).toBeGreaterThanOrEqual(9)
  })

  it('the reply table covers exactly the correlated set', () => {
    expect([...addressed].filter((t) => !(t in EXPECTED_REPLY)).sort()).toEqual([])
    expect(Object.keys(EXPECTED_REPLY).filter((t) => !addressed.includes(t)).sort()).toEqual([])
  })

  it('the shared constants carry the non-empty half', () => {
    // The per-type assertions above accept the shared constant by name, so this is what gives that name
    // its meaning. Weakening the constant fails here; weakening one call site fails above.
    expect(validateSrc).toMatch(/^const requestId = z\.string\(\)\.min\(1\)$/m)
    expect(validateSrc).toMatch(/^const sessionId = z\.string\(\)\.min\(1\)$/m)
  })
})
