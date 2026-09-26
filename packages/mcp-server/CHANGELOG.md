# @tapflowio/mcp-server

## 0.25.0

### Patch Changes

- Updated dependencies [761db41]
  - @tapflowio/flow-runner@0.25.0
  - @tapflowio/protocol@0.25.0

## 0.24.0

### Patch Changes

- e03c9da: `tapflow flow run` now exits 2 when every failed flow failed for environmental reasons (relay, agent or session level: a refused input with an environmental reason, a session lost to an agent restart, a dropped relay connection). Those used to reach CI as exit 1, reading as product regressions on the dashboards that rely on the 1-vs-2 distinction. Selector, assertion and other product failures still exit 1, successful runs still exit 0, and a run with both kinds keeps exit 1 so a real regression is never masked by a blip. The engine carries the kind on the flow result, so consumers never branch on prose; `run_flow` (MCP) now also returns `failureKind` and classifies input refusals the same way as the CLI. Fractional `durationMs` values (e.g. 250.5) stay valid as on 0.23.0.
- Updated dependencies [e03c9da]
  - @tapflowio/flow-runner@0.24.0
  - @tapflowio/protocol@0.24.0

## 0.23.0

### Patch Changes

- Updated dependencies [e63e410]
  - @tapflowio/protocol@0.23.0
  - @tapflowio/flow-runner@0.23.0

## 0.22.0

### Patch Changes

- @tapflowio/protocol@0.22.0
- @tapflowio/flow-runner@0.22.0

## 0.21.0

### Patch Changes

- Updated dependencies [7d8eb4e]
  - @tapflowio/protocol@0.21.0
  - @tapflowio/flow-runner@0.21.0

## 0.20.1

### Patch Changes

- @tapflowio/protocol@0.20.1
- @tapflowio/flow-runner@0.20.1

## 0.20.0

### Patch Changes

- Updated dependencies [3f18f70]
- Updated dependencies [cb04a51]
- Updated dependencies [5e2fcc5]
- Updated dependencies [faeaae9]
- Updated dependencies [4901c8c]
- Updated dependencies [d238c34]
  - @tapflowio/protocol@0.20.0
  - @tapflowio/flow-runner@0.20.0

## 0.19.0

### Minor Changes

- 2bf043f: Say why a session-scoped failure happened in four places that did not, and declare what each client does with every message it can receive

  Both clients decorate a failure with what the relay has told them about that session — so a caller reading
  "No booted device" also learns that the agent reconnected and cleared its binding. The mechanism was shared
  and the coverage was not.

  What a user can observe:

  - **A refused `connect_device` now says which of the three refusals it was.** It used to report the relay's
    prose alone, so "the device is open in another browser session" and "this Mac is over its resource
    ceiling" arrived as sentences a model had to guess at rather than the closed reason it can act on.
  - **A failed screenshot or UI-tree query says what is wrong with the _session_.** They reported what the
    relay said about the request and nothing about the session it belonged to — so a query failing because
    the agent reconnected and dropped its device binding read as a bare 409. `flow-runner`'s screenshot was
    worse: an HTTP status alone. That is the least useful moment for it, since a screenshot is usually being
    taken to explain a step that has already failed.

  Those four were never reverted; they were never written. A static check now holds every construction in
  both clients to reaching the session record, which is what #546 asked for — and finding the rule took three
  attempts, because anchoring on `throw`, on the error's class, or on the method's name each let a real case
  through. Anchoring on the construction and asking whether the expression reaches the record covers the
  rejections inside closures too, which is where the highest-leverage one lives: a single deleted call in
  `waitFor` would strip the cause from every request's timeout in the file.

  Each package also gains an `inboundDisposition` module: a declaration, per message a browser socket can
  receive, of whether this client reads it and what it does — or why it deliberately does not. The compiler
  owns the key set, so a message added to the wire breaks both files until someone decides. Unlike the
  dashboard's equivalent, the check runs in both directions: an entry claiming a message is ignored fails if
  anything in the package starts reading it.

- c67a690: Stop waiting when the answer is never coming: leaving a session fails what it was waiting on, and a dead session fails a flow step now instead of at its timeout

  Both clients waited out their full deadline for replies that could not arrive. Three cases, one shape.

  What a user can observe:

  - **Disconnecting from a session no longer leaves a request hanging for thirty seconds.** An AI agent that
    calls `disconnect_device` while a `boot_device` is still in flight — ordinary, because tool calls run in
    parallel — used to get a bare timeout half a minute later. It now fails immediately and says the
    disconnect is what ended it. The message still warns that the request may have reached the device
    anyway, because leaving does not undo what was already sent.
  - **A worse version of that could report a boot that never happened as success.** Re-joining a session
    reuses its id, so a reply meant for the new join could satisfy a request from before the disconnect.
    Nothing shipped could reach it — a missing field on one message happened to be in the way — but it was
    one field away, and it is now closed at the cause.
  - **A flow run whose device dies stops blaming the wrong thing.** When the agent restarts mid-run the
    device binding is gone, and nothing in a flow can restore it — flows boot once, before the first step.
    Every remaining step used to poll for its full timeout and then fail with "no element matched",
    pointing at the selector — a restart three steps into a ten-step flow spent eighty seconds saying the
    wrong thing. Those steps now fail as soon as the query does, and say the session needs booting again.
  - **The relay's fifteen-second grace is untouched.** While it holds a session open for an agent that may
    come back, queries keep retrying exactly as before. That window is what the retry is for, and cutting
    it short would kill runs that recover.

  `@tapflowio/flow-runner` exports one new error, `SessionLeftError`, alongside `SessionEndedError`. They are
  deliberately separate: one means the relay ended the session, the other means the caller walked away from
  one that is still there, and they call for different next steps.

- e55371c: **Requires Node.js ≥ 22.** Node 20 reached end of life on 2026-04-30 and no longer receives security patches.

  Three declarations disagreed about what was supported, and none of them matched what was actually run. The manifests said `>=20.12.0`, the documentation said "≥ 20" — meaning 20.0.0 — and CI ran 20 while Docker ran 22 and the release job ran 24. There was also a band that was declared but unusable: every `undici` 7.x requires Node `>=20.18.1`, so 20.12 through 20.17 could not complete a development install regardless of what the manifests promised.

  The floor is now 22 everywhere, and 22 is a version that will be tested rather than merely claimed — CI runs the suite on both 22 and 24. That is the part that had been missing: `>=20.12.0` was declared for a year and never once exercised on 20.12, which is how it drifted below what the dependency tree already required.

  `tapflow`, `@tapflowio/flow-runner` and `@tapflowio/mcp-server` declared no `engines` at all and now do. `tapflow` is the package installed with `npm i -g`, so until now the CLI announced no Node requirement to the people most likely to need it.

  `tapflow doctor` moves with it and reports `Node ≥ 22 required` below the floor. Without that change it would have printed a green check on Node 20 while the package manifest called the same version unsupported.

  Node 22 is supported until 2027-04-30; Node 24 is the active LTS. Containers and the published image now run 24.

- 7ad6343: Answer a shutdown the relay cannot deliver, release every session a closing socket held, and let a viewer re-join a session it already holds

  Three defects that share a subject — who holds a session — and none of which needed the question that
  sounds like their root. The root question — **who should be allowed to drive a session** — is answered in this same release; see
  the note titled "A session belongs to whoever opened it". It could not be answered in this slice because the dashboard's four
  senders per tab are four connections, and a socket-shaped owner refuses the tab's own teardown.

  What a user can observe:

  - **A device shut down from an MCP client fails in a second instead of half a minute.** `device:shutdown`
    was the one browser command the relay never answered when it could not deliver it — a stale session id
    or an agent that went away produced no reply at all, and `shutdown_device` reported `Request timed out`
    with no cause after 30 seconds. It now says which of the two happened.
  - **A device list stops getting stuck on "Shutting down…".** The same silence left that row inert with
    both its buttons hidden for the life of the page.
  - **A tester whose browser reconnects lands back in their session instead of being thrown out of it.**
    Re-sending `session:start` for a session the socket already held was answered `session-not-found` — for
    a live session, held by the caller, that the device list reported as theirs two lines later. The viewer
    reads that reason as the agent having disconnected and takes the tester off a session that is fine.
    A re-join is idempotent now: same reply as a fresh join, and the session's cached state is replayed.
  - **Devices no longer stay booted with nobody watching them.** The relay tracked one session per browser
    socket while the relation is one-to-many — `mcp-server` runs a single socket for the whole process and
    joins a session per device. Closing it released only the last one joined; the rest stayed marked in-use
    for the life of the relay, with no idle timer, so their simulators kept running. All of them are
    released now, each with its own idle timeout.

  `@tapflowio/protocol` gains `device:shutdown-error` on the browser-inbound surface. It is relay-produced
  only: neither agent has a failure path that emits a message, so a shutdown that reaches a device either
  completes or times out. Its `requestId` is optional because the request's is — the relay originates
  `device:shutdown` from its own idle timer, and a reply cannot demand a field the request need not carry.

  `SessionManager.join()` returns its two expected failures instead of throwing them. It used to throw both
  as `ValidationError`, which left the caller's `catch` unable to tell an expected refusal from a bug — so
  it guessed a reason, and guessed wrong for the most common one. Nothing in tapflow depended on the throw;
  this affects code outside it that called `SessionManager` directly. `getByBrowserSocket` returns an array
  for the same reason the index changed.

