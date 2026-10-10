// Compile-time assertions about the contract. This file exports nothing anyone imports — it exists
// so `tsc` fails if the guards ever loosen.
//
// Each `@ts-expect-error` says "the next line must not compile". If someone widens a union, adds an
// index signature, or turns a payload back into `unknown`, the error disappears — and an unused
// `@ts-expect-error` is itself a compile error. So the guard cannot rot silently, which is exactly
// the failure mode this whole package was built to remove.

import type {
  AgentRegister, AgentRegistered, AgentResourceReport, AgentToBrowser, AgentsList, AgentsListed,
  AppClearState, AppClearStateDone, AppClearStateError, AppInstallDone, AppInstallError, AppInstallToAgent,
  AppInstallToRelay, AppLaunchDone, AppLaunchError, AppLaunchToAgent, AppLaunchToRelay, BrowserInbound,
  BrowserToRelay, ClipboardData, ClipboardError, ClipboardRead, ClipboardWrite, ClipboardWriteDone,
  NetworkError, NetworkSet, NetworkState, NetworkStatePayload,
  DeviceBoot, DeviceBootError, DeviceBooting, DeviceReady, DeviceShutdown, DeviceShutdownDone,
  DeviceShutdownError, GenericError,
  InputButton, InputDone, InputError, InputKey, InputKeyboardToggle, InputPinchEnd, InputPinchMove,
  InputPinchStart, InputRotate, InputTouchEnd, InputTouchMove, InputTouchStart, InputType, InputTypeDone,
  InputTypeError, KeyboardToggled, OpenUrl, OpenUrlDone, OpenUrlError, RelayOutbound, ScreenshotDone,
  ScreenshotError, ScreenshotRequest, SessionAgentAway, SessionChrome, SessionDeviceInfo, SessionEnd,
  SessionJoined, SessionLeave, SessionRebound, SessionStart, SessionTerminated, StreamRegister,
  AgentControlOutbound, StreamToRelay,
  StreamRegistered, StreamRequestIdr, UiTreeError, UiTreeRequest, UiTreeResponse,
  NetworkRequestState,
  InputPosture, DevicePostures,
  WatchStart, WatchStop, WatchStarted, WatchRefused, WatchHolderLeft, WatchEnded,
} from './index.js'

// ── must NOT compile ─────────────────────────────────────────────────────────

// @ts-expect-error - a type that is not in the union
export const unknownType: RelayOutbound = { type: 'nope', message: 'x' }

// @ts-expect-error - `capabilities` is required on session:joined
export const missingField: RelayOutbound = { type: 'session:joined', sessionId: 's' }

// L5d made `error` an addressed `session:start` reply, so the line that used to sit here — asserting it
// carries **no** `sessionId` — now describes the opposite of the contract. It is not simply deleted: it was
// this file's only whole-message excess-property assertion (`unknownType` tests a bad literal, `missingField`
// a missing required field, `legacyKeyField` an excess key nested inside `payload`), and an unused
// `@ts-expect-error` is itself an error, so retiring it silently would drop an assertion *class* as a side
// effect of narrowing one message. Relocated to a message that has no reason to grow a field.
// @ts-expect-error - `session:joined` has no `deviceId`; the session already names the device
export const extraField: RelayOutbound = { type: 'session:joined', sessionId: 's', capabilities: [], deviceId: 'd' }

// And `error` now belongs to the family, which is the positive half of the same change.
export const addressedError: RelayOutbound = { type: 'error', sessionId: 's', message: 'x', reason: 'session-busy' }

// Kept on one line each: `@ts-expect-error` applies to the next line only, so a multi-line literal
// whose error lands three lines down leaves the directive unused — which reads as a failure of the
// assertion rather than of the thing it guards.

// @ts-expect-error - modifiers is a bitmap (number), not a list — the drift this package caught
export const wrongModifierType: BrowserToRelay = { type: 'input:key', sessionId: 's', payload: { code: 'KeyA', modifiers: ['Shift'] } }

// @ts-expect-error - `key` was never the field name; senders and agents use `code`
export const legacyKeyField: BrowserToRelay = { type: 'input:key', sessionId: 's', payload: { key: 'a' } }

// ── must compile ─────────────────────────────────────────────────────────────
// The other direction: if one of these breaks, the contract stopped describing something real.

