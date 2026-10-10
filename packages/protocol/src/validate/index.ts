/**
 * Runtime validation for everything the relay receives — the half of the contract types cannot hold.
 *
 * `../index.ts` is types only, and deliberately so: the dashboard consumes it with `import type`, so it
 * must erase completely. This entry point is where the runtime lives, reached as
 * `@tapflowio/protocol/validate`, and only the relay imports it. `../AGENTS.md` reserved this spot.
 *
 * ## Why this exists at all
 *
 * The outbound direction has been compile-checked since #419 — `sendTo` refuses a message outside its
 * union. Nothing checked the inbound direction, so the relay reached for `msg.sessionId!` and
 * `msg.payload as X` on values that arrived over a network. #550 asked for `RelayMessage` (a flat
 * interface where `type` is the only required member) to become a discriminated union, and doing that
 * with a bare `as` at the door would have been a **downgrade**: the visible cast at
 * `RelayServer.ts:753` would have become an invisible `msg.payload`, with the compiler now vouching
 * for an attacker's JSON. So the union has to be the product of a parse, and this is that parse.
 *
 * ## The rule the two tiers come from
 *
 * **A field that was not validated must not appear in the type.** Anything else reintroduces the lie
 * in a quieter place.
 *
 * - **Validated** — the full schema; parsing yields the interface. Used where the relay reads or acts
 *   on the message.
 * - **Envelope** — `type` plus whichever of `sessionId` / `requestId` the interface declares; parsing
 *   yields `EnvelopeOf<I>`, so the relay **cannot** read a payload it did not check. Used where the
 *   relay only forwards.
 *
 * ## Why the whole agent direction is Envelope except the six it consumes
 *
 * Not laziness, and not a deferral: agent-payload conformance is a property the protocol deliberately
 * does not have. `AgentRegister.platform` is `string` — open, because a third-party platform registers
 * through `AgentRegistry.register()` and the root AGENTS.md's OCP rule says that must work without
 * modifying existing code — while `ChromePayload` is a **closed two-member union**. So a platform this
 * repo promises to support has no valid `session:chrome` variant to send. Rejecting one would cost
 * that platform its bezel and buttons permanently: the message arrives once per boot, a rejection
 * skips `setChromeData` and therefore empties the re-join replay too, and there is no
 * `session:chrome-error` for anyone to be told through.
 *
 * The six the relay consumes (`agent:register`, `agent:resources`, the two screenshot replies and the
 * two ui-tree replies) forward nowhere, so rejecting them breaks no forward path — and their schemas
 * carry a `.default()` for every field the relay currently reads through a `??`, which keeps today's
 * tolerance for an older agent exactly as it is. `UIElement` is safe to validate where `ChromePayload`
 * is not, for a reason worth stating: it is not a per-platform union but the normalized shape every
 * platform maps *into*, so a third-party agent conforms by construction.
 *
 * ## What is not checked here, and where it is
 *
 * Role authorisation. `directionOf` answers which socket may send a type; deciding what to do about a
 * mismatch (the relay closes a browser socket with 1008) stays in `RelayServer`, because it is a
 * policy about a connection rather than a fact about a message.
 */
import * as z from 'zod'

import type {
  AgentRegister, AgentResourceReport, AgentsList, AppClearState, AppClearStateDone,
  AppClearStateError, AppInstallDone, AppInstallError, AppInstallToRelay, AppLaunchDone,
  AppLaunchError, AppLaunchToRelay, ClipboardData, ClipboardError, ClipboardRead, ClipboardWrite,
  NetworkError, NetworkSet, NetworkState,
  ClipboardWriteDone, DeviceBoot, DeviceBootError, DeviceBooting, DeviceReady, DeviceShutdown,
  DeviceShutdownDone, DeviceShutdownError, InputButton, InputDone, InputError, InputKey, InputKeyboardToggle,
  InputPinchEnd, InputPinchMove, InputPinchStart, InputPosture, InputRotate, InputTouchEnd, InputTouchMove,
  InputTouchStart, InputType, InputTypeDone, InputTypeError, KeyboardToggled, OpenUrl, OpenUrlDone,
  OpenUrlError, ScreenshotDone, ScreenshotError, SessionChrome, SessionDeviceInfo, SessionEnd,
  SessionLeave, SessionStart, StreamRegister, UiTreeError, UiTreeResponse, WatchStart, WatchStop,
} from '../index.js'
import type { Assert, EnvelopeOf, IsEmpty, SchemaExact } from './assert.js'

