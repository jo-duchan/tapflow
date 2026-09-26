import type { BrowserInbound } from '@tapflowio/protocol'

/**
 * What this client does with each message a browser socket can receive.
 *
 * The twin of `mcp-server`'s, and **deliberately a copy rather than a shared module.** The key set is what
 * must not be duplicated, and it is not: `satisfies Record<BrowserInbound['type'], Disposition>` takes it
 * from `@tapflowio/protocol`, so a message added to the wire breaks both files. The *values* genuinely
 * differ, and sharing them would flatten the difference into one sentence — this package has no shutdown at
 * all, and where `mcp-server`'s input-ack wrapper appends the session note this one deliberately does not,
 * because the message it wraps already carries it.
 *
 * A runtime module rather than a type, because `satisfies` needs a value. Nothing imports it; it exists to
 * be read by a person and checked by `scripts/__tests__/clientInboundDisposition.test.mjs`, which holds a
 * `does` entry to a real comparison or `case` label somewhere in this package's source and an `ignored`
 * entry to the absence of one.
 */
type Disposition =
  /** Read, and it does the one thing its name implies: settles the request it answers. The value is the
   *  method, which is the only part a reader cannot get from the literal. **No sentence** — a symmetric
   *  request/reply pair has nothing to say that its own name does not, and writing one anyway is how a
   *  table becomes something people skim. */
  | { settles: string }
  /** Read, and it does more than settle one request — or something a reader would get wrong. These are
   *  the entries worth prose, and there are few of them on purpose. */
  | { does: string }
  /** Deliberately not read. The reason is the value, because a reason nobody wrote down becomes an
   *  oversight the next time someone reads the file. */
  | { ignored: string }

export const INBOUND_DISPOSITION = {
  'agents:listed': { settles: 'listDevices' },
  'session:joined': { settles: 'joinSession' },
  'error': { does: 'settles `joinSession` as a refusal with the closed `reason`; an unaddressed one from an older relay settles nothing and is logged once as skew' },
  'session:agent-away': { does: 'records that the agent went away — suspends the optimistic input path' },
  'session:rebound': { does: 'records that the device binding is gone; settles an in-flight boot waiter (#583); a ui-tree query then fails now (#573)' },
  'session:terminated': { does: 'records the end, and rejects that session\'s waiters with the reason' },
  'device:ready': { settles: 'bootDevice' },
  'device:boot-error': { settles: 'bootDevice' },
  'app:install-done': { settles: 'installApp' },
  'app:install-error': { settles: 'installApp' },
  'app:launch-done': { settles: 'launchApp' },
  'app:launch-error': { settles: 'launchApp' },
  'app:clear-state-done': { settles: 'clearState' },
  'app:clear-state-error': { settles: 'clearState' },
  'open-url:done': { settles: 'openUrl' },
  'open-url:error': { settles: 'openUrl' },
  'input:done': { settles: 'awaitInputAck' },
  'input:error': { settles: 'awaitInputAck' },
  'input:type-done': { settles: 'typeText' },
  'input:type-error': { settles: 'typeText' },

  // ── deliberately not read ─────────────────────────────────────────────────────────────────────────

  'device:shutdown-done': {
    ignored: 'This package never shuts a device down. A flow leaves its session and the CLI exits; powering '
      + 'the device off is the operator\'s or `shutdown_device`\'s call, not a replay step. The step '
      + 'vocabulary is deliberately minimal and adding one would be a schema change.',
  },
  'device:shutdown-error': { ignored: 'Same as `device:shutdown-done` — nothing here sends the request.' },
  'device:booting': {
    ignored: 'Not "no consumer" — it is the only signal separating "the agent picked the boot up" from '
      + '"nothing happened" during `bootDevice`\'s wait. It is ignored because it settles nothing: the '
      + 'waiter is for the `device:ready` / `device:boot-error` pair, and a progress frame answers neither.',
  },
  'clipboard:data': {
    ignored: 'No clipboard step exists, and one could not be deterministic — the payload lands on the host '
      + 'OS clipboard, which is shared mutable state outside the flow.',
  },
  'clipboard:error': { ignored: 'Same as `clipboard:data` — nothing here sends a clipboard request.' },
  'clipboard:write-done': {
    ignored: 'Same as `clipboard:data` — no clipboard step exists, so a confirmation here answers nothing a flow '
      + 'asked for.',
  },
  'network:state': {
    ignored: 'No network step exists. A flow that took its own device offline would be asserting against a '
      + 'device it can no longer drive, and the step after it could not report why it failed.',
  },
  'network:error': { ignored: 'Same as `network:state` — nothing here sends a `network:set`.' },
  'keyboard:toggled': {
    ignored: 'Nothing here sends `input:keyboard:toggle`. `inputText` drives a paste handshake and does not '
      + 'depend on the on-screen keyboard\'s visibility.',
  },
  'device:postures': {
    ignored: 'Which postures a foldable offers, and which it is in. A replay engine does not fold '
      + 'the device: a flow that needs a posture would have to say so as a step, and none does.',
  },
  'session:chrome': {
    ignored: 'Bezel geometry and device model, for drawing a device frame around a video stream. A replay '
      + 'engine renders nothing, and selectors are resolved from the UI tree in normalized coordinates.',
  },
  'session:deviceInfo': {
    ignored: 'No consumer anywhere, which `@tapflowio/protocol` states for the whole repo: both agents send '
      + 'it, the relay caches and replays it, and nothing reads the result.',
  },
} satisfies Record<BrowserInbound['type'], Disposition>