export const validOutbound: RelayOutbound = { type: 'stream:request-idr', sessionId: 's' }
export const validInbound: BrowserToRelay = {
  type: 'input:key', sessionId: 's', requestId: 'rq', payload: { code: 'KeyA', modifiers: 2 },
}
export const validClipboard: BrowserToRelay = {
  type: 'clipboard:write', sessionId: 's', requestId: 'r', payload: { text: 'x', pasteAfter: true },
}

// ── browser-inbound directions ───────────────────────────────────────────────
// `RelayOutbound` is what `sendTo` takes, so it must NOT accept a message only an agent produces —
// the relay forwards those with `JSON.stringify(msg)` and never builds one. Nothing else can state
// this: `browserInboundRouting.test.mjs` compares *membership*, so it would still pass if the relay
// gained a `sendTo` call constructing a forward-only message.

// @ts-expect-error - agents produce input:done; the relay only forwards it
export const relayCannotOriginateForward: RelayOutbound = { type: 'input:done', sessionId: 's' }

// @ts-expect-error - same, and this one carries a payload the relay has no source for
export const relayCannotOriginateKeyboard: RelayOutbound = { type: 'keyboard:toggled', sessionId: 's', payload: { visible: true } }

// A consumer reads the whole surface, whoever sent it — both of the above are valid here.
export const inboundFromAgent: BrowserInbound = { type: 'input:done', sessionId: 's', requestId: 'rq' }
export const inboundFromRelay: BrowserInbound = { type: 'error', sessionId: 's', message: 'x', reason: 'session-busy' }

// @ts-expect-error - sessionId is required on every one of the twelve forward-only messages
export const forwardWithoutSession: AgentToBrowser = { type: 'app:install-done' }

// The shape an agent actually sends for the three shared messages the relay also replays. `sessionId`
// is optional on the shared declaration because the replay omits it, so this direction cannot reject
// the absence — pinning what the agent sends is what the union can state here. L4 tightens it.
export const agentStampsSession: AgentToBrowser = { type: 'device:ready', sessionId: 's', payload: { deviceId: 'd' } }

// The stream socket's one message is its own direction now, so it is still reachable through
// `sendTo` but is no longer part of what a browser can receive.
export const streamRegistered: RelayOutbound = { type: 'stream:registered' }
// @ts-expect-error - stream:registered does not go to a browser
export const streamIsNotBrowserInbound: BrowserInbound = { type: 'stream:registered' }

// ── input:error reason ───────────────────────────────────────────────────────
// The field was optional so an agent predating it could omit one, and a consumer had to read absence
// as "unknown" rather than "fine". #491 took the breaking step: all six in-repo producers already sent
// a reason, so what this closes is an agent outside the repo omitting it, and a consumer being handed a
// failure it cannot branch on.

// @ts-expect-error - reason is required as of #491; prose alone is not an answer a caller can act on
export const errorWithoutReason: RelayOutbound = { type: 'input:error', sessionId: 's', requestId: 'rq', message: 'agent offline' }
export const errorWithReason: RelayOutbound = { type: 'input:error', sessionId: 's', requestId: 'rq', message: 'agent offline', reason: 'channel-unavailable' }
// The other half of the inversion: prose is now the optional one, and a producer with nothing
// parameterised to add may leave it out.
export const errorWithoutMessage: RelayOutbound = { type: 'input:error', sessionId: 's', requestId: 'rq', reason: 'channel-unavailable' }

// @ts-expect-error - the reason set is closed; a free string would let each agent invent its own
export const errorWithFreeReason: RelayOutbound = { type: 'input:error', sessionId: 's', message: 'x', reason: 'something-else' }

