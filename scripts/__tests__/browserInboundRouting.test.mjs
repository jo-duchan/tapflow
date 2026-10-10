import { describe, it, expect } from 'vitest'
import { sources } from './sourceFiles.mjs'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The relay forwards an agent's reply to the browser with `JSON.stringify(msg)` — it never
// constructs one. So `sendTo(socket, msg: RelayOutbound)` does not see these messages and the
// compiler cannot check them: `AgentToBrowser` could name a message the relay drops, or the relay
// could forward one no consumer's type has ever heard of, and both compile.
//
// That is not a hypothetical gap. All twelve forward-only messages were missing from
// `@tapflowio/protocol` until L3, and the dashboard's hand-copy of the browser-inbound surface had
// diverged in four places with nothing reporting it.
//
// `RelayToBrowser` needs no such check. The relay builds those literals itself and passes them
// through `sendTo`, so the compiler already holds them to the union.

const root = join(import.meta.dirname, '../..')
const relaySrc = readFileSync(join(root, 'packages/relay/src/RelayServer.ts'), 'utf8')
const protocolSrc = readFileSync(join(root, 'packages/protocol/src/index.ts'), 'utf8')

/** Case labels whose block forwards to a browser socket. Labels fall through — two of these blocks
 *  carry thirteen and three labels — so they are accumulated until a block actually opens, and the
 *  block is then read by counting braces rather than by a lazy regex. A regex that stopped at the
 *  first `}` would end at the inner `if`, miss the `send`, and silently report the block as not
 *  forwarding: the direction that makes this check pass while covering nothing. */
function forwardedToBrowser(src) {
  const lines = src.split('\n')
  const found = new Set()
  let pending = []
  let blockLabels = null
  let depth = 0
  let body = ''

  for (const line of lines) {
    if (blockLabels) {
      body += line + '\n'
      depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length
      if (depth <= 0) {
        if (FORWARD_TO_BROWSER.test(body)) {
          for (const l of blockLabels) found.add(l)
        }
        blockLabels = null
        body = ''
      }
      continue
    }
    const label = line.match(/^\s*case '([^']+)':/)
    if (label) {
      pending.push(label[1])
      // `case 'x': {` opens on the same line; a bare `case 'x':` falls through to the next label.
      if (/\{\s*$/.test(line)) {
        blockLabels = pending
        pending = []
        depth = 1
        body = ''
      }
      continue
    }
    if (line.trim() && !line.trim().startsWith('//')) pending = []
  }
  return found
}

/**
 * A browser-bound forward, and it must serialise **`raw`** — the frame as it arrived.
 *
 * It was `JSON.stringify(msg)` until #444 made the inbound frame a parse product. `z.object` strips
 * keys it does not declare, so forwarding the product here would silently delete a field a newer agent
 * added, in the one direction where the sender is the more recently updated side. The browser→agent
 * forwards are the mirror and deliberately send `msg`: there the stripping is the point, because the
 * sender may be an attacker with devtools open.
 *
 * Anchored on `raw` rather than accepting either, so a forward that goes back to the product fails
 * here instead of shipping a compatibility break nothing else would report.
 */
const FORWARD_TO_BROWSER = /browserSocket\.send\(JSON\.stringify\(raw\)\)/

/** `export interface Name { … }` bodies, by name. L1 moved every message out of its union and into one
 *  of these, so a parser that reads only union bodies now finds nothing — it did, and this file's
 *  `stream:registered` assertion is what said so. */
function interfaceBodies(src) {
  const out = new Map()
  for (const m of src.matchAll(/export interface (\w+)(?: extends (\w+))? \{\n((?:  [^\n]*\n)+)\}/g)) {
    out.set(m[1], { body: m[3].replace(/^\s*\/\/.*$/gm, ''), extends: m[2] ?? null })
  }
  return out
}

const IFACES = interfaceBodies(protocolSrc)

