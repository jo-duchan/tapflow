/**
 * `parseInbound` / `directionOf` — the runtime half of the door.
 *
 * The type-level half lives beside the schemas in `validate/index.ts` and is mutation-tested: eight
 * mutations were run against it and eight were caught (a payload added to an Envelope schema as
 * `z.unknown()`, `z.any()` and `z.custom<T>()`; an envelope emptied to `z.object({})`; a Validated
 * schema swapped for `z.custom`; a member dropped from the map; an envelope losing its correlator; an
 * optional field made required).
 *
 * **Two survived, and they are what this file exists for.** `.min(1)` and `.default([])` are runtime
 * behaviour that does not change what `z.output` infers — by design, since that is exactly why they
 * cost the tier assertions nothing — so no type-level assertion can hold them. Removing either leaves
 * the whole static suite green. `rejects an empty sessionId` and `accepts an agent that predates
 * capabilities` are the tests that fail instead; the rest of the file covers the door's own branches.
 */
import { describe, expect, it } from 'vitest'

import { directionOf, parseInbound, readRunResetReport, readServiceTier, readyFacts } from '../validate/index.js'

/** The narrowing every test does. Written once because `parseInbound` returns a union and each test
 *  would otherwise repeat the same four lines to reach `msg`. */
function ok(raw: unknown) {
  const r = parseInbound(raw)
  if (!r.ok) throw new Error(`expected a parse, got ${r.reason}`)
  return r
}

function fail(raw: unknown) {
  const r = parseInbound(raw)
  if (r.ok) throw new Error('expected a rejection, got a parse')
  return r
}

describe('the door rejects what it cannot name', () => {
  // `JSON.parse` returns bare `null`, numbers and strings without throwing, and the caller reads
  // `.type` off whatever it is handed.
  it.each([null, 42, 'a string', true, []])('refuses %p as not-an-object', (raw) => {
    expect(fail(raw).reason).toBe('not-an-object')
  })

  it('refuses a frame with no type', () => {
    expect(fail({ sessionId: 's' }).reason).toBe('unknown-type')
  })

  it('refuses a type nothing declares', () => {
    const r = fail({ type: 'input:teleport', sessionId: 's' })
    expect(r.reason).toBe('unknown-type')
    if (r.reason === 'unknown-type') expect(r.type).toBe('input:teleport')
  })

  // **The universe is the inbound map, not every literal the protocol declares.** Eleven types are
  // relay-produced and belong to no inbound direction. A browser that sends one is inert today — it
  // reaches the switch and matches no case. Classifying it as a *direction* violation instead would
  // route it to the 1008 close, disconnecting a dashboard over a frame that does nothing.
  it.each(['session:joined', 'error', 'agents:listed', 'session:terminated', 'stream:registered'])(
    'reads the relay-produced %s as unknown rather than as a direction violation',
    (type) => {
      expect(fail({ type, sessionId: 's' }).reason).toBe('unknown-type')
    },
  )

  // `session:chrome` rather than a browser request: the twelve answerable ones report `bad-payload`
  // instead, which carries its own type and is covered below.
  it('reports the type it refused on a shape failure, so a log can name it', () => {
    const r = fail({ type: 'session:chrome' })
    expect(r.reason).toBe('bad-shape')
    if (r.reason === 'bad-shape') {
      expect(r.type).toBe('session:chrome')
      expect(r.detail).toMatch(/sessionId/i)
    }
  })
})

