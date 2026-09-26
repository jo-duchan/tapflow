# @tapflowio/agent-core

## 0.24.0

### Minor Changes

- 2700746: Lean mode for iOS simulators. With `agent.lean: true` in `tapflow.config.json` (or `TAPFLOW_LEAN=on`), the agent turns off a fixed list of background services — Siri and Apple Intelligence background work, iCloud Keychain and backup, Health app and HomeKit, photo analysis, Screen Time, iMessage and FaceTime, Continuity, telemetry and similar — on each simulator it boots, and puts them back when it shuts the simulator down. Measured on iOS 27, a simulator uses about a quarter less memory. Wallpaper, widgets and the services apps commonly call (push, StoreKit, CloudKit, HealthKit, the photo picker, universal links and others) stay on; an app that needs one on the list should run with Lean mode off. `tapflow init` asks on a Mac (default off) and `tapflow doctor ios` reports it. iOS 18.5 or later. Android emulators get their own Lean mode in this release: four bundled Google apps kept disabled.

### Patch Changes

- @tapflowio/protocol@0.24.0

## 0.23.0

### Minor Changes

- e63e410: Foldable devices. Taps now land where you press them on a device whose display is rotated — the emulator's gRPC input takes coordinates in the display's natural orientation, and the viewer normalises against the rotated picture it is showing, so the two axes were swapped on every unfolded foldable. Folded, they also land in the right place: the emulator scales injected touch pixels by its own display size, which stays at the unfolded panel's, so scaling by the panel the guest reports sent every tap 1.92x too far across. A toolbar control folds and unfolds the device, keeping the orientation you were in, and the device frame follows the screen when it changes. A session starts unfolded and upright rather than inheriting whatever the last one left. Screenshots and recordings save the picture on screen rather than the frame behind it — the emulator captures a foldable's panel in its own fixed orientation, so an unfolded device was portrait on screen and landscape in the file, with the cursor overlay a quarter turn from the finger. `PosturableAgent` (`agent-core`) and the `input:posture` / `device:postures` messages carry it, with posture ids and labels owned by the platform so a device that folds differently needs no change outside its own agent.

### Patch Changes

- Updated dependencies [e63e410]
  - @tapflowio/protocol@0.23.0

## 0.22.0

### Patch Changes

- @tapflowio/protocol@0.22.0

## 0.21.0

### Patch Changes

- 7d8eb4e: **Installing a build works when the relay is not on the same machine as the agent.** It never did. The relay sent the agent its own filesystem path and the agent opened it, which is only true when the two share a disk — so on the topology the guide recommends, a relay on a LAN box with agents on Macs, every install failed. A relay in a container failed the same way for the same reason.

  **And it failed by blaming the build.** `unzip` said `cannot find or open`, the agent threw that away, and what reached the browser was "check this is a simulator .app.zip". The archive was fine every time. The tool's own words are in the message now, and a download that fails is reported as a download failing — the three causes a person acts on differently (a bad archive, a relay that cannot be reached, a transfer cut short) had been collapsed into the one sentence that was wrong for all of them.

  The relay now mints a single-use credential where it has already checked who owns the session, and serves that one build against it. Nothing is added to any token's permissions: an agent still cannot ask for a build it was not told to install, and `tapflow start` — whose agent runs with no token at all — keeps working, which a permissions-based approach would have broken. The agent builds the address from the relay URL it is already connected to rather than from anything the relay claims about itself, because that is the one address known to be reachable.

  A truncated transfer is caught against a size that travels with the instruction rather than against `Content-Length`, which a proxy is free to drop — a check that reads an absent header passes while looking at nothing, and hands on a half a file to be reported as a damaged one. Downloads have a stall timeout, so a half-open socket fails instead of hanging forever and leaving a temp copy of the build behind; the Android install path gained the cleanup it never had. An agent too old to fetch builds is unaffected and installs exactly as before, and the relay says so once in its log rather than guessing whether that agent is somewhere else — it cannot tell, and a check that is wrong in both directions is worse than none.

  `@tapflowio/agent-core` gains `downloadBuild`, and `@tapflowio/protocol`'s `app:install` gains `buildTicket`, `buildName` and `buildBytes` — additive, so an agent that predates them keeps working on the field it already reads. Both are named here rather than left to ride the version bump because a third-party platform built on `AgentRegistry.register()` reads those changelogs, and this is the API it would use to support installs from a relay it does not share a disk with.