- 1123d63: fix: read the relay's session-lifecycle messages instead of dropping them

  The last finding in #512. The relay reports a session's fate on three messages — `session:agent-away`,
  `session:rebound`, `session:terminated` — and sends them **without closing the socket**. Both clients
  were browser-role sockets receiving all three and discarding them, so the `close` handler never ran, no
  waiter was ever settled, and a flow learned that its agent had died by burning a 120s install deadline.

  ## The worse half was not the deadline

  `mcp-server` reported an input as **landed** while the relay was saying the agent was gone. Silence from
  a session that has never acknowledged an input takes the optimistic path — that exemption is for agents
  predating the ack contract — and `agent-away` is exactly when the ack cannot come: the relay only refuses
  inputs sent _after_ the agent's socket closes, so one already in flight gets nothing at all. The
  exemption's usual case is the first input after a boot, which is the same input. So #457's defect was
  reachable through a door the client could see through and was not looking at. It now reports "could not
  confirm", naming the agent's departure as the cause.

  `flow-runner` had the mirror image: `warnInputAckSilence` accused the agent of predating input
  correlation or of being slow, both false when the relay has already said the agent left. That
  accusation is withheld now, on the same reasoning that already withheld it for a closed socket.

  ## Only `session:terminated` settles a waiter

  The other two are **ambiguous about a request in flight**, and this is the part that looks like an
  oversight and is not. Both agents reconnect without restarting the process, so the request is still
  executing and its reply closure reads the socket at _completion_ time: finish after the reconnect and
  the reply lands on the new socket, the relay forwards it to the same session, and the waiter matches it
  on `requestId` and resolves. Finish during the backoff and the socket is null and the reply is dropped.
  So a rebound is not evidence that no answer can come, and rejecting on it would fail requests that
  succeed today — which is what the relay's 15-second grace window exists to protect. Both are held as
  state and read at the deadline instead, which is where they turn "timed out" into a cause — three of
  each client's waiters are shorter than that 15-second window and three more sit exactly on it, so those
  never hear the outcome message at all.

  A rebound leaves the session needing `boot_device` again, because the agent's reconnect clears its own
  device bindings. It does **not** reset the device: the simulator stays booted and the app stays running,
  so the advice says so rather than sending a caller at a reinstall it does not need.

  ## Also

  - Waiters now carry their session, so one session ending settles that session's requests and no others.
    `agents:list` carries no session on the wire and is explicitly unaffected.
  - `mcp-server` refuses a `shutdown_device` on a terminated session locally, saving a round trip and
    naming _why_ the session was dropped — which the relay's generic "session not found" cannot. It was
    written when this was the one command the relay dropped in silence; #542, in this same release, gave the
    pair a `device:shutdown-error`, so the local refusal is now an improvement on an answer rather than a
    stand-in for none.
  - `mcp-server`'s timeout and disconnect branches are distinguished by error class rather than by
    comparing the message string, which stopped being reliable the moment a deadline started carrying why
    it expired.
  - `flow-runner` exports `SessionEndedError` from its package entry, so a consumer can branch on the type
    rather than on the message — the thing the point above stopped doing internally.

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