describe('an empty correlator is not a correlator', () => {
  // The predicates this replaced (`isAddressed` / `isCorrelated`) rejected `''` as well as absence,
  // and a bare `z.string()` accepts it. Losing that half is invisible to every type-level assertion:
  // `.min(1)` does not change what `z.output` infers. What it costs is concrete — a `device:boot`
  // with `requestId: ''` would pass the door, fail at `dispatchTarget`, and be answered with a
  // `device:boot-error` carrying `requestId: ''`, a frame whose required correlator is
  // present-but-empty and which every correlating consumer discards.
  it('rejects an empty sessionId', () => {
    expect(fail({ type: 'session:start', sessionId: '' }).reason).toBe('bad-shape')
  })

  it('rejects an empty requestId', () => {
    const raw = { type: 'device:boot', sessionId: 's', requestId: '', payload: { deviceId: 'd' } }
    expect(fail(raw).reason).toBe('bad-shape')
  })

  it('rejects a non-string sessionId', () => {
    expect(fail({ type: 'session:start', sessionId: 7 }).reason).toBe('bad-shape')
  })

  // The mirror. Without it, a schema that rejected *every* sessionId would pass the two above.
  it('accepts a real one', () => {
    expect(ok({ type: 'session:start', sessionId: 's' }).msg).toEqual({ type: 'session:start', sessionId: 's' })
  })
})

describe('an agent older than a field still registers', () => {
  // `AgentRegister` declares `capabilities` and `devices` required, and an agent that predates either
  // sends neither — which is how a viewer tells them apart. The relay carried `msg.capabilities ?? []`
  // for exactly this. The `.default([])` moves that tolerance into the schema, where it is visible,
  // and it is invisible to the type assertions because `z.output` is `string[]` either way.
  it('accepts an agent that predates capabilities', () => {
    const raw = { type: 'agent:register', platform: 'ios', agentName: 'mac-1', devices: [] }
    expect(ok(raw).msg).toMatchObject({ capabilities: [], devices: [] })
  })

  it('accepts an agent that reports no devices', () => {
    const raw = { type: 'agent:register', platform: 'ios', agentName: 'mac-1', capabilities: ['clipboard'] }
    expect(ok(raw).msg).toMatchObject({ capabilities: ['clipboard'], devices: [] })
  })

  // **The most expensive rejection in the protocol, so the most tolerant schema.** A first draft
  // required `platform` and `agentName` — both declared required, both sent by both agents here — and
  // the relay reads each through a `??`. An agent omitting either would have had its frame refused, so
  // no `agent:registered` goes back, so its handshake promise never resolves: the whole Mac and every
  // device on it absent from the dashboard, with one relay-side warn as the only trace.
  it('registers an agent that sends neither a platform nor a name', () => {
    const r = ok({ type: 'agent:register', devices: [] })
    expect(r.msg).toMatchObject({ platform: '', agentName: '', capabilities: [], devices: [] })
  })

  // `''` and not `undefined` is what lets `z.output` match the interface, and it has to stay falsy:
  // the relay's eviction runs only `if (identity)`, where identity is `agentId ?? agentName`. A
  // placeholder like `'unknown'` there would make every nameless agent evict every other one.
  it('leaves a defaulted name falsy, because identity keys on it', () => {
    const r = ok({ type: 'agent:register', devices: [] })
    expect((r.msg as { agentName: string }).agentName).toBeFalsy()
  })

  // The tolerance is for *absence*, not for a wrong shape — otherwise `.default()` would be
  // indistinguishable from not checking the field at all.
  it('still refuses capabilities that are not strings', () => {
    const raw = { type: 'agent:register', platform: 'ios', agentName: 'm', capabilities: [{}] }
    expect(fail(raw).reason).toBe('bad-shape')
  })

  // `formFactor` (PR B of #785's follow-up) is how a viewer tells an iPad from an iPhone. A value this
  // relay does not know yet — an agent newer than it, reporting a form factor added later — must cost
  // that one field, not the registration: the rejection here is the most expensive one in the
  // protocol (see above).
  describe('a device form factor', () => {
    const register = (formFactor: unknown) =>
      ({ type: 'agent:register', devices: [{ id: 'd', name: 'iPad', platform: 'ios', status: 'booted', formFactor }] })
    const device = (r: ReturnType<typeof ok>) => (r.msg as { devices: Array<{ formFactor?: string }> }).devices[0]

    it.each(['phone', 'tablet', 'foldable'])('keeps %s', (v) => {
      expect(device(ok(register(v))).formFactor).toBe(v)
    })

    // Mutation: a plain `z.enum`. The whole register is refused and the Mac drops out of the list.
    it('drops a form factor it does not know, and still registers', () => {
      expect(device(ok(register('watch'))).formFactor).toBeUndefined()
    })

    it('registers a device that reports none', () => {
      const r = ok({ type: 'agent:register', devices: [{ id: 'd', name: 'iPhone', platform: 'ios', status: 'booted' }] })
      expect(device(r).formFactor).toBeUndefined()
    })

    // Unknown is upward compatibility; not a string is a broken agent — the same line `capabilities`
    // draws above. Mutation: `.catch(undefined)` over the whole field, which swallows this too.
    it('still refuses a form factor that is not a string', () => {
      expect(fail(register(5)).reason).toBe('bad-shape')
    })
  })

  it('defaults a screenshot format the way the relay used to', () => {
    const raw = { type: 'screenshot:done', sessionId: 's', requestId: 'r', data: 'AAA' }
    expect(ok(raw).msg).toMatchObject({ format: 'png' })
  })
})