- Updated dependencies [7d8eb4e]
  - @tapflowio/protocol@0.21.0

## 0.20.1

### Patch Changes

- @tapflowio/protocol@0.20.1

## 0.20.0

### Minor Changes

- becbe77: Refuse an ambiguous device instead of picking one, and drop the audio capability interface

  `AndroidAgent`'s session-less entry points resolved their device with
  `deviceStates.values().next().value` — the entry the relay happened to register first. On a Mac
  running two emulators that meant answering about a device nobody asked about, and for
  `setNetworkOffline` it meant taking a device off the network while somebody else was testing on it.
  `IOSAgent` has refused this since the same feature shipped; Android never got the fix.

  Eleven entry points now go through one resolver that throws when it cannot choose. `sessionId` keeps
  answering, deliberately: a read's worst case is naming the wrong device, and it answers before any
  device is chosen.

  `AudioStreamCapability` and `hasAudioCapability` are removed. Nothing implemented them, nothing
  detected them, and audio has no `AgentCapability` string because it is not gated — the dashboard plays
  whatever frames arrive. The audio _data_ types move to `agent-core`'s shared types and keep their
  names.

- 3f18f70: Gate the dashboard's Full reset toggle on an agent capability instead of the platform string.

  `AgentCapability` gains `full-reset`, `IOSAgent` advertises it, and `SessionInfo` now carries the
  agent's capabilities so the viewer can gate while picking a device — before any session exists to
  join. The old `os !== 'android'` check said "Android cannot" when it meant "this agent did not say
  it can", and got both directions wrong: an iOS agent too old to implement Full reset was still
  offered the toggle, and an Android agent that implements it later would still have it hidden.