// ── name ↔ literal bindings ────────────────────────────────────────────────────────────────────────
//
// One line per message, and the only thing here that survived L1's conversion window. The `Equals<>`
// net that proved the conversion compared union *contents*, and a union is a set — so which interface
// got which `type` literal was not part of the comparison at all. `AgentToBrowser` has seven members
// whose shape is identical apart from the literal, so a copy-paste that swaps two of them passed
// `Equals`, passed the routing check (which compares membership) and passed the payload check.
// Measured: the swap produced two errors here and zero from the nine `Equals` assertions.
//
// `scripts/__tests__/protocolMessageNames.test.mjs` asserts every message interface has a line here —
// a guard you can forget one entry of is a guard with 57-of-58 coverage, and the gap is invisible.
export const _AgentRegistered: AgentRegistered['type'] = 'agent:registered'
export const _AgentsList: AgentsList['type'] = 'agents:list'
export const _AgentsListed: AgentsListed['type'] = 'agents:listed'
export const _AppClearState: AppClearState['type'] = 'app:clear-state'
export const _AppClearStateDone: AppClearStateDone['type'] = 'app:clear-state-done'
export const _AppClearStateError: AppClearStateError['type'] = 'app:clear-state-error'
export const _AppInstallDone: AppInstallDone['type'] = 'app:install-done'
export const _AppInstallError: AppInstallError['type'] = 'app:install-error'
export const _AppInstallToAgent: AppInstallToAgent['type'] = 'app:install'
export const _AppInstallToRelay: AppInstallToRelay['type'] = 'app:install'
export const _AppLaunchDone: AppLaunchDone['type'] = 'app:launch-done'
export const _AppLaunchError: AppLaunchError['type'] = 'app:launch-error'
export const _AppLaunchToAgent: AppLaunchToAgent['type'] = 'app:launch'
export const _AppLaunchToRelay: AppLaunchToRelay['type'] = 'app:launch'
export const _ClipboardData: ClipboardData['type'] = 'clipboard:data'
export const _ClipboardError: ClipboardError['type'] = 'clipboard:error'
export const _NetworkSet: NetworkSet['type'] = 'network:set'
export const _NetworkState: NetworkState['type'] = 'network:state'
export const _NetworkError: NetworkError['type'] = 'network:error'

// `available` and `reason` travel together or not at all, and these two are what say so — the rule
// began as prose on a single interface, which admitted both of the frames below. An unavailable
// state with nothing to show a tester is a control that says it does not work and cannot say why.
// @ts-expect-error - an unavailable state must name a reason
export const _networkUnavailableNeedsReason: NetworkStatePayload = { offline: true, available: false }
// One line, deliberately: `@ts-expect-error` covers the line after it, and a declaration wrapped
// onto a continuation puts the error out of its reach — which reads as the assertion passing.
// @ts-expect-error - a steerable state must not carry one
export const _networkAvailableRefusesReason: NetworkStatePayload = { offline: true, available: true, reason: 'not-armed' }
// Only `state-unconfirmed` may leave the position out (#667) — every other reason knows where the device
// is. The positive case is here too, so this proves the member is reachable and not only that the
// others refuse it.
export const _networkUnobserved: NetworkStatePayload = { available: false, reason: 'state-unconfirmed' }
// @ts-expect-error - a reason that knows the position must give it
export const _networkUnobservedOnlyUnconfirmed: NetworkStatePayload = { available: false, reason: 'filter-unavailable' }
// @ts-expect-error - a steerable state always has a position
export const _networkSteerableNeedsPosition: NetworkStatePayload = { available: true }
export const _ClipboardRead: ClipboardRead['type'] = 'clipboard:read'
export const _ClipboardWrite: ClipboardWrite['type'] = 'clipboard:write'
export const _ClipboardWriteDone: ClipboardWriteDone['type'] = 'clipboard:write-done'
export const _DeviceBoot: DeviceBoot['type'] = 'device:boot'
export const _DeviceBootError: DeviceBootError['type'] = 'device:boot-error'
export const _DeviceBooting: DeviceBooting['type'] = 'device:booting'
export const _DeviceReady: DeviceReady['type'] = 'device:ready'
export const _DeviceShutdown: DeviceShutdown['type'] = 'device:shutdown'
export const _DeviceShutdownDone: DeviceShutdownDone['type'] = 'device:shutdown-done'
export const _DeviceShutdownError: DeviceShutdownError['type'] = 'device:shutdown-error'
export const _GenericError: GenericError['type'] = 'error'
export const _InputButton: InputButton['type'] = 'input:button'
export const _InputDone: InputDone['type'] = 'input:done'
export const _InputError: InputError['type'] = 'input:error'
export const _InputKey: InputKey['type'] = 'input:key'
export const _InputKeyboardToggle: InputKeyboardToggle['type'] = 'input:keyboard:toggle'
export const _InputPinchEnd: InputPinchEnd['type'] = 'input:pinch:end'
export const _InputPinchMove: InputPinchMove['type'] = 'input:pinch:move'
export const _InputPinchStart: InputPinchStart['type'] = 'input:pinch:start'
export const _InputRotate: InputRotate['type'] = 'input:rotate'
export const _InputPosture: InputPosture['type'] = 'input:posture'
export const _InputTouchEnd: InputTouchEnd['type'] = 'input:touch:end'
export const _InputTouchMove: InputTouchMove['type'] = 'input:touch:move'
export const _InputTouchStart: InputTouchStart['type'] = 'input:touch:start'
export const _InputType: InputType['type'] = 'input:type'
export const _InputTypeDone: InputTypeDone['type'] = 'input:type-done'
export const _InputTypeError: InputTypeError['type'] = 'input:type-error'
export const _KeyboardToggled: KeyboardToggled['type'] = 'keyboard:toggled'
export const _OpenUrl: OpenUrl['type'] = 'open-url'
export const _OpenUrlDone: OpenUrlDone['type'] = 'open-url:done'
export const _OpenUrlError: OpenUrlError['type'] = 'open-url:error'
export const _ScreenshotRequest: ScreenshotRequest['type'] = 'screenshot:request'
export const _SessionAgentAway: SessionAgentAway['type'] = 'session:agent-away'
export const _SessionChrome: SessionChrome['type'] = 'session:chrome'
export const _DevicePostures: DevicePostures['type'] = 'device:postures'
export const _SessionDeviceInfo: SessionDeviceInfo['type'] = 'session:deviceInfo'
export const _SessionEnd: SessionEnd['type'] = 'session:end'
export const _SessionJoined: SessionJoined['type'] = 'session:joined'
export const _SessionLeave: SessionLeave['type'] = 'session:leave'
export const _SessionRebound: SessionRebound['type'] = 'session:rebound'
export const _SessionStart: SessionStart['type'] = 'session:start'
export const _SessionTerminated: SessionTerminated['type'] = 'session:terminated'
export const _StreamRegistered: StreamRegistered['type'] = 'stream:registered'
export const _StreamRequestIdr: StreamRequestIdr['type'] = 'stream:request-idr'
export const _NetworkRequestState: NetworkRequestState['type'] = 'network:request-state'
export const _UiTreeRequest: UiTreeRequest['type'] = 'ui:tree:request'
export const _AgentRegister: AgentRegister['type'] = 'agent:register'
export const _AgentResourceReport: AgentResourceReport['type'] = 'agent:resources'
export const _ScreenshotDone: ScreenshotDone['type'] = 'screenshot:done'
export const _ScreenshotError: ScreenshotError['type'] = 'screenshot:error'
export const _StreamRegister: StreamRegister['type'] = 'stream:register'
export const _UiTreeResponse: UiTreeResponse['type'] = 'ui:tree:response'
export const _UiTreeError: UiTreeError['type'] = 'ui:tree:error'
export const _WatchStart: WatchStart['type'] = 'watch:start'
export const _WatchStop: WatchStop['type'] = 'watch:stop'
export const _WatchStarted: WatchStarted['type'] = 'watch:started'
export const _WatchRefused: WatchRefused['type'] = 'watch:refused'
export const _WatchHolderLeft: WatchHolderLeft['type'] = 'watch:holder-left'
export const _WatchEnded: WatchEnded['type'] = 'watch:ended'