describe('the Envelope tier hands back no payload', () => {
  // The tier's whole claim, at runtime. The static half is TC15's mutation — adding `payload` to an
  // envelope schema — which the assertion catches at compile time; this is what a reader can see.
  it('drops a chrome payload from the parse product while keeping it on the raw frame', () => {
    const payload = { buttons: [], streamType: 'h264' }
    const r = ok({ type: 'session:chrome', sessionId: 's', payload })
    expect(r.msg).toEqual({ type: 'session:chrome', sessionId: 's' })
    expect(r.raw['payload']).toBe(payload)
  })

  // Why the tier exists: `ChromePayload` is a closed two-member union while `AgentRegister.platform`
  // is open by OCP, so a third-party platform has no valid variant to send. Validating this message
  // would cost that platform its bezel and buttons for the life of the session — the message arrives
  // once per boot, and a rejection skips the cache the re-join replay reads.
  it('accepts a chrome payload belonging to neither declared variant', () => {
    const payload = { kind: 'some-third-platform', frameSvg: '<svg/>' }
    const r = ok({ type: 'session:chrome', sessionId: 's', payload })
    expect(r.raw['payload']).toBe(payload)
  })

  it('accepts an unknown field on a forwarded reply, so a newer agent is not broken by an older relay', () => {
    const raw = { type: 'input:done', sessionId: 's', requestId: 'r', hapticsApplied: true }
    const r = ok(raw)
    expect(r.msg).toEqual({ type: 'input:done', sessionId: 's', requestId: 'r' })
    expect(r.raw['hapticsApplied']).toBe(true)
  })

  // The envelope is still an envelope: the fields it does declare are checked.
  it('refuses a forwarded reply whose correlator is missing', () => {
    expect(fail({ type: 'input:done', sessionId: 's' }).reason).toBe('bad-shape')
  })
})