- 4901c8c: Add the wire contract for taking a device under test off the network (#607): `network:set` from the
  viewer, `network:state` and `network:error` back, and a `NetworkControlCapability` beside
  `DeviceAgent` for the agents that implement it.

  This is the contract, and it landed before the platforms so each one had something to build
  against; both of them and the control ship in this same release.

  **`network-control` in `capabilities` claims less than the other two entries do.** `clipboard` and
  `full-reset` are settled facts about an agent's own code, but that string is sent once at
  `agent:register`, before any device is booted or app launched — so it can only mean "this agent has
  the code". Whether the mechanism actually takes is per device and per app, and `network:state`
  carries that as `available` plus a closed `reason`. A single boolean was tried and rejected: with the
  capability gating the control, `available: false` would have been unreachable, and the state it
  describes — conditioned but no longer steerable — would have hidden the only control that could undo
  it.

  `offline` reports the **device**, not the request: one taken offline and then left unsteerable is
  still offline, and saying otherwise would render "online" over a device whose app reaches nothing.
  The payload shape and its reason set live in `@tapflowio/protocol` and are re-exported by
  `agent-core`, the rule that package already follows for `ClipboardErrorPayload`.

- d238c34: Stop drawing a working network control as a dead one (#607).

  `NetworkUnavailableReason` gains `awaiting-app`, for a device whose injection is in place and which
  no app has run under yet. That is not an edge case on iOS — the library is delivered when the device
  boots but can only name its target when an app is launched, so **it is the state every session is in
  until its app starts**, and it is the first thing a tester meets.

  It had been reported as `not-armed`, and that value means something else: nothing was delivered, and
  the remedy it prescribes is a reboot. Rebooting does not help here, and neither does the sentence the
  dashboard drew from it — _"tapflow can no longer change it"_ was wrong twice over. Nothing had been
  armed, so there was no "no longer"; and clicking the control **does** change the device, because
  traffic-level control works in this state. What does not work is telling the app, which is the half
  that needed saying.

  So the control now says what is missing — _"Launch an app through tapflow so it is told too"_ — and
  is drawn as what it is: actionable. It keeps its plain action name rather than the `Retry:` prefix,
  which claims a previous attempt that never happened, and a device taken offline here stays amber,
  because it really is offline.

  **A control tapflow cannot currently steer is drawn as unusable wherever the device is pointing**,
  where before it was drawn that way only at `online` and left washed out at `offline` — the same faint
  rendering that reads as disabled on a button that still works, in another hue. A device whose state
  has not been read yet is untouched by this and stays muted: it has had no attempt, so drawing one as
  a failure claims something that never happened, in the opening seconds of every session.

  That colour says the control is unusable **now**, and deliberately not that the device will never do
  it. The dashboard reads this one member and still ignores the rest of the set, for the reason
  recorded where it ignores them: every Android read failure currently arrives as `unsupported-device`,
  so a rebooting device and a permanently incapable one are indistinguishable here, and nothing the
  dashboard draws may tell those apart. `awaiting-app` is not in that set — an agent emits it only
  about a fact it knows — which is what makes it safe to read alone.

### Patch Changes

- 7152b21: Stop the network control describing a device that is rebooting, and settle what the toolbar's groups mean.

  A device that restarts keeps its session, and the control only forgot what it knew when the _session_ changed — so for the 30–60 seconds an emulator takes to come back, the toolbar showed the position from before it. Worse than merely stale: the agent's boot path turns airplane mode off and reports the device online, so an amber "offline" sat over a device being reset to the opposite, and nothing ever replaced it. The control now forgets the moment the device stops being ready, and starts waiting for the report again.

  The toolbar's buttons were grouped by a criterion nobody had written down. They are now grouped by what the tester is doing to the device — **move around the app → leave the device in a condition → take the state out of the session → change what the device is sitting in** — and the rule, with its worked examples, is in `packages/dashboard/AGENTS.md`. A new button has an answer before anyone argues: GPS goes in Environment, Shake in Device.

  Where a button sits is now decided in one place. Android's toolbar was ordered by the _agent_, because its buttons arrive as a capability list and the dashboard rendered that array in array order — so reordering that list moved buttons in the browser, and nothing on either side would have said so. The dashboard names its own order now and looks each button up. A button the agent adds and no group claims does not render — deliberately, so that where it belongs is a decision rather than an accident, and a check fails if one is left unclaimed.

  Also recorded rather than changed: `NetworkControlCapability` is an in-process API. `mcp-server` and `flow-runner` hold a relay client and address devices by session over the wire, so the network tool they would expose goes through `network:set`, which already names its session and answers with a correlated report. Two issues had been filed asking this interface to take a session id and report on the wire, on the premise that MCP calls it.

- Updated dependencies [3f18f70]
- Updated dependencies [cb04a51]
- Updated dependencies [5e2fcc5]
- Updated dependencies [faeaae9]
- Updated dependencies [4901c8c]
- Updated dependencies [d238c34]
  - @tapflowio/protocol@0.20.0

## 0.19.0

### Minor Changes

- e55371c: **Requires Node.js ≥ 22.** Node 20 reached end of life on 2026-04-30 and no longer receives security patches.

  Three declarations disagreed about what was supported, and none of them matched what was actually run. The manifests said `>=20.12.0`, the documentation said "≥ 20" — meaning 20.0.0 — and CI ran 20 while Docker ran 22 and the release job ran 24. There was also a band that was declared but unusable: every `undici` 7.x requires Node `>=20.18.1`, so 20.12 through 20.17 could not complete a development install regardless of what the manifests promised.

  The floor is now 22 everywhere, and 22 is a version that will be tested rather than merely claimed — CI runs the suite on both 22 and 24. That is the part that had been missing: `>=20.12.0` was declared for a year and never once exercised on 20.12, which is how it drifted below what the dependency tree already required.

  `tapflow`, `@tapflowio/flow-runner` and `@tapflowio/mcp-server` declared no `engines` at all and now do. `tapflow` is the package installed with `npm i -g`, so until now the CLI announced no Node requirement to the people most likely to need it.

  `tapflow doctor` moves with it and reports `Node ≥ 22 required` below the floor. Without that change it would have printed a green check on Node 20 while the package manifest called the same version unsupported.

  Node 22 is supported until 2027-04-30; Node 24 is the active LTS. Containers and the published image now run 24.

### Patch Changes

- a5466b9: refactor(protocol): declare the agent→relay direction, and type every agent send

  An agent's outbound literal was the one part of the wire contract no compiler could see. The relay forwards
  replies with `JSON.stringify(msg)`, so nothing typed ever re-creates them, and each agent handed its literal
  straight to `ws.send`. #489 (an agent answering nobody) and #490 (a missing `reason`) both came out of that,
  and `scripts/__tests__/inputErrorReason.test.mjs` exists because a script had to stand in for a compiler.

  Seven message types were declared nowhere: `agent:register`, `agent:resources`, `screenshot:done`,
  `screenshot:error`, `stream:register`, `ui:tree:response`, `ui:tree:error` — the last undeclared direction.
  They are now `AgentToRelay` and `StreamToRelay`, and `AgentControlOutbound` is what the agents' typed send
  helpers take.

  `stream:register` is its own direction rather than part of `AgentToRelay`, mirroring `RelayToStream`: the
  relay assigns the role `'stream'` from it, not `'agent'`, so folding it in would make the union's name
  disagree with the runtime role — and would let a control socket claim to be a session's stream socket once
  inbound is narrowed by role.

  ## Two helpers, and why not one

  ```ts
  private sendMsg(msg: AgentControlOutbound): void { this.ws?.send(JSON.stringify(msg)) }
  private sendOn(ws: WebSocket, msg: AgentControlOutbound): void { ws.send(JSON.stringify(msg)) }
  ```

  `sendOn` takes the socket **as an argument**. Seven call sites sit behind an entry guard (`if (!this.ws)
return`) and are therefore compiler-proven non-null; reading `this.ws` inside a helper — or asserting it with
  `!` — would make those guards optional to the compiler and turn deleting one from a compile error into a
  runtime `TypeError`. One of them has a test whose subject is the window that guard covers.

  ## What the compiler found once it could see

  - **30 sends passed an optional `sessionId` into a field declared required.** The agents' dispatcher took
    `{ sessionId?: string }` while every message it dispatches is session-scoped. It now takes a required one,
    with the check moved to the socket boundary — a message with no `sessionId` did not come from the relay's
    forward path, which resolves the session before forwarding.
  - **`requestId` was read as optional in the clipboard cases and required in the screenshot and ui:tree ones**,
    for the same wire guarantee, in the same file. Now consistent. It is still an assertion about unvalidated
    JSON, as the other two always were; that is #444.
  - **The clipboard `respond` helper took `object`**, so all three clipboard replies were unchecked. Typed with
    `ClipboardReplyBody`, which is `ClipboardReply` minus the ids the helper merges.

  **Twenty-five `msg.sessionId!` assertions went away as a consequence**, along with the now-unreachable
  `if (!sessionId) return` inside each agent's `ackNoSession`. That is the same payoff #444 is after on the relay
  side, arriving here first: once the declaration is required, the assertion has nothing left to assert.

  `screenshot:error` and `ui:tree:error` are the first `*-error` messages that do **not** extend `SessionError`.
  They are request-scoped — the relay resolves them by `requestId` alone — and the convention check names them,
  which draws the family's boundary rather than widening it. `SessionError` is for a failure a _session_ is
  waiting on.

  Their `sessionId` is **required**, like every other producer field. A draft made it optional on the grounds
  that the agents pass through an optional id; that was true when written and false by the end of this change,
  which required it on both dispatchers. A field weaker than every producer describes a message nobody sends —
  and here it would also have removed the one field a symmetric ownership check could read, since the clipboard
  replies beside these verify `session.agentSocket === ws` before resolving and these two do not.

  The agents' helpers take `AgentControlOutbound = AgentToRelay | AgentToBrowser`, **not** a union that also
  includes `StreamToRelay`. An earlier draft merged all three, which handed back the exact hazard the direction
  split exists to avoid: `case 'stream:register'` calls `setStreamSocket(session.id, ws)` with no role gate, so a
  control socket that could type-check that message could take over the session's video path.

  `UIElement`, `UIElementRole` and `UIElementFrame` moved from `agent-core` to `protocol` — `ui:tree:response`
  cannot be typed without them and protocol is a leaf that cannot import agent-core. `mcp-server` had a
  hand-written mirror with a comment saying so; it is now a re-export.

  `scripts/__tests__/agentSendTyped.test.mjs` asserts nothing goes around the helpers, and it matches
  **serialization** rather than any spelling of `.send`. Three drafts keyed on `this.ws` were bypassed in review
  by renaming the socket — `streamWs.send(JSON.stringify(…))` walks past them, and that is not hypothetical:
  `streamWs` is in scope in `startBinaryStream` and the relay dispatches a text frame from a stream socket
  through the same agent cases. A commented-out copy of the canonical helper also satisfied the positive
  assertion while the real one took `msg: object`, leaving all 66 of that agent's sends unchecked with the check
  green. Both are closed, and a file in the agent packages that writes to a socket _and_ serializes now has to
  be listed with a reason.

- 15593db: A boot that will not finish says so, instead of letting you wait

  Two halves of one question — what ends the wait for a device to come up — and both used to be answered by
  a timeout somewhere else.

  What you can observe:

  - **A boot that gets overtaken fails immediately, with the reason.** Re-pick a device while the first one
    is still starting, or shut it down mid-boot, and the agent used to abandon the earlier boot silently.
    Nothing was sent in either direction, so whoever asked found out by waiting: 30 seconds for an MCP
    caller, two minutes for a flow run, forever for a spinner. An abandoned boot is now answered on its own
    request — as superseded by a newer boot, abandoned by a shutdown, or invalidated by the agent losing the
    relay — whenever the agent still has an open connection to send that answer on. When it does not, the
    paragraph at the end of this note applies instead.
  - **A slow cold boot is no longer reported as a failure that never happened.** The agents poll a booting
    device for up to 90 seconds (iOS) or 120 (Android) and then explain what went wrong. `mcp-server` gave
    up at 30 — inside both — so a device that was simply slow came back to the model as a bare timeout
    while the explanation was still on its way. `flow-runner` sat at exactly Android's 120, which left no
    room at all. Both now wait past the agent, and a check across the packages keeps them there: the
    numbers may change, the relationship may not. The cost of waiting longer is worth knowing: a wedged
    relay now blocks an MCP caller for three minutes rather than 30 seconds, so a host whose own tool
    timeout is shorter will cut in first with a message of its own.
  - **A tester is no longer told a boot failed when the failure belongs to a boot they replaced.** The
    viewer reports the failure of the boot it is waiting on, and an uncorrelated one — which is how a dead
    video stream is reported, and has no request behind it — exactly as before.
  - **Losing the relay mid-boot no longer leaves Android finishing a boot nobody owns.** Both agents drop
    their device state when the connection goes, but a boot already running holds its own reference to
    one; on Android it ran to completion against that, standing up a video stream and announcing the
    device ready for a session that no longer existed. iOS has invalidated in-flight boots there since its
    helper-leak fix. The two now agree.

  One thing deliberately stays silent: a boot abandoned when the agent has no open connection to the relay.
  The reply's own channel is what is missing. That case is covered by the relay, which declares the agent
  away and ends the session's waits inside its grace window — and `sendMsg` now checks that the socket is
  open rather than merely present, because sending to a closing one buffers the message and reports nothing,
  which is how an answer becomes a silence.

- 5ab537d: Type-check and lint the test trees

  Backfills: #537

  <!-- changelog: internal — a per-package `typecheck` script and a test-tree tsconfig; no runtime or interface change a self-hoster can observe -->

  Every package's build tsconfig excluded `src/__tests__` and eslint ignored it, so a test double could
  drift from the interface it doubled with both gates green. The manifests gained a `typecheck` script and
  the test trees a tsconfig of their own, which is the only reason this touches published files at all.
  What the gates then found was inside the tests: a double declaring `implements DeviceAgent` while missing
  two members, five duplicate object keys, a call passing one argument to a two-argument method, and a
  `test-utils` constraint no named message could satisfy.

  The CLI is `tapflow`, not `@tapflowio/cli` — the manifest name, which is what `changeset version` resolves.

- b459157: refactor(protocol): wire payload types are declared once, and a check keeps them that way

  Every wire payload type was declared separately in three to five packages, and they had drifted **in
  both directions**: `@tapflowio/protocol` was missing the `payload` field on `clipboard:error` that both
  agents send and the viewer reads, while the dashboard's `session:chrome` declaration was missing three
  fields its own `DeviceViewer` reads. Nothing checked either side, which is the situation
  `@tapflowio/protocol` was created to end — it had been half done.

  Protocol now owns them and everyone else imports: `ChromeData`, `ChromeButton`, `ChromeRect`,
  `AndroidButton`, `AgentResources`, `SessionInfo`, `Point`, and `ClipboardErrorPayload` (which moves out
  of `agent-core`, since neither the dashboard nor `mcp-server` can reach that package). `agent-core`,
  `flow-runner` and the relay re-export the names they published, so no consumer of those packages
  changes — including third-party agents built on `AgentRegistry.register()`.

  Three shapes were also the same thing under different names, which is how the duplication survived:
  protocol's `DeviceSummary` was `AgentDevice` in the dashboard and `DeviceInfo` in `mcp-server` and
  `flow-runner`, and that last name collided with the relay's own `DeviceInfo`, which is a _different_
  shape. `DeviceSummary` is now the one name; `flow-runner` keeps exporting `DeviceInfo` as an alias
  because the CLI imports it.

  **The comments moved with the types, and that mattered more than the types.** `ChromeData`'s fields
  were described accurately only in `ios-agent`, which produces them: the viewer lays out against an
  _expanded_ composite canvas (the device frame grown by the button margins), and protocol's copy said
  `compositeWidth` was "full PDF width including devicePadding" — a different quantity. Deleting the
  producer's declaration would have deleted the only correct description of the coordinate space three
  viewers compute against. Protocol's fields now carry it, with the two spaces named explicitly.

  A new check (`scripts/__tests__/protocolPayloadTypes.test.mjs`) fails if any package re-declares a
  protocol payload shape. It matches on **field sets, not names** — the inventory that planned this work
  grepped for names and missed two of the five copies of one shape for exactly the reason above, so a
  name-scoped check would have passed with all five standing and would be bypassed by a rename. It found
  two more copies during implementation: the relay's own `SessionInfo` and `agent-core`'s `Point`.

  No behaviour change: type declarations, imports and comments only. Every package's test count is
  unchanged.

- Updated dependencies [a5466b9]
- Updated dependencies [d63811f]
- Updated dependencies [42987e1]
- Updated dependencies [87cd901]
- Updated dependencies [4d4fe13]
- Updated dependencies [17a7484]
- Updated dependencies [513b17b]
- Updated dependencies [1ce516f]
- Updated dependencies [b5ea86d]
- Updated dependencies [a669e0a]
- Updated dependencies [ef2dac8]
- Updated dependencies [e55371c]
- Updated dependencies [e8b29b8]
- Updated dependencies [3f903c8]
- Updated dependencies [7ad6343]
- Updated dependencies [e84a2ea]
- Updated dependencies [b459157]
- Updated dependencies [2317d50]
- Updated dependencies [760e27a]
  - @tapflowio/protocol@0.19.0

## 0.18.0

## 0.17.0

## 0.16.0

## 0.15.0

## 0.14.0

### Minor Changes

- ba0a3d8: Automated QA axis: UI accessibility tree queries and the deterministic flow runner.

  - `query_ui_tree` (MCP) / `GET /api/v1/sessions/:sessionId/ui-tree` — unified element schema (`role`/`label`/`identifier`/`frame`/`enabled`), frames normalized 0-1 so a frame center feeds straight into `tap`. iOS reads the tree via a resident XCUITest runner inside the simulator — window-agnostic (no Simulator.app window required) and still no WebDriverAgent; Android via `uiautomator dump` with a device-side timeout.
  - `@tapflowio/flow-runner` (new package) + `tapflow flow run` — replay YAML flows with zero LLM calls: 10-step vocabulary, identifier/label selector resolution, condition-based waits, JUnit reports, failure screenshots, CI exit-code contract (0/1/2).
  - `run_flow` (MCP) — agents author a flow once, then replay it deterministically over the existing session.
  - New relay messages `app:clear-state` (reset app data — `pm clear` on Android, data-container wipe on iOS) and `input:type-done`/`input:type-error` (text-entry completion ack, so a following key press stays ordered). Text entry now waits for this ack: a self-hosted agent older than this release will not send it, so text steps time out — update the agent alongside the relay.
  - mcp-server and flow-runner graduate from the `experimental` dist-tag to the standard npm channel, versioned with the repo-wide fixed group.

## 0.13.0

## 0.12.0

## 0.11.1

## 0.11.0

### Patch Changes

- 3377bfe: Fix the package type entrypoint for npm consumers (#345). `exports.types` now points at the published `dist/*.d.ts` instead of `src/` — which isn't shipped in the tarball (`files` ships only `dist`/`bin`), so consumers couldn't resolve the package's types.

  The monorepo moves to **TypeScript project references** (each lib package gets `composite: true` + `references`, plus a root solution `tsconfig.json`). `typecheck`/`build` run via `tsc -b`, so workspace typecheck stays build-light (incremental, no manual dist build) while the published packages expose correct types from `dist`. No runtime or public API changes.

## 0.10.0

## 0.9.2

### Patch Changes

- - Prevent display sleep by default (`caffeinate -di`) so the host Mac keeps streaming during a session.
  - Dedup agent re-register by machine id to remove duplicate "Stale" cards.

## 0.9.1

## 0.9.0

## 0.8.2

## 0.8.1

### Patch Changes

- 6e4801a: Restore remote agent connections to the relay (#271). The WS auth gate added in 17b8615 closed every non-loopback connection without a cookie/PAT, so no remote agent could register — the agent then hung forever on a silent pre-registration close ("Connecting ios agent…"). Remote agents now connect again, authenticated with a token.

  **Changed — remote agents now require a token.** A relay on a different machine only accepts agents that present a PAT with the new `agent` scope (create one in Settings → Tokens, pass it via `--token` or `TAPFLOW_AGENT_TOKEN`). Agents connecting to a relay on the same machine (`localhost`) stay unauthenticated, so `tapflow start` is unchanged. See [Remote relay authentication](https://www.tapflow.dev/operate/agents#remote-relay-authentication).

  Details:

  - relay: remote connections presenting a PAT with the new `agent` scope are accepted and roled by their first message (`agent:register` / `stream:register`); the rejection close reason explains the fix and is logged. Token creation API accepts a `scope` field (`agent` scope is Admin-only; default scope unchanged).
  - dashboard: token dialog gains an API/Agent type selector; creating an agent token shows a ready-to-run `tapflow agent start --token` command.
  - agents (iOS/Android): new `token` option sends `Authorization: Bearer` on the control and stream WS; pre-registration closes now reject with the close code/reason instead of hanging; handshake timeout (10s default); reconnect failures log their cause.
  - cli: `tapflow agent start --token` flag (or `TAPFLOW_AGENT_TOKEN` env); a 1008 rejection prints token setup guidance. Local (`localhost`) agents stay unauthenticated — `tapflow start` is unchanged.

## 0.8.1-next.0

## 0.8.0

## 0.8.0-next.4

## 0.8.0-next.3

## 0.8.0-next.2

## 0.8.0-next.1

## 0.8.0-next.0

## 0.7.0

### Minor Changes

- Low-latency render pipeline.

  - **Android host-encode**: emulators now capture over gRPC and encode H.264 on the Mac host (VideoToolbox). The gRPC backend is the default for emulators, with a 30fps cap and automatic scrcpy fallback; real devices continue to use scrcpy.
  - **Unified downscale**: per-session resolution is chosen from the viewer's connection context (native on a secure context, 1280px on LAN-HTTP, 1000px external) and is tunable via `TAPFLOW_MAX_SIZE` and the per-platform / `_LAN` / `_EXTERNAL` overrides.
  - **Relay IDR-on-rejoin**: the relay requests an IDR keyframe when a browser (re)joins a booted device, so a late joiner paints immediately.
  - **iOS**: static-frame skip, tear-free framebuffer snapshots, and keyframe-aware backpressure on the agent→relay stream.
  - **Android**: keyframe-aware backpressure and 16-aligned encode sizing to avoid macroblock padding on the WASM decoder.

  The dashboard unifies iOS/Android decoding and perf telemetry behind a single `useDecoderStream` hook (hardware WebCodecs on a secure context, WASM fallback otherwise).

## 0.6.1

## 0.6.0

### Minor Changes

- Robust Android LAN streaming — keyframe-aware backpressure, on-demand IDR recovery, and idle-throttle prevention.

  - Android H.264 frames now carry the codec/keyframe flags in the stream envelope, so the relay's keyframe-aware backpressure preserves the reference chain under LAN congestion — it drops to the next keyframe instead of forwarding P-frames that tear. (`scrcpy send_frame_meta=true`; the public `stream()` contract is unchanged.)
  - On-demand IDR recovery for Android: the relay's `stream:request-idr` now resets the scrcpy encoder (RESET_VIDEO), resyncing fast instead of waiting for the periodic IDR — bringing Android congestion recovery to parity with iOS.
  - Agents hold a macOS power assertion (`caffeinate -i`) while connected so an unattended/idle Mac doesn't throttle the simulator/emulator. macOS-only; no-op elsewhere.
  - Fixed: the Android scrcpy stream now terminates on socket close, so the agent's pump and its timers no longer leak after a device shuts down.
  - Added: opt-in Android stream throughput metrics (`TAPFLOW_STREAM_METRICS=1`), matching the iOS agent.

## 0.5.1

## 0.5.0

### Minor Changes

- H.264 streaming pipeline with automatic codec negotiation.

  - iOS streams H.264 by default (VideoToolbox encoder), cutting bandwidth ~10× vs JPEG (~16–27 KB/frame vs ~235 KB) for noticeably lower latency. Android streaming moves to a runtime decoder layer.
  - The browser advertises its decode capability (`acceptH264`) at boot; the agent picks H.264 only when the client can decode it, otherwise falls back to JPEG — no black screens on older browsers.
  - Tiered browser decoders: HTTPS → WebCodecs, plain-HTTP LAN → WASM (tinyh264), both WebGL2-rendered.

  Backward compatible: the envelope codec/keyframe marker reuses a previously zero flag byte, so older clients read frames as JPEG and the relay forwards payloads untouched. Agents without `acceptH264` (version skew) default to JPEG. Opt out of H.264 anytime with `TAPFLOW_IOS_CODEC=jpeg`.

## 0.4.1

### Patch Changes

- 17b8615: fix: path traversal in /uploads/ and unauthenticated WebSocket access

## 0.4.0

### Minor Changes

- feat!: tapflow init redesign, Tailscale tunnel, web onboarding, and UX improvements

## 0.3.1

### Patch Changes

- Fix mcp-server release: add publishConfig for experimental tag and public access

## 0.3.0

### Minor Changes

- bec7ff1: Release v0.3.0

  - relay: add screenshot REST endpoint (`GET /api/v1/sessions/:id/screenshot`) for CI and AI agent use
  - relay: enforce PAT scope checks on builds endpoints; new tokens include `view` scope by default
  - relay: add `session:leave` message type — MCP clients can disconnect without ending the session
  - relay: fix `.app` bundle names with spaces in zip upload validation
  - dashboard: add deeplink URL execution from QA session toolbar
  - dashboard: add keyboard shortcuts and Kbd UI to simulator toolbar
  - dashboard: add streaming performance overlay

## 0.2.2

## 0.2.1

### Patch Changes

- fix: WebSocket backpressure, Android pinch via scrcpy multi-touch, dashboard skeleton visibility

## 0.2.0

### Minor Changes

- Add typed errors, CLI install banner, and dashboard toast feedback

  - **typed errors** (`agent-core`): `ValidationError`, `PlatformError`, `AuthError` exported from `@tapflowio/agent-core`; key runtime throw sites updated for typed `instanceof` handling (#63)
  - **CLI install banner**: `postinstall` prints success banner after global npm install (suppressed in CI / non-TTY / local workspace); `tapflow` with no args shows version banner and quick-start commands (#90)
  - **dashboard toast feedback**: sonner toasts on all key mutation flows — token create/revoke/copy, workspace/profile/password/app settings, app creation, build upload; `confirm()` replaced with `AlertDialog`; `toast.promise` for upload progress (#91)

## 0.1.0

## 0.1.0-alpha.8

## 0.1.0-alpha.7

## 0.1.0-alpha.2