// ── field helpers ────────────────────────────────────────────────────────────
//
// `.min(1)`, never a bare `z.string()`, on both correlation fields. The predicates this replaces
// (`isAddressed` / `isCorrelated`) rejected the empty string as well as the absent one, and dropping
// that half would be a silent regression: a `device:boot` carrying `requestId: ''` would pass the door
// and the relay would answer `device:boot-error` with `requestId: ''` — a frame whose required
// correlator is present-but-empty, which every correlating consumer discards. `.min(1)` does not
// change what `z.output` infers (`min(minLength): this` — zod 4.4.3 `v4/classic/schemas.d.ts:95`), so
// it costs the tier assertions nothing.
const sessionId = z.string().min(1)
const requestId = z.string().min(1)

const point = z.object({ x: z.number(), y: z.number() })

// ── envelope-tier builders ───────────────────────────────────────────────────
//
// Four shapes cover all 26 forward-only messages. Getting one wrong is a compile error at its
// assertion below rather than something that shows up as a dropped frame in production.

/** `{ type, sessionId }` — no correlator on the interface. */
const env = <T extends string>(type: T) => z.object({ type: z.literal(type), sessionId })
/** `{ type, sessionId, requestId }`. */
const envC = <T extends string>(type: T) => z.object({ type: z.literal(type), sessionId, requestId })
/** `{ type, sessionId, requestId? }` — the relay originates some of these itself, so the agent's copy
 *  is not always a reply. */
const envCo = <T extends string>(type: T) =>
  z.object({ type: z.literal(type), sessionId, requestId: requestId.optional() })

// ── browser → relay ──────────────────────────────────────────────────────────
//
// Fully validated, and the only direction whose parse product is what gets forwarded. This is the
// attacker-controllable side: a viewer can send arbitrary frames from devtools. `z.object` strips
// unknown keys rather than rejecting them, so forwarding the product — not the original — is what
// makes a key an attacker appended disappear before any agent sees it. Nothing in the repo loses a
// field to that: the dashboard, `mcp-server` and `flow-runner` all send through a
// `send(msg: BrowserToRelay)` signature, so their frames are already compile-checked against exactly
// these shapes.

