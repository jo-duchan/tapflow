import type {
  AndroidButton, AgentResources, ClipboardErrorPayload, FormFactor, Point, UIElement, UIElementFrame, UIElementRole,
} from '@tapflowio/protocol'

// These three are **wire** payload types, so `@tapflowio/protocol` owns them — it is the leaf both
// consumers that read them can reach, and this package is not one of them (neither `dashboard` nor
// `mcp-server` depends on `agent-core`). Re-exported under the same names so agent code and
// third-party agents built on `AgentRegistry.register()` are unaffected.
//
// `export type`, not a bare `export { … } from`: the latter is a real runtime import of protocol's
// `dist`, which would drag this package into the source-resolution rule in the root AGENTS.md.
export type { AndroidButton, AgentResources, ClipboardErrorPayload, Point, UIElement, UIElementFrame, UIElementRole }

export type Platform = string

export type DeviceStatus = 'booted' | 'shutdown' | 'unknown'

export interface Device {
  id: string
  name: string
  platform: Platform
  status: DeviceStatus
  typeId?: string     // platform device type identifier (iOS: com.apple.CoreSimulator.SimDeviceType.*)
  osVersion?: string  // e.g. "iOS 18.3"
  /** Phone, tablet or foldable, when the platform can say; reported in `agent:register`. */
  formFactor?: FormFactor
}



// Android physical button descriptor sent via session:chrome payload

// ── Agent capabilities ──────────────────────────────────────────────────────
// Advertised in `agent:register` so a viewer can tell what the agent on the other
// end actually implements. An agent that predates a capability simply does not list
// it, so `undefined`/absent means "not supported" — no version parsing, and nothing
// has to be inferred from a timeout (guessing that way once produced a double paste
// on a merely-slow agent, and a lost keystroke on an old one).
// The dashboard cannot import from here (it has no agent-core dependency), so this stays a
// plain string list on the wire rather than a helper nobody on the reading side can call.
// `full-reset`: the agent honours `device:boot`'s `resetMode: 'full-erase'` by wiping the device
// before booting it. Both platforms do as of #447 — iOS with `simctl erase`, Android with
// `-wipe-data` — and an agent that does not says so by not listing it rather than by being named in
// a platform check on the viewer.
//
// `network-control`: the agent implements `network:set` (#607). **This one claims less than the
// other two do.** They are settled facts about the agent's own code; whether the network mechanism
// actually takes is per device and per app — an injection that did not land, an emulator image too
// old for the command — and this string is sent once at `agent:register`, before any device is
// booted. So it means "this agent has the code", and `network:state.available` carries the rest.
// Reading it as a promise that the toggle will work is the mistake this comment exists to prevent.
//
// `launch-options`: the agent applies `app:launch`'s `arguments` and `env`, or refuses what its platform cannot
// take (#1047). An agent without it ignores both fields, so the relay refuses a launch carrying them rather than
// forwarding it to be silently dropped.
//
// `launch-env`: of those, the agent also applies `env` (iOS; Android has no channel for it and refuses). The relay
// reads it to leave a per-app env default out of a launch on a device that cannot take it, rather than naming a
// platform — a caller's own `env` is still the agent's to refuse.
//
// `touch-cancel`: the agent takes `input:touch:cancel` as a cancel — the app sees its touch cancelled, and the
// `input:touch:end` a leaving client sends after it injects nothing (#1115). The relay reads it to leave that end out
// of what a watcher is shown; an agent without it completes the gesture with the end, which is a tap worth showing.
// It says the agent takes the message, not that every device of it can cancel: where one can only lift with an up,
// the cancel itself is a tap, which the watcher then misses.
//
// **The vocabulary, not a declaration (#700).** This is every capability any agent can name. What one
// agent *implements* is its own list, typed against this — an agent that announced the whole set
// would start claiming a feature the moment another platform gained it. Same split as
// `NetworkControlCapability`: the shape lives here, and an agent opts in.
//
// A runtime value rather than only a union so the relay, which can import from here, checks its
// gates through `hasCapability` and a rename fails to compile there. The dashboard still cannot, and
// `scripts/__tests__/agentCapabilityConsumers.test.mjs` holds its literals against this array.
export const KNOWN_AGENT_CAPABILITIES = ['clipboard', 'full-reset', 'network-control', 'build-download', 'launch-options', 'launch-env', 'touch-cancel'] as const
export type AgentCapability = (typeof KNOWN_AGENT_CAPABILITIES)[number]

