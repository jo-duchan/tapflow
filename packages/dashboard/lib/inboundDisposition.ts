import type { BrowserInbound } from '@tapflowio/protocol'

/**
 * What this package does with each message a browser socket can receive.
 *
 * The bug class this whole wire-contract program started from was **a reply arriving and nobody
 * answering** (#489, #485, #492, #457). L1–L3 made the declarations honest; a declared message with no
 * handler is still silent. Measured when this file was written: of the 28 messages then on the wire the
 * dashboard handled 22 and dropped 6 — and the three reasons those 6 were dropped for are
 * *indistinguishable in code*, because
 * "handled elsewhere", "deliberately ignored" and "nobody ever wrote it" all look like an absent branch.
 *
 * `satisfies Record<BrowserInbound['type'], …>` is what makes that a decision instead of an oversight:
 * a message added to the wire **breaks this file** until someone picks a category. There is no
 * derivation and therefore nothing to go stale.
 *
 * ### Why not derive the reachable subset and oblige only that
 *
 * Two independent reasons, both measured during design review, and both worth stating because the idea
 * is the obvious one:
 *
 *  - **`send()` is shared by three sockets.** `useRelay` is called by `DeviceViewer`, `useAgentSession`
 *    and `MacResources`, and each opens its own WebSocket. So "what the dashboard
 *    sends" is a package-level fact while a handler lives in one component — deriving one from the other
 *    obliges `DeviceViewer` to handle replies to requests it never issues.
 *  - **A reply does not go to whoever asked.** The relay forwards agent replies to
 *    `session.browserSocket` — whichever socket holds the session *now*. `mcp-server` speaks to the same
 *    relay, so a reply to its request lands on the dashboard once the dashboard joins. "We never send
 *    `input:type`, so its replies cannot arrive" is true per *session*, not per socket.
 *
 * Any browser socket can receive any of the 29. That is why every entry is present and `ignored` says
 * *why* rather than *cannot happen*.
 *
 * **Two siblings exist now** — `mcp-server/src/inboundDisposition.ts` and
 * `flow-runner/src/inboundDisposition.ts` (#544). They categorise as `settles` / `does` / `ignored` rather
 * than `at`, because each has one file rather than five, and their check holds an `ignored` entry to the
 * *absence* of a handler as well — the half this one does not have. The key set is the same and comes from
 * the same place, so a message added to the wire breaks all three.
 */
type Disposition =
  /** Handled. The value names the files, and `scripts/__tests__/inboundDisposition.test.mjs` checks each
   *  one actually tests this literal — the compiler owns the key set, so that parser cannot under-cover. */
  | { at: string }
  /** Deliberately not handled. The reason is the value, because a reason nobody wrote down becomes an
   *  oversight the next time someone reads the file. */
  | { ignored: string }