const BROWSER_INBOUND = {
  'agents:list': z.object({ type: z.literal('agents:list') }),
  // `clientKind` optional: a client that predates it joins as before, and is simply not watchable.
  'session:start': z.object({
    type: z.literal('session:start'), sessionId,
    clientKind: z.enum(['dashboard', 'mcp', 'flow-runner']).optional(),
  }),
  'watch:start': z.object({ type: z.literal('watch:start'), sessionId }),
  'watch:stop': z.object({ type: z.literal('watch:stop'), sessionId }),
  'session:end': z.object({ type: z.literal('session:end'), sessionId }),
  'session:leave': z.object({ type: z.literal('session:leave'), sessionId }),
  'device:boot': z.object({
    type: z.literal('device:boot'),
    sessionId,
    requestId,
    payload: z.object({
      deviceId: z.string(),
      resetMode: z.enum(['app-only', 'full-erase']).optional(),
      acceptH264: z.boolean().optional(),
      secureContext: z.boolean().optional(),
    }),
  }),
  'device:shutdown': z.object({
    type: z.literal('device:shutdown'),
    sessionId,
    requestId: requestId.optional(),
    payload: z.object({ deviceId: z.string() }),
  }),
  // Strict, because `ANSWERABLE` below answers a bad one rather than dropping it. A draft carried it
  // through as `NaN` so the handler's `Number.isInteger` could keep replying `Build not found` — which
  // worked, and left this message as the single special case in a class the door now handles uniformly.
  // It was also the wrong diagnosis: nothing was looked up, so "not found" describes a query that never
  // ran.
  'app:install': z.object({ type: z.literal('app:install'), sessionId, requestId, buildId: z.number().int() }),
  'app:launch': z.object({ type: z.literal('app:launch'), sessionId, requestId, buildId: z.number().int() }),
  'app:clear-state': z.object({
    type: z.literal('app:clear-state'), sessionId, requestId,
    payload: z.object({ bundleId: z.string() }),
  }),
  'open-url': z.object({
    type: z.literal('open-url'), sessionId, requestId, payload: z.object({ url: z.string() }),
  }),
  'input:touch:start': z.object({ type: z.literal('input:touch:start'), sessionId, payload: point }),
  'input:touch:move': z.object({ type: z.literal('input:touch:move'), sessionId, payload: point }),
  // `payload` optional because that is what the wire carries — the dashboard omits it and the agents
  // never read it. See the note on `InputTouchEnd`.
  'input:touch:end': z.object({
    type: z.literal('input:touch:end'), sessionId, requestId, payload: point.optional(),
  }),
  'input:pinch:start': z.object({
    type: z.literal('input:pinch:start'), sessionId, payload: z.object({ f0: point, f1: point }),
  }),
  'input:pinch:move': z.object({
    type: z.literal('input:pinch:move'), sessionId, payload: z.object({ f0: point, f1: point }),
  }),
  'input:pinch:end': z.object({ type: z.literal('input:pinch:end'), sessionId, requestId }),
  // `modifiers` is a bitmap, not a list — see the note on `InputKey`.
  'input:key': z.object({
    type: z.literal('input:key'), sessionId, requestId,
    payload: z.object({ code: z.string(), modifiers: z.number().optional() }),
  }),
  'input:type': z.object({
    type: z.literal('input:type'), sessionId, requestId, payload: z.object({ text: z.string() }),
  }),
  'input:button': z.object({
    type: z.literal('input:button'), sessionId, requestId,
    payload: z.object({ name: z.string(), phase: z.enum(['down', 'up']).optional() }),
  }),
  'input:rotate': z.object({
    type: z.literal('input:rotate'), sessionId,
    payload: z.object({ orientation: z.enum(['portrait', 'landscape']) }).optional(),
  }),
  'input:posture': z.object({
    type: z.literal('input:posture'), sessionId,
    payload: z.object({ postureId: z.string() }),
  }),
  'input:keyboard:toggle': z.object({ type: z.literal('input:keyboard:toggle'), sessionId }),
  'clipboard:read': z.object({
    type: z.literal('clipboard:read'), sessionId, requestId,
    payload: z.object({ press: z.enum(['copy', 'cut']).optional() }).optional(),
  }),
  'clipboard:write': z.object({
    type: z.literal('clipboard:write'), sessionId, requestId,
    payload: z.object({ text: z.string(), pasteAfter: z.boolean().optional() }),
  }),
  // `payload` required, and `offline` required inside it: this command has exactly one thing to say
  // and a frame that omits it is not "toggle" — nothing on the wire carries the current state, so
  // there would be nothing to toggle *from*. A malformed one is answered rather than dropped
  // (`ANSWERABLE` below), because the viewer's control would otherwise sit armed on a device that
  // never heard the request.
  'network:set': z.object({
    type: z.literal('network:set'), sessionId, requestId,
    payload: z.object({ offline: z.boolean() }),
  }),
} as const

// ── agent → relay ────────────────────────────────────────────────────────────

/** The six the relay consumes. Every `.default()` below mirrors a `??` that is in `RelayServer` today,
 *  so an agent older than a field keeps working exactly as it does now — the default lands in the
 *  schema, where it is visible, instead of at the read site, where it read as defensive noise.
 *
 *  This is what makes rejection affordable here: `z.input` stays as loose as the wire has ever been
 *  while `z.output` matches the interface, which is what the tier assertion compares. */