export function isAgentCapability(s: string): s is AgentCapability {
  return (KNOWN_AGENT_CAPABILITIES as readonly string[]).includes(s)
}

/**
 * Does this announced list include `cap`? Typed on the second argument only: the list stays
 * `string[]` because a relay is a conduit, and a capability it does not know must still reach the
 * viewer that does. Narrowing it at registration would make an older relay strip what a newer agent
 * and dashboard both understand.
 */
export function hasCapability(caps: readonly string[] | undefined, cap: AgentCapability): boolean {
  return caps?.includes(cap) ?? false
}


// ── Clipboard bridge shared contract ────────────────────────────────────────
// Both agents implement the same protocol, so the limits and the sentinel vocabulary
// live here rather than being duplicated (and drifting) per package.

/** Payload ceiling in UTF-8 bytes, both directions. Clipboard JSON shares the socket
 *  with video, so an unbounded payload would stall the stream on backpressure. */
export const MAX_CLIPBOARD_BYTES = 1024 * 1024

export const clipboardByteLength = (text: string): number => Buffer.byteLength(text, 'utf8')

/** Marker an agent parks on the device clipboard while it waits for a copy to land.
 *  Recognisable on purpose: a sentinel must never be handed back as the user's text. */
export const CLIPBOARD_SENTINEL_PREFIX = '​tapflow-clipboard-'

export const isClipboardSentinel = (value: string): boolean =>
  value.startsWith(CLIPBOARD_SENTINEL_PREFIX)

// ── Clipboard timing ────────────────────────────────────────────────────────
// Shared so the two agents cannot drift, and so the browser can DERIVE its own budget from
// the agent's worst case rather than happening to pick the same number. They were equal by
// coincidence once, and that hid a defect where the browser gave up at the exact moment the
// agent was about to answer.

/** Watch the device clipboard this long for an injected chord to take effect. */
export const CLIPBOARD_COPY_DEADLINE_MS = 2_000
/** Confirm a write became visible on the device within this. */
export const CLIPBOARD_WRITE_DEADLINE_MS = 1_000
/** Bound on confirming the post-failure restore. It is cleanup, not part of answering: the
 *  agent replies from the `catch` and restores in the `finally` that follows, so this window
 *  sits OUTSIDE the caller's round trip and is deliberately absent from the worst case below.
 *  The queue is still held for its duration, which is what keeps the next operation from
 *  reading a sentinel. */
export const CLIPBOARD_RESTORE_DEADLINE_MS = 500
/** Floor between confirm reads — never busy-spin on a fast backend. */
export const CLIPBOARD_POLL_MS = 20
/** Slowest observed `simctl pbpaste`/`pbcopy` under load; the read path makes several calls. */
export const CLIPBOARD_DEVICE_CALL_MS = 300

/** How long an agent should be expected to take to ANSWER a clipboard read — the slow path being
 *  the one that produces the useful message ("did not copy anything — is something selected?").
 *  The browser waits at least this long before giving up with a generic message of its own.
 *
 *  Two deadline windows are inside the answer: confirm the sentinel applied, then watch for the
 *  copy. The restore window is not — the reply goes out before it starts.
 *
 *  Five device calls, not four. Each windowed loop checks its deadline AFTER the call returns,
 *  so a window can overrun by one call; counting the loops' overruns plus the fixed calls
 *  (read the original, ready the guest for the chord, write the sentinel) gives five.
 *  Undercounting these is what previously left the browser giving up first on this very path.
 *
 *  NOT a hard upper bound, and it cannot be one. Every device call carries its own multi-second
 *  timeout (5s for a simctl pasteboard call, an emulator gRPC deadline, an adb keyevent), so a
 *  genuinely wedged device can take far longer than this. `CLIPBOARD_DEVICE_CALL_MS` is an
 *  observed-under-load figure, not a ceiling. What this budget buys is that the *normal* slow
 *  path — a real device that simply had nothing selected — answers before the browser stops
 *  listening. A hung device loses the specific message; that is the correct trade, since at that
 *  point the message is not the user's problem. */