/** The `type` literal an interface declares. A base like `SessionScoped` carries none. */
function literalOf(name) {
  const m = IFACES.get(name)?.body.match(/^ {2}type: '([^']+)';?$/m)
  return m ? m[1] : null
}

/** Fields of an interface with `extends` resolved, each suffixed `?` when optional, **sorted**.
 *  Declaration order carries no meaning, and `extends SessionScoped` puts the inherited field first —
 *  which reordered three signatures that had not otherwise changed. Sorting keeps the check aimed at
 *  what a consumer can observe: which fields exist and which are optional. */
function fieldsOf(name) {
  const decl = IFACES.get(name)
  if (!decl) return null
  const own = []
  let nest = 0
  for (const line of decl.body.split('\n')) {
    const before = nest
    nest += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length
    if (before !== 0) continue
    // Top-level fields only — a nested `payload: { deviceId: string }` must not contribute `deviceId`.
    const m = line.match(/^ {2}(\w+)(\??):/)
    if (m && m[1] !== 'type') own.push(m[1] + m[2])
  }
  const inherited = decl.extends ? (fieldsOf(decl.extends) ?? '').split(' ').filter(Boolean) : []
  return [...inherited, ...own].sort().join(' ')
}

function unionBody(src, name) {
  const start = src.indexOf(`export type ${name} =`)
  expect(start, `${name} not found in protocol`).toBeGreaterThan(-1)
  const rest = src.slice(start)
  // Through the declaration boundary, not the first blank line: TypeScript
  // permits blank lines inside a union, and stopping at one would let a
  // member added after it escape the completeness check while green.
  const end = rest.search(/\n(?=export (?:type|interface)\b)/)
  return rest.slice(0, end === -1 ? undefined : end).replace(/^\s*\/\/.*$/gm, '')
}

/** Interface names a union denotes, following one level of referenced unions (`| OtherUnion`). */
function unionRefs(src, name) {
  const out = []
  for (const m of unionBody(src, name).matchAll(/^\s*\|\s*(\w+)\s*$/gm)) {
    if (IFACES.has(m[1])) out.push(m[1])
    else out.push(...unionRefs(src, m[1]))
  }
  return out
}

/** Message `type` literals a union denotes. */
function unionMembers(src, name) {
  const types = new Set()
  for (const ref of unionRefs(src, name)) {
    const lit = literalOf(ref)
    expect(lit, `${ref} declares no type literal`).not.toBeNull()
    types.add(lit)
  }
  return types
}

/** Interface names a union lists directly, without following nested union refs
 *  (so `RelayOrAgentToBrowser` inside `AgentToBrowser` stays one entry). */
function unionOwnRefs(src, name) {
  const out = []
  for (const m of unionBody(src, name).matchAll(/^\s*\|\s*(\w+)\s*$/gm)) {
    if (IFACES.has(m[1])) out.push(m[1])
  }
  return out
}

/** Union refs a union lists directly that are not interfaces (embedded unions).
 *  Pinned to exactly `['RelayOrAgentToBrowser']` for the two `OWN_ONLY` unions
 *  below, so a future embedded union cannot escape coverage while the suite
 *  stays green. */
function unionSkippedRefs(src, name) {
  const out = []
  for (const m of unionBody(src, name).matchAll(/^\s*\|\s*(\w+)\s*$/gm)) {
    if (!IFACES.has(m[1])) out.push(m[1])
  }
  return out
}

/** Message `type` literals from directly-listed interfaces only (shared unions excluded). */
function unionOwnMembers(src, name) {
  const types = new Set()
  for (const ref of unionOwnRefs(src, name)) {
    const lit = literalOf(ref)
    expect(lit, `${ref} declares no type literal`).not.toBeNull()
    types.add(lit)
  }
  return types
}

/** The pinned signature lookup: find the interface in this union that owns `type`, return its fields. */
function memberSignature(src, name, type) {
  for (const ref of unionRefs(src, name)) {
    if (literalOf(ref) === type) return fieldsOf(ref)
  }
  return null
}

