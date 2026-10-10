import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Two facts about `packages/protocol/src/index.ts` that no type can state about itself.
//
// **1. Which interface owns which `type` literal.** `Equals<Union, UnionOld>` — the net L1 used to
// prove the conversion preserved every union — compares union *contents*, and a union is a set. Which
// name got which literal is not part of the comparison. `AgentToBrowser` has seven members whose shape
// is identical apart from the literal (`{ type: <literal>; sessionId: string }`), so swapping two of
// them passes `Equals`, passes `browserInboundRouting` (which compares membership, so the literal set
// is unchanged) and passes `protocolPayloadTypes`. Measured: the swap produced zero errors from the
// nine `Equals` assertions and two from the bindings.
//
// The bindings in `typeAssertions.ts` (`export const _InputDone: InputDone['type'] = 'input:done'`)
// are what catch it, and this file asserts every message interface has one — a guard you can forget an
// entry of is a guard with 57-of-58 coverage, and the missing one is invisible.
//
// **2. That a session-scoped failure declares `extends SessionScoped`.** This cannot be asserted with a
// type: every object with `{ sessionId }` is assignable to `SessionScoped` — a weaker bar than the
// `{ sessionId, message }` pair this argued from before #491, so the assignment
// succeeds whether or not the interface declares the inheritance. And `extends` is transparent to
// `Equals` — inherited members arrive in the resolved member set, so an error written inline instead
// passes every type-level check. The inheritance exists for the family relation, which is source text,
// so the check reads source text.

const root = join(import.meta.dirname, '../..')
const src = readFileSync(join(root, 'packages/protocol/src/index.ts'), 'utf8')
const assertionsRaw = readFileSync(join(root, 'packages/protocol/src/typeAssertions.ts'), 'utf8')
// Comments out before anything looks for declarations. The bindings' own note explains what `Equals<>`
// did and did not catch, and the "net is gone" assertion below read that prose as the net still being
// there. Same shape as the bug in `browserInboundRouting`, where a comment mentioning `{ type: 'error' }`
// was counted as an eleventh union member.
const assertions = assertionsRaw.replace(/^\s*\/\/.*$/gm, '')

/** `index.ts` with comments removed, for the union parser below.
 *
 *  **The line filter is the load-bearing half, and the first draft credited the wrong one.** That
 *  draft said removing comment lines rather than blanking them was what mattered, because blanking
 *  leaves an empty line the parser stops at. Review measured both variants over the real file and
 *  found no difference in any of the nineteen unions. What actually broke was leaving `//` lines in:
 *  `unionMembers` then reads their prose as members, so `RelayOrAgentToBrowser` came back with
 *  `Moved`, `L5c`, `An` and `TERMINAL_INPUT_TYPES` among its members.
 *
 *  The trailing `[ \t]*` and `\n?` are not cosmetic either. Without them a docblock between two union
 *  members leaves its indentation behind as a whitespace-only line, and `unionMembers` stops at one —
 *  measured: a `/** … *\/` inserted inside `AgentToBrowser` reported `ClipboardData` and
 *  `ClipboardWriteDone` as orphans of nothing. A parser that loses a declaration reports a hole that
 *  is not there, which is the same class of failure as one that reports full coverage of nothing. */