const AGENT_CONSUMED = {
  'agent:register': z.object({
    type: z.literal('agent:register'),
    // **All four defaults come from a `??` in `RelayServer`, and the list is exhaustive by
    // construction** — `agentId ?? agentName` for identity, `devices ?? []`, `capabilities ?? []`, and
    // `agentName ?? agentId ?? 'unknown'` / `platform ?? 'unknown'` in the connect log. A first draft
    // defaulted only `capabilities` and `devices` and required these two, which would have made an
    // agent omitting either **never register at all**: the frame is refused, no `agent:registered`
    // goes back, and the agent's handshake promise never resolves — the whole Mac and every device on
    // it simply absent from the dashboard, with one relay-side warn as the only trace. That is the
    // most expensive rejection in the protocol, so this message is the one to be most tolerant on.
    //
    // `''` rather than `undefined` because `z.output` must match the interface, and it is behaviourally
    // the same everywhere it reaches: `identity` stays falsy so no eviction runs, and the log line uses
    // `||` for exactly this.
    platform: z.string().default(''),
    // How a viewer tells an agent that predates a capability from one that has it.
    capabilities: z.array(z.string()).default([]),
    agentId: z.string().optional(),
    agentName: z.string().default(''),
    // Deduplication by device id stays in the handler — it is a policy about the *set*, not a shape.
    devices: z.array(z.object({
      id: z.string(), name: z.string(), platform: z.string(), status: z.string(),
      osVersion: z.string().optional(),
      // A form factor this relay does not know is a newer agent, not a broken one: the field goes and
      // the register stands. Anything that is not a string is still refused, the line `capabilities`
      // draws — `.catch` over the whole field would swallow that too.
      formFactor: z.union([z.enum(['phone', 'tablet', 'foldable']), z.string().transform(() => undefined)]).optional(),
    })).default([]),
  }),
  'agent:resources': z.object({
    type: z.literal('agent:resources'),
    resources: z.object({
      cpuPercent: z.number(), memUsedMB: z.number(), memTotalMB: z.number(),
      slotsAvailable: z.number(), slotsTotal: z.number(), reportedAt: z.number(),
    }),
  }),
  'screenshot:done': z.object({
    type: z.literal('screenshot:done'), sessionId, requestId,
    // The claim, not the truth — the relay sniffs the bytes and logs a mismatch rather than
    // overwriting this, because only the agent knows what it produced (#508).
    format: z.enum(['png', 'jpeg']).default('png'),
    data: z.string().default(''),
  }),
  'screenshot:error': z.object({
    type: z.literal('screenshot:error'), sessionId, requestId, message: z.string().default(''),
  }),
  'ui:tree:response': z.object({
    type: z.literal('ui:tree:response'), sessionId, requestId,
    // Safe to validate where `ChromePayload` is not: a normalized shape every platform maps into,
    // not a union with one member per platform.
    elements: z.array(z.object({
      role: z.enum([
        'button', 'text', 'input', 'image', 'checkbox', 'switch', 'slider', 'list', 'cell', 'tab', 'other',
      ]),
      label: z.string(),
      identifier: z.string().optional(),
      frame: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
      enabled: z.boolean(),
      rawRole: z.string().optional(),
    })).default([]),
  }),
  'ui:tree:error': z.object({
    type: z.literal('ui:tree:error'), sessionId, requestId, message: z.string().default(''),
  }),
} as const

/** The 26 the relay only forwards. Envelope tier — see the header for why there is no exception. */
const AGENT_FORWARDED = {
  'session:chrome': env('session:chrome'),
  'session:deviceInfo': env('session:deviceInfo'),
  'device:postures': env('device:postures'),
  // The only member whose `sessionId` is optional, and it is a documented deferral rather than an
  // oversight — stamping it would make a replayed ready satisfy an in-flight boot. See `DeviceReady`.
  'device:ready': z.object({
    type: z.literal('device:ready'),
    sessionId: sessionId.optional(),
    requestId: requestId.optional(),
  }),
  'device:booting': env('device:booting'),
  'device:shutdown-done': envCo('device:shutdown-done'),
  'device:boot-error': envCo('device:boot-error'),
  // `envCo` for the reason its `-done` is: the relay's idle timer sends the request with no id (#455).
  'device:shutdown-error': envCo('device:shutdown-error'),
  'app:install-done': envC('app:install-done'),
  'app:install-error': envC('app:install-error'),
  'app:launch-done': envC('app:launch-done'),
  'app:launch-error': envC('app:launch-error'),
  'app:clear-state-done': envC('app:clear-state-done'),
  'app:clear-state-error': envC('app:clear-state-error'),
  'open-url:done': envC('open-url:done'),
  'open-url:error': envC('open-url:error'),
  'input:done': envC('input:done'),
  'input:error': envC('input:error'),
  'input:type-done': envC('input:type-done'),
  'input:type-error': envC('input:type-error'),
  'keyboard:toggled': env('keyboard:toggled'),
  'clipboard:data': envC('clipboard:data'),
  'clipboard:write-done': envC('clipboard:write-done'),
  'clipboard:error': envC('clipboard:error'),
  // `envCo`, not `envC`: this one answers `network:set` **and** arrives unsolicited — on
  // `device:ready`, on a boot that re-arms the injection, when a session's condition is cleared, and
  // in reply to the relay's `network:request-state` on a viewer re-join (#614).
  // Absent means "not the answer to a request", never "an old agent".
  'network:state': envCo('network:state'),
  'network:error': envC('network:error'),
} as const

