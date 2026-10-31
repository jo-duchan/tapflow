---
type: rules
topics: [relay, websocket, server]
status: living
---

# relay — AGENTS.md

> Common rules: [AGENTS.md](../../AGENTS.md) | Full index: [INDEX.md](../../INDEX.md)

---

## WHAT

WebSocket relay server + dashboard serving: handles NAT traversal, session routing, and JWT auth, while also serving the dashboard static files from `public/` over HTTP.
A single process on a single configurable port (default: 4000) handles both WebSocket connections and HTTP static serving. With `tls` configured it terminates HTTPS + WSS on that same port (LAN secure context, required for WebCodecs hardware decode) — full setup in [`docs/reference/configuration.md`](../../docs/reference/configuration.md). Given a `tunnelPort` it also listens on a loopback-only **tunnel port**: the same handler, `WebSocketServer` and TLS material, but nothing arriving there counts as local. The CLI passes one whenever a tunnel is configured (default 4001, `TAPFLOW_TUNNEL_PORT`); `server.ts` passes only what `local.tunnelPort` names, because that entry point starts no tunnel.

## Domain Structure — apps / builds separation (migration 004+)

`apps` and `builds` are separate entities.

- **apps**: product-level app identity. Its bundle IDs live in `app_bundle_ids` (migration 020, #1086), one row per (app, platform), so an app can have a different ID on iOS and Android. Two rules the table does not hold are kept in `lib/appBundleIds.ts`: **an ID belongs to one app whatever the platform** (every ownership lookup ignores the platform; `POST /apps` refuses a taken ID with 409) and **an app has at most one ID per platform** (a different ID for a platform the app already has goes to that ID's own app, so a build flavor stays separate). `platform` is `ios` | `android` | `both`, widened when a build or ID for the other platform arrives. `__unknown__` collects builds whose ID could not be read and never takes part in a create or a merge. `POST /apps/:id/merge` moves one platform's ID and builds into another app and deletes the source when it has nothing left, and `POST /apps/:id/split` moves them into a new app, the way back (the source must keep its other platform). The rules for the side that leaves are one function, `cannotLeave`, shared by both; everything else a build has hangs off `build_id` and follows it, and only `builds.app_id` points at `apps`.
- **builds**: build artifacts. `app_id FK → apps.id`. Contains `version_name`, `build_number`, `file_path`.
  `version_name` / `build_number` are what the build file says and never change after upload; a person's values go
  in `version_name_override` / `build_number_override` (migration 022, #1084). **Read builds through the
  `builds_effective` view**, which is the one place the value in use is made (`binary_*` keeps the file's).
  `__tests__/buildsEffectiveReads.test.ts` finds a query that reads them straight from `builds` — a floor; the fence
  is `buildOverride.test.ts`. Write rules (trim, empty = none, 100 characters, an override equal to the file's value
  is none) are `lib/buildVersion.ts`, shared by the upload and the edit. The label (`version_label`) is not the app's
  name when the file has none: that is the file name.
- An upload's bundle ID finds its app (`routeUploadToApp` / `upsertApp`) → re-uploading the same app adds only a new `builds` row. `app_id` adds the ID to the named app only when that app has none on the platform and no other app holds it; an `app_id` naming no app (merged away) is routed by the ID. A build's `platform` is its file type, never the caller's field.

Build file storage path: `uploads/builds/`.

## Schema conventions

What the schema already does, written down so the next table follows it rather than whatever the last migration
happened to show. Each cites where it holds.

1. **A fact is stored once.** A value a person may set beside one tapflow derives goes in its own NULL-able column,
   NULL meaning "not set", and the value in use is made in SQL with `COALESCE`: `users.display_name` (the email's
   name part otherwise), `builds.*_override`. When several queries read it, one VIEW makes it (`builds_effective`),
   so no query can forget. `device_prefs.display_name` falls back in the dashboard instead, because devices are not
   in the database. NULL is the only "not set": `users.display_name` keeps that in code (`api/profile.ts` stores
   `trim() || null`); from 022 a CHECK holds it in the schema too (`trim(x) <> ''`).
2. **Many of a thing to one is a table, not columns**: `app_bundle_ids` (an app's ID per platform),
   `flow_run_video_chunks` (a video's chunks). `flow_run_videos` is a table of its own for timing, not count: its
   chunks arrive before the flow row exists.
3. **A closed set of values is a CHECK**: `status_label`, `platform`, a skipped flow's reason only with a skip
   (017).
4. **A rule the table cannot hold lives in one `lib/` function with tests**: `lib/appBundleIds.ts` (an ID belongs
   to one app whatever the platform), `lib/buildVersion.ts`.
5. **Migrations are numbered and only added.** A table another references is never rebuilt — inside the migration
   transaction `PRAGMA foreign_keys = OFF` does nothing, so dropping it fails (020). One nothing references may be,
   inside the transaction (017). 007 rebuilt `apps`, which `builds` references, under that same no-op pragma: it is
   the case 020 warns about, not a precedent. A view references nothing and is dropped and recreated when its table
   gains a column. Dropping a column is a decision of its own. A column nothing reads: `builds.label` (the upload
   still writes it).

iOS build format: `.app.zip` **or** `.tar.gz`/`.tgz` (EAS `eas build` simulator artifacts). `.ipa` uploads return 400. `.tar.gz` is stored natively (no re-zip) so the `.app`'s exec bits / symlinks survive to install time; `tar` extraction happens on the macOS agent.
- Auto-extracts `CFBundleIdentifier`, `CFBundleShortVersionString`, `CFBundleVersion`, `CFBundleDisplayName`/`CFBundleName` from the top-level `*.app/Info.plist` (zip: `unzip -p`; tar: `tar -xzOf`).
- Validates simulator slices via `lipo -info`. **Skipped in Linux environments (lipo not available) — errors surface at install time instead**.
- `.tar.gz` uploads are validated before storage (`validateTarGz`): rejects path traversal (`..`/absolute), symlink/hardlink entries, corrupt gzip, and gzip bombs (`TAPFLOW_MAX_UNPACKED_BYTES`, default upload cap ×4). `tar` resolves PAX/GNU long names so header parsing can't be bypassed.

## HOW

- The agent connects to the relay via outbound WebSocket first (the key to NAT traversal).
- **Auth boundary**: connections from `localhost` **on the relay port** are unauthenticated; every other connection must authenticate — browsers by JWT cookie or a PAT with the `view` scope, agents by a PAT with the `agent` scope whose owner is currently an Admin (`Authorization: Bearer`).
  **Every credential is re-read from the database, at the handshake and for as long as the socket is open.** `getAuth` checks the users row on every call, which is the one place every cookie path passes; a remote socket's principal (cookie user + JWT `exp`, or PAT id) is kept in a `WeakMap` and re-judged by `revalidatePrincipal` on the heartbeat and from `onAuthChanged()`, which the team, token and invitation handlers call after their write. A new handler whose write can take access away gets that hook too; the heartbeat still catches it within 30 s if it does not. Host-only doors (`auth/init`, `auth/status`, `/api/v1/logs`) share `resolveRequestClient` with the same trusted-proxy list as the socket path. **Loopback on the tunnel port is not local.** A tunnel client (rathole, `tailscale serve`) connects from loopback on someone else's behalf, and rathole adds no header, so the listener is the only fact that tells it apart from `tapflow start`'s own agent. `resolveClientAddress` takes a required `viaTunnel` for that, and requests are marked by the tunnel server before anything reads them. The role (browser / agent / stream) is decided in `classifyConnection` (`lib/connectionAuth.ts`); a `browser`-role socket that sends an agent-only message (`directionOf` from `@tapflowio/protocol/validate`, which counts `stream:register` as its own direction) is closed with 1008, and so is an `agent`/`stream`-role socket on a token without `view` that sends a browser-direction one (agents' own sends are `AgentToRelay | AgentToBrowser`, none browser-direction). That set used to be `AGENT_MSG_TYPES`, a hand-copied array of 29 literals held against the protocol by two type assertions; it is derived now, and the derived set was verified member for member against the array it replaced.

  **The role and direction are settled before the shape is, and the order is load-bearing.** A malformed frame is dropped, but an agent-only type a browser spoofed *badly* must still close the socket — gating after shape validation lets such a spoofer keep its connection. The direction is a fact about the `type` alone, which is known even when the payload is not. A failed handshake is the one exception: it confers no role, so an agent whose `agent:register` does not parse gets its frame dropped rather than a `Forbidden` close, and its next attempt still introduces it.
- JSON messages and binary frames share the same WebSocket connection, branched by the `isBinary` flag.
- Control message protocol: `input:touch:*`, `input:pinch:*`, `input:button`, `input:key`, `input:type`, `input:rotate`, `input:posture`, `input:keyboard:toggle`, `device:boot`, `device:lease`, `device:shutdown`, `session:start`, `session:leave`, `session:end`, `session:activity`, `clipboard:read`, `clipboard:write`, `network:set`, `watch:start`, `watch:stop`, `agents:list` — the authority is `BrowserToRelay`, not this line.
- **The message shapes live in [`@tapflowio/protocol`](../protocol/AGENTS.md), not here.** Every message the relay *originates* goes through `sendTo(socket, msg: RelayOutbound)`, so adding one means adding it to that union first — the compiler will not let you do it in the other order. **Inbound frames are parsed into a discriminated union at the door** (`parseInbound`), not cast — see the header of `protocol/src/validate/`. Which frame gets forwarded differs by direction and is checked by `scripts/__tests__/browserInboundRouting.test.mjs`:

  - **agent → browser: the original frame (`raw`).** `z.object` strips undeclared keys, so forwarding the parse product would delete a field a newer agent added — the one direction where the sender is the more recently updated side.
  - **browser → agent: the parse product (`msg`).** Here the stripping is the point: a key a viewer appended from devtools is gone before any agent sees it.

  **A refused browser request is answered, not just dropped.** The envelope is judged separately from
  the payload, so a frame whose `sessionId` and `requestId` are good carries everything a reply needs —
  and `refuseMalformed` sends the error type that request's own waiter reads, with `reason: 'malformed'`
  on the input pair. Without it this door would have converted an answered failure into silence: a
  malformed `open-url` used to reach the agent, whose guard answered, and `IOSAgent.ts` names this
  validation as what takes that over. The cost is worst on the inputs, because `awaitInputAck` reports
  silence from a never-acked session as **success** (#457). The thirteen answerable requests,
  `ANSWERABLE` in the protocol and the replies in `refuseMalformed` are held to one derived set by
  `scripts/__tests__/correlatedRequestsGated.test.mjs`.

  Agent payloads are **deliberately not validated**, and the reason is not a deferral. `AgentRegister.platform` is `string`, open so a third-party platform can register through `AgentRegistry.register()` (OCP), while `ChromePayload` is a closed two-member union — so a platform this repo promises to support has no valid `session:chrome` variant, and refusing one would cost it bezel and buttons for the life of the session. The six messages the relay *consumes* (`agent:register`, `agent:resources`, the screenshot and ui-tree replies) are validated, with a `.default()` for every field the relay used to read through a `??`.
- **Clipboard bridge** (`clipboard:*`): browser→agent `clipboard:read` (`payload.press`: `'copy' | 'cut'` presses that chord on the device first) and `clipboard:write` (`payload.text`, `payload.pasteAfter`); agent→browser `clipboard:data` / `clipboard:write-done` / `clipboard:error`, correlated by `requestId`. Unlike the other agent→browser replies these are **bound to the session's own `agentSocket`** — their payload lands on the viewer's host OS clipboard, so a second agent must not be able to address someone else's session. An undeliverable request answers `clipboard:error` immediately rather than letting the caller's deadline expire. Agents advertise `capabilities: ['clipboard']` in `agent:register`; the relay echoes them on `session:joined` so a viewer can tell a capable agent from one that predates the feature instead of inferring it from silence.
- **An input the relay cannot dispatch is answered here, with a reason.** The four terminal frames get an
  `input:error` and `input:type` gets an `input:type-error`, so an MCP or browser caller fails now instead of
  waiting out its own timeout — which its fallback would report as success. `input:type` used to receive
  nothing and burn its full deadline; widening the terminal set would not have fixed it, because its waiters
  key on the `input:type-*` pair and ignore an `input:error`, and L5c did what the note here called the
  honest fix — a reply in the shape those waiters read.
  Two situations reach that reply and only one is the agent's fault, so they carry **different prose
  and the same reason**: a held session with a closed socket is `agent offline`, while no session at
  all is `Session not found` — evicted after the reconnect grace, or never valid, and the agent may be
  perfectly healthy. `device:boot` already told that pair apart with those two strings. The reason is
  `channel-unavailable` for both because the set is derived from what a consumer must *do* differently
  and both want a reconnect or a re-join; the machine field was right for both while the prose was
  wrong for one, which is the concrete case for reading `reason` rather than `message` (#492).
  **Everything else gets nothing, and that is the contract**: opening and move frames, `input:rotate`,
  `input:posture` and `input:keyboard:toggle` have no waiter, so a reply would be one nobody is listening for.
  The twelve `input:*` cases are **two clauses**, split by whether an ack answers them, and the split is
  load-bearing rather than tidy — the correlator gate belongs on the answered five, and written into the
  shared body it would have dropped every opening and move frame with it.
- **A browser-role command is acted on only from the client the session is bound to** — one client's several sockets are one holder, which is what a browser tab needs and what a socket could not express. The mirror of the
  clipboard rule above, and it was missing until L5c on **every** branch: the relay resolved the session and
  forwarded without asking who was asking, so any authenticated client that knew a session id could drive a
  device another tester was looking at — `clipboard:write` pasting its text into that device,
  `clipboard:read` pressing copy or cut on it with the payload landing on *that* tester's host OS clipboard,
  `session:end` deleting their session. The reply then routed to the session's own browser, never to the
  injector.
  `dispatchTarget` decides it once for all of them — session exists, **this client owns it**, agent
  connected — and each case wraps the prose it returns in the reply type its own waiter reads. The two
  ownership strings are one reason with different prose (`ownershipRefusal`), the treatment #492 settled:
  telling a caller the session is in use when it is idle steers it off a device it could have had.
  **A refusal is answered where a waiter exists and dropped where none does.** `input:*`, `device:boot`,
  `open-url`, `app:*` and `clipboard:*` are answered — `awaitInputAck` reports silence from a session that
  has never acked as *success*, so a silent refusal would report a command that never left the relay as
  having landed. `session:leave` and `session:end` are dropped, because neither has a reply and inventing
  one would grow the wire for a message no consumer reads.
  **A session is owned by a *client*, not by a socket** (#527). The owner is `<userId>:<clientId>`, taken
  from the `?client=` query parameter at the handshake and minted per connection when absent — the
  parameter is wire contract and is specified in protocol's AGENTS.md, *Connection handshake*. There is
  no fallback branch, and a caller that identifies itself gets an identity spanning its sockets while one
  that does not gets the per-socket identity ownership used to have. The dashboard sends one value per
  *document*, deliberately not `sessionStorage`: that store is copied into a tab opened from another, and
  two tabs sharing an identity would silently take each other's devices.
  **`device:shutdown` has its own, weaker gate** — refused when another client holds the session, permitted
  when nobody does. Not "owned by me", because the unmount teardown races its own viewer socket's close on
  a different connection: if the close lands first the session is unheld, and an owns-it gate would refuse
  the very teardown that stops a device costing money. The residual surface — a device between owners — is
  the price, and it is unchanged from before, when this command had no gate at all.
  A session held by a client that identified itself with **nothing** relaxes the gate further, since each
  of that client's connections was granted a separate identity and none of them can pass an ownership
  test — **but only for the same signed-in user**, so a build predating the parameter never becomes a way
  to power off a colleague's device. Whether an identity was *claimed* or *granted* is a field on the
  session: a first version recovered it from the identifier, which the caller supplies, so claiming one
  that looked granted handed the caller its own exemption.
  It is **not** an exception to being answered, and used to be both. `reachableTarget` is `dispatchTarget`
  minus the ownership clause, so the other two refusals — no such session, agent gone — come back as
  `device:shutdown-error` instead of the silence that burned `shutdownDevice`'s 30s deadline with no cause
  (#542). Splitting the resolver rather than inlining two checks is what makes closing #527 a one-line
  move to `dispatchTarget`; the cost, written down rather than waved past, is that a non-owner now learns
  whether a session id exists — small against being able to shut that device down, which it still can.
  The app-command handlers check ownership **after** the session lookup and **before** the build lookup,
  deliberately not through `dispatchTarget`: that resolver also decides agent liveness, and using it there
  would move `agent offline` ahead of `Build not found`, changing which of two simultaneous problems the
  caller is told about.
- **The relay keeps a record of the build on each device, so a viewer coming back does not wipe it** (#1087).
  An install clears the app's data first, and a reconnecting viewer sends one per `device:ready`. An
  `app:install` with `keepIfInstalled` is answered here when `Session.installed` names the same build (id and
  stored path), or joins `Session.pendingInstall` when that build is already on its way. The record is
  dropped wherever the app may have gone without the relay installing over it — a shutdown, a ready that is
  not explicitly warm, a full-erase or run-reset boot, another install starting — and the pending half also
  in `rejectPending`, which every way an agent leaves passes through (a restart that replaces its socket
  skips the hold). Treating an unknown ready as cold has a cost, written down rather than hidden: a device
  that was shut down outside tapflow (Simulator.app, DeviceHub, a crash) and came back with the app's data
  intact is reinstalled anyway. The relay cannot tell that case from iOS's zombie recovery, which erases.
  The opposite direction has a cost too: an app deleted on the device by hand, or a simulator erased and booted
  again outside tapflow before tapflow boots it, stays recorded — the next boot reads as warm — so a
  reconnect answers "installed" and Launch fails, where it used to reinstall. Picking the device again
  installs it. Fixing it needs the agent to report a shutdown it did not perform; no one has hit it.
  `appInstallKeepIfInstalled.test.ts` walks each way the record is dropped.
- **A device remembers the person it is waiting for** (#1087, `Session.waitingOwner`). The owner fields are
  cleared on release, so without it the same person coming back from another browser read as anyone. It is
  tied to the idle countdown the relay already keeps, not a second timer: set where a person's countdown starts
  in `clearBrowser`, kept while an AI client borrows the device (the existing `lastHolderWasAi` /
  `idleResumeOnLeave` rule decides whose countdown it is) and restored in full when it leaves, ended by a
  person's join, the timer, or a shutdown. A person taking it, or shutting it down, leaves `endedBy` for the one
  waited for. **A shutdown counts when it is forwarded to the agent** (`noteShutdown`), so a refused one ends
  nothing, and **the countdown is cancelled when the agent reports the device down** (`settleShutdown`), so a
  shutdown that fails keeps its backstop, and the wait and notice it ended are put back (`undoShutdown`) — unless a boot went out after that shutdown (`bootAfterShutdown`): its
  done then answers a device someone has picked up again, and the wait and countdown on the session are that later
  pick-up's. A waiting device is also not a candidate for a capacity shutdown, as a person's countdown is not one
  for a lease. Nothing here refuses a join: a teammate may take a waiting device, and
  the dashboard asks first. The listing reads all of it per asker *user* (`list(…, askerUser)`), because a person
  is a different client in each browser. `endedBy` is not cleared by being read: every open tab polls. Held by
  `sessionWaitingOwner.test.ts` (rules) and `sessionResumeRelay.test.ts` (wiring, two signed-in users through the
  tunnel port, since loopback sockets are all one anonymous user).
- **A session an AI client holds can be watched, read-only** (`watch:*`). The rules live with the code, and
  the ones that are easy to undo are these:
  - **Watchers are an index in `SessionManager`, never `owner` or `browserSocket`,** each bound to the owner
    key it was admitted under. A *different* client binding the session evicts them (`holder-changed`) —
    otherwise whoever watched the agent would go on watching the person who picked the device up next. The
    same client re-joining keeps them, and `remove()` evicts on every path.
  - **The ownership gate is not the only gate a watcher meets.** `mayShutDown` passes anyone while the session
    is unheld, which is exactly the holder's reconnect grace, so a watching socket is refused `device:shutdown`
    and `session:start` for the session it watches before the usual gates run.
  - **What reaches a watcher is an allowlist**: video frames (not audio), the device's description (chrome,
    device info, postures, booting, ready) and the lifecycle (agent away, rebound, holder left, ended), and what the holder just did (`watch:action`,
    built by the relay from the commands it passed on). Every
    reply to something the holder asked — acks, clipboard, network state — stays the holder's.
  - **One keyframe-aware sender per watcher, and a watcher's drop asks for no IDR.** The sender's drop state
    lives in its closure, so a shared one would let a slow watcher push the holder into drop-to-keyframe; and
    an IDR changes the encoder's output for everyone, so a watcher on a slow link requesting one on every
    drain would cost the holder forced keyframes. A watcher resyncs on the periodic keyframe (plus the one
    throttled request when it starts watching). Frame forwarding is not gated on the holder either: watchers
    keep the picture through the holder's reconnect grace.
  - **A holder cannot watch its own session** — it already receives every frame, and the watcher gates would
    then refuse its own shutdown and re-join.
  - **`watchUrl` follows the invite rule**: sent only when `forTeammates(resolvePublicBaseUrl(…))` gives an
    address; otherwise omitted and the client builds the link from the address it dialled.
  - **An unauthenticated loopback socket may hold a session but never watch** — any browser on the relay's Mac
    reaches loopback without a credential. `mayWatch` is decided once at the handshake.
- JWTs are issued based on team invite links.
- **Every address handed to someone else is decided in `lib/publicUrl.ts`** — invite mail, the link the dashboard copies, CORS, and what `/api/v1/relay/host` reports. Never from the `Host` header (#6). A tunnel's `publicUrl` is for teammates' browsers and `relay.url` is where agents connect, so the endpoint reports them separately. **What a tunnel actually did beats what config says**: config names a tunnel but not whether it came up or at which address (Tailscale's is detected, #794), so an entry point that starts one passes the outcome as the `RelayServer` `tunnel` option, and the CLI starts the tunnel before the relay for that reason. No option means no entry point manages a tunnel, and config is trusted — the standalone `server.ts` case. `scripts/__tests__/teammateUrlsSingleSource.test.mjs` holds that only `publicUrl.ts` and `config.ts` read those two settings.
- Serves the `public/` directory as HTTP static files (dashboard build output).
- The relay does not buffer stream data — it forwards immediately on arrival.
- WebSocket upgrade requests and regular HTTP requests are split on the same port.
- A heartbeat (`runHeartbeat`, every `HEARTBEAT_MS`=30s) pings every socket (agent/browser/stream); a socket that has not answered for 1.5 intervals → `ws.terminate()`, which fires the existing `close` cleanup — detects dead sockets without waiting for TCP timeout.
  **Liveness is a pong timestamp, not a swept flag**, and the difference matters beyond termination. The flag was set `false` for every socket at the start of a sweep and back to `true` when the pong returned, so a healthy socket read as dead for a whole round trip — harmless while it only decided termination, and not once session occupancy and `busy` read it. The window was longest for the holder: video goes out on that socket and the ping is queued behind it. Occupancy and `busy` take the same predicate; two that disagreed would show a device as free while a join for it was refused (#579).

### API Endpoints (builds / apps)

Routes are registered in `RelayServer.ts`; user-facing reference: [`docs/reference/api.md`](../../docs/reference/api.md).

> **Deletion lifecycle (issue #258)**: review status and deletion are orthogonal. `status_label` (incl. `Done`) is a pure review state and never schedules deletion; purge keys off `delete_after` only, which is set by the explicit schedule-deletion action. `completed_at` is informational.

> **A build goes with everything that points at it, on one path.** `deleteBuildsWithDependents` (`lib/buildDeletion.ts`) is used by both the daily purge and app deletion: recordings, run records and their screenshot files, then the build file. App deletion used to delete only the build rows, so an app with a recorded build failed on the recordings foreign key and one without left its build files on disk.

### A device list after registration (`agent:devices`, #1085)

An agent re-reads its simulators or emulators every 30 s and sends the whole list when it changed, to a relay that
announced `'device-updates'` on `agent:registered`. `handleAgentDevices` diffs it against that socket's sessions:

- **A new device gets a session under the identity the socket registered with** (`agentIdentities`), not one read
  off its other sessions — an agent that registered with no devices has none to read, and its first device would
  otherwise come out with no agent name, no capabilities, and no way for the next restart to rebind it.
- **A listed device is refreshed by `refreshDevice`, not `agentFields`.** Name, form factor, and a version the list
  still carries. `deviceStatus` and `deviceServiceTier` come from `device:ready` and shutdowns and the lease reads
  them, so a list read in between must not move them. `REFRESHED_FIELDS` is held against `deviceFields` by a test.
- **A device that left is removed only if nobody holds it.** One in use is marked `deviceGone`, left out of the
  listing and the lease, and removed by the heartbeat (`sweepGoneDevices`) once `goneAndVacant`: an idle shutdown
  sends `device:shutdown` and keeps the session, so no single place sees a session stop being held. Removal goes
  through `removeSession`, which also releases the boot gate.
- **Only the one who was on a gone device may re-join it** (`SessionManager.join`): the same client, or the person a
  dropped session is waiting for. Anyone else holding the id would boot a device that is no longer there and, as its
  holder, keep the session from being swept.
- **Only the socket that registered last takes a list** (`latestAgentSocket`). A re-register evicts the sockets it
  finds through their sessions, so one that registered with no devices lingers until the heartbeat.
- The two-reads-in-a-row rule for a missing device lives in the agent (`DeviceListWatcher`): the agent sends only on
  change, so the relay never hears the second absence.

Device prefs and favourites (`api/devicePrefs.ts`, migration 021) are laid over `agents:listed` by
`withDevicePrefs`, keyed by `SessionInfo.agentKey` (`agentId ?? agentName`) and the device id. **Nothing is removed
from the listing**: an MCP client and the lease read the same one, and a hidden device must stay usable to them.

### Flow run records (`/api/v1/runs`)

What `tapflow flow run` did, for the dashboard's runs page (A3). The CLI writes with its `builds:write` token; anyone who may view reads.

- **Only the run's creator writes to it**: the same user, and the same PAT when it was created with one, plus `assertCanWrite`. A run id in a CI log must not let another job rewrite its result.
- **A run is live while its runner's socket is open.** The flow runner does not reconnect, so the close handler ends its running runs (`holder-lost`). The client id is matched in two key forms, `<userId>:<client>` and `anon:<client>`, because the handshake does not read a PAT on loopback and a runner on the relay's own Mac holds its sessions anonymously. A relay restart closes sockets without that handler; reads and the daily purge close what is left after a minute of quiet. No timer exists for it.
- **The watch link opens the session the runner holds now**, never a stored one: session ids outlive runs, so a stored id would open whoever took the device next.
- A run with a build expires with the build; a run with none expires after 7 days.
- **A flow the runner did not replay is a `skipped` row with a `skip_reason`** (`app-mismatch`, `tag-filter`; migration 017), its reason in words in `failure_message`. The table's CHECK ties the two together — a reason only with a skip, and a skip only with one — and a skipped flow takes no screenshot. The list counts it as `flowsSkipped`.

### Flow run videos (`/api/v1/runs/:id/flows/:idx/video`)

A flow's whole recording, as evidence that it passed as much as of how it failed (A4). The runner opens it, sends
chunks of the stream it already receives, and ends it; the dashboard reads the chunk index and fetches byte ranges.
Files live in `run-videos/` beside `uploads/`.

- **A video is its own row, not a column of the flow's.** Chunks arrive while the flow runs, before any flow row
  exists, and a runner killed mid-flow never reports one.
- **Chunks are numbered and written at the committed length** (`r+` at `bytes`, never append). A retried chunk is a
  duplicate, a skipped number is a gap the index reports, and a write torn by a crash is overwritten by the next.
  Writes to one video are serialised; `r+` also means a file deleted underneath answers 410 instead of being recreated.
  Seq numbers stop at `MAX_SEQ`: the index lists every missing number up to the last, synchronously.
- **The cap is enforced on the append path, in one synchronous transaction**: settle orphaned runs, make room,
  reserve. Usage counts in-flight reservations, so two videos cannot both pass the check, and a chunk is refused if
  it would bring the disk below `max(1 GB, 10%)` free, whatever the cap says. Only video appends are held to that
  floor; builds, recordings and the database are not. Reservations count against it too, because bytes not yet
  written do not show in free space. No write survives a restart, so `start()` zeroes every reservation.
  Room is made by evicting ended videos of finished runs, passed flows first, oldest first. A running run's video is
  never evicted; when nothing more can go, the writer's own video ends `storage-full` (507). An evicted row stays,
  so the page says "no longer kept" rather than "never recorded".
- **"Ended" is derived here, not only from the end call**, which is lost with the runner: an explicit end, or the
  run finished and `VIDEO_GRACE_SECONDS` passed (`truncated`), or the relay closed the run as `holder-lost`
  (`runner-lost`). The grace exists because the last flow's tail is sent after `finish`; `ownRun` takes it as a
  parameter so only the video routes accept writes to a finished run.
- **Reads never pass the committed length**, and are `no-store` until the video has ended — a cached range of a
  growing file would be stale. Ended videos get `private` plus an ETag of their length.
- The daily purge removes passed flows' videos past `video_pass_retention_days`, sweeps files no live row names,
  and marks rows whose file is missing as evicted so usage stops counting them. A failure's video is kept as long as its run, unless the cap needs the room.

## Environment Variables

전체 목록 및 설명: [`docs/reference/configuration.md`](../../docs/reference/configuration.md)

설치 디렉토리: `lib/dataDir.ts`의 `resolveInstallDir()`이 `TAPFLOW_HOME` → 현재 폴더가 이미 설치 → `~/.tapflow` 순으로 정한다. 설정 파일 안의 상대 경로(`local.dataDir`, `tls.certPath`)는 **그 파일이 있는 폴더 기준**이고, `TAPFLOW_DATA_DIR`만 셸 기준이다. 데이터는 설치 디렉토리 안에서 `.tapflow/data` → `.tapflow-data` → `data`(새 기본값) 순으로 찾는다. `jwt-secret` 하나만 든 데이터 폴더는 설치로 치지 않는다 — 예전 CLI가 실행한 자리마다 남긴 흔적이고, 릴레이는 부팅 때 항상 `tapflow.db`를 만든다.

JWT 시크릿은 `getJwtSecret()`으로 **처음 쓸 때** 만든다. `RelayServer.start()`가 부팅 때 한 번 호출하므로 로그와 실패 시점은 전과 같고, 릴레이를 띄우지 않는 CLI 명령은 아무 데도 시크릿을 남기지 않는다. `JWT_SECRET` 길이 검증만 import 시점에 그대로 둔다(파일을 만들지 않으므로 부작용이 없다).

비밀 기본 경로: `config.ts`의 `load()`가 dataDir 확정 직후 `<dataDir>/.env`를 로드한 뒤 나머지 `process.env`를 읽는다 → `JWT_SECRET`·`SMTP_*`·DNS/ACME 토큰 등 **모든 비밀이 `.env`를 기본 경로로** 쓴다. 우선순위는 **셸 env > `.env` > config.json**(`process.loadEnvFile`이 기존 값을 안 덮음). 예외는 `TAPFLOW_DATA_DIR` 하나 — `.env` 경로를 결정하는 값이라 `.env`에서 못 읽고 config.json/셸로만 받는다.

로컬 테스트 시 자주 쓰는 값:
- `TAPFLOW_BUILD_TTL_DAYS=0.001` — 빌드 자동 삭제를 즉시 확인할 때
- `TAPFLOW_WS_BACKPRESSURE_BYTES` — 브라우저 소켓 backpressure 임계값 (기본 1 MB)

## HOW NOT

- Do not store or analyze screen data in the relay. **Two exceptions, both uploaded by a flow runner to its own run** — bound to the run's creator, and deleted with the run:
  - the screenshot (`api/runs.ts`) — at most one image per flow (the screen it failed on, or a passed flow's last screen), PNG or JPEG by its bytes, at most 5 MB, served back as its own type with `nosniff`;
  - the video (`api/runVideos.ts`) — capped per flow, kept by the retention policy and the disk cap below. The relay reads only the open call's JSON, never the frames.

  A stream the relay is forwarding on its own is still never stored.
- Do not allow session routing without authentication.
- Do not introduce designs that require more than a t3.small instance (cost principle).
- Do not modify files in `public/` directly — they are dashboard build output.
- Do not parse or deserialize binary frames as JSON — if `isBinary === true`, forward immediately.

---

## Compound

### Binary Frame Forwarding with Backpressure

**When**: relaying WebSocket binary messages from the Agent to the Browser

**How**: the binary branch of the `ws.on('message')` handler in `RelayServer.ts` — a per-session `createKeyframeAwareSender` (`@tapflowio/agent-core` `utils/stream.ts`) handles backpressure. Core call: `dropper.send(browserSocket, frame, threshold, isKeyframe, onDrop, requestIdr)`. `isKeyframe` comes from `readEnvelopeFlags(frame)` (JPEG, or H.264 IDR).

**Why** (not obvious from the code):
- Omitting `{ binary: true }` makes `ws` send the Buffer as UTF-8 text → `e.data` becomes a string in the browser. The relay must be content-agnostic, with zero parsing cost.
- **drop-to-keyframe**: a dropped H.264 P-frame tears the stream until the next IDR, so once it drops under backpressure it keeps dropping until a keyframe can be sent — the decoder never receives a P referencing a dropped frame. JPEG / no-envelope frames pass `isKeyframe=true`, reproducing drop-to-latest exactly.
- On a drop with no sendable keyframe, `requestIdr` sends a throttled `stream:request-idr` for an on-demand IDR (unsupported agents ignore it) → fast resync instead of waiting for the periodic IDR.
- Threshold default 1 MB (`TAPFLOW_WS_BACKPRESSURE_BYTES`). Per-session dropper / drop-warn (one warn/sec) / IDR-requester must be cleared on `session:end`.