describe('browser-inbound routing matches the protocol union', () => {
  const forwarded = forwardedToBrowser(relaySrc)
  const declared = unionMembers(protocolSrc, 'AgentToBrowser')

  it('every message the relay forwards to a browser is declared in AgentToBrowser', () => {
    expect([...forwarded].filter((t) => !declared.has(t)).sort()).toEqual([])
  })

  it('every AgentToBrowser member is actually forwarded', () => {
    expect([...declared].filter((t) => !forwarded.has(t)).sort()).toEqual([])
  })

  // A parser that quietly finds nothing passes both assertions above. These pin what it found, so a
  // refactor that moves the forward blocks out of reach fails here instead of going green on an
  // empty set. L2 shipped exactly that mistake in the other direction — a lazy regex truncated a
  // nested literal to 6 of 11 fields and the by-name assertion passed anyway.
  it('the parser reached every forward site', () => {
    expect(forwarded.size).toBe(26)
    const sends = (relaySrc.match(/browserSocket\.send\(JSON\.stringify\(raw\)\)/g) ?? []).length
    expect(sends).toBe(10) // 8 single-label blocks + the 13-label block + the owner-gated block
  })

  // Same anti-vacuity for the union parser: it must read through the
  // declaration boundary, not stop at the first blank line. A member added
  // after an internal blank line and omitted from SIGNATURES would otherwise
  // escape both the coverage and the field checks while green.
  it('union bodies span internal blank lines', () => {
    const src = [
      'export type FakeUnion =',
      '  | Alpha',
      '',
      '  | Beta',
      '',
      'export interface Alpha {',
      "  type: 'alpha';",
      '}',
      '',
    ].join('\n')
    expect(unionBody(src, 'FakeUnion')).toContain('| Beta')
  })

  // The other half of the rule above, and the one a count cannot see: a forward that switched back to
  // the parse product would keep the count at 8 while stripping every field the schemas do not declare
  // — which for the Envelope tier is *every* payload. The symptom would be a viewer that renders
  // nothing, from a change that looks like a rename.
  it('no browser-bound forward serialises the parse product', () => {
    expect(relaySrc).not.toMatch(/browserSocket\.send\(JSON\.stringify\(msg\)\)/)
  })

  // #557, restated for the door that exists now. The issue asks that `AGENT_MSG_TYPE_LIST` be tied to
  // `route()`'s forwarding cases rather than to a proxy type — and that list is gone: #444 replaced it
  // with `directionOf`, derived from the inbound schema maps. Its worked example is already caught, too,
  // by the first assertion in this file: `session:terminated` lives in `RelayToBrowser` and not in
  // `AgentToBrowser`, so a forwarding case for it fails there.
  //
  // What survives is the property underneath, which nothing states. A forward resolves the session from
  // the message and sends to *that session's* browser without checking that the sender is that session's
  // agent — `clipboard:*` and `network:*` are the deliberate exceptions, bound to `session.agentSocket`
  // with the reason
  // beside it. The door is what makes that safe, and it is safe only while the two sets are disjoint: a
  // literal that is **both** browser-sendable and browser-forwardable passes the role gate and is then
  // injected into another tester's viewer, which acts on it.
  //
  // Derived from `BrowserToRelay` rather than from the schema map, and they are the same set by
  // construction: `_BrowserCovers` and `_BrowserInventsNothing` in `protocol/src/validate/index.ts` make
  // a divergence a compile error. So this reads the union the door is held to, not a second copy of it.
  it('no literal is both browser-sendable and browser-forwardable', () => {
    const sendable = unionMembers(protocolSrc, 'BrowserToRelay')
    // Anti-vacuity on both operands. `forwarded` is pinned above; this one has no other pin, and an
    // empty set would make the intersection empty for the wrong reason.
    expect(sendable.size).toBeGreaterThanOrEqual(20)
    expect([...forwarded].filter((t) => sendable.has(t)).sort()).toEqual([])
  })

  it('RelayOrAgentToBrowser is shared by both directions rather than copied', () => {
    const shared = unionMembers(protocolSrc, 'RelayOrAgentToBrowser')
    expect(shared.size).toBe(14)
    for (const name of ['RelayToBrowser', 'AgentToBrowser']) {
      expect(protocolSrc).toContain(`export type ${name} =\n  | RelayOrAgentToBrowser`)
    }
  })

  // The field sets, pinned. Without these the check is name-only, and every drift it was written in
  // response to comes back green: turning all twelve `sessionId` optional, re-optionalising
  // `capabilities`, dropping `payload` off `device:shutdown-done` — same names, same counts. `tsc`
  // does not object either, because the dashboard's consumers compare `msg.sessionId === sessionId`
  // and that still compiles against `string | undefined`.
  //
  // `sessionId` is required on all twelve forwarded messages and on the seven shared errors, and on two
  // of the three the relay also replays. `device:ready` is the one exception, and it is deliberate —
  // see the note above the declarations for the measurement.
  //
  // All five message unions are here, not just the browser-inbound three. The bindings in
  // `typeAssertions.ts` pin 58 literals and read like per-message coverage, but a literal is all they
  // pin — measured, `ScreenshotRequest.requestId`, `DeviceBoot.sessionId` and `DeviceBoot.payload.deviceId`
  // could all be made optional with every assertion green, and `sessionId?` is the widening
  // `packages/protocol/AGENTS.md` calls near-irreversible.
  //
  // `payload` is one token here, so a change *inside* a nested literal is still invisible. The named
  // payload types have their field counts pinned in `protocolPayloadTypes`; inline ones like
  // `device:boot`'s do not, and closing that is a separate job.
  const SIGNATURES = {
    AgentToBrowser: {
      'device:booting': 'sessionId',
      'device:shutdown-done': 'payload requestId? sessionId',
      'app:install-done': 'requestId sessionId',
      'app:launch-done': 'requestId sessionId',
      'app:clear-state-done': 'requestId sessionId',
      'open-url:done': 'requestId sessionId',
      'input:done': 'requestId sessionId',
      'input:type-done': 'requestId sessionId',
      'keyboard:toggled': 'payload sessionId',
      'clipboard:data': 'payload requestId sessionId',
      'clipboard:write-done': 'requestId sessionId',
      'network:state': 'payload requestId? sessionId',
    },
    RelayOrAgentToBrowser: {
      'session:chrome': 'payload sessionId',
      'session:deviceInfo': 'payload sessionId',
      'device:postures': 'payload sessionId',
      'device:ready': 'payload requestId? sessionId?',
      'app:install-error': 'message requestId sessionId',
      'app:launch-error': 'message requestId sessionId',
      'device:boot-error': 'message requestId? sessionId',
      'open-url:error': 'message requestId sessionId',
      'app:clear-state-error': 'message requestId sessionId',
      // #491 inverted this pair: `reason` is the closed union a consumer branches on and is now
      // required, `message` is producer prose and is now optional. The sibling below keeps `reason?`
      // because its agent-side producers answer with a rejected `adb` or pasteboard write and have no
      // reason to give — only the relay sets one there.
      'input:error': 'message? reason requestId sessionId',
      // Moved here from AgentToBrowser in L5c: the relay refuses an `input:type` whose session the sender
      // does not hold, and the waiters key on this pair rather than on `input:error`.
      'input:type-error': 'message reason? requestId sessionId',
      'clipboard:error': 'message payload? requestId sessionId',
      // Moved here from RelayToBrowser (#455): both agents answer a shutdown they could not confirm.
      'device:shutdown-error': 'message requestId? sessionId',
      'network:error': 'message requestId sessionId',
    },
    BrowserToRelay: {
      'agents:list': '',
      // `clientKind` optional: an older client joins as before and is simply not watchable.
      'session:start': 'clientKind? sessionId',
      'session:end': 'sessionId',
      'session:leave': 'sessionId',
      'device:boot': 'payload requestId sessionId',
      'device:shutdown': 'payload requestId? sessionId',
      'app:install': 'buildId requestId sessionId',
      'app:launch': 'buildId requestId sessionId',
      'app:clear-state': 'payload requestId sessionId',
      'open-url': 'payload requestId sessionId',
      'input:touch:start': 'payload sessionId',
      'input:touch:move': 'payload sessionId',
      'input:touch:end': 'payload? requestId sessionId',
      'input:pinch:start': 'payload sessionId',
      'input:pinch:move': 'payload sessionId',
      'input:pinch:end': 'requestId sessionId',
      'input:key': 'payload requestId sessionId',
      'input:type': 'payload requestId sessionId',
      'input:button': 'payload requestId sessionId',
      'input:rotate': 'payload? sessionId',
      'input:keyboard:toggle': 'sessionId',
      'input:posture': 'payload sessionId',
      'clipboard:read': 'payload? requestId sessionId',
      'clipboard:write': 'payload requestId sessionId',
      'network:set': 'payload requestId sessionId',
      'watch:start': 'sessionId',
      'watch:stop': 'sessionId',
    },
    RelayToAgent: {
      'agent:registered': 'registeredSessions',
      'stream:request-idr': 'sessionId',
      'network:request-state': 'sessionId',
      'device:shutdown': 'payload requestId? sessionId',
      'app:install': 'payload requestId sessionId',
      'app:launch': 'payload requestId sessionId',
      'screenshot:request': 'format requestId sessionId',
      'ui:tree:request': 'requestId sessionId',
    },
    RelayToBrowser: {
      'agents:listed': 'sessions',
      // `watchUrl` only for a holder that declared an AI client kind, and absent from an older relay.
      'session:joined': 'capabilities sessionId watchUrl?',
      'session:terminated': 'reason sessionId',
      'session:agent-away': 'sessionId',
      'session:rebound': 'capabilities sessionId',
      error: 'message reason sessionId',
      'watch:started': 'sessionId',
      'watch:refused': 'message reason sessionId',
      'watch:holder-left': 'sessionId',
      'watch:ended': 'reason sessionId',
    },
  }

  // `AgentToBrowser` and `RelayToBrowser` embed the shared `RelayOrAgentToBrowser`
  // union, whose members are pinned under that key — these two maps pin their own
  // members only. Every other map must cover its union in full.
  const OWN_ONLY = new Set(['AgentToBrowser', 'RelayToBrowser'])

  for (const [union, members] of Object.entries(SIGNATURES)) {
    it(`${union} member fields are unchanged`, () => {
      const actual = {}
      for (const type of Object.keys(members)) actual[type] = memberSignature(protocolSrc, union, type)
      expect(actual).toEqual(members)
    })

    // #569: the loop above iterates the map, not the union, so a message added to
    // the protocol and not to SIGNATURES is field-checked by nothing and the suite
    // stays green (`device:shutdown-error` shipped that way in #542). Pin the
    // coverage contract itself: the map keys must equal the union's members
    // (own members only for the two unions embedding the shared one).
    it(`${union} signatures cover every union member`, () => {
      if (OWN_ONLY.has(union)) {
        expect(unionSkippedRefs(protocolSrc, union).sort()).toEqual(['RelayOrAgentToBrowser'])
      }
      const expected = OWN_ONLY.has(union)
        ? unionOwnMembers(protocolSrc, union)
        : unionMembers(protocolSrc, union)
      expect(new Set(Object.keys(members))).toEqual(expected)
    })
  }

  // The whole point of the layer is that this surface has one declaration. A second one is easy to
  // reintroduce — the original was written because a viewer needed a type for its message handler and
  // protocol did not have one — and it costs nothing until it drifts, which is how the last one
  // survived four divergences.
  //
  // Scoped to the whole package and to both spellings, because the first version of this assertion
  // read one file and matched one form: a union written without a leading `|`, or moved to
  // `hooks/useRelay.ts`, walked straight past it. The regex that found the mutation was the only
  // regex the mutation could have failed.
  it('no consumer declares a wire-message union of its own', () => {
    // The vocabulary comes from protocol, so "is this a wire message union" is decided by the wire and
    // not by a shape heuristic. A first version flagged any alias with two `{ type: '…' }` members and
    // reported `flow-runner`'s `Step` — a union of flow steps, which is a domain type and belongs
    // where it is.
    const wire = new Set([...protocolSrc.matchAll(/\{\s*type: '([^']+)'/g)].map((m) => m[1]))
    const found = []
    for (const pkg of ['packages/dashboard', 'packages/mcp-server/src', 'packages/flow-runner/src']) {
      const files = sources(pkg)
      for (const f of files) {
        const src = readFileSync(join(root, f), 'utf8').replace(/^\s*\/\/.*$/gm, '')
        for (const m of src.matchAll(/export type (\w+)\s*=\s*((?:\s*\|?\s*\{[^{}]*\}\s*)+)/g)) {
          const types = [...m[2].matchAll(/type: '([^']+)'/g)].map((t) => t[1]).filter((t) => wire.has(t))
          if (types.length >= 2) found.push(`${f}: ${m[1]} (${types.join(', ')})`)
        }
      }
    }
    expect(found).toEqual([])
    expect(readFileSync(join(root, 'packages/dashboard/lib/types.ts'), 'utf8')).toMatch(/BrowserInbound/)
  })

  // Removing the payload casts made the clipboard bridge's *shapes* compiler-checked, but the list of
  // types `DeviceViewer` routes into it is still plain control flow that nothing reads. Dropping
  // `clipboard:write-done` from that condition leaves every dashboard test green — the bridge's own
  // tests call `handlerRef.current` directly and skip the viewer — and the user sees a paste that
  // lands on the device followed by "the device is taking too long".
  //
  // Both sides are derived, so the guard cannot drift with either one.
  it('DeviceViewer routes exactly the messages the clipboard bridge declares', () => {
    const bridge = readFileSync(join(root, 'packages/dashboard/hooks/useClipboardBridge.ts'), 'utf8')
    const viewer = readFileSync(join(root, 'packages/dashboard/components/DeviceViewer.tsx'), 'utf8')

    // L1 replaced the `Extract<>` with named members, so the expected set comes from resolving those
    // names to their literals — still derived from the bridge's own declaration, not restated here.
    // Up to the next blank line, not the next newline. A one-line capture truncates the moment the
    // declaration wraps, and it truncates *silently*: `wanted` loses the trailing members, and if the
    // author also forgot to route them then `routed` is short by the same ones and the sets match. The
    // count pin below does not help — the truncation lands on exactly the old count.
    const declared = bridge.match(/export type ClipboardBridgeMessage =([\s\S]*?)\n\s*\n/)
    expect(declared, 'ClipboardBridgeMessage is no longer a union of named wire messages').not.toBeNull()
    const wanted = declared[1].split('|').map((n) => n.trim()).filter(Boolean).map((n) => {
      const lit = literalOf(n)
      expect(lit, `${n} is not a protocol message interface`).not.toBeNull()
      return lit
    }).sort()

    const at = viewer.indexOf('clipboardHandlerRef.current?.(msg)')
    expect(at, 'DeviceViewer no longer routes into the clipboard bridge').toBeGreaterThan(-1)
    const condition = viewer.slice(viewer.lastIndexOf('if (', at), at)
    const routed = [...condition.matchAll(/msg\.type === '([^']+)'/g)].map((m) => m[1]).sort()

    expect(routed).toEqual(wanted)
    expect(wanted.length).toBe(3)
  })

  it('stream:registered is not on the browser-inbound surface', () => {
    // It goes to an agent's stream socket; the consumer is agent-core's stream registration. It sat
    // in `RelayToBrowser` because that union was "everything that is not an agent".
    const inbound = new Set([...unionMembers(protocolSrc, 'BrowserInbound')])
    expect(inbound.has('stream:registered')).toBe(false)
    expect(unionMembers(protocolSrc, 'RelayToStream').has('stream:registered')).toBe(true)
  })
})