const AGENT_INBOUND = { ...AGENT_CONSUMED, ...AGENT_FORWARDED } as const

// ── stream → relay ───────────────────────────────────────────────────────────
//
// One message, and its own direction on purpose: the relay assigns the role `'stream'` from it, so
// merging it into the agent direction would let a control socket claim to be a session's stream
// socket. Everything else on that socket is binary and never reaches this parser.
const STREAM_INBOUND = {
  'stream:register': z.object({ type: z.literal('stream:register'), sessionId }),
} as const

const INBOUND = { ...BROWSER_INBOUND, ...AGENT_INBOUND, ...STREAM_INBOUND } as const

// ── the requests whose payload failure can be answered ───────────────────────
//
// **The envelope is judged separately from the payload, and that is what makes an answer possible.**
// A frame whose `sessionId` and `requestId` are both good and whose payload is not carries everything
// a reply needs: an address and a correlator. Refusing it wholesale would be the regression this door
// otherwise ships — today a malformed `open-url` reaches the agent, which answers `open-url:error`
// from its own guard (`IOSAgent.ts` says so in writing: "validating third-party frames at the relay's
// door is #444, which will take this over"). Taking it over must not mean losing the answer.
//
// The cost of losing it is worst on the inputs, and not obviously: `awaitInputAck` reports silence
// from a session that has never acked as **success** (#457), so a dropped `input:key` would be
// reported to an MCP caller as an input that landed.
//
// Exactly the twelve browser requests that declare a required `requestId`. The relay maps each to the
// reply its own waiter reads; `scripts/__tests__/correlatedRequestsGated.test.mjs` derives that set
// from the protocol and holds all three lists to it.
const ANSWERABLE = {
  'device:boot': envC('device:boot'),
  'app:install': envC('app:install'),
  'app:launch': envC('app:launch'),
  'app:clear-state': envC('app:clear-state'),
  'open-url': envC('open-url'),
  'input:touch:end': envC('input:touch:end'),
  'input:pinch:end': envC('input:pinch:end'),
  'input:key': envC('input:key'),
  'input:button': envC('input:button'),
  'input:type': envC('input:type'),
  'clipboard:read': envC('clipboard:read'),
  'clipboard:write': envC('clipboard:write'),
  'network:set': envC('network:set'),
} as const

export type AnswerableType = keyof typeof ANSWERABLE

// ── what the door proved ─────────────────────────────────────────────────────

/**
 * The parse product, derived from the map — **not** a union of the protocol's interfaces.
 *
 * An earlier draft returned `BrowserToRelay | AgentToRelay | AgentToBrowser | StreamToRelay`, which
 * violates this file's own opening rule with its return type: narrowing that by
 * `msg.type === 'session:chrome'` hands back `payload: ChromePayload`, fully typed, with nothing
 * having checked it — worse than the `as` it replaced, because a cast can at least be grepped.
 * Deriving from `INBOUND` means an Envelope member arrives as `{ type, sessionId }` and reading
 * `msg.payload` off it is a compile error, which is the claim the tiers make.
 */
export type ParsedInbound = { [K in keyof typeof INBOUND]: z.output<(typeof INBOUND)[K]> }[keyof typeof INBOUND]

export type InboundType = keyof typeof INBOUND
export type InboundDirection = 'browser' | 'agent' | 'stream'