describe('a browser frame is stripped, because its product is what gets forwarded', () => {
  // The browser direction is the attacker-controllable one, and `z.object` strips rather than
  // rejects — so what makes an appended key harmless is that the relay forwards `msg` here and not
  // `raw`. If that ever flips, this test still passes and the relay's own test is what fails, which
  // is why the relay carries one too.
  it('removes a key the schema does not declare', () => {
    const raw = {
      type: 'input:key', sessionId: 's', requestId: 'r',
      payload: { code: 'KeyA', modifiers: 0, injected: 'rm -rf /' },
      extra: 'appended',
    }
    const r = ok(raw)
    expect(r.msg).toEqual({ type: 'input:key', sessionId: 's', requestId: 'r', payload: { code: 'KeyA', modifiers: 0 } })
    expect(r.raw['extra']).toBe('appended')
  })

  it('keeps an optional payload absent rather than inventing one', () => {
    const r = ok({ type: 'input:touch:end', sessionId: 's', requestId: 'r' })
    expect(r.msg).toEqual({ type: 'input:touch:end', sessionId: 's', requestId: 'r' })
  })

  it('refuses a buildId that is not an integer, answerably', () => {
    for (const buildId of [{}, [], '3', 1.5, null, undefined]) {
      expect(fail({ type: 'app:install', sessionId: 's', requestId: 'r', buildId }).reason).toBe('bad-payload')
    }
  })

  it('keeps a real buildId', () => {
    expect(ok({ type: 'app:install', sessionId: 's', requestId: 'r', buildId: 3 }).msg).toMatchObject({ buildId: 3 })
  })

  // Stripped, the relay would reinstall on every reconnect and wipe the app's data, with nothing failing to say so.
  it('carries keepIfInstalled through', () => {
    const install = { type: 'app:install', sessionId: 's', requestId: 'r', buildId: 3, keepIfInstalled: true }
    expect(ok(install).msg).toEqual(install)
  })

  it('refuses a keepIfInstalled that is not a boolean, answerably', () => {
    for (const keepIfInstalled of ['yes', 1, {}]) {
      expect(fail({ type: 'app:install', sessionId: 's', requestId: 'r', buildId: 3, keepIfInstalled }).reason).toBe('bad-payload')
    }
  })

  // The relay forwards the parse product, so a field the schema does not name never reaches an agent. These two must be
  // named, or every launch option is stripped here and the launch still succeeds.
  it('carries launch arguments and env through', () => {
    const launch = { type: 'app:launch', sessionId: 's', requestId: 'r', buildId: 3, arguments: { a: 'x', n: 1, b: true, l: ['en'] }, env: { K: 'v' } }
    expect(ok(launch).msg).toEqual(launch)
  })

  it('refuses a launch option of the wrong shape, answerably', () => {
    for (const extra of [{ arguments: [] }, { arguments: { a: { b: 1 } } }, { arguments: { a: null } }, { env: { K: 1 } }, { env: 'K=v' }]) {
      expect(fail({ type: 'app:launch', sessionId: 's', requestId: 'r', buildId: 3, ...extra }).reason).toBe('bad-payload')
    }
  })
})

describe('directionOf replaces the hand-written agent list', () => {
  it('routes the handshake messages that decide a role', () => {
    expect(directionOf('agent:register')).toBe('agent')
    expect(directionOf('stream:register')).toBe('stream')
    expect(directionOf('session:start')).toBe('browser')
  })

  it.each(['screenshot:done', 'ui:tree:response', 'session:chrome', 'clipboard:data', 'input:error'] as const)(
    'calls %s an agent message, as the 1008 gate did',
    (type) => { expect(directionOf(type)).toBe('agent') },
  )

  it.each(['agents:list', 'device:boot', 'input:touch:move', 'clipboard:read', 'session:leave'] as const)(
    'calls %s a browser message',
    (type) => { expect(directionOf(type)).toBe('browser') },
  )

  // The first frame of an agent connection is the case that broke the first design of this module:
  // the role does not exist until this message is parsed, so a parser selecting a schema *by* role
  // could never validate it. Parsing first is what makes the answer available at all.
  it('answers for a type parsed before any role exists', () => {
    const r = ok({ type: 'agent:register', platform: 'ios', agentName: 'm', capabilities: [], devices: [] })
    expect(directionOf(r.msg.type)).toBe('agent')
  })
})

// #910. The relay forwards the parsed message, not the raw one, so a field this schema does not declare
// is stripped at the door and never reaches an agent — declaring it is what delivers it.
describe('input:rotate carries a target', () => {
  // Mutation: leave `payload` out of the schema. The parse succeeds and the target is gone.
  it('keeps the target', () => {
    const r = ok({ type: 'input:rotate', sessionId: 's', payload: { orientation: 'landscape' } })
    expect(r.msg).toMatchObject({ payload: { orientation: 'landscape' } })
  })

  it('still takes one with no target, from a dashboard that sends none', () => {
    ok({ type: 'input:rotate', sessionId: 's' })
  })

  it('refuses a target it does not name', () => {
    expect(fail({ type: 'input:rotate', sessionId: 's', payload: { orientation: 'landscapeLeft' } }).reason).toBe('bad-shape')
  })
})