const srcNoComments = src
  // Every block comment, not only JSDoc, and the whitespace it sat on — see below for why the trailing
  // `\n?` matters.
  .replace(/[ \t]*\/\*[\s\S]*?\*\/\n?/g, '')
  .split('\n')
  // A comment-only line goes entirely: leaving it blank would terminate the union parser, which stops
  // at a blank line.
  .filter((l) => !/^\s*\/\//.test(l))
  // **And an inline one goes while its line stays.** A first draft stripped only whole-line comments,
  // and a trailing `// unlike OrphanPing, …` on a union member put `OrphanPing` in that direction's
  // member list — so a message declared in no direction at all was reported as reachable and the
  // orphan check stayed green. Measured. Prose read as a value is the shape this repo has now been
  // bitten by three times.
  .map((l) => l.replace(/\s*\/\/.*$/, ''))
  .join('\n')

/** Every `export type X = A | B | …` whose right-hand side is a union of names. */
function unionMembers(text) {
  const out = new Map()
  for (const m of text.matchAll(/export type (\w+)\s*=([\s\S]*?)(?=\n\s*\n|\nexport |\n\/\*)/g)) {
    // Skip object and string-literal types (`SessionTerminatedReason`, `ChromePayload`): only unions
    // of interface names can carry a message into a direction.
    if (/[{'"]/.test(m[2])) continue
    const names = [...m[2].matchAll(/\b([A-Z]\w+)\b/g)].map((x) => x[1])
    if (names.length) out.set(m[1], names)
  }
  return out
}

/** The seven directions a message can travel. Every declared message must be reachable from one.
 *
 *  This list is the one thing here that is restated rather than derived, and it is the small stable
 *  half: directions are added once a year, messages weekly. A renamed or deleted root is caught by the
 *  assertion that every name in it parses. */
const DIRECTIONS = [
  'BrowserToRelay', 'RelayToBrowser', 'AgentToRelay', 'AgentToBrowser',
  'RelayToAgent', 'StreamToRelay', 'RelayToStream',
]

/** Every `export interface` that declares a `type: '<literal>'` — i.e. every wire message.
 *
 *  Bodies are found by counting braces, not by matching a run of two-space lines. The regex version
 *  skipped any interface with a blank line in its body — and `expect(messages.size).toBe(65)` was then
 *  satisfied *because* of the skip, so a new message with no binding passed all seventeen assertions.
 *  A count is only coverage if the parser cannot lose a declaration. */
function interfaceBlocks(text) {
  const out = []
  // Tolerant on purpose, and each allowance is a measured escape: a generic parameter list, and an
  // `extends` wrapped onto its own line, each made a declaration invisible to the strict form — and
  // invisible means exempt from every assertion in this file *and* from `AnyWireMessage`, which is
  // the hole this file's direction check exists to close.
  for (const m of text.matchAll(/export interface (\w+)\s*(?:<[^>]*>)?\s*(?:extends\s+(\w+)[^{]*)?\{/g)) {
    let depth = 0
    let end = m.index + m[0].length - 1
    for (; end < text.length; end++) {
      if (text[end] === '{') depth++
      else if (text[end] === '}' && --depth === 0) break
    }
    out.push({ name: m[1], extends: m[2] ?? null, body: text.slice(m.index + m[0].length, end) })
  }
  return out
}

/** Every `export interface` that declares a `type: '<literal>'` — i.e. every wire message.
 *
 *  Bodies are found by counting braces, not by matching a run of two-space lines. The regex version
 *  skipped any interface with a blank line in its body — and `expect(messages.size).toBe(65)` was then
 *  satisfied *because* of the skip, so a new message with no binding passed all seventeen assertions.
 *  A count is only coverage if the parser cannot lose a declaration.
 *
 *  Which is why the count is no longer the only thing holding that. Review measured four further ways
 *  to be dropped — a trailing `//` after the literal, `type:'x'` with no space, a generic parameter
 *  list, a wrapped `extends` — and every one of them kept the size at exactly 65, so the pin was
 *  satisfied by the loss in each case. `everyDeclaredLiteralWasCaptured` below audits the capture with
 *  a looser pattern than the capture itself uses; a pin cannot audit the parser that feeds it. */
function messageInterfaces(text) {
  const out = new Map()
  for (const b of interfaceBlocks(text)) {
    const lit = b.body.match(/^\s*type\s*:\s*'([^']+)'\s*;?\s*(?:\/\/.*)?$/m)
    if (lit) out.set(b.name, { literal: lit[1], extends: b.extends, body: b.body })
  }
  return out
}

/** The interface name a `type` literal implies: PascalCase over its `:`/`-` segments.
 *
 *  This is the only assertion here that a regeneration cannot satisfy. The bindings in
 *  `typeAssertions.ts` compare two copies of one fact — the interface's literal and the binding's — so
 *  they catch an author who edits one. They do not catch an author who edits both, and since the names
 *  were *derived* mechanically, "regenerate the table" is the natural response to a rename in progress:
 *  it re-derives from the declarations it is meant to check. Measured — swapping two literals in
 *  `index.ts` *and* their two binding lines left all 228 script assertions green.
 *
 *  A derivation rule is independent of both copies. */
function derivedName(literal) {
  return literal.split(/[:-]/).map((p) => p[0].toUpperCase() + p.slice(1)).join('')
}

// Names that deliberately do not follow the derivation, each because the literal alone cannot name the
// interface. Two literals travel in both directions with different shapes, so each needs two names; and
// `Error` would shadow the global.
const NAME_EXCEPTIONS = new Map([
  ['GenericError', 'error'],
  // `agent:resources` derives `AgentResources`, which protocol already exports — as the *payload* shape
  // this message carries. Renaming that one is a breaking change to a published type that `agent-core`,
  // `relay` and `dashboard` all re-export, so the message takes a different name instead.
  ['AgentResourceReport', 'agent:resources'],
  ['AppInstallToAgent', 'app:install'],
  ['AppInstallToRelay', 'app:install'],
  ['AppLaunchToAgent', 'app:launch'],
  ['AppLaunchToRelay', 'app:launch'],
])

const messages = messageInterfaces(src)

describe('protocol message interfaces', () => {
  it('found every message interface — the parser is not quietly empty', () => {
    // Without this the two assertions below pass on an empty map. The count is pinned rather than
    // derived so that a parser that stops matching says so, instead of reporting full coverage of
    // nothing. L2 shipped that exact failure in the other direction. 58 is 57 from L1's conversion plus
    // `InputKey`, which was already named and is a message like any other. L4a added the seven agent→relay
    // messages, the last direction that had none. 66 is `DeviceShutdownError`, #542 — the shutdown pair had
    // no failure member, so an undeliverable shutdown had nothing to be answered with. 70 is
    // `NetworkRequestState`, #614 — the relay had no way to ask an agent to re-report a device's
    // network condition, so a re-joining viewer had no way to learn it. 72 is the posture pair —
    // `InputPosture` and `DevicePostures`, the foldable work: a device whose screens rearrange needs a
    // way to be asked and a way to say what it offers. 78 is the six `watch:*` messages — a teammate
    // watching, read-only, the device an AI client is driving.
    expect(messages.size).toBe(78)
    // `InputKey` predates L1 and has always been named; it must be in here too.
    expect(messages.has('InputKey')).toBe(true)
  })

  // The pin above cannot audit the parser that feeds it: every measured way to lose a declaration kept
  // the size at 65, so the floor was satisfied by the loss. This asks the question the other way round
  // — with a pattern loose enough to find a literal the capture would miss — so a declaration the
  // capture drops is named rather than counted as absent.
  it('captured every interface that declares a literal', () => {
    const dropped = interfaceBlocks(src)
      .filter((b) => /^\s*type\s*:\s*'/m.test(b.body))
      .map((b) => b.name)
      .filter((n) => !messages.has(n))
    expect(dropped, `declares a type literal but the parser dropped it: ${dropped.join(', ')}`).toEqual([])
  })

  // **The half `AnyWireMessage` cannot state about itself.** `relay/src/types.ts` asserts its literal
  // list against `AnyWireMessage`, which is the seven directions unioned — so a message added to a
  // direction reaches the relay's check for free. A message added to **no** direction reaches nothing:
  // it is absent from `AnyWireMessage`, so the relay is never obliged to know it, and every type-level
  // assertion stays green while a declared message travels on no declared path.
  //
  // Types cannot enumerate their own declarations, which is why this is here and not there — the same
  // reason the two facts at the top of this file are checked as source text.
  it('every message interface belongs to a direction', () => {
    const unions = unionMembers(srcNoComments)

    // Anti-vacuity first, and in the specific way this check can go quiet: if a direction is renamed
    // and this list is not, its members vanish from `reachable` and every message in it is reported as
    // an orphan — loud. If the *parser* stops matching, `reachable` is empty and the orphan list is
    // everything — also loud. The dangerous direction is a root silently resolving to nothing, so each
    // one is required to have parsed.
    for (const d of DIRECTIONS) {
      expect(unions.get(d), `direction ${d} did not parse — renamed, or the parser stopped matching`).toBeDefined()
    }

    const seen = new Set()
    const stack = [...DIRECTIONS]
    while (stack.length) {
      const name = stack.pop()
      if (seen.has(name)) continue
      seen.add(name)
      for (const member of unions.get(name) ?? []) stack.push(member)
    }

    const orphans = [...messages.keys()].filter((n) => !seen.has(n))
    expect(orphans, `declared but in no direction: ${orphans.join(', ')}`).toEqual([])
  })

  // `DIRECTIONS` above and `AnyWireMessage` in the protocol are two copies of one list, and only one
  // divergence is loud. A direction added to `AnyWireMessage` alone orphans its members — safe. A
  // direction added to `DIRECTIONS` alone is **green everywhere**: the orphan check is satisfied while
  // every literal in that direction stays exempt from the relay's `_MessageTypeCoversProtocol`, and if
  // it is agent-produced, from `_AgentSetCoversProtocol` too — so the door would let a browser send it.
  it('the direction list matches AnyWireMessage', () => {
    const declared = unionMembers(srcNoComments).get('AnyWireMessage')
    expect(declared, 'AnyWireMessage did not parse').toBeDefined()
    expect([...declared].sort()).toEqual([...DIRECTIONS].sort())
  })

  it('every message interface has a name↔literal binding', () => {
    const missing = []
    const wrong = []
    for (const [name, { literal }] of messages) {
      const line = assertions.match(new RegExp(`^export const _${name}: ${name}\\['type'\\] = '([^']+)'$`, 'm'))
      if (!line) missing.push(name)
      // The compiler already rejects a binding whose value disagrees with the interface. This catches
      // the other direction — a binding whose literal drifted along *with* the interface, which
      // compiles and asserts nothing about what the wire carries.
      else if (line[1] !== literal) wrong.push(`_${name} says '${line[1]}', interface says '${literal}'`)
    }
    expect(missing).toEqual([])
    expect(wrong).toEqual([])
  })

  it('every message name is derivable from its literal', () => {
    const offenders = []
    for (const [name, { literal }] of messages) {
      const expected = NAME_EXCEPTIONS.get(name)
      if (expected !== undefined) {
        // An exception still has to name the right message.
        if (literal !== expected) offenders.push(`${name} is listed for '${expected}' but declares '${literal}'`)
        continue
      }
      if (name !== derivedName(literal)) offenders.push(`${name} declares '${literal}', which derives ${derivedName(literal)}`)
    }
    expect(offenders).toEqual([])
    // Pinned so an exception cannot be added quietly to make a rename compile.
    expect(NAME_EXCEPTIONS.size).toBe(6)
  })

  // Failures addressed to a *request*, not to a session: the relay resolves both by `requestId` alone
  // (`RelayServer.ts:1293-1312`). Listing them draws the boundary of the family rather than widening it —
  // the base is for a failure a session is waiting on.
  const REQUEST_SCOPED = new Set(['screenshot:error', 'ui:tree:error'])

  it('a session-scoped failure declares extends SessionScoped', () => {
    const offenders = []
    for (const [name, { literal, extends: base, body }] of messages) {
      const isFailure = /error$/.test(literal) && !REQUEST_SCOPED.has(literal)
      const hasSession = /^ {2}sessionId[?]?:/m.test(body) || base === 'SessionScoped'
      // `error` used to be excluded here, on the grounds that it was the escape hatch for a failure that
      // could not be attributed to a session — "the member's nature, not an exception". L5d replaced that
      // nature: a request naming no session is dropped at the relay's door, so every producer of `error`
      // answers one specific join, and it joins the family like every other session-scoped failure. The
      // predicate needed no change; what changed is that `error` now satisfies it.
      if (!isFailure || !hasSession) continue
      if (base !== 'SessionScoped') offenders.push(`${name} ('${literal}')`)
    }
    expect(offenders).toEqual([])
    // 12 with `watch:refused`. The other three `watch:*` replies are not failures and carry `sessionId` directly.
    expect([...messages].filter(([, m]) => m.extends === 'SessionScoped')).toHaveLength(12)
    // `error` is the ninth, as of L5d. Pinned by name rather than only by the count, because the count alone
    // would be satisfied by any new member and this is the one whose membership was argued.
    expect(messages.get('GenericError')).toMatchObject({ literal: 'error', extends: 'SessionScoped' })
    // `device:shutdown-error` is the tenth (#542), and it reached the family through the predicate above
    // rather than by being added to a list — it ends in `error`, it is not request-scoped, and it names a
    // session. Pinned by name for the same reason as `error`: a count alone cannot say *which* member.
    expect(messages.get('DeviceShutdownError'))
      .toMatchObject({ literal: 'device:shutdown-error', extends: 'SessionScoped' })
    // #491 moved `message` off the base onto each member that requires it, so the family relation is no
    // longer implied by the shared pair — the `extends` is the only thing left saying these ten are one
    // kind. That makes this assertion load-bearing in a way it was not when the base carried two fields.
    for (const [name, { body, extends: base }] of messages) {
      if (base !== 'SessionScoped' || name === 'InputError') continue
      expect(/^ {2}message: string$/m.test(body), `${name} lost its message declaration`).toBe(true)
    }
    expect(REQUEST_SCOPED.size).toBe(2)
    for (const literal of REQUEST_SCOPED) {
      const entry = [...messages].find(([, m]) => m.literal === literal)
      expect(entry, `${literal} is gone`).toBeDefined()
      expect(entry[1].extends, `${literal} now extends something`).toBeNull()
      // What makes them request-scoped is `requestId`, not a weak `sessionId`. An earlier draft asserted
      // the field was *optional* and took that as the evidence — but every producer has one, so declaring
      // it optional described a message nobody sends. Required, and out of the family.
      expect(entry[1].body).toMatch(/^ {2}sessionId: string$/m)
      expect(entry[1].body).toMatch(/^ {2}requestId: string$/m)
    }
    // What the base carries, pinned. `browserInboundRouting`'s signatures resolve `extends` and sort,
    // so they cannot tell an inherited field from an own-declared one: moving `sessionId` out of the
    // base and into all nine subclasses leaves every signature identical and every check green.
    // Measured. This line is what makes the inheritance mean something.
    //
    // It carried `message` too until #491, which demoted prose to optional on `input:error` alone —
    // TypeScript cannot narrow an inherited required member, so the field moved onto each of the nine.
    // That left the base with the one thing all nine actually share, and the name followed the shape.
    const base = readFileSync(join(root, 'packages/protocol/src/index.ts'), 'utf8')
      .match(/export interface SessionScoped \{([^}]*)\}/)
    expect(base, 'SessionScoped is gone').not.toBeNull()
    expect([...base[1].matchAll(/^ {2}(\w+)(\??):/gm)].map((m) => m[1] + m[2]).sort()).toEqual(['sessionId'])
  })

  it('the L1 conversion net is gone', () => {
    // `Equals` and the `…Old` snapshots were the conversion-window net and were deleted with it. If
    // they come back, they are being mistaken for lasting protection — they compare unions that no
    // longer have an "old" to compare against, so a fresh snapshot would be taken from the same
    // declarations it is meant to check.
    expect(assertions).not.toMatch(/type \w+Old =/)
    expect(assertions).not.toMatch(/Equals</)
  })
})