// ── membership: what a browser may send, and what an agent produces, do not overlap ──────────────
//
// The relay's door closes a `browser`-role socket with 1008 for any agent-produced type, because the
// forwards it guards mostly resolve a session from the message and send to *that session's* browser
// with no check that the sender is that session's agent. So the two sets overlapping is not an
// untidiness — it is a message a browser can inject into a stranger's viewer.
//
// Stated as `Extract` rather than as a list, which is what lets it catch a widening without restating
// 63 literals. Measured before this existed: adding `DeviceBooting` to `BrowserToRelay` left
// `pnpm typecheck` at zero errors and all 294 static tests green.
//
// **Not blanket disjointness between directions.** `device:shutdown` is deliberately a member of both
// `RelayToAgent` and `BrowserToRelay`, identical in both; it is not agent-produced, so it is not here.
// And a *relay*-produced message added to `BrowserToRelay` is outside this claim — `route()` has no
// case for one. The forwarding half is `browserInboundRouting.test.mjs`, which asserts both that every
// forward is declared in `AgentToBrowser` and that no literal is in `BrowserToRelay` **and** forwarded.
// #557 asked for that against `AGENT_MSG_TYPE_LIST`, which no longer exists — #444 replaced it with
// `directionOf`, derived from the schema maps.
type AgentProduced = (AgentControlOutbound | StreamToRelay)['type']
type AssertTrue<T extends true> = T
type NoOverlap<A, B> = [Extract<A, B>] extends [never] ? true : false
export type _BrowserSendsNothingAgentProduced = AssertTrue<NoOverlap<BrowserToRelay['type'], AgentProduced>>
