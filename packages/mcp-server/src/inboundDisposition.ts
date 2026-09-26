import type { BrowserInbound } from '@tapflowio/protocol'

/**
 * What this client does with each message a browser socket can receive.
 *
 * The dashboard has had one of these since the wire-contract work found six messages being dropped there
 * with three different reasons that looked identical in code — "handled elsewhere", "deliberately ignored"
 * and "nobody wrote it" are all an absent branch. Both other browser-role clients had the same gap and no
 * such table; #544 is that, and #512's session-lifecycle work is what it would have prevented.
 *
 * `satisfies Record<BrowserInbound['type'], Disposition>` is what makes it a decision rather than an
 * oversight: **a message added to the wire breaks this file** until someone picks a category. The key set is
 * the compiler's, so there is nothing here to go stale.
 *
 * The value is deliberately *not* the dashboard's `at`. That one names which of five components handles the
 * message, a question worth asking there and constant here — every inbound comparison in this package is in
 * `client.ts` (measured: `tools.ts` and `index.ts` contain none).
 *
 * **And most entries get no sentence.** A first version wrote one for all 29, which produced twenty lines
 * saying `settles \`installApp\`` under the key `app:install-done` — the key restated, and the kind of
 * filler that teaches a reader to skim the six entries that do carry something. A symmetric request/reply
 * pair gets `settles` and the method name; prose is reserved for what a reader would otherwise get wrong.
 *
 * `scripts/__tests__/clientInboundDisposition.test.mjs` holds both directions: a `settles` or `does` entry
 * must have a real comparison or `case` label in the package's source, and an `ignored` entry must have
 * none. The second half is the one the dashboard's check lacks — there, a message quietly starting to be
 * handled while the table still says `ignored` is invisible.
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
  'session:joined': { settles: 'connectDevice' },
  // Not a general escape hatch: as of L5d every producer of this message answers one specific
  // `session:start`, and it carries the closed `reason` that says what the caller should do next.
  'error': { does: 'settles `connectDevice` as a refusal with `reason` as well as the prose; an unaddressed one from an older relay settles nothing and is logged once as skew' },
  'session:agent-away': { does: 'records that the agent went away — suspends the optimistic input path' },
  'session:rebound': { does: 'records that the device binding is gone until something boots again; settles an in-flight boot waiter (#583)' },
  'session:terminated': { does: 'records the end, and rejects that session\'s waiters with the reason' },
  'device:ready': { settles: 'bootDevice' },
  'device:boot-error': { settles: 'bootDevice' },
  'device:shutdown-done': { settles: 'shutdownDevice' },
  'device:shutdown-error': { settles: 'shutdownDevice' },
  'app:install-done': { settles: 'installApp' },
  'app:install-error': { settles: 'installApp' },
  'app:launch-done': { settles: 'launchApp' },
  'app:launch-error': { settles: 'launchApp' },
  'app:clear-state-done': { settles: 'clearState' },
  'app:clear-state-error': { settles: 'clearState' },
  'open-url:done': { settles: 'openUrl' },
  'open-url:error': { settles: 'openUrl' },
  'input:done': { does: 'settles `awaitInputAck`; a correlated one also records that this session acks' },
  'input:error': { settles: 'awaitInputAck' },
  'input:type-done': { settles: 'typeText' },
  'input:type-error': { settles: 'typeText' },

  // ── deliberately not read ─────────────────────────────────────────────────────────────────────────

  'device:booting': {
    ignored: 'Not "no consumer" — it is the only signal separating "the agent picked the boot up" from '
      + '"nothing happened" during `bootDevice`\'s wait. It is ignored because it settles nothing: the '
      + 'waiter is for the `device:ready` / `device:boot-error` pair, and a progress frame answers neither. '
      + 'A boot the agent silently drops or supersedes is #526, and reading this would not fix it: both agents '
      + 'send this *before* every supersede check, so a superseded boot has already sent one and the winner '
      + 'sends a second — and it carries no `requestId` by design, so neither can be attributed. Only the '
      + 'dropped path returns before the send, which makes absence all you get there.',
  },
  'clipboard:data': {
    ignored: 'There is no clipboard tool here. The bridge is a viewer feature: the payload lands on the '
      + 'reader\'s host OS clipboard, which an MCP process does not have in any useful sense.',
  },
  'clipboard:error': { ignored: 'Same as `clipboard:data` — nothing in this package sends a clipboard request.' },
  'clipboard:write-done': {
    ignored: 'Same as `clipboard:data` — this package sends no `clipboard:write`, so a confirmation here answers '
      + 'nothing it asked for.',
  },
  'network:state': {
    ignored: 'No network tool here. Taking a device off the network is a manual-testing control a person '
      + 'arms while watching the screen; an agent driving a flow has no use for a device it cannot reach.',
  },
  'network:error': { ignored: 'Same as `network:state` — nothing in this package sends a `network:set`.' },
  'keyboard:toggled': {
    ignored: 'Nothing here sends `input:keyboard:toggle`. It reports the on-screen keyboard\'s visibility, '
      + 'which is a viewer concern — this client has no surface to reflect it on.',
  },
  'device:postures': {
    ignored: 'Which postures a foldable offers, and which it is in. No tool changes a device\'s '
      + 'posture, so there is nothing here that would act on the list.',
  },
  'session:chrome': {
    ignored: 'Bezel geometry and device model, for drawing a device frame around a video stream. This '
      + 'client renders nothing; `list_devices` already carries the name and platform a model needs.',
  },
  'session:deviceInfo': {
    ignored: 'No consumer anywhere, which `@tapflowio/protocol` states for the whole repo: both agents send '
      + 'it, the relay caches and replays it, and nothing reads the result. Kept on the wire for '
      + 'third-party agents.',
  },
} satisfies Record<BrowserInbound['type'], Disposition>