export const INBOUND_DISPOSITION = {
  'agents:listed': { at: 'useAgentSession, MacResources' },
  'app:install-done': { at: 'DeviceViewer' },
  'app:install-error': { at: 'DeviceViewer' },
  'app:launch-done': { at: 'DeviceViewer' },
  'app:launch-error': { at: 'DeviceViewer' },
  'clipboard:data': { at: 'DeviceViewer, useClipboardBridge' },
  'clipboard:error': { at: 'DeviceViewer, useClipboardBridge' },
  'clipboard:write-done': { at: 'DeviceViewer, useClipboardBridge' },
  // The viewer is the only consumer that acts on these — it owns the control. Both were `ignored`
  // while the protocol was ahead of the UI (#607); the control landed and this is what closed that gap.
  //
  // `DeviceViewer` routes both into one handler because they answer the same request. They are not the
  // same answer: a `network:state` says where the device is, and a `network:error` says the request
  // never reached one — so it clears the wait and moves nothing.
  'network:state': { at: 'DeviceViewer, useNetworkControl' },
  'network:error': { at: 'DeviceViewer, useNetworkControl' },
  'device:boot-error': { at: 'DeviceViewer' },
  'device:booting': { at: 'DeviceViewer' },
  'device:ready': { at: 'DeviceViewer' },
  // `DeviceViewer` joined this pair with #628: a reboot is a `device:shutdown` followed by a
  // `device:boot`, because `device:boot` alone no-ops on a running device. Its shutdown is the only
  // **correlated** one this app sends — `useAgentSession`'s three fire on the way out of a view and
  // are deliberately id-less — so the viewer compares before it acts.
  'device:shutdown-done': { at: 'DeviceViewer' },
  // The relay's half of the pair (#542), so it reaches whichever socket asked. `useAgentSession` is not
  // among them and never was: it only ever sends `agents:list` and `device:shutdown`, never
  // `session:start`, so it does not become the session's `browserSocket` — and it has no branch for
  // this, which is right, because its three senders fire on the way out of a view and nothing there
  // waits. The name below does compare `.type` against this literal, which is what `at` answers.
  'device:shutdown-error': { at: 'DeviceViewer' },
  // **`useAgentSession`'s branch cannot fire, and it is still named here.** L5d measured it: all five
  // producers are `sendTo(ws, …)` to the socket that sent `session:start`, and that hook's socket only ever
  // sends `agents:list` and `device:shutdown`. So relay failures do **not** surface in the device list, which
  // naming two files here implies.
  //
  // The name stays because `at` answers "which files compare `.type` against this", and the reverse-direction
  // check derives exactly that — dropping the name made the table stale the other way. A first attempt did
  // drop it and that check said so. Reachability is a different question from handling, and this comment is
  // where it belongs; the branch is a correct handler for a message that does not arrive, so whoever removes
  // it can, and this says why.
  'error': { at: 'DeviceViewer, useAgentSession' },
  'input:error': { at: 'DeviceViewer' },
  'keyboard:toggled': { at: 'DeviceViewer' },
  'open-url:done': { at: 'DeviceViewer' },
  'open-url:error': { at: 'DeviceViewer' },
  'session:agent-away': { at: 'DeviceViewer' },
  'device:postures': { at: 'DeviceViewer' },
  'session:chrome': { at: 'DeviceViewer' },
  // Same as `error` above: `useAgentSession`'s branch cannot fire, and is named for the same reason.
  'session:joined': { at: 'DeviceViewer, useAgentSession' },
  'session:rebound': { at: 'DeviceViewer' },
  'session:terminated': { at: 'DeviceViewer' },

  // ── deliberately not handled ──────────────────────────────────────────────────────────────────────

  'input:done': {
    ignored: 'A success carries no state worth keeping. A latched "input unavailable" line was designed '
      + 'and discarded because nothing announces that input works again, the acks are unordered, and an '
      + 'ack does not say which channel answered — the toast lifetime carries that state instead. '
      + 'dashboard/AGENTS.md has the three reasons in full.',
  },
  'input:type-done': {
    ignored: 'Nothing here sends `input:type` — it is an MCP and flow-runner path. If a reply arrives '
      + 'anyway (the relay routes to whoever holds the session), there is no pending typed text to '
      + 'settle, so there is nothing to do with a success.',
  },
  'input:type-error': {
    ignored: 'Same path as `input:type-done`: no `input:type` is sent from here, so a failure belongs to '
      + 'a caller that is not this tab. Reporting it would attribute someone else\'s failed keystrokes '
      + 'to the tester looking at the screen.',
  },
  'app:clear-state-done': {
    ignored: 'The dashboard offers no clear-state action — resets go through `device:boot` with '
      + '`resetMode`. Nothing is waiting on this.',
  },
  'app:clear-state-error': {
    ignored: 'Same as `app:clear-state-done`. A failure for a request this tab did not make has no place '
      + 'to be shown.',
  },
  'session:deviceInfo': {
    ignored: 'No consumer, here or anywhere. Both agents send it and the relay caches and replays it on '
      + 'join, and nothing reads the result — the viewer takes device name and OS from `agents:listed` '
      + 'instead. Kept on the wire because third-party agents send it; the field to display it is a '
      + 'feature nobody has asked for, not a handler someone forgot.',
  },
  // The page that watches an AI client's session sends `watch:start` and reads these. Until it exists no
  // socket in this dashboard watches, so none of the four can arrive.
  'watch:started': { ignored: 'Answers `watch:start`, which no page sends yet.' },
  'watch:refused': { ignored: 'Answers `watch:start`, which no page sends yet.' },
  'watch:holder-left': { ignored: 'Sent only to a watching socket, and no page watches yet.' },
  'watch:ended': { ignored: 'Sent only to a watching socket, and no page watches yet.' },
} satisfies Record<BrowserInbound['type'], Disposition>