export const CLIPBOARD_AGENT_WORST_MS =
  CLIPBOARD_WRITE_DEADLINE_MS + CLIPBOARD_COPY_DEADLINE_MS + 5 * CLIPBOARD_DEVICE_CALL_MS

/** Why an agent gave up on a `device:boot` it had already started.
 *
 *  **The three ways a boot ends without running, and they are answers rather than silences.** Every
 *  checkpoint in `handleDeviceBoot` used to `return` with nothing sent in either direction, so the caller
 *  learned about it by waiting out its own deadline — 30s for `mcp-server`, 120s for `flow-runner`, and a
 *  spinner that never resolves for a viewer (#526).
 *
 *  Shared rather than declared per platform because the *user-visible* answer must not differ by platform.
 *  That is the class of defect the invariant table in this slice's plan exists to catch: one platform
 *  fixed, the other not, found five separate times on the clipboard bridge. */
export type BootAbandonReason = 'superseded' | 'shut-down' | 'relay-lost'

/** What to tell the caller, given the reason.
 *
 *  Prose, not a `reason` field on the wire. The consumers that read this — a model deciding whether to
 *  retry, a tester reading a toast — need a sentence; the one consumer that branches (the dashboard,
 *  which suppresses the boot it replaced itself) branches on the correlator it already holds. A machine
 *  field nobody reads is what #492's rule is against, and it is cheap to add later if a consumer needs it.
 *
 *  Each string says what happened *and* what to do about it, because the two clients surface it as the
 *  whole failure — there is no second line for advice. */
export function bootAbandonMessage(reason: BootAbandonReason): string {
  switch (reason) {
    case 'superseded':
      return 'Boot superseded by a newer boot for this session — the newer one is what to wait on.'
    case 'shut-down':
      return 'Boot abandoned: the device was shut down while it was starting. Boot it again to use it.'
    case 'relay-lost':
      return 'Boot abandoned: the agent lost its connection to the relay while the device was starting.'
  }
}

/** The answer for a boot that names a session this agent holds no device state for.
 *
 *  Separate from the three above because it is not an abandonment — nothing was ever started. It is the
 *  boot equivalent of `ackInput`'s no-session reply (#489), and it is reachable for the same reason: the
 *  re-seeding from `agent:registered` carries one entry per *device*, while a device can now sit behind
 *  two sessions. */
export const BOOT_NO_SESSION_STATE =
  'No device state for this session on the agent — re-join the session before booting.'

/** The same situation on the shutdown path (#455). Nothing was attempted, so the device is exactly as it
 *  was — which is the one agent-side shutdown failure that may say so. */
export const SHUTDOWN_NO_SESSION_STATE =
  'No device state for this session on the agent, so no shutdown was attempted — re-join the session first.'


// ── Audio frames ────────────────────────────────────────────────────────────
//
// **Data types, and they live here rather than behind a capability interface.** They arrived with
// `AudioStreamCapability`, which declared `audioFormat()` / `audioStream()` for consumers to
// feature-detect — and nothing ever implemented it, detected it, or gave audio an `AgentCapability`
// string, because audio is not gated: the dashboard plays whatever frames arrive. The interface and
// its guard are gone; these are not, because `ios-agent`'s `AudioCaptureStreamer` speaks them and
// two packages needing the same shape is exactly what this file is for.

export type AudioSampleFormat = 's16' | 'u8'
export type AudioChannels = 'mono' | 'stereo'

export interface AudioFormat {
  sampleRate: number          // e.g. 44100
  channels: AudioChannels
  sampleFormat: AudioSampleFormat
}

export interface AudioFrame {
  payload: Buffer             // raw PCM samples in the stream's AudioFormat (no codec)
  timestamp: number           // capture timestamp, epoch microseconds — for loose A/V sync
}