export type ParseFailure =
  | { ok: false; reason: 'not-an-object' }
  | { ok: false; reason: 'unknown-type'; type: string }
  | { ok: false; reason: 'bad-shape'; type: InboundType; detail: string }
  /** The payload is wrong but the envelope is not, so the caller can be told. */
  | { ok: false; reason: 'bad-payload'; type: AnswerableType; sessionId: string; requestId: string; detail: string }

export type ParseResult =
  | {
      ok: true
      msg: ParsedInbound
      /** The frame as it arrived.
       *
       *  Forwarding differs by direction and this is why both are available. An **agent**-origin
       *  message is forwarded as this, so a field a newer agent added survives a relay that does not
       *  know it — `z.object` strips, and stripping here would break upward compatibility in the one
       *  direction where the sender is the more recently updated side. A **browser**-origin message is
       *  forwarded as `msg` instead, so a key an attacker appended does not survive.
       *
       *  It is also where the two Envelope payloads the relay stores come from, and it should stay
       *  visibly separate for that reason: a value read off `raw` is a value the parser did not
       *  vouch for. */
      raw: Readonly<Record<string, unknown>>
    }
  | ParseFailure

const DIRECTIONS: ReadonlyMap<string, InboundDirection> = new Map([
  ...Object.keys(BROWSER_INBOUND).map((t) => [t, 'browser'] as const),
  ...Object.keys(AGENT_INBOUND).map((t) => [t, 'agent'] as const),
  ...Object.keys(STREAM_INBOUND).map((t) => [t, 'stream'] as const),
])

/**
 * Which socket role is allowed to send this type.
 *
 * This replaces `AGENT_MSG_TYPE_LIST` — 29 literals hand-copied into `RelayServer` and held by two
 * type assertions. It is derived from the map above, which the assertions at the bottom of this file
 * tie back to the protocol's own direction unions, so the copy is gone rather than moved.
 *
 * A runtime set cannot come out of a union directly (types erase), which is why it comes out of the
 * schema map's keys. That makes the relay's role gate depend on this map existing — a real coupling,
 * and the reason the coverage assertions below are not optional.
 */
export function directionOf(type: InboundType): InboundDirection {
  // Non-null: `DIRECTIONS` is built from the same keys `InboundType` is derived from, and the
  // coverage assertions below make a divergence a compile error rather than a runtime miss.
  return DIRECTIONS.get(type)!
}

/**
 * Parse a frame the relay received.
 *
 * **Takes no role.** A first design did, and it could not be called: `classifyConnection` returns
 * `role: 'first-message'` for every local connection and every remote agent-scoped PAT, so the role is
 * assigned from the first message's own `type`. `agent:register` is the message that *creates* the
 * role, so selecting a schema by role to validate it is circular — and defaulting the unknown role to
 * `'browser'`, which is what the relay does for a socket that skips the handshake, would have closed
 * every agent's socket on its opening frame. The order is parse, then role, then gate.
 */
export function parseInbound(raw: unknown): ParseResult {
  // `JSON.parse` returns bare `null`, numbers and strings without throwing, and a caller that reads
  // `.type` off one of those is the reason this is checked before anything else.
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, reason: 'not-an-object' }
  const frame = raw as Record<string, unknown>
  const type = frame['type']
  if (typeof type !== 'string' || !Object.hasOwn(INBOUND, type)) {
    return { ok: false, reason: 'unknown-type', type: typeof type === 'string' ? type : String(type) }
  }
  const known = type as InboundType
  // **The universe is the inbound map, not `AnyWireMessage`.** Eleven literals belong to no inbound
  // direction — `session:joined`, `error`, `agents:listed` and the rest the relay produces. A browser
  // that sends one today reaches the switch, matches no case and is ignored. Measuring `unknown-type`
  // against every declared literal instead would classify those as a direction violation, and the
  // relay closes a direction violation with 1008 — disconnecting a dashboard over a frame that is
  // inert today.
  const result = INBOUND[known].safeParse(frame)
  if (!result.success) {
    const detail = z.prettifyError(result.error)
    // Second stage, and only for the twelve. If the envelope stands on its own, the failure is in the
    // payload and the relay has an address and a correlator to answer with — see `ANSWERABLE`.
    if (Object.hasOwn(ANSWERABLE, known)) {
      const answerable = known as AnswerableType
      const envelope = ANSWERABLE[answerable].safeParse(frame)
      if (envelope.success) {
        const { sessionId: s, requestId: r } = envelope.data
        return { ok: false, reason: 'bad-payload', type: answerable, sessionId: s, requestId: r, detail }
      }
    }
    return { ok: false, reason: 'bad-shape', type: known, detail }
  }
  return { ok: true, msg: result.data as ParsedInbound, raw: frame }
}