- d63811f: fix: a screenshot's format is what the bytes are, not what was asked for

  An Android screenshot requested as JPEG came back as **PNG bytes labelled `image/jpeg`** (#508).
  `AdbWrapper.screenshot()` runs `screencap -p` and takes no format argument, so Android always produces
  PNG — but the reply echoed the _requested_ format, and the relay turns that field into the HTTP
  `Content-Type`.

  ## The part that is not cosmetic

  `mcp-server`'s `getImageDimensions` picks a parser **by format**. Handed PNG bytes and told they are
  JPEG, it scans for a JPEG SOF0 marker; in a few hundred KB of IDAT a stray `ff c0` is close to certain,
  so it returned a **wrong** width and height. Those numbers go into the response text the LLM reads and
  hands back as `tap`'s `screenshotWidth` / `screenshotHeight`, which are its divisors — so the tap lands
  somewhere else on the screen. The usual reassurance that decoders sniff magic bytes and render anyway
  does not apply here: this format is not deciding how to render, it is deciding how to measure.

  ## What changed, and what each edit is worth on its own

  - **`protocol`** now says what the request's `format` means: a **preference**, not a requirement. That
    asymmetry is the platform contract rather than slack — `DeviceAgent.screenshot()` takes no format
    argument, so no agent was ever asked to honour it. iOS happens to (`simctl io … --type`), Android
    cannot, and a third-party platform registered through `AgentRegistry` is free to produce whatever it
    can. Only `ScreenshotDone.format` describes an outcome, and even that is a claim.
  - **`android-agent`** answers `format: 'png'` unconditionally, because that is what it produced. On its
    own this fixes **no in-repo consumer** — it makes the HTTP `Content-Type` honest for anything reading
    the REST endpoint directly, and makes protocol's declaration true.
  - **`mcp-server`** reads the magic bytes instead of the request. This is the edit users feel, and it
    works against an agent that has **not** been upgraded — agents are separate processes on separate
    release lines and this protocol has no version handshake, so a self-hosted install running an older
    Mac agent is the ordinary case, not an edge one. When the format differs from what was asked for, the
    response says so; when the bytes match neither signature it falls back to the request and says that
    too, rather than presenting a guess as a reading.
  - **`relay`** logs a mismatch between the bytes and the agent's claim, and **does not overwrite it**.
    Correcting the field there would make the relay the authority on something only the agent can know,
    which is a contract change where this is a drift detector. It costs four bytes of a buffer the relay
    had already decoded. Without it the consumer-side sniff would hide a lying agent forever — #508 was
    found by a person noticing, and nothing reported it.

  The MCP `screenshot` tool keeps its `format` parameter: dropping it is a change to a published tool
  schema, and it is a working feature on iOS. Its description and the docs now name the platform
  difference.

  Not addressed: `relay/src/types.ts` keeps its own `format?: 'png' | 'jpeg'` while protocol declares it
  required — the drift that package exists to remove, and a separate slice.

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

- 4d4fe13: feat(protocol): `error` is the session-start refusal, and it names the session it refuses

  Closes #512's first finding, and ends a contradiction that sat in two files at once. `GenericError`'s doc
  claimed _"the escape hatch for a failure the relay cannot correlate to a session"_, while
  `SessionStartFailure`'s claimed the reason has **a single producer inside `handleSessionStart`**. Both cannot
  be true.

  The correlation work settled it by removing the general role rather than the specific one. A request naming no
  session is dropped at the relay's door, because answering it would ship a frame whose own required `sessionId`
  `JSON.stringify` erases — and `error` has no `requestId` either, so a caller could not attribute the answer and
  would wait out the same deadline silence costs. With nothing left needing an unaddressed failure, all five
  producers answer one specific join.

  ## What the address buys

  The join waiters in `mcp-server` and `flow-runner` matched `sessionId === undefined || sessionId === mine`, and
  with no such key **the left half was always true** — so any refusal resolved any pending join. Two concurrent
  `connect_device` calls and the first refusal woke the wrong one, reported as a failure that session never had,
  while the one actually refused waited out its deadline, because `dispatch` resolves only the first matching
  waiter. That is the defect; the escape was it.

  ## `extends SessionError`, not a bolted-on field

  The naming check forced the decision the plan had left open. `protocolMessageNames.test.mjs` asserts that a
  session-scoped failure declares `extends SessionError`, and its predicate is exactly this change: `'error'`
  already matched `/error$/`, and it survived only because it had no `sessionId`. Adding the field flips that.

  Joining the family is the honest answer rather than carving an exception: the shape is the base verbatim, and
  the base's own definition — a failure a _session_ is waiting on — is now exactly what `error` is. The check's
  note saying `error` _"cannot be a `SessionError`… that is the member's nature, not an exception"_ described a
  nature this change replaced, so the note is corrected in place rather than worked around.

  ## The name stays `GenericError`

  A first draft leaned toward `SessionStartError`, arguing that a narrowed role was the only chance to remove the
  naming exception. **Review refuted it.** The derivation rule splits the literal and PascalCases it, so `'error'`
  yields `Error` — which shadows the global, and that is the exception's whole reason. `SessionStartError` is not
  the derived name either, so it needs an exception entry just the same; `NAME_EXCEPTIONS.size` stays 6. The
  exception is removable only by renaming the **wire literal**, which this slice does not scope. Renaming would
  have touched every consumer plus `typeAssertions` and bought nothing.

  ## Skew is logged, not hedged

  A client newer than its relay sees unaddressed refusals, which now match nothing — so the join runs to its
  deadline instead of reporting why it was refused. There is no version handshake anywhere in this protocol, so
  the alternative was a fallback, and a fallback here is the ambiguity this work removes. Both clients log once
  per session instead: the same shape and the same reasoning as the input-ack skew record, that logging is not
  matching. Approved as part of the breaking change, in that direction specifically.

  ## What the design review changed

  Eight things, and two of them were premises the plan had asserted rather than measured.

  - **The scope in the program plan was wrong in three ways.** Its table called this slice _"`session:start`/`error`
    echo (#512 finding 1 · #444's seven reply sites)"_. The seven reply sites had **already gone** — the input
    slice's door predicate removed them, so what is left is #444's own body. "Echo" was rejected by the same
    file's decision log, which had already refused a correlator on `error` on the grounds that attaching one
    makes it a different message. And the general role was already dead in code while two comments still claimed
    it.
  - **Three consumers, not one.** The plan said the dashboard's filtering would newly affect
    `DeviceViewer`, `SessionList` and `useAgentSession`. `SessionList` has no session gate at all, and **`error`
    never arrives at `useAgentSession`** — every producer is `sendTo(ws, …)` to the socket that sent
    `session:start`, and that hook's socket only sends `agents:list` and `device:shutdown`. So the filtering
    affects one consumer, and it is a no-op there: no `error` the wire can deliver to that socket will be dropped.
    A planned test for "the dashboard receives another session's error" was deleted — the wire cannot produce it.
  - **`useAgentSession`'s `error` and `session:joined` branches are unreachable**, and `inboundDisposition` named
    it as handling both. Correcting that by _removing_ the name made the table stale in the other direction, and
    the reverse-direction check said so: `at` answers "which files compare `.type` against this", which is still
    true. The name stays and the reachability went into the comment — with what the first attempt got wrong.
  - **Stale prose was in six places, not two — and a second review found five more that the first pass had not
    reached.** The sharpest of the first six is `SessionList`, where three comments justify a serialisation guard
    on `error` carrying no sessionId, and #527 has that list joining before it shuts down as a client-side
    stand-in for a missing server check, so someone deleting the guard on the strength of the old comment would
    unlock the wrong row's badge. The sharpest of the second five is worse, because this change's own headline
    claimed to have fixed it: the retired _"send `error` instead"_ argument was still on `SessionError`, the
    interface `GenericError` now `extends`, 140 lines above the rewritten block — so the contradiction moved
    inside one file instead of ending, and a #444 implementer reading the base was told to do the thing this
    slice removed, with seven line numbers that had drifted onto a `break` and three comments. Two files were
    where the first pass looked; the six places it then found were the ones that mention `error` by name. What it
    did not do was re-read the **paragraph above each edit**, and four of the five survivors were exactly that.
  - **`typeAssertions` needed two edits and a relocation.** One line was in the must-compile section and failed
    under `pnpm --filter @tapflowio/protocol typecheck`, which `tsc -b` does not cover. And the `@ts-expect-error`
    being flipped was the file's **only whole-message excess-property assertion** — flipping it would have retired
    an assertion class as a side effect, so the guard moved to another message instead.
  - **Fixtures the compiler cannot see.** Two `mcp-server` fixtures send `error` through a fake relay typed
    `Record<string, unknown>`; they carried neither `sessionId` nor the already-required `reason` and passed only
    because of the escape. `flow-runner` had **no `error` fixture at all**, so removing its escape was untested in
    both directions — three tests now cover it.

  - **The remaining `msg.sessionId!` count was wrong, and its composition was the misleading half.** A first
    draft of this note said "the eleven left are all agent→browser forwards". There were **twelve**, and four
    were not forwards: `stream:register`, `device:shutdown`, `forwardUnacked` and `handleAckedInput` — whose
    assertion was **dead**, since L5c's door predicate had already narrowed that parameter to
    `sessionId: string`. Removing it leaves eleven, of which eight are forwards and three are request-side
    paths that deliberately carry no address gate. "All forwards" invited the conclusion that the request side
    was settled, while `device:shutdown` sits on it with no ownership gate either (#527). The count and the
    composition are now recorded next to the sites, with an instruction to re-derive rather than trust the
    sentence.

  ## Mutations

  Ten in the author's round, none surviving — and then **four more from review, all four alive**, which is the
  number worth reporting.

  - **`session:joined`'s address held nothing.** Pointing it at `session.deviceId` passed relay 620, ios 382,
    android 263 and the static suite, while **no client could join at all**: both clients match
    `sessionId === mine` strictly and the dashboard's gate drops the rest. This slice added four assertions that
    each _refusal_ names the right session and zero that the _reply_ does — and the reply is the half that was
    already strict, so it had the largest blast radius and the least cover. The agent suites miss it because they
    wait on the type alone.
  - **The mcp skew log's stated reason was free**, and its keying contradicted its own docstring. Adding
    `&& this.waiters.length > 0` passed 81, so nothing held the "recorded whether or not anything is waiting"
    claim — which exists for the refusal that arrives _after_ its join gave up, the one caller who has been told
    "timed out" with no cause. Worse, the record keyed on the literal `'a pending join'`, so it was once per
    **process** rather than once per session: against an old relay the first refused session logged and every
    later one was silent. Keying per session is not available — the frame carries no address and `Waiter` keeps
    its predicate as a closure — and naming one anyway is a guess between pending joins, which is the false
    attribution this slice removes. So it is once per **client**, which is the honest cardinality: an agent is
    per session, a relay is per client.
  - **`flow-runner`'s once-guard was free too.** Its fixture answered a single `session:start`, so "once" and
    "every time" were indistinguishable. The premise that flow-runner already held all three properties was
    two-thirds true.
  - **The gate's new reach over `error` was unpinned in both directions.** Exempting `error` passed all 329.
    Unreachable today because `useRelay` opens a socket per hook, but the unreachability expires with #527, and
    then a foreign `session-not-found` tears down a healthy viewer. Four on the relay's `error` exits — and the fourth, the `join()` catch, **survived at
    first**: it is reached only when `join()` throws for something the two checks above it do not cover, so no
    existing test touched it. Forced with a spy rather than left unpinned, on the rule the previous slice arrived at:
    an address no test can hold is one that will drift.

  Three more on the mcp client survived at first for a subtler reason — the foreign-address test does not exercise
  the `sessionId === undefined` escape, because that half only fires for a refusal carrying **no** address. The
  test that holds it is the unaddressed one, and it holds the skew log and its once-guard too.

- 513b17b: feat(protocol): correlate input acks, and refuse an input from a socket that does not hold the session

  Closes #499. Five requests carry a required `requestId` — the four terminal frames (`input:touch:end`,
  `input:pinch:end`, `input:key`, `input:button`) and `input:type` — and so do the four replies. The four pairs
  already correlated arrive at the speed a person clicks a button; a swipe is dozens of frames, which is why an
  ack that missed its own deadline being consumed by the **next** input's waiter was never a corner case.

  **Opening and move frames carry none, and neither does `input:rotate`.** Nothing acks them, so an id there
  would name a waiter that does not exist.

  ## Required on both sides, and the compiler holds more here than anywhere else in this work

  No producer of these replies sends one unsolicited — `ackInput` fires on terminal outcomes only,
  `ackNoSession` answers a terminal input for a session the agent lost, and the relay answers one it cannot
  dispatch. Six producers of `input:error`, every one behind a request. So both sides are required, unlike the
  lifecycle pair (#521) whose replies have genuinely unsolicited producers.

  That matters concretely: the relay's own `input:error` goes through `sendTo(msg: RelayOutbound)` and the
  agents' through `sendMsg(msg: AgentControlOutbound)`, so omitting the echo is a **compile error** rather than
  something only a test could catch. That is the position #521 could not reach, and it is exactly where the same
  defect had already shipped twice.

  `input:type-error` moved from `AgentToBrowser` to `RelayOrAgentToBrowser`, because the relay produces it now —
  the compiler refused the send until the union said so, which is the rule `relay/AGENTS.md` states.

  ## The eleven input cases became two clauses

  Written into the shared body, the correlator gate would have dropped every opening and move frame with it: no
  swipe, no pinch, no rotation, and nothing said. `correlatedRequestsGated` resolves fall-through by sharing the
  next non-empty body, so it would have read one gate as covering all eleven — the trap `#521`'s own comment
  documents, walked into one slice later. `TERMINAL_INPUT_TYPES` is deleted: the clause labels are the
  definition now, and a second source of truth for "which inputs are answered" is what this work removes.

  ## The sender must hold the session — on every branch, not just input

  Folded in rather than deferred, because it changes this layer's own reasoning: with the check, a foreign
  `input:error` cannot reach the dashboard, so the rule "the dashboard does not correlate" gets a durable reason
  instead of one a later slice deletes.

  Review then found that **input was one branch of ten.** The relay acted on every browser→agent command on the
  strength of the session existing — `clipboard:write` pasting attacker text into the victim's device,
  `clipboard:read` pressing copy or cut on it with the payload landing on _that_ tester's host OS clipboard,
  `session:end` deleting their session. `clipboard:data` has asked the mirror-image question since the bridge
  was written, with the reason beside it; the browser direction had none anywhere. And the hole was already
  documented in-repo: `SessionList.tsx` sends `session:start` before a shutdown purely to work around it, and
  its comment says so.

  So the check now covers the five acked inputs, `device:boot`, `open-url`, `app:install`, `app:launch`,
  `app:clear-state`, `clipboard:read`, `clipboard:write`, `session:leave` and `session:end`. Nothing in-repo
  relied on the old behaviour — every sender joins first, and the dashboard's app, deeplink and clipboard
  senders all live under the component that joins.

  `dispatchTarget` decides it once: session exists, this socket holds it, agent connected. That collapsed three
  conditions spread across seven `case` bodies as two each — with ownership in none of them — so the cases got
  **shorter**. The app-command handlers check ownership directly instead, after the session lookup and before
  the build lookup: the resolver also decides agent liveness, and using it there would move `agent offline`
  ahead of `Build not found`, changing which of two simultaneous problems the caller is told about.

  A refusal is **answered where a waiter exists** and dropped where none does. Answering is the load-bearing
  half: a session that has never acked reports silence as _success_, so dropping would report a command that
  never left the relay as having landed. `session:leave` and `session:end` have no reply, so they are dropped —
  the same asymmetry as the input frames nothing acks.

  `not-session-owner` is its own reason on this set's rule — one reason per thing a consumer must do
  differently — and it is the only member that can promise nothing reached the device, so the first whose advice
  says "retry after joining" without a hedge (#491). Two prose strings behind it (`ownershipRefusal`), because
  telling a caller the session is in use when it is idle steers it off a device it could have had.

  **`device:shutdown` is the one command left out of the ownership gate**, and the blocker is the dashboard
  rather than the relay:
  three of its four senders come from `useAgentSession`, whose socket never joins, so the gate would break going
  back and the unmount teardown. The question is whether that hook should join — #527.

  One diagnosis improved for free: `open-url` answered `'agent offline'` for a session the relay does not have,
  which is the wrong-diagnosis class #492 fixed for `device:boot` and `input:error` and had left here. The
  shared resolver corrected it, and the test that pinned the old prose says so.

  ## A second door predicate: the request must name a session

  CodeRabbit found that `isCorrelated` validated `requestId` only, so a command with no `sessionId` — or an
  empty one, which type-checks and which `mcp-server`'s bare `z.string()` tool schemas let a model produce —
  reached the reply builders and shipped a frame whose **required** `sessionId` `JSON.stringify` erases. Every
  consumer's session gate then discards it, so the caller waits out its deadline with the diagnosis in hand and
  no way to attribute it. `isAddressed` closes it at the same doors, with the same policy: not forwarded, not
  answered, logged.

  **Dropped rather than answered, and the note this contradicts is in this repo.** `SessionError`'s doc said
  "the only correct thing for it to send with no sessionId is `{ type: 'error' }`". That was written before
  requests carried a second correlator, and its own premise refutes it now: `GenericError` has no `requestId`,
  so a caller that receives one cannot attribute it and waits out the same deadline it would have waited out on
  silence. Answering was never the payoff — not shipping a frame that violates its own declaration is, and
  dropping achieves that more cheaply. Widening `SessionStartFailure` to carry an "unaddressed" reason was the
  alternative, and it is what L5d is for: that union's own doc says it has a single producer in
  `handleSessionStart`, so adding a member would make that false while pre-deciding what `error` is.

  Narrowing `dispatchTarget` to `sessionId: string` is what found the doors — exactly four compile errors, then
  the handler signatures carried the rest. **Seven `msg.sessionId!` assertions went away** on the request side
  as a consequence, which is the payoff `SessionError`'s doc predicted. Twelve are left, and reviewing L5d
  corrected the sentence that stood here: they are **not** all agent→browser forwards. Eight are; `stream:register`,
  `device:shutdown` and `forwardUnacked` are request-side paths that deliberately carry no address gate, and
  `handleAckedInput`'s assertion is dead — this slice's own door predicate narrowed that parameter, so the `!`
  counted itself into #444's body while asserting nothing. Still #444, minus one line L5d removes.

  Three places got the predicate and then **had it removed again**, because a mutation showed there was nothing
  observable to hold it with: the unacked input clause, `device:shutdown`, and the two session commands. In each
  the frame is dropped by the session miss anyway, so the gate bought only its log — one line per
  `input:touch:move` in the first case, which is the ~60/s the ownership warn had already been removed from that
  same method for. A line no test can hold is a line that will drift, and the reason is recorded at each site.

  ## The ledger records a _correlated_ ack

  `ackedSessions` gates whether silence is fatal, and it now records `input:done` only when it carries a
  correlator. `strict` licenses one inference — _silence here is an anomaly, not an agent that does not ack_ —
  and for an agent that never carries a correlator, silence at the waiter is **structural**: its acks can never
  match. Recording it would make every input after the first report a failure the agent had no way to avoid.

  Not a provenance question, which is what a first draft claimed: an id-less `input:done` is still the agent's
  word. What it lacks is attribution, and attribution is the waiter's question. Nor is the condition "an id
  _this client_ issued" — that needs a set of issued ids outliving their waiters, and since the late ack is
  precisely the one worth recording, the set would never shrink in a long-lived stdio process.

  The cost lands on agents predating the correlator, and it is not a revert of #457: `mcp-server/AGENTS.md`
  already documented that an agent whose acks never arrive keeps the optimistic path. This widens that
  exemption from "predating the ack protocol" to "predating the correlator". Because there is **no version
  handshake anywhere** in this system, an id-less ack is the only skew signal that exists — so it goes in a
  second set carrying no strictness, logged once per session. Dropped silently, the session would return to
  optimistic reporting, which from an operator's seat is indistinguishable from #457.

  ## Not closed: #517

  `input:keyboard:toggle` stays out, and not for the reason a first draft gave. It **has** a reply on iOS
  (`keyboard:toggled`) with a consumer that sets session state; what is missing is the **failure half** — the
  `.catch` only logs, so the pending flag never clears and the button latches off. Correlating a pair whose
  failure half does not exist leaves it half-correlated, and the missing half is platform-asymmetric, since
  Android's toggle has no device-side effect at all. #517 is the prerequisite.

  ## What the mutation round found

  **26 mutations, none surviving** — reached in three rounds, and what each round found is the story.

  Round one: nine mutations, **five alive** on a green suite. The correlator gate deleted (600 relay tests
  passed), the ownership check deleted (600 passed), both agents' `input:done` echo replaced with a literal,
  `ackNoSession`'s echo likewise, and a `sessionId` fallback added back to the waiter (77 passed). Every one was
  a test the plan had specified and this work had not written — the same blind spot as #521, where fixing the
  fixtures felt like finishing.

  Round two, after six new tests: the two review channels found **four more**, and the sharpest was not a gap in
  coverage but a new failure mode. `flow-runner`'s `tap`, `swipe` and `pressKey` await nothing, so setting their
  minted id to `''` left all 63 tests passing while every frame was dropped at the relay's door — a flow whose
  taps never left the relay reports **PASS**. The old code could not fail that way, because there was no id to
  get wrong. Also unpinned: the `input:error` half of both agents' `ackInput` (worse than a hang — an unmatched
  reply resolves _optimistically_, so a stated device failure reaches the caller as success), `input:type`'s
  correlation on all four producers and both consumers, and an **unheld** session accepting input from anyone.

  Round three: two of the tests written in round two were themselves Potemkin. Both staged a stale reply and
  then asserted the request count — 1 either way, so they passed with the correlator check deleted. Making the
  stale reply an _error_ is what made which reply resolved the call observable. Asserting a property needs the
  mutation that removes it to fail, and counting requests was not that.

  Six more mutations cover the widened gate, including one that collapses the two ownership prose strings into
  one (nine tests) and one that drops `Session not found` from the resolver (four).

  Two things caught by tooling rather than by me. `pnpm exec tsc -b` does not cover
  `protocol/tsconfig.assertions.json`, so four errors there passed straight through my checks until the
  pre-commit hook refused the commit. And lint reported `TERMINAL_INPUT_TYPES` dead the moment the clause split
  removed its last use.

  Promoting the request side hung both agent suites rather than failing to compile: 64 fixtures across
  `IOSAgent.test.ts` and `AndroidAgent.test.ts` send these inputs from inside `JSON.stringify({ … })`, where no
  annotation exists for a compiler to check. Third slice in a row on that surface — worth a rule for the agent
  packages, as the dashboard has, and out of scope here.

- b5ea86d: feat(protocol): give `input:error` a machine-readable `reason`, so a caller can tell "retry" from "reconnect" from "never"

  `input:error` carried a human-readable `message` and nothing else, so three different situations
  arrived looking identical: an input that would land if retried in 200ms, one that needs a reconnect,
  and one that will never work. With nothing to switch on, a caller could only give up or blindly retry.
  (This is not the same gap as `mcp-server`'s optimistic timeout fallback, which fires when no ack
  arrives at all — that is #457.)

  `InputErrorReason` is a closed string-literal union in `@tapflowio/protocol`, and the set comes from
  **what a consumer must do differently** rather than from how many internal states an agent has. iOS
  has one input path; Android has three. Each agent maps its own states onto the smaller set, so the
  wire contract stays the same size while the platforms stay different.

  - **`channel-starting` is the reason that had no name.** iOS's input helper needs a measured
    186–247ms after spawn before an injected frame reaches the device, and `device:ready` can arrive
    inside that window — so a caller tapping as soon as a boot returned was told the channel was gone
    when it was merely coming up. It now says so, and says to retry.
  - **A refusal from a healthy channel is no longer reported as a dead one.** iOS's gesture-ownership
    guard answers `no-gesture`, which carries its own advice: the message was well-formed and the
    channel may be fine, but _this_ frame can never land, so the caller opens a new gesture rather than
    retrying or giving up. Ownership is checked before readiness, because a gesture whose opening frame
    was refused inside the start-up window owns nothing — reading readiness first told that caller
    "never retry" for the very case `channel-starting` exists to serve.
  - **iOS answers a terminal input for a session it lost state for** (#489), where all four terminal
    handlers used to return silently. Nothing answered, so the caller waited out its own timeout — and
    MCP's fallback reports that as success. Both agents now map it to `channel-unavailable`. Opening
    frames stay silent, since nothing is waiting on them.
  - **`message` stays free prose.** That is what lets iOS keep `unknown key code: KeyFoo` while adding
    `reason: 'unsupported'` — the machine field is separate, so parameterised wording survives.
  - `mcp-server` includes the reason in the error it raises. Acting on it — retrying `channel-starting`
    rather than failing, and dropping the optimistic fallback for reasons that say never retry — is
    separate work.

  The field landed **optional**, so an agent that predates it omits it and nothing breaks; absence means
  _unknown_, never _fine_, and a consumer meeting an unfamiliar reason must treat it as
  `channel-unavailable`. Making it required is the breaking step, and **a later slice in this same release took it**: as of v0.19.0 `reason` is required and `message` is optional. The paragraph above describes the field as it landed, not as it ships — see the root changelog for the upgrade-together note. There is
  deliberately no shared message table: one would be a runtime value, and the protocol entry point has
  to erase under `import type` so it never reaches the dashboard bundle.

- a669e0a: feat(protocol): correlate device:boot and device:shutdown, with an optional correlator

  The lifecycle pair joins the four already correlated by `requestId` (`screenshot`, `ui:tree`, `clipboard`, the
  app commands). It is the first one whose correlator is **optional on every reply**, and that difference is the
  whole design — `device:ready`, `device:boot-error` and `device:shutdown-done` all have producers that answer no
  request at all, so absence has a real and permanent meaning: _this frame is not the answer to anything_.

  Consumers correlate when the id is present and fall back to `sessionId` + type when it is not
  (`mcp-server`, `flow-runner`). Precisely what that fallback carries is worth separating, because the two
  id-less cases arrive by different routes and only one of them is permanent:

  - **Android's mid-session `device:boot-error`** carries a `sessionId`, so it reaches a client waiter through
    the fallback. There is no request behind it and never will be, so this half does not expire.
  - **An agent predating the echo** likewise, on either reply. This half is compatibility slack.
  - **The relay's `device:ready` replay** does _not_ reach a client at all — it carries no `sessionId`, so the
    comparison ahead of the fallback excludes it, which is the point of the "not satisfied by the replay" test
    in both clients. It reaches the **dashboard**, and it gets there because `'sessionId' in msg` is false, not
    because of anything the correlator or the fallback does.

  What correlation buys on this pair is narrower than the obvious claim, and review caught the first draft
  making the obvious one. It does **not** let two concurrent boots both resolve: the agents answer a
  superseded boot with nothing at all (`bootSeq` returns silently at every checkpoint), so one of two
  overlapping boots times out either way. Both clients' `dispatch` resolves the first waiter whose predicate
  matches and then stops — so on `sessionId` + type alone, that single reply went to the boot registered
  **first**, the superseded one, and the boot that actually happened was reported as a failure. The
  correlator sends the reply to the request it answers. Same one timeout, correct attribution.

  ## What the design review changed

  The first draft made `DeviceReady.sessionId` required and had the relay stamp its replay, then argued the pair
  faced a forced choice: correlate strictly and break every agent predating the field, or keep a fallback and
  let a replayed ready satisfy an in-flight boot. Measured against a real `RelayServer`, that choice was
  manufactured by the draft itself. **The discriminator today is that the replay carries no `sessionId`**, and
  both boot waiters already depend on it — so requiring and stamping it is what deletes the working guard.
  Dropped from this change; `sessionId` on `device:ready` stays optional, and closing #516's deferral is its own
  later slice, which must carry a test pinning the _value_ stamped. There is none: with the stamp mutated to
  `session.deviceId` — a plausible slip on a line whose payload reads `{ deviceId: session.deviceId }` — the
  relay's 591 tests, the dashboard's 317 and the entire static suite still pass.

  The review also found the producer inventory wrong. `AndroidAgent.restartVideoStream` sends
  `device:boot-error` for a video stream that died mid-session and failed to restart, with no `device:boot`
  anywhere behind it. So that message qualifies for an optional correlator **on its own merits**, and the
  consumer that reads it — `DeviceViewer`, the only surface reporting a dead stream — must not gate on the
  correlator at all, or #426's symptom comes back.

  ## Optional means tests are the entire enforcement

  `<Pair>ReplyBody` cannot be built for a field an object may omit: `Omit<T,'sessionId'|'requestId'>` is
  satisfied by an object with no correlator, so the excess-property trick that catches a freshly minted id has
  nothing to bite on. And `scripts/__tests__/correlatedRequestsGated.test.mjs` derives its set from _required_
  declarations, so it does not see this pair — including the position that matters most: **the relay is itself a
  producer of `device:boot-error`**, answering a boot it cannot hand to an agent. An uncorrelated diagnosis
  there is read as unsolicited and discarded, and the caller waits out its deadline instead of failing. That
  exact defect shipped twice from agent code (`open-url:error`, then `clipboard:error` a slice later); here it
  sits where no check can reach, so a relay test holds it.

  Every echo, prohibition and fallback added here was verified by mutation — 23 of them, each failing only the
  tests that claim it: 5 on the relay, 7 across the two agents, 5 on the dashboard, 6 across the two clients.
  Two are worth naming. A _strict_ correlator gate on `device:boot-error` and a mere _presence_ check fail
  **different** tests, which is why both prohibition cases exist. And replacing an echoed id with a freshly
  minted one fails the echo test **and** the absence test — a shape that, one slice earlier, only the first of
  those caught.

  Those 23 shared a blind spot, and review found it: they all probed what the gate does **with** an id, so
  nothing held how ids enter or leave `bootIdsRef`. Four mutations survived the whole suite. The sharpest is
  `bootIdsRef.current.clear()` added to the `device:booting` branch — invited by the comment above it, since
  that is where every other per-cycle record is dropped, and fatal because both agents send `device:booting`
  _before_ the ready answering the same boot. Every real ready is then rejected while `setDeviceReady(true)`
  has already run: spinner cleared, device apparently healthy, app never installed, on the primary
  manual-testing path. The other three: the rebind boot's id never registered (so #426's recovery keeps the
  picture and loses the controls), the `session:joined` cross-cycle clear removed, and `mcp-server`'s
  `shutdownDevice` correlator left off the wire — where `toMatchObject` ignored the absent key and the
  mismatch test still passed against a hardcoded foreign id. All four are pinned now, each by one test.

  ## `DeviceBoot.requestId` is required, and 42 test fixtures said nothing about it

  The request side is asymmetric on purpose, and for a mechanical reason rather than a stylistic one: a
  request passes _through_ the relay, so one door gates and logs every sender at once, while a reply does not
  — the relay forwards it with `JSON.stringify` without inspecting it. Absence also has no legitimate meaning
  on a boot: nothing originates one but a browser. So `device:boot` is the pair's one required correlator,
  which is what puts it inside `correlatedRequestsGated` and makes the door gate reachable. `device:shutdown`
  stays optional because the relay sends that one itself, from its idle timer.

  Promoting it produced no compile error, and the reason is worth stating precisely, because the convenient
  version of it is false. It is **not** that the compiler cannot see the request side: all four `device:boot`
  senders go through a sink typed `BrowserToRelay` (`DeviceViewer.tsx:38`, `mcp-server/src/client.ts:182`,
  `flow-runner/src/RelayClient.ts:126`), so every one of them would have errored. They did not error because
  the earlier hunks of this same commit had already added the ids. The request side is exactly where the
  compiler works.

  What it produced instead was **two hung agent suites**. 42 fixtures across `IOSAgent.test.ts` and
  `AndroidAgent.test.ts` send `device:boot` through a real `RelayServer`; the door now drops them, and each
  test waited for a `device:ready` that never came. None was a type error, and typechecking the test folders
  would not have found them: those literals sit inside `JSON.stringify({ … })` at an untyped `ws.send`, so
  there is no annotation for a compiler to check. Three _documented_ recipes had the same shape and were
  updated too — `ios-agent/AGENTS.md`, `test-utils/src/socket.ts` and `test-utils/AGENTS.md` — because that
  first one is the file the 42 were copied from, so leaving it would hand the next contributor the same
  30-second mystery. The dashboard has a rule against untyped injected fixtures ("not `as never`, not a local
  shape") and the agent packages have no equivalent; worth one, and out of scope here.

  `case 'device:boot': case 'device:shutdown':` was one fall-through clause and is now two. Not cosmetic: the
  correlator on `device:shutdown` cannot be required, because the relay originates that message from its idle
  timer with no browser behind it — so a gate written into the shared body would have stopped the dashboard's
  four senders and the relay's own from reaching the agent, silently, in the one direction nothing replies to.

  `DeviceViewer` correlates `device:ready` only past the line that clears the spinner, which newly rejects a
  straggler ready from an earlier boot cycle — it used to release the current rebind and install on top of an
  install already in flight. It does **not** close the duplicate-install-on-re-join case that branch's comment
  describes: the replayed ready carries no id, so it is still accepted, and it has to be while an agent
  predating the echo answers the same way. Separating those two needs the replay to be identifiable on its own,
  which is the deferred `sessionId` tightening.

- 2dd32ee: fix(mcp-server): stop reporting an unacknowledged input as success

  `awaitInputAck` waited 2s for `input:done` / `input:error` and, on timeout, **returned successfully**.
  So `tap`, `swipe` and every other terminal gesture reported success when nothing had acked, and the
  model driving the session was told the tap landed and moved on.

  The fallback existed for agents predating the input-ack protocol and outlived them: both agents ack
  every terminal input unconditionally (#484, #488), and since #495 every producer also sends a
  machine-readable reason. When both ends are current, silence means something is actually wrong — which
  is exactly the case the fallback converted into a success.

  **Silence is now reported as "could not confirm", not as a drop.** That distinction is load-bearing:
  `ackInput` awaits a device verify on the first input after a boot or reconnect, on the same Mac the
  relay gates at 80% CPU, so an ack past the window can belong to an input that _did_ land. Calling that
  a drop invites a retry, and a retry of a landed input duplicates it. The error tells the caller the
  input may have landed and to check device state rather than repeat it.

  A dropped relay connection is answered the same way. It used to be reported as "the input was not
  dispatched", which was wrong: every caller sends its input before awaiting the ack, so by the time the
  socket closes the input has left the process and the relay may already have forwarded it.

  **Whether silence is fatal is decided by what the session has already done.** A session that has
  answered an input with `input:done` is judged strictly; one that never has keeps the optimistic path,
  because an agent that does not ack at all is exactly what the fallback was for. This degrades in the safe
  direction and needs nothing on the wire.

  `input:done` specifically, not any ack: the relay originates `input:error` to the client for a terminal
  input it cannot dispatch, so counting those would let one agent-offline blip mark a session as acking
  when its agent may never have answered anything — and then report every later input as unconfirmed on
  evidence the agent did not produce. A session that has never had an answer keeps the optimistic path
  indefinitely, so #457 is unchanged for an agent whose acks never arrive; what this buys is that once a
  session answers, silence after that is reported.

  One gap stays open and is documented rather than papered over: an ack carries no correlation id, so an
  ack arriving after its own input timed out is consumed by the next input's waiter. That needs a field on
  the wire (#499).

  **An `input:error` now carries advice, not just prose.** Each reason maps to what the caller should do
  — boot the device, reconnect, send the same input again in a moment, or never retry this one. The
  `no-gesture` advice warns that part of the input may already have been applied, because that reason
  covers both "nothing landed" and "the opening frames landed and only the last was refused".

  Nothing is retried automatically. That was the first design and was discarded after review: the wire
  cannot distinguish those two `no-gesture` cases, so a client that retried would sometimes apply a drag
  twice with nobody able to see it had — and `TapflowClient` also drives `run_flow`, where a retry would
  make deterministic replay non-deterministic. Retrying is the caller's decision, which is why the reason
  now comes with advice instead of an action.

- 0c63c1b: A session belongs to whoever opened it, not to one of their connections

  Two defects met on the same two lines, and both came from the relay answering "who holds this session?"
  with a socket.

  What a user can observe:

  - **Nobody else can power off a device you are using.** Any signed-in client that knew a session id could
    shut down a colleague's simulator mid-test. The check that stops it could not be added before, because
    the browser tab that holds a session and the one that sends the shutdown when you navigate away are
    different connections — so refusing "not the holder" would have refused the tab's own cleanup and left
    devices running.
  - **A Wi-Fi blip no longer costs you your session.** The relay treated a connection as present until TCP
    or a heartbeat noticed otherwise, up to a minute after a laptop went to sleep. Returning within that
    window meant being told the device was in use — by yourself. The tab is now recognised as the same tab, and the
    session is simply resumed — unless you reload while the connection is down, which gives the page a new
    identity even though it is the same tab, and waits out the window.
  - **A device whose tester's connection died frees up in at most 45 seconds** rather than up to a minute,
    and no longer appears free while it is still in use. (A tester who leaves a tab open is a different
    case — that is the idle timer's, not this.) Both questions — "can I take this?" and the "In use" badge — now read the same signal, and
    that signal is when the holder last answered rather than a flag that read every healthy connection as
    gone for the length of a round trip.

  The relay reads an optional `client` parameter on the WebSocket handshake and pairs it with the signed-in
  user, so a leaked identifier is useless to anyone else's account. A connection that sends none is given one
  of its own, which is per-connection ownership — what it had before. The shutdown check is then relaxed for
  that session, because every one of such a client's connections is a stranger to the others and gating them
  would refuse the client's own cleanup — **but only for the same signed-in user**, so an older build never
  becomes a way to power off someone else's device. Whether an identity was claimed or granted is recorded by
  the relay, not read back out of the identifier, which the caller supplies.

  The dashboard sends one value per open page. Deliberately not stored: browsers copy that storage into a tab
  opened from another one, and two tabs sharing an identity would take each other's devices silently.

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

- 2317d50: feat(protocol): open-url carries a requestId, and both replies echo it

  First pair of the request/response correlation work. `open-url` requests carry a `requestId` and
  `open-url:done` / `open-url:error` echo it, so a caller matches its own reply instead of matching on
  `sessionId` + message type and taking whichever arrives first.

  Nine request/response pairs correlate that way today, and it is the shared root of #499, #512's first
  finding, and the seven relay reply sites in #444. Three other pairs — `screenshot`, `ui:tree`,
  `clipboard` — already carry a `requestId` and have no such issues. This layer extends what works rather
  than inventing anything.

  **`requestId` is required on the reply, not optional, and the reasoning is worth keeping.** A first draft
  made it optional so that an agent predating the field would not falsify the declaration. Review measured
  that decision and reversed it:

  - Required yields **complete, precise** in-repo compile errors — ten, at exactly the ten production sites
    for this pair, nothing else. L4a's typed agent sends are what make the write side fully covered.
  - Optional needs a static check to replace the compiler, and that check **cannot exist.** Presence is
    checkable; the property is _provenance_ — that the id is the request's. A check built and run against
    the clipboard family (100% correlated today) produced seven false positives, because
    `respond({ sessionId, requestId, ...body })` puts the `type` literal and the id in different object
    literals; and it passed when an echo was replaced with a freshly minted id.
  - Absence would carry **two** meanings wanting opposite handling — "an old agent" and "not a reply at
    all". The relay's `device:ready` replay is a permanent producer of the second, and reading it as the
    first is the `{booted: true}` for a boot that never happened that #516 measured and refused to ship.
  - The repo had already decided this seven times: of the eleven messages declaring `requestId`, seven are
    agent-produced replies and all are required.

  The echo is enforced by a mix, and the mix is worth stating precisely because review measured 13 attacks
  and the type caught 3. **Omitting the correlator is a compile error** — from `requestId: string` being
  required on the reply interfaces, reached through the agents' typed send helper. **A freshly minted id
  written as a literal at the `respond(...)` call is an excess property** — that one is `OpenUrlReplyBody`,
  the reply minus the ids, mirroring `ClipboardReplyBody`. The agents spread `...body` **first** so that a
  body _variable_ carrying an id cannot override the real one; excess-property checking does not fire on
  variables, and an earlier draft had the ids first, which let a wrong id win.

  What the types do **not** cover: the agents' send helper accepts any `string`, so a site that bypasses
  `respond` type-checks. Each agent's echo tests are what catch that, including a **concurrency** test —
  hoisting the correlator out of per-request scope compiles clean, passes every other test, and answers two
  in-flight requests with the second one's id, which is precisely the class this layer removes. So each
  remaining pair needs its own echo tests; this helper does not remove that work.

  There is deliberately **no fallback** to `sessionId` + type. The `fixed` version group locks protocol,
  agent-core, both agents and the relay together, so the in-repo skew window is zero. An `open-url` with no
  `requestId` is dropped rather than answered — by both agents **and by the relay**, which is one policy
  instead of the two an earlier draft had: it answered with `requestId: msg.requestId!`, and that is not the
  `sessionId!` beside it in kind. `sessionId!` feeds a read, so a miss still produces a visible error;
  `requestId!` feeds a write into an outbound frame, where `JSON.stringify` drops the key and ships an
  `open-url:error` whose required correlator is absent — which every correlating consumer then discards,
  turning "agent offline" into a caller waiting out its full deadline. The relay drops such a request at the
  door now — before either branch, so forwarding and answering share one policy rather than two. General
  inbound validation is still issue #444's; this is one required field on one message, whose absence the
  relay can act on locally.

  **A reply from a third-party agent predating this field is dropped the same way** — the dashboard shows no
  toast and `mcp-server` / `flow-runner` wait out 15s. In-repo that cannot happen (the `fixed` group), but an
  independently installed older `mcp-server` or `flow-runner` will time out `openUrl` against a current
  relay. That is the upgrade note for this release.

  Two additions from an earlier draft were **removed** after review measured them inert: a `RequestReplies`
  / `ReplyOf` mapping with zero consumers repo-wide (deleting it left `tsc` and all 255 static assertions
  green — exactly the unenforced-mapping property its own doc comment criticised), and `OpenUrl` in
  `RelayToAgent`, whose stated reason was false: neither agent consumes that union, both still read a
  hand-written inbound literal, and removing the member changed nothing. They come back when a second pair
  needs them and something checks them.

  **Routing is unchanged and this does not fix it.** Replies are still delivered to whichever socket holds
  the session rather than to the requester, so an `mcp-server` deeplink on a dashboard-held session now has
  its reply dropped silently by the dashboard instead of toasted as a lie. Correct at both endpoints, still
  misaddressed in the middle — the relay already keys replies by `requestId` for `screenshot` / `ui:tree`
  via a pending map, and the same shape would fix it.

  **The dashboard was a producer nobody had counted, and correlating it fixes a live bug.** It sends
  `open-url` from `DeepLinkDialog`, and `DeviceViewer` toasts the reply — but a reply does not go to whoever
  asked, it goes to whichever socket holds the session, so the viewer was showing "Deeplink opened" for
  `mcp-server`'s deeplinks. The viewer mints and records the id now and toasts only its own. The id comes
  from `getRandomValues`, not `crypto.randomUUID`, which is secure-context only and therefore absent on the
  plain-HTTP LAN deployment that is tapflow's primary path.

  Also: `open-url` had **no test on the iOS side** — the whole change passed that suite because nothing
  exercised the handler, and `SimctlWrapper`'s test double had no `openUrl` at all. Both agents now cover
  the echo and the drop.

- 760e27a: feat(protocol): the app commands carry a requestId, and the relay carries it across a rebuild

  `app:install`, `app:launch` and `app:clear-state` now correlate by `requestId` like `open-url`, so a caller
  matches its own reply instead of matching on `sessionId` + message type and taking whichever arrives first.

  **Two of the three are not forwards, and that is the new part.** `open-url` was re-serialised whole, so the
  correlator rode along for free. `app:install` / `app:launch` arrive carrying a `buildId`, and the relay
  looks up the build and sends the agent a **different message** — so the id has to be copied across the
  rebuild or the agent's reply, which the relay forwards without inspecting, cannot be attributed to
  anything. `AppInstallToAgent` / `AppLaunchToAgent` declare it required, which makes _dropping_ the copy a
  compile error.

  **The reply direction is held entirely by tests, and the first version of this change had none of them.**
  Review made both relay `fail()` closures, the clear-state error exit and all six agent `respond` helpers emit
  a fabricated correlator, and every suite held its baseline exactly. A wrong echo is worse than a
  misattribution now that consumers gate strictly: the dashboard discards the reply and nothing clears
  `installing`, so the Launch control never appears, and the MCP caller burns its full deadline. There are
  assertions on all nine relay error exits, echo tests per pair on both agents, six concurrency tests (the
  mutation that hoists the correlator out of per-request scope was invisible to everything else), dashboard
  tests for both gates, and `mcp-server` tests that fail if the predicate reverts to `sessionId` — which it
  could, silently, before.

  **Nothing type-checks that the copied value is the request's**, and that is not for want of trying. Four
  candidate guards were built and broken: a branded `CorrelatedId` is laundered by any cast to the brand,
  because a brand names a _kind_ while provenance is a property of the _instance_ and TypeScript has no
  value-dependent types; a generic `Omit`-body helper does not compile without a cast of its own, which is
  worse than the literal it replaces since a literal at least gets its whole shape checked. So the reply side
  keeps its `<Pair>ReplyBody` — worth it there, with ~20 literal sites — and the request side is held by
  tests, one per handler, asserting the forwarded id is the one that came in.

  **`device:shutdown` was in this slice and came out.** It had no error type at the time (#542 added one
  later in the same release), and two properties this shape cannot express: the relay **originates** one itself when a browser socket closes (`DeviceShutdown` is a
  single interface shared by both directions, so a required correlator would force the relay to invent an id
  for a request nobody made — exactly what the door checks exist to prevent), and `device:shutdown-done` is
  consumed by `SessionList` as a **device-status broadcast** rather than as a reply to its own request. That
  second property is why `device:ready` was carved out too, so the two go together into the slice that
  decides what a relay-originated request and a dual-role reply mean. It also cannot have a meaningful
  concurrency test — the agents' shutdown handler returns early once state is gone, so a second request
  produces no second reply to correlate.

  **An agent older than this field strands the command, and that is the upgrade cost.** The earlier draft
  argued the skew window is zero because the packages share a `fixed` version group — but `fixed` makes them
  _release_ together, not _install_ together, and the agent runs on a tester's Mac installed separately from
  the relay. Such an agent's `app:install-done` has the key absent, the dashboard discards it, and "Installing…"
  persists with no Launch control. For `open-url` last slice the same skew cost a toast; here it costs the
  primary manual-testing flow. The relay's door checks log now, since otherwise all three hops are silent.

  **Door checks, one policy per request**: an uncorrelatable request is not forwarded, not rebuilt and not
  answered, since every reply these produce declares `requestId` as required. They go through a type
  predicate rather than a bare `typeof`, because a bare check narrows the property and not the object — the
  handler call would not compile — and because narrowing does not survive into a nested function, so a
  `fail()` closure built after the check sees `string | undefined` again, whose shortest fix is the
  `msg.requestId!` that was removed for `open-url` in the previous slice.

  `clipboard:read` / `clipboard:write` get the same door check, and `clipboard:error` stops asserting
  `msg.requestId!`. Not part of this slice's pairs — clipboard has carried a required correlator since it was
  written — but it had the identical defect, and leaving it would have made this change's own claim of one
  policy at the door false the moment it landed.

  The dashboard mints and records ids for its install and launch, like it does for deeplinks, so an
  `mcp-server` install on a session this viewer holds no longer flips its install state. The relay delivers a
  reply to whichever socket holds the session, not to whoever asked.

  One thing this does **not** cover, stated because "every exit carries the request's id" would be false: a
  throw out of the build lookup — SQLITE_BUSY, a closed database, I/O — unwinds to the message-loop catch and
  answers nothing at all. Pre-existing and unchanged.

- Updated dependencies [a5466b9]
- Updated dependencies [d63811f]
- Updated dependencies [15593db]
- Updated dependencies [42987e1]
- Updated dependencies [2bf043f]
- Updated dependencies [87cd901]
- Updated dependencies [c67a690]
- Updated dependencies [4d4fe13]
- Updated dependencies [57981a1]
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
- Updated dependencies [1123d63]
- Updated dependencies [0c63c1b]
- Updated dependencies [5ab537d]
- Updated dependencies [e84a2ea]
- Updated dependencies [b459157]
- Updated dependencies [2317d50]
- Updated dependencies [760e27a]
  - @tapflowio/protocol@0.19.0
  - @tapflowio/flow-runner@0.19.0

## 0.18.0

### Minor Changes

- 7637be3: Add `@tapflowio/protocol`, one wire contract for the WebSocket messages exchanged between browser, relay and agents, and type every place that originates a message against it.

  Nothing checked those messages before. The relay built them as inline object literals passed to `JSON.stringify`, the dashboard's `send()` took `object`, and mcp-server's took `Record<string, unknown>` — so the definitions each package kept were descriptions, not contracts, and three of them had already drifted from the wire:

  - `stream:request-idr` was sent by the relay from two places while absent from its own `MessageType`.
  - `input:key` was documented as `payload: { key: string }`. Every sender and both agents use `{ code, modifiers }`, with `modifiers` a HID bitmap — so the field name and the type were both wrong.
  - `input:touch:end` and `app:clear-state` carried payloads from mcp-server that no definition mentioned.

  All three are fixed by the contract now describing what actually travels. The relay's 25 originating sends go through a typed `sendTo`, which also folds in the `readyState` check that was repeated at most call sites and missing at some. `Session.chromeData` is `ChromePayload` rather than `unknown`; the relay still only stores and forwards it, but a new platform now extends the union instead of the relay.

  No message changed shape on the wire. This is types only, and `@tapflowio/protocol` emits no runtime code — consumers import it with `import type`, so nothing reaches a browser bundle.

### Patch Changes

- Updated dependencies [2aebd34]
- Updated dependencies [f4235e5]
- Updated dependencies [7637be3]
- Updated dependencies [a391b85]
- Updated dependencies [273c016]
  - @tapflowio/protocol@0.18.0
  - @tapflowio/flow-runner@0.18.0

## 0.17.0

### Minor Changes

- eaa78ac: MCP input tools now report what actually happened instead of always reporting success.

  `tap`, `swipe`, `press_key` and `press_button` were fire-and-forget: the tool answered `{tapped: true}` no matter what the agent did with the input. Against a session whose device is not booted the input was dropped and still reported as success — a false positive that also makes parallel test results untrustworthy.

  Agents now acknowledge a gesture's terminal message with `input:done` or `input:error`, and the tools surface that. `done` means the agent dispatched the input to a booted device; as with the existing `input:type-done`, it is not a guarantee the app reacted.

  Additive: an agent that does not send the ack is handled as before.

### Patch Changes

- @tapflowio/flow-runner@0.17.0

## 0.16.0

### Minor Changes

- Flow-runner reliability and MCP session lifecycle.

  - **flow-runner: retry transient ui-tree query errors while polling.** Wait steps (`tapOn` / `assertVisible` / `assertNotVisible`) no longer fail the instant a query throws — e.g. the app not being in the foreground yet right after `launchApp`. The poll loop distinguishes transient failures (foreground race, idle timeout, network) from permanent ones (bad request, auth, missing session) and retries the transient ones until the step deadline, so waits are truly condition-based (no `sleep` workarounds). A stalled query is also bounded by an abort signal so it can't block past the deadline.
  - **flow-runner: `role` and `index` selector disambiguators.** The object-form selector takes two new optional fields — `role` (narrow by element kind, e.g. `{ label, role: button }` when a button and its inner text share a label) and `index` (0-based, pick the Nth remaining match, e.g. `{ role: cell, index: 2 }` for a label-less row). Additive: bare-string and `{ id }` / `{ label }` selectors are unchanged; the object form now needs at least one of `id` / `label` / `role`.
  - **mcp: `run_flow` installs the build before replaying** when `buildId` is set (parity with `tapflow flow run --build`), so `clearState` / `launchApp` find the app present; pass `install: false` to skip.
  - **mcp: `shutdown_device` tool** — powers a session's booted simulator/emulator down to free resources or force a cold boot, distinct from `disconnect_device` (which only leaves the session, keeping the device running).
  - Security: pinned `axios`, `protobufjs`, `body-parser`, and `js-yaml` past their advisories via `pnpm.overrides`.

### Patch Changes

- Updated dependencies
  - @tapflowio/flow-runner@0.16.0

## 0.15.0

### Patch Changes

- @tapflowio/flow-runner@0.15.0

## 0.14.0

### Minor Changes

- ba0a3d8: Automated QA axis: UI accessibility tree queries and the deterministic flow runner.

  - `query_ui_tree` (MCP) / `GET /api/v1/sessions/:sessionId/ui-tree` — unified element schema (`role`/`label`/`identifier`/`frame`/`enabled`), frames normalized 0-1 so a frame center feeds straight into `tap`. iOS reads the tree via a resident XCUITest runner inside the simulator — window-agnostic (no Simulator.app window required) and still no WebDriverAgent; Android via `uiautomator dump` with a device-side timeout.
  - `@tapflowio/flow-runner` (new package) + `tapflow flow run` — replay YAML flows with zero LLM calls: 10-step vocabulary, identifier/label selector resolution, condition-based waits, JUnit reports, failure screenshots, CI exit-code contract (0/1/2).
  - `run_flow` (MCP) — agents author a flow once, then replay it deterministically over the existing session.
  - New relay messages `app:clear-state` (reset app data — `pm clear` on Android, data-container wipe on iOS) and `input:type-done`/`input:type-error` (text-entry completion ack, so a following key press stays ordered). Text entry now waits for this ack: a self-hosted agent older than this release will not send it, so text steps time out — update the agent alongside the relay.
  - mcp-server and flow-runner graduate from the `experimental` dist-tag to the standard npm channel, versioned with the repo-wide fixed group.

### Patch Changes

- Updated dependencies [ba0a3d8]
  - @tapflowio/flow-runner@0.14.0

## 0.7.0