describe('a touch says which picture it is in', () => {
  // Mutation: leave `space` out of either schema. The door strips the key, and the agent reads a frame point as
  // the screen — a quarter off on a turned body, with nothing failing.
  it.each(['input:touch:start', 'input:touch:move'] as const)('keeps the space on %s', (type) => {
    const r = ok({ type, sessionId: 's', payload: { x: 0.1, y: 0.2, space: 'frame' } })
    expect(r.msg).toMatchObject({ payload: { x: 0.1, y: 0.2, space: 'frame' } })
  })

  it.each(['input:pinch:start', 'input:pinch:move'] as const)('keeps the space on %s', (type) => {
    const r = ok({ type, sessionId: 's', payload: { f0: { x: 0.1, y: 0.2 }, f1: { x: 0.9, y: 0.8 }, space: 'frame' } })
    expect(r.msg).toMatchObject({ payload: { space: 'frame' } })
  })

  it('still takes a touch with none, from every other sender', () => {
    const r = ok({ type: 'input:touch:start', sessionId: 's', payload: { x: 0.1, y: 0.2 } })
    expect(r.msg).not.toHaveProperty('payload.space')
  })

  it('refuses a space it does not name', () => {
    expect(fail({ type: 'input:touch:move', sessionId: 's', payload: { x: 0.1, y: 0.2, space: 'screen' } }).reason).toBe('bad-shape')
  })
})

describe('a payload failure the caller can be told about', () => {
  // **The regression this exists to prevent, and it is one the door itself would have shipped.** Today
  // a malformed `open-url` reaches the agent and the agent answers `open-url:error` from its own
  // guard — `IOSAgent.ts` says so beside that guard and names this validation as what takes it over.
  // Taking it over without taking the answer over turns an answered failure into silence.
  //
  // Worst on the inputs, and not obviously: `awaitInputAck` reports silence from a session that has
  // never acked as **success** (#457), so a dropped `input:key` would be reported to an MCP caller as
  // an input that landed.
  it.each([
    ['open-url', { payload: {} }],
    ['app:clear-state', { payload: { bundleId: 7 } }],
    ['clipboard:write', { payload: {} }],
    ['input:key', { payload: { modifiers: 1 } }],
    ['input:button', { payload: {} }],
    ['input:type', { payload: { text: null } }],
    ['device:boot', {}],
    ['app:install', { buildId: {} }],
  ] as const)('reports %s as answerable, carrying the address and the correlator', (type, rest) => {
    const r = fail({ type, sessionId: 'sess-1', requestId: 'rq-1', ...rest })
    expect(r.reason).toBe('bad-payload')
    if (r.reason === 'bad-payload') {
      expect(r.type).toBe(type)
      expect(r.sessionId).toBe('sess-1')
      expect(r.requestId).toBe('rq-1')
    }
  })

  // The mirror, and why the envelope is judged first rather than the payload being retried leniently:
  // with no usable correlator there is nothing to answer *with*. A reply carrying an empty `requestId`
  // is discarded by every correlating consumer, which is the deadline-burning non-answer this whole
  // door exists to stop shipping.
  it.each([
    ['no requestId', { type: 'open-url', sessionId: 's', payload: {} }],
    ['an empty requestId', { type: 'open-url', sessionId: 's', requestId: '', payload: {} }],
    ['an empty sessionId', { type: 'open-url', sessionId: '', requestId: 'r', payload: {} }],
  ])('refuses %s outright rather than answerably', (_name, raw) => {
    expect(fail(raw).reason).toBe('bad-shape')
  })

  // A request with no error reply must not be reported as answerable — the relay would have nothing
  // to send, and a `bad-payload` that cannot be answered is a lie about what the door achieved.
  //
  // Broken through `sessionId` rather than `payload`, and that is not incidental: `session:leave`
  // declares no payload, so an undeclared key there is *stripped* and the frame parses. Which is the
  // right answer — the tier only ever promises what it declares — and a first draft of this test
  // asserted a rejection that never happens.
  it.each(['session:leave', 'input:touch:move'])('leaves %s unanswerable', (type) => {
    expect(fail({ type, sessionId: 7 }).reason).toBe('bad-shape')
  })

  // A well-formed frame is untouched by the second stage.
  it('does not report a valid request as anything', () => {
    const raw = { type: 'open-url', sessionId: 's', requestId: 'r', payload: { url: 'x://y' } }
    expect(ok(raw).msg).toEqual(raw)
  })
})