// ── the map is tied to the protocol, both ways ───────────────────────────────
//
// Everything below is type-level and erases. `satisfies` reports at the literal; these report at the
// declaration and survive the map being moved or re-exported, which is the same belt-and-braces shape
// `relay/src/types.ts` uses for its own membership claims.
//
// Note what is deliberately NOT written here: `const INBOUND: Record<…, z.ZodType>`. Annotating the
// map erases each entry's schema type, so `z.output` would answer `unknown` and every tier assertion
// below would pass while checking nothing.

type BrowserKeys = keyof typeof BROWSER_INBOUND
type AgentKeys = keyof typeof AGENT_INBOUND
type StreamKeys = keyof typeof STREAM_INBOUND

/** Tier and direction membership, stated rather than conventional: giving `device:boot` an envelope
 *  schema, or filing an agent reply under the browser direction, is a compile error here instead of
 *  something noticed when a relay line fails to read a payload. */
type _BrowserCovers = Assert<IsEmpty<Exclude<import('../index.js').BrowserToRelay['type'], BrowserKeys>>>
type _BrowserInventsNothing = Assert<IsEmpty<Exclude<BrowserKeys, import('../index.js').BrowserToRelay['type']>>>
type _AgentCovers = Assert<
  IsEmpty<Exclude<(import('../index.js').AgentToRelay | import('../index.js').AgentToBrowser)['type'], AgentKeys>>
>
type _AgentInventsNothing = Assert<
  IsEmpty<Exclude<AgentKeys, (import('../index.js').AgentToRelay | import('../index.js').AgentToBrowser)['type']>>
>
/** Every answerable request is a browser request. An agent reply is not something the relay answers. */
type _AnswerableIsBrowser = Assert<IsEmpty<Exclude<AnswerableType, BrowserKeys>>>

type _StreamCovers = Assert<IsEmpty<Exclude<import('../index.js').StreamToRelay['type'], StreamKeys>>>
type _StreamInventsNothing = Assert<IsEmpty<Exclude<StreamKeys, import('../index.js').StreamToRelay['type']>>>

// ── each schema against the interface it mirrors ─────────────────────────────
//
// The Validated tier compares against the interface; the Envelope tier against `EnvelopeOf<I>`, which
// is the interface projected onto the fields the door checks. One assertion kind for both, because the
// projection is derived from the interface and so cannot disagree with it.
//
// An earlier design gave the Envelope tier a weaker assertion — "the interface is assignable to what I
// parsed" — and it was vacuous: adding `payload: z.unknown()` to an envelope schema passed, as did
// `z.any()`, `z.custom<T>()` and an empty `z.object({})`, which is to say every idiomatic way of
// making the mistake it was written to catch.

// `Assert` is applied at each use below rather than inside these two, because a constraint on a
// generic alias is checked against the *unresolved* parameter — `SchemaExact<…[K], I>` for an
// unknown `K` is not provably `true`, so the alias would fail to declare while saying nothing about
// any actual pair.
type V<K extends keyof typeof INBOUND, I> = SchemaExact<(typeof INBOUND)[K], I>
type E<K extends keyof typeof INBOUND, I extends { type: string }> = SchemaExact<(typeof INBOUND)[K], EnvelopeOf<I>>