describe('a client newer than this relay still joins', () => {
  // `session:start` has no answerable reply, so a refused one is silence and the client waits out its join
  // deadline. A `clientKind` this relay does not know therefore goes — the session is simply not
  // watchable — and the join stands. A closed enum here broke that for the first kind ever added.
  it('drops a client kind it does not know, and keeps the join', () => {
    const r = ok({ type: 'session:start', sessionId: 's1', clientKind: 'some-future-client' })
    expect(r.msg).toEqual({ type: 'session:start', sessionId: 's1', clientKind: undefined })
  })

  it('keeps a kind it knows', () => {
    expect(ok({ type: 'session:start', sessionId: 's1', clientKind: 'mcp' }).msg).toMatchObject({ clientKind: 'mcp' })
  })

  it('keeps stream: false, and drops a stream value it does not know without refusing the join', () => {
    expect(ok({ type: 'session:start', sessionId: 's1', stream: false }).msg).toMatchObject({ stream: false })
    expect(ok({ type: 'session:start', sessionId: 's1', stream: 'audio-only' }).msg).toEqual({ type: 'session:start', sessionId: 's1', stream: undefined })
  })

  it('still refuses a kind that is not a string', () => {
    expect(fail({ type: 'session:start', sessionId: 's1', clientKind: 7 }).reason).toBe('bad-shape')
  })
})

describe('readyFacts reads the checked fields the boot gate needs off a forwarded ready', () => {
  const ready = (payload: Record<string, unknown>) => ({ type: 'device:ready', sessionId: 's', payload: { deviceId: 'd', ...payload } })
  it('returns cold and the tier when they are well formed', () => {
    expect(readyFacts(ready({ cold: true }))).toEqual({ cold: true })
    expect(readyFacts(ready({ cold: false, serviceTier: { name: 'slim', keep: ['push'] } }))).toEqual({ cold: false, serviceTier: { name: 'slim', keep: ['push'] } })
    expect(readyFacts(ready({ serviceTier: 'unsupported' }))).toEqual({ serviceTier: 'unsupported' })
  })
  it('drops each field it cannot read, alone', () => {
    expect(readyFacts(ready({}))).toEqual({})
    expect(readyFacts(ready({ cold: 'yes', serviceTier: { name: 'slim', keep: [] } }))).toEqual({ serviceTier: { name: 'slim', keep: [] } })
    expect(readyFacts(ready({ cold: true, serviceTier: { name: 'turbo', keep: [] } }))).toEqual({ cold: true })
    expect(readyFacts({ type: 'device:ready', sessionId: 's' })).toEqual({})
  })
})

describe('a boot can ask for a service tier', () => {
  const boot = (serviceTier: unknown) => parseInbound({ type: 'device:boot', sessionId: 's', requestId: 'r', payload: { deviceId: 'd', serviceTier } })
  it('takes a known tier and features', () => {
    expect(boot({ name: 'slim', keep: ['push', 'photos'] }).ok).toBe(true)
  })
  it('refuses an unknown feature rather than booting slim without it', () => {
    expect(boot({ name: 'slim', keep: ['push', 'teleport'] }).ok).toBe(false)
  })
})

describe('readServiceTier checks a tier from outside a frame against the boot\'s schema', () => {
  it('takes a tier, and nothing else', () => {
    expect(readServiceTier({ name: 'slim', keep: ['push'] })).toEqual({ name: 'slim', keep: ['push'] })
    expect(readServiceTier({ name: 'turbo', keep: [] })).toBeUndefined()
    expect(readServiceTier({ name: 'slim', keep: ['teleport'] })).toBeUndefined()
    expect(readServiceTier({ name: 'slim' })).toBeUndefined()
    expect(readServiceTier('slim')).toBeUndefined()
    expect(readServiceTier(undefined)).toBeUndefined()
  })
})

describe('a boot can ask for a run reset', () => {
  const boot = (runReset: unknown) => parseInbound({ type: 'device:boot', sessionId: 's', requestId: 'r', payload: { deviceId: 'd', runReset } })
  const payloadOf = (r: ReturnType<typeof boot>) => (r.ok ? (r.msg as { payload: Record<string, unknown> }).payload : undefined)
  it('forwards a well-formed request', () => {
    expect(payloadOf(boot({ uninstall: ['com.example.app'], clear: [] }))?.runReset).toEqual({ uninstall: ['com.example.app'], clear: [] })
  })
  // The agent's report is the evidence, so a reset that cannot be read is dropped and the run warns — the boot stands.
  it('drops a malformed request and keeps the boot', () => {
    for (const bad of [{ uninstall: 'com.example.app', clear: [] }, { uninstall: [''], clear: [] }, { uninstall: Array(33).fill('a'), clear: [] }, 'yes']) {
      const r = boot(bad)
      expect(r.ok).toBe(true)
      // What the agent receives is the serialized product, and `undefined` does not survive it.
      expect(JSON.parse(JSON.stringify(payloadOf(r)))).not.toHaveProperty('runReset')
    }
  })
})

describe('readRunResetReport reads what an agent reported resetting', () => {
  it('keeps the items it knows and drops the rest', () => {
    expect(readRunResetReport({ done: ['keychain', 'teleport'], failed: ['location'] })).toEqual({ done: ['keychain'], failed: ['location'] })
  })
  it('is undefined for anything that is not a report', () => {
    expect(readRunResetReport({ done: ['keychain'] })).toBeUndefined()
    expect(readRunResetReport(undefined)).toBeUndefined()
  })
})

// A lease names no session, so a refusal at the door would have no address and the client would wait out its
// deadline. Every payload value the door cannot use is read as absent instead, and the relay answers.
// `correlatedRequestsGated` exempts `device:lease` from `ANSWERABLE` on the strength of this test.
describe('a lease is never dropped for its payload', () => {
  const lease = (payload: unknown) => parseInbound({ type: 'device:lease', requestId: 'r', payload })
  const payloadOf = (r: ReturnType<typeof lease>) => (r.ok ? JSON.parse(JSON.stringify((r.msg as { payload: unknown }).payload)) as Record<string, unknown> : undefined)

  it('keeps every well-formed field', () => {
    const full = {
      platform: 'android', buildId: 7, serviceTier: { name: 'lean', keep: [] }, acceptH264: true,
      runReset: { uninstall: ['com.example.app'], clear: [] }, stream: false, exclude: ['s1'],
    }
    expect(payloadOf(lease(full))).toEqual(full)
  })

  it('reads each unusable field as absent and keeps the rest', () => {
    const bad = {
      platform: 'windows', buildId: 1.5, serviceTier: 'slim', acceptH264: 'yes',
      runReset: { uninstall: 'x' }, stream: 1, exclude: [''],
    }
    // Two good fields beside the bad one, so dropping the whole payload is told apart from dropping the field.
    const good = { platform: 'ios', buildId: 3 }
    for (const [key, value] of Object.entries(bad)) {
      const r = lease({ ...good, [key]: value })
      expect(r.ok, key).toBe(true)
      const kept: Record<string, unknown> = { ...good }
      delete kept[key]
      expect(payloadOf(r), key).toEqual(kept)
    }
  })

  it('reads a payload that is not an object as empty', () => {
    for (const payload of [undefined, null, 'ios', 3, ['ios']]) {
      const r = lease(payload)
      expect(r.ok, String(payload)).toBe(true)
      expect(payloadOf(r)).toEqual({})
    }
  })

  it('drops only a frame with no usable correlator, which nothing could answer', () => {
    expect(parseInbound({ type: 'device:lease', requestId: '', payload: {} }).ok).toBe(false)
    expect(parseInbound({ type: 'device:lease', payload: {} }).ok).toBe(false)
  })
})