type _AgentsList = Assert<V<'agents:list', AgentsList>>
type _SessionStart = Assert<V<'session:start', SessionStart>>
type _SessionEnd = Assert<V<'session:end', SessionEnd>>
type _SessionLeave = Assert<V<'session:leave', SessionLeave>>
type _DeviceBoot = Assert<V<'device:boot', DeviceBoot>>
type _DeviceShutdown = Assert<V<'device:shutdown', DeviceShutdown>>
type _AppInstall = Assert<V<'app:install', AppInstallToRelay>>
type _AppLaunch = Assert<V<'app:launch', AppLaunchToRelay>>
type _AppClearState = Assert<V<'app:clear-state', AppClearState>>
type _OpenUrl = Assert<V<'open-url', OpenUrl>>
type _InputTouchStart = Assert<V<'input:touch:start', InputTouchStart>>
type _InputTouchMove = Assert<V<'input:touch:move', InputTouchMove>>
type _InputTouchEnd = Assert<V<'input:touch:end', InputTouchEnd>>
type _InputPinchStart = Assert<V<'input:pinch:start', InputPinchStart>>
type _InputPinchMove = Assert<V<'input:pinch:move', InputPinchMove>>
type _InputPinchEnd = Assert<V<'input:pinch:end', InputPinchEnd>>
type _InputKey = Assert<V<'input:key', InputKey>>
type _InputType = Assert<V<'input:type', InputType>>
type _InputButton = Assert<V<'input:button', InputButton>>
type _InputRotate = Assert<V<'input:rotate', InputRotate>>
type _InputPosture = Assert<V<'input:posture', InputPosture>>
type _InputKeyboardToggle = Assert<V<'input:keyboard:toggle', InputKeyboardToggle>>
type _ClipboardRead = Assert<V<'clipboard:read', ClipboardRead>>
type _ClipboardWrite = Assert<V<'clipboard:write', ClipboardWrite>>
type _NetworkSet = Assert<V<'network:set', NetworkSet>>
type _WatchStart = Assert<V<'watch:start', WatchStart>>
type _WatchStop = Assert<V<'watch:stop', WatchStop>>

type _AgentRegister = Assert<V<'agent:register', AgentRegister>>
type _AgentResources = Assert<V<'agent:resources', AgentResourceReport>>
type _ScreenshotDone = Assert<V<'screenshot:done', ScreenshotDone>>
type _ScreenshotError = Assert<V<'screenshot:error', ScreenshotError>>
type _UiTreeResponse = Assert<V<'ui:tree:response', UiTreeResponse>>
type _UiTreeError = Assert<V<'ui:tree:error', UiTreeError>>

type _StreamRegister = Assert<V<'stream:register', StreamRegister>>

type _SessionChrome = Assert<E<'session:chrome', SessionChrome>>
type _SessionDeviceInfo = Assert<E<'session:deviceInfo', SessionDeviceInfo>>
type _DeviceReady = Assert<E<'device:ready', DeviceReady>>
type _DeviceBooting = Assert<E<'device:booting', DeviceBooting>>
type _DeviceShutdownDone = Assert<E<'device:shutdown-done', DeviceShutdownDone>>
type _DeviceBootError = Assert<E<'device:boot-error', DeviceBootError>>
type _DeviceShutdownError = Assert<E<'device:shutdown-error', DeviceShutdownError>>
type _AppInstallDone = Assert<E<'app:install-done', AppInstallDone>>
type _AppInstallError = Assert<E<'app:install-error', AppInstallError>>
type _AppLaunchDone = Assert<E<'app:launch-done', AppLaunchDone>>
type _AppLaunchError = Assert<E<'app:launch-error', AppLaunchError>>
type _AppClearStateDone = Assert<E<'app:clear-state-done', AppClearStateDone>>
type _AppClearStateError = Assert<E<'app:clear-state-error', AppClearStateError>>
type _OpenUrlDone = Assert<E<'open-url:done', OpenUrlDone>>
type _OpenUrlError = Assert<E<'open-url:error', OpenUrlError>>
type _InputDone = Assert<E<'input:done', InputDone>>
type _InputError = Assert<E<'input:error', InputError>>
type _InputTypeDone = Assert<E<'input:type-done', InputTypeDone>>
type _InputTypeError = Assert<E<'input:type-error', InputTypeError>>
type _KeyboardToggled = Assert<E<'keyboard:toggled', KeyboardToggled>>
type _ClipboardData = Assert<E<'clipboard:data', ClipboardData>>
type _ClipboardWriteDone = Assert<E<'clipboard:write-done', ClipboardWriteDone>>
type _ClipboardError = Assert<E<'clipboard:error', ClipboardError>>
type _NetworkState = Assert<E<'network:state', NetworkState>>
type _NetworkError = Assert<E<'network:error', NetworkError>>
