# @tapflowio/protocol

## 0.25.0

## 0.24.0

## 0.23.0

### Minor Changes

- e63e410: Foldable devices. Taps now land where you press them on a device whose display is rotated — the emulator's gRPC input takes coordinates in the display's natural orientation, and the viewer normalises against the rotated picture it is showing, so the two axes were swapped on every unfolded foldable. Folded, they also land in the right place: the emulator scales injected touch pixels by its own display size, which stays at the unfolded panel's, so scaling by the panel the guest reports sent every tap 1.92x too far across. A toolbar control folds and unfolds the device, keeping the orientation you were in, and the device frame follows the screen when it changes. A session starts unfolded and upright rather than inheriting whatever the last one left. Screenshots and recordings save the picture on screen rather than the frame behind it — the emulator captures a foldable's panel in its own fixed orientation, so an unfolded device was portrait on screen and landscape in the file, with the cursor overlay a quarter turn from the finger. `PosturableAgent` (`agent-core`) and the `input:posture` / `device:postures` messages carry it, with posture ids and labels owned by the platform so a device that folds differently needs no change outside its own agent.

## 0.22.0

## 0.21.0

### Patch Changes

- 7d8eb4e: **Installing a build works when the relay is not on the same machine as the agent.** It never did. The relay sent the agent its own filesystem path and the agent opened it, which is only true when the two share a disk — so on the topology the guide recommends, a relay on a LAN box with agents on Macs, every install failed. A relay in a container failed the same way for the same reason.

  **And it failed by blaming the build.** `unzip` said `cannot find or open`, the agent threw that away, and what reached the browser was "check this is a simulator .app.zip". The archive was fine every time. The tool's own words are in the message now, and a download that fails is reported as a download failing — the three causes a person acts on differently (a bad archive, a relay that cannot be reached, a transfer cut short) had been collapsed into the one sentence that was wrong for all of them.

  The relay now mints a single-use credential where it has already checked who owns the session, and serves that one build against it. Nothing is added to any token's permissions: an agent still cannot ask for a build it was not told to install, and `tapflow start` — whose agent runs with no token at all — keeps working, which a permissions-based approach would have broken. The agent builds the address from the relay URL it is already connected to rather than from anything the relay claims about itself, because that is the one address known to be reachable.

  A truncated transfer is caught against a size that travels with the instruction rather than against `Content-Length`, which a proxy is free to drop — a check that reads an absent header passes while looking at nothing, and hands on a half a file to be reported as a damaged one. Downloads have a stall timeout, so a half-open socket fails instead of hanging forever and leaving a temp copy of the build behind; the Android install path gained the cleanup it never had. An agent too old to fetch builds is unaffected and installs exactly as before, and the relay says so once in its log rather than guessing whether that agent is somewhere else — it cannot tell, and a check that is wrong in both directions is worse than none.

  `@tapflowio/agent-core` gains `downloadBuild`, and `@tapflowio/protocol`'s `app:install` gains `buildTicket`, `buildName` and `buildBytes` — additive, so an agent that predates them keeps working on the field it already reads. Both are named here rather than left to ride the version bump because a third-party platform built on `AgentRegistry.register()` reads those changelogs, and this is the API it would use to support installs from a relay it does not share a disk with.

## 0.20.1

## 0.20.0

### Minor Changes

- 3f18f70: Gate the dashboard's Full reset toggle on an agent capability instead of the platform string.

  `AgentCapability` gains `full-reset`, `IOSAgent` advertises it, and `SessionInfo` now carries the
  agent's capabilities so the viewer can gate while picking a device — before any session exists to
  join. The old `os !== 'android'` check said "Android cannot" when it meant "this agent did not say
  it can", and got both directions wrong: an iOS agent too old to implement Full reset was still
  offered the toggle, and an Android agent that implements it later would still have it hidden.

- faeaae9: A viewer that reconnects now learns whether its device is on the network (#614).

  `network:state` is produced by the agent, and the relay replays only three things to a re-joining
  browser — so the network toggle had no value to render and would have shown a guessed position. The
  relay now asks the agent to re-read the device, from the same block that already asks for a
  keyframe, and the Android agent answers with an uncorrelated report.

  The relay asks only agents that announce `network-control`, so an agent without the feature — one
  predating this release, say — is never asked and a viewer never has to guess from a silence.

  Caching it in the relay would have been cheaper and wrong: the relay caches only what it can
  invalidate, and airplane mode changes when someone types `adb` in a terminal.

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

- cb04a51: Write the injected library's verdict file atomically, so a healthy app stops reporting that its state could not be confirmed.

  The library wrote the file with `fopen(path, "w")`, which truncates it in place. The agent reads that file on every `state()` call — the relay triggers one on `device:ready`, on a viewer's re-join and after every toggle — so a read landing inside the write is reachable on a session where nothing is wrong, and what it gets is half a file. The reader cannot tell that from a real answer, so the network control reported `state-unconfirmed` for no cause. It now writes beside the target and `rename`s onto it: a reader sees the whole old file or the whole new one.

  The dylib is a committed prebuilt with no recorded build recipe, so `packages/ios-agent/build-nethook.sh` now holds one. Its flags were recovered from the committed binary rather than remembered, and confirmed by a rebuild whose every section matched byte for byte.

  Two things that were invisible now report. `bin/libtapflow-nethook.dylib` is a committed prebuilt, and every test that exercised the network hook injected a _fake_ path — so editing the source and shipping the previous binary was silent. It is now recorded against its sources like the network filter next door, with the difference stated in the guard: a failure here is the contributor's to fix, because no signing key is involved.

  And the library itself had no diagnosis at all. `DYLD_INSERT_LIBRARIES` naming a path that does not exist is ignored by dyld without a word, so a damaged install launched the app unhooked and wrote no verdict — leaving the control asking the tester to launch an app through tapflow, for the whole session, while the app they launched was running in front of them. `tapflow doctor ios` now reports the library, and the agent says so instead of asking for something already done.

- 5e2fcc5: Split the network-control reason set so each member carries a remedy, and confirm that a simulator's rule is actually being enforced before reporting it offline.

  `unsupported-device` now means only what it says — the write was accepted, the read-back succeeded, and the device had not moved. Every other Android failure is `state-unconfirmed`, which a retry may fix. Two iOS members are new: `filter-unavailable` for a Mac that cannot take devices offline, and `enforcement-lost` for enforcement that stopped underneath a device that was already offline.

  On iOS the rule is now confirmed over XPC before the other layers are applied, and a request that cannot be confirmed is refused rather than half-applied — applying the app-facing layers alone tells an app it is offline while its requests keep succeeding. Enforcement is watched while any device is offline, so an outage that used to pass silently is reported instead of leaving a tester signing off on requests that succeeded.

  The dashboard says what to do per reason, stops offering a retry where a retry cannot help, and interrupts rather than re-colouring when a finished check has been invalidated.

## 0.19.0

### Minor Changes

- 87cd901: fix(protocol): app:clear-state must carry a bundleId, and flow-runner's sends are checked against the contract

  `AppClearState` declared `payload?: { bundleId?: string }` — looser than every producer **and** every consumer.
  `mcp-server` and `flow-runner` are its only senders and both supply a string, and both agents answer
  `app:clear-state-error` with `'bundleId missing'` when it is absent. So the declaration permitted a message whose
  only possible outcome was that error, and it compiled. Now `payload: { bundleId: string }`.

  **No in-repo producer changes** — both senders already comply and the dashboard does not send this message at all.

  **`minor`, because it is source-breaking anyway.** `AppClearState` is a published export and this package
  advertises `declare module` re-opening, so adding a required field breaks an out-of-repo producer that omits it.
  None is known to exist, but CONTRIBUTING's table is not conditional on one being known: any breaking change is a
  `major`, relaxed to `minor` before `v1.0.0`. This was written as a `patch` on the strength of the in-repo census,
  which is the wrong question — the census cannot see the consumers the bump exists to warn. Every package in the
  fixed group moves to `0.19.0` with it, which is the signal, not a side effect.

  `flow-runner`'s `engine.ts` no longer reaches `driver.clearState` through `flow.appId!`. `parseFlow` rejects a
  bare `clearState` with no flow-level `appId`, but `runFlow` is exported and does not parse — an embedder can hand
  it a `Flow` built by hand, and the assertion laundered that into `payload: {}` for the device to reject a network
  hop later. It fails the step with a nameable cause instead.

  `flow-runner`'s `RelayClient.send` takes `BrowserToRelay` instead of `Record<string, unknown>`, so its 15
  outbound literals are checked. `mcp-server`'s equivalent was already typed in `7637be3`; this finishes the pair.

  **Zero compile errors came out of it, and that is the honest result.** Every `sessionId` in that file arrives as
  a required `string` parameter, so the root cause that produced 30 errors when the agents were typed (#509) does
  not exist here. The value is regression defence, and `scripts/__tests__/clientOutboundTyped.test.mjs` is what
  carries it.

  That check took two attempts. Its first draft asserted the signature `private send(msg: BrowserToRelay)` — and
  review defeated it with a second helper, `private sendRaw(msg: RelayMsg)`, which passed all seven assertions with
  `tsc` and the package suite green while putting a misspelled type on the wire. Keying on a name is the failure
  `agentSendTyped.test.mjs` had already been through three times. So it now anchors where its sibling does:
  `JSON.stringify` appears once per file and the function enclosing it takes `BrowserToRelay`. Two further gaps
  review found in it are closed too — the file list is derived by inspection rather than hardcoded (the pair it
  started with excluded the **dashboard**, which has the most send sites of the three), and `BrowserToRelay` is
  asserted to still be a union of named messages, because appending `| Record<string, unknown>` to it passed all
  250 static assertions while making every literal in all three files accept anything.

  Two comments corrected while passing through, since a stale reason argues for the thing that was removed:

  - `test-utils`'s `SocketMessage` said its looseness accommodates each importer's richer view of the wire via
    `waitForType<T extends SocketMessage>`. #505 broke that — named interfaces have no implicit index signature, so
    no protocol type satisfies the constraint, and all 25 call sites already violate it invisibly because
    `src/__tests__` is outside the package's tsconfig. The looseness now blocks the richer views rather than
    accommodating them; it stays only because a narrowing nothing type-checks is decoration.
  - `mcp-server`'s AGENTS.md presented its loose _inbound_ as a settled decision. It is a deferral, tracked in
    #512 along with the live defect narrowing would catch.

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

- 1ce516f: fix(protocol)!: invert `input:error` — `reason` is required, `message` is optional

  **This is a breaking wire-contract change**, shipped as `minor` because the package is pre-1.0 and
  CONTRIBUTING says breaking changes may land in a minor until `v1.0.0` is tagged.

  `input:error` declared `message: string` required and `reason?: InputErrorReason` optional. The
  package's own AGENTS.md states that split on purpose — `message` is free prose each agent owns,
  `reason` is the closed union consumers branch on — so the field a consumer was **guaranteed** to
  receive was the one it must not depend on, and the one it should depend on could be absent. Every
  consumer carried an unknown-reason branch for as long as that held, and "absence means unknown" had to
  be re-derived by each new one.

  That was the right way to _ship_ it in #490: an agent predating the field omitted it and nothing broke.
  It was never a correct end state, and the prerequisite closed with #492 — the relay used to be the one
  producer sending prose alone.

  ## What it costs

  **No producer had to change.** All six production sites already send a reason, two of them with
  `satisfies InputErrorReason` on the literal. The clients that read it through
  `Record<string, unknown>` are unaffected by the declaration — but the dashboard is a _typed_ consumer
  and did need editing: `message` becoming optional meant it rendered `(undefined)` into a toast, which
  is fixed here with a test on it.

  **What it buys** is an agent outside this repo, which can no longer omit the field, and a consumer
  written tomorrow, which cannot be handed a failure it has no way to branch on. Both absence branches
  stay, and now say why beside themselves: they exist for producers predating the field, which a required
  declaration corrects going forward and cannot retroactively fix.

  `message` is optional rather than removed — it still carries parameterised detail a closed union
  cannot (`unknown key code: KeyFoo`), which is a debug and forward-compatibility field. A structured
  `params` is the honest way to keep that once prose is demoted and is deliberately **not** added here:
  issue #485 is what will say whether a rendered UI misses the variable.

  `InputTypeError` keeps `reason?`, and that asymmetry is deliberate. Its agent-side producers answer
  with prose from a rejected `adb` or pasteboard write and have no reason to give; only the relay sets one.

  ## `SessionError` is now `SessionScoped`, and carries only `sessionId`

  TypeScript cannot narrow an inherited required member to optional, so making `message` optional on one
  member meant moving it off the base — onto each of the nine that keep it required. What is left is the
  one thing all nine share, and the name follows the shape.

  The `extends` is now the only thing stating the family relation, where the shared field pair used to
  imply it. `protocolMessageNames.test.mjs` gains an assertion that each member still declares `message`
  for that reason.

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

- e55371c: **Requires Node.js ≥ 22.** Node 20 reached end of life on 2026-04-30 and no longer receives security patches.

  Three declarations disagreed about what was supported, and none of them matched what was actually run. The manifests said `>=20.12.0`, the documentation said "≥ 20" — meaning 20.0.0 — and CI ran 20 while Docker ran 22 and the release job ran 24. There was also a band that was declared but unusable: every `undici` 7.x requires Node `>=20.18.1`, so 20.12 through 20.17 could not complete a development install regardless of what the manifests promised.

  The floor is now 22 everywhere, and 22 is a version that will be tested rather than merely claimed — CI runs the suite on both 22 and 24. That is the part that had been missing: `>=20.12.0` was declared for a year and never once exercised on 20.12, which is how it drifted below what the dependency tree already required.

  `tapflow`, `@tapflowio/flow-runner` and `@tapflowio/mcp-server` declared no `engines` at all and now do. `tapflow` is the package installed with `npm i -g`, so until now the CLI announced no Node requirement to the people most likely to need it.

  `tapflow doctor` moves with it and reports `Node ≥ 22 required` below the floor. Without that change it would have printed a green check on Node 20 while the package manifest called the same version unsupported.

  Node 22 is supported until 2027-04-30; Node 24 is the active LTS. Containers and the published image now run 24.

- e8b29b8: Check every message the relay receives against the contract, and make the inbound frame a discriminated union

  The outbound direction has been compile-checked since #419 — `sendTo` refuses a message outside its
  union. Nothing checked the inbound direction: the relay's `RelayMessage` was a flat interface where
  `type` was the only required member, so every field it read was optional by construction and every
  field it needed came with a `!`. That is how the two type systems could disagree about the same wire
  field — `format?` in the relay against a required `format` in the protocol — with nothing to report it.

  `@tapflowio/protocol/validate` is a second entry point, imported only by the relay, that parses an
  inbound frame into a discriminated union at the door. It is a parse rather than a cast on purpose:
  narrowing the union with `as` would have turned the relay's one visible `msg.payload as ChromePayload`
  into an invisible `msg.payload`, with the compiler vouching for JSON that arrived over a socket.

  What a user can observe:

  - **A malformed command is refused before it reaches a device, and the caller is told which field was
    wrong.** A `device:boot` with no payload, an `open-url` with no URL, an `app:install` whose `buildId`
    is an object — these were forwarded to an agent before, and the agent's own guard answered if it had
    one. The relay answers now, in the shape that request's waiter reads, so the diagnosis arrives sooner
    and does not depend on which agent is on the other end. A request that has no reply at all is dropped
    and logged with the field that failed. No client shipped here can produce any of these; a third-party
    one can.
  - **A command with no usable session id or request id is refused outright**, including the empty
    string, which type-checks and which an LLM driving the MCP tools could produce. Answering one is not
    possible — the reply's own required fields would be missing, and every client discards such a frame —
    so it is dropped with a log rather than turned into a caller waiting out its deadline.
  - **A key appended to a browser message no longer reaches a device.** Browser-origin frames are
    forwarded as the parse product, so anything the contract does not declare is gone before an agent
    sees it. Agent-origin frames are forwarded unchanged, so a field a newer agent adds still survives a
    relay that does not know it.
  - **Nothing else changes.** Every well-formed frame routes exactly as before.

  `@tapflowio/protocol` gains a `./validate` subpath and, with it, a runtime dependency on `zod` — its
  first dependency of any kind. The main entry is unchanged: still types only, still fully erased by
  `import type`, and it does not reach `zod`. A consumer that imports only `@tapflowio/protocol` gains
  nothing in its bundle and one package in its install.

  Agent payloads are deliberately not validated, and that is a decision with a reason rather than a gap:
  `AgentRegister.platform` is `string` — open, so a third-party platform can register through
  `AgentRegistry.register()` — while `ChromePayload` is a closed two-member union. A platform this
  project promises to support has no valid `session:chrome` variant to send, and refusing one would cost
  it bezel and buttons for the life of the session. The six messages the relay consumes are validated,
  each with a default for every field the relay previously read through a `??`, so an agent older than a
  field keeps working exactly as it did.

- 3f903c8: fix(relay): the session-state replay carries a sessionId, so two of the three can require it

  `session:chrome`, `session:deviceInfo` and `device:ready` were declared `sessionId?: string` while both
  agents stamped the field on every copy they sent. The relay was the only producer that did not: its
  replay of cached session state to a re-joining viewer (`handleSessionStart`) omitted it, and the three
  share one declaration with the forwarded copies, so `optional` was the honest thing that declaration
  could say about two producers that disagreed.

  **The disagreement was the defect.** When this surface was consolidated, two ways to tighten the
  _declaration_ were weighed and rejected. The third option was not considered: fix the producer. The relay
  stamps `session:chrome` and `session:deviceInfo` now and both are required. Closes the Major deferred
  on #503 for those two.

  **`device:ready` is deliberately left optional, and that is the interesting half.** Its `sessionId?` is
  doing correlation work by accident: `mcp-server` and `flow-runner` gate a pending `device:boot` on
  `msg.sessionId === sessionId` with no truthiness escape, so the unstamped replay is invisible to them.
  Stamping it makes a _replayed_ `device:ready` satisfy an in-flight boot — measured on a real relay with a
  silent agent, `boot_device` answers `{booted: true}` having received nothing, where the same harness
  reports still-waiting without the stamp. The replay is cached state addressed to a **join**, not an answer
  to a **boot**, and `readySent` is cleared by nothing while an agent is wedged-but-connected, which is
  exactly when a boot hangs — so the value is stalest precisely when it would be consumed.

  The defect underneath is that leaving a session does not clear its waiters: a _real_ `device:ready` after
  a re-join already satisfies the stale one, so this is pre-existing and stamping only widens the trigger.
  Filed separately. What makes this message tightenable is a request correlator, not another field.

  `minor`, because the two that changed are published exports and adding a required field is source-breaking
  for an out-of-repo producer that omits it. `CONTRIBUTING.md` makes any breaking change a `major`, relaxed
  to `minor` before `v1.0.0`, and that is not conditional on a consumer being known.

  **The dashboard's session gate got stricter as a consequence.** It read
  `'sessionId' in msg && msg.sessionId && msg.sessionId !== sessionId`. The middle check was never what
  carried the replay — the relay omits the key, so `'sessionId' in msg` already lets those through — it only
  ever admitted a key that was _present and falsy_. With it gone, `sessionId: ''` is a mismatch rather than
  a pass. That is defence in depth against the unvalidated-inbound gap (#444), not a live hole: measured, an
  agent-sent `''` never reaches a viewer, because every agent→browser forward resolves
  `sessions.get(msg.sessionId!)` against a `randomUUID` key and breaks on the miss.

  One correction to a reason recorded three times in this package: rejecting the `Omit`-mapping alternative
  was justified by "it breaks `useClipboardBridge`, which reads its replies through `Extract<>`". It does
  not — that hook takes the three replies as named members and says so in its own comment, and its only
  `Extract` is over `ClipboardRequest`, an outbound union the mapping would never touch. The outcome is
  unchanged, since fixing the producer made both alternatives unnecessary.

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

- e84a2ea: fix: enforce union membership in both directions, not just narrowing

  The wire-contract program made every message's **fields** checked and left its **set membership**
  checked in one direction only. Narrowing was held by the compiler and held well — `sendTo` refuses a
  message outside its union. Widening was free: measured on `main`, adding `DeviceBooting` to
  `BrowserToRelay` left `pnpm typecheck` at zero errors and all 294 static tests green.

  ## The copy with the security consequence

  `AGENT_MSG_TYPES` in the relay is a hand-maintained second list of what an agent produces, and the
  door check closes a `browser`-role socket with 1008 for any member. The forwards it guards mostly
  resolve a session from the message and send to _that session's_ browser with no check that the sender
  is that session's agent — `clipboard:*` is the deliberate exception. So an agent→browser message added
  to the protocol and forgotten in that list makes a viewer drivable by anyone who knows a session id,
  with the type union claiming otherwise.

  Measured before this change: dropping `keyboard:toggled` from the set left both suites green.
  `clipboard:data` was held only because somebody had written that one test by hand.

  Types erase, so no runtime array can be derived from a union. What is available is the compiler
  checking two lists against each other, and that is what this adds — as type-level assertions, so a
  violated invariant is a compile error at the declaration rather than a test somebody has to run.

  Three invariants now hold:

  - the relay's `MessageType` covers every protocol literal and invents none. It was missing
    `stream:request-idr` — the exact drift `protocol/AGENTS.md` cites as this package's reason to exist,
    still alive in the copy underneath it;
  - `AGENT_MSG_TYPES` equals what the agent directions declare, both ways;
  - **nothing a browser may send is something an agent produces.** This is the one that catches widening
    without restating 63 literals, and it is the invariant the door enforces at runtime. Not blanket
    disjointness: `device:shutdown` is deliberately a member of both `RelayToAgent` and `BrowserToRelay`.

  ## And the half a type cannot state about itself

  A message declared in the protocol but placed in **no** direction reaches none of the above — it is
  absent from the union those assertions read, so nothing is ever obliged to know it. Types cannot
  enumerate their own declarations, so that one is checked as source text alongside the two facts
  `protocolMessageNames.test.mjs` already checks that way. All 65 declared messages reach a direction
  today.

  `AnyWireMessage` is new and public: the seven directions unioned, so a consumer can assert its own
  list is complete rather than merely correct so far.

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

- 42987e1: refactor(protocol): complete the browser-inbound surface by direction, and delete the dashboard's hand-copy of it

  A browser receives 28 message types. `@tapflowio/protocol` declared 17 of them — one of which does
  not go to a browser at all — and the dashboard declared its own copy of 24 in `lib/types.ts`. The
  twelve an agent sends were in neither, because the relay forwards them with `JSON.stringify(msg)` and
  so nothing on its typed send path ever mentions them.

  The two copies had drifted in four places, and nothing reported any of it: three error types were
  `sessionId?` in the dashboard against protocol's required, `session:joined.capabilities` was optional
  against required, four members were declared with no `sessionId` the wire always carries, and four
  more were missing outright.

  - `AgentToBrowser` — the twelve forward-only messages, shapes derived from both agents' send literals.
  - `RelayOrAgentToBrowser` — the ten with both producers, declared **once** and referenced by both
    directions rather than written into each. `device:ready` carries `sessionId?` here because the two
    producers genuinely differ: both agents stamp it, and the relay's replay to a re-joining viewer does
    not. (`session:chrome` and `session:deviceInfo` were in the same position and are required now — the
    relay stamps them; see the entry for that change.)
  - `BrowserInbound` — what a consumer should use. The dashboard's `RelayMessage` is gone; view code
    imports this.
  - `RelayToStream` — `stream:registered` goes to an agent's stream socket, not a browser.

  `scripts/__tests__/browserInboundRouting.test.mjs` now compares the relay's forward case labels
  against `AgentToBrowser` in both directions, because no compiler can: a forwarded message is never
  constructed by the relay, so `sendTo(socket, msg: RelayOutbound)` does not see it.

  Two silent drops surfaced once the dashboard read the real union. The clipboard bridge had declared
  its own `{ type: string; payload?: unknown }`, wide enough that a `clipboard:write-done` answering a
  read parsed as "no text" and cancelled the claim with nothing said; the same for `clipboard:data`
  answering a write. Both now report. Five test fixtures were also sending a `device:booting` with no
  `sessionId` — a message the wire does not produce, and one that bypasses the viewer's session
  scoping; they compiled because the injection ended in `as never`.

- 17a7484: fix(dashboard): tell the second tester the device is in use, and make an unhandled message a compile error

  `Session busy` reached the viewer and did nothing. The relay sends it when another browser socket already
  holds the session, so **two testers opening the same device** — the likeliest collision in a product whose
  premise is that the whole team opens a browser — left the second tab waiting on a `session:joined` that
  cannot arrive.

  Nothing reported it, because from the outside `error` _was_ a handled type. The viewer branched on the
  free-prose `message` and covered two of the three wordings the relay sends.

  `error` now carries a closed `reason` — the same split #491 gave `input:error`: `message` stays prose the
  producer owns, the machine field is closed. **Required here, unlike `InputErrorReason`**, because that
  one's producer set is open by design (a third-party platform registers through `AgentRegistry.register()`
  and may predate the field) while this one has a single producer: the relay, at three sites. So `sendTo`
  enforces it. The viewer switches on `reason` exhaustively, and a fourth reason is a compile error instead
  of another silent case.

  `busy-elsewhere` and `mac-overloaded` are dashboard-local stop reasons rather than new
  `SessionTerminatedReason` values, because in both cases the session is **alive** — widening the protocol
  vocabulary would let `session:terminated` carry a reason it can never mean. The copy record is keyed on the
  union, so it forced both wordings.

  The busy wording deliberately does **not** name another person. The relay answers `session-busy` whenever
  the session's browser socket still reads OPEN, and the commonest cause is the tester's _own_ previous
  socket: a sleeping laptop reconnects in 2s while the relay takes up to a heartbeat (30s) to notice the old
  one died. "Someone else is testing this device" would be false in exactly the case the viewer's own comment
  calls routine. Relatedly, the relay now checks occupancy _before_ the resource gate — with both true, the
  tester was told to pick a different Mac while the real reason went unreported — and skips the check for a
  socket re-joining the session it already holds, which is what `SessionList` does before a shutdown.

  `agent-resources-exhausted` also gained an exit. It only toasted, and the relay `return`s after sending it,
  so the tab sat on "Starting device…" indefinitely: making `reason` required stopped a case from being
  unhandled without making the handled cases _end_.

  **`SessionList` was dropping `error` too**, and the same shape of bug: `handleShutdown` sends
  `session:start` on its own socket, a refused join is answered there, and `device:shutdown-done` — the only
  message that clears `shutting` — never arrives. The badge read "Shutting down..." permanently and the gate
  on it hid both buttons, so the row went inert.

  ## The layer this belongs to

  Browser-inbound is 28 message types; the dashboard handled 22 and dropped 6. The three reasons for
  dropping — handled elsewhere, deliberately ignored, nobody wrote it — were **indistinguishable in code**,
  since all three look like an absent branch. `lib/inboundDisposition.ts` states one per message under
  `satisfies Record<BrowserInbound['type'], Disposition>`, so a message added to the wire breaks the file
  until someone picks a category. Measured: adding one produces `TS1360` at the table.

  Deriving the _reachable_ subset and obliging only that was designed and discarded, and it is the obvious
  idea, so both reasons are recorded in the file: `send()` is shared by four sockets that each open their
  own WebSocket, and a reply does not go to whoever asked — the relay forwards to whichever socket holds the
  session now, so "we never send `input:type`" is true per session, not per socket.

  Also corrects a false comment: `DeviceDetails` was documented as "what the viewer shows in its info card".
  Nothing reads it — both agents send `session:deviceInfo` and the relay replays it, while the viewer takes
  device name and OS from `agents:listed`. It stays on the wire because third-party agents send it.

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

- ef2dac8: refactor(protocol): give every wire message a name

  58 messages were anonymous members of a union, which meant two things could not be done. A single
  message could not be referred to — consumers reached for `Extract<Union, { type: 'x' }>`, one of them
  needing `extends { payload: infer P }` to get at a payload. And shared structure had nowhere to live:
  eight session-scoped failures carry the same `{ sessionId, message }` contract with no place to say so,
  and the comment explaining it floated above a union line.

  Each message is now an `export interface`, and the unions are unions of those names.

  - **`SessionError`** — the eight session-scoped failures extend it. Not for DRY (two fields) but so
    that "this is a failure addressed to a session" is something a reader and a check can see, and the
    contract note has a home. `error` does not inherit: it has no `sessionId`, which is the whole point
    of that member.
  - **Direction suffixes where a literal means two things.** `app:install` and `app:launch` travel in
    both directions with _different_ shapes — the browser sends `buildId`, the relay resolves it and
    sends `payload: { filePath, bundleId }`. Naming forced the split: `AppInstallToRelay` /
    `AppInstallToAgent`. `device:shutdown` is identical in both directions, so it is one interface both
    unions reference, which now says out loud that the relay forwards it untouched.
  - `GenericError`, because `Error` would shadow the global.

  **Names were derived from the `type` literals mechanically, not typed by hand.** The conversion's real
  hazard is a copy-paste that leaves two interfaces holding each other's literal, and `AgentToBrowser`
  has seven members whose shape is identical apart from the literal. A type-level equivalence check
  cannot see it — a union is a set, so which name owns which literal is not part of the comparison, and
  the routing check compares membership, so the literal set is unchanged. Measured: the swap produced
  zero errors from the nine equivalence assertions.

  So `typeAssertions.ts` carries one binding per message (`_InputDone: InputDone['type'] = 'input:done'`),
  and `scripts/__tests__/protocolMessageNames.test.mjs` asserts every message has one — plus that the
  eight failures declare `extends SessionError`, which no type can state about itself because every
  object with `{ sessionId, message }` is assignable to it.

  The conversion itself was proven with `Equals<Union, UnionOld>` against verbatim snapshots and then
  deleted along with them; that net was for the conversion window, not for keeping.

  **Two properties were given up, neither visible to that proof.** A named `interface` has no implicit
  index signature, so a message is no longer assignable to `Record<string, unknown>` — nothing breaks
  today because the three such sinks in this repo only ever receive fresh object literals, and the fix
  when one needs a typed value is to type the sink rather than widen the message. And an `interface` can
  be reopened by a consumer via `declare module`, which an anonymous union member could not. Both are
  recorded in `packages/protocol/AGENTS.md`.

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

## 0.18.0

### Minor Changes

- 7637be3: Add `@tapflowio/protocol`, one wire contract for the WebSocket messages exchanged between browser, relay and agents, and type every place that originates a message against it.

  Nothing checked those messages before. The relay built them as inline object literals passed to `JSON.stringify`, the dashboard's `send()` took `object`, and mcp-server's took `Record<string, unknown>` — so the definitions each package kept were descriptions, not contracts, and three of them had already drifted from the wire:

  - `stream:request-idr` was sent by the relay from two places while absent from its own `MessageType`.
  - `input:key` was documented as `payload: { key: string }`. Every sender and both agents use `{ code, modifiers }`, with `modifiers` a HID bitmap — so the field name and the type were both wrong.
  - `input:touch:end` and `app:clear-state` carried payloads from mcp-server that no definition mentioned.

  All three are fixed by the contract now describing what actually travels. The relay's 25 originating sends go through a typed `sendTo`, which also folds in the `readyState` check that was repeated at most call sites and missing at some. `Session.chromeData` is `ChromePayload` rather than `unknown`; the relay still only stores and forwards it, but a new platform now extends the union instead of the relay.

  No message changed shape on the wire. This is types only, and `@tapflowio/protocol` emits no runtime code — consumers import it with `import type`, so nothing reaches a browser bundle.

- 273c016: Tell an open dashboard tab when its session ends because the agent went away, instead of leaving it to spin.

  Restarting a device agent used to orphan the viewer: the relay deleted the session, the browser kept a live socket addressed to a `sessionId` that no longer existed, and everything it sent was dropped as unknown. The tab sat on `Waiting for first frame...` forever with no message, and only a manual page refresh recovered it.

  The relay now sends `session:terminated` (with `reason: 'agent-disconnected'`) to whoever is attached, before removing the session — after removal the socket reference is gone. The viewer reports it upward and the dashboard returns to the Mac list with an explanation, then refreshes the agent list immediately so picking the same Mac again does not try to join the dropped session.

  The relay also logs one line when an agent connects and one when it disconnects. It previously printed `Waiting for agents...` at startup and then said nothing either way, so a terminal gave no signal about whether an agent was attached.

  This is the first half of the fix. Rebinding the tab to the restarted agent's new session — so a restart is invisible rather than merely announced — is tracked separately.

### Patch Changes

- 2aebd34: Make an agent restart survivable for the tab that is watching (#426).

  The relay could already re-point a session at a restarted agent's socket (#458), but the trigger almost never fired. It required the old socket to still be registered when the new one arrived, and on a restart it never is: the close is processed in under 400 ms while a new agent takes about a second to register. Measured on a real simulator — the tab got the same bounce to the Mac list it got before any of this existed.

  So a closed agent socket no longer ends its sessions on the spot. They are held for 15 seconds (`TAPFLOW_AGENT_GRACE_MS`), which is long enough for the agent to come back and reclaim them, and the tab keeps its place. If it does not come back the window closes and the session ends exactly as before.

  The sessions stay where they are rather than moving to a holding area of their own — a returning agent is found by walking the sessions and reading the socket each one points at, so a session parked anywhere else could never be reclaimed.

  **`session:agent-away`** tells an attached viewer what is going on. Without it the tab would sit on a picture that stopped updating for the length of the window, which is the complaint #426 was opened with. The viewer drops the frame and says the agent went away; whichever answer follows — reconnected, or ended — replaces it. A genuinely dead agent is now better reported than before, not worse: the wait is explained, and only the news that it is over arrives later.

  Also, while an agent is away:

  - **Its devices are not offered.** A held session is not something anyone can pick, and listing it would draw a Mac card carrying the dead agent's last CPU and memory reading with no warning attached — the existing staleness badge keys off a 30-second-old sample, far longer than the window. It also prevents a duplicate card when a returning agent identifies itself differently, which is what happens when the upgrade that prompted the restart is the one that starts sending a machine id.
  - **Joining says so.** The join is allowed and answered with `session:agent-away`, rather than refused. Refusing looked simpler and was a trap: the viewer sends `session:start` once per reconnect and ignores a plain error, so a browser blip inside the window would strand the tab past any recovery.
  - **Nothing from the previous process is replayed** to a viewer that joins — its chrome, device info and readiness all describe an agent that is gone.
  - `device:boot` for a held session answers `agent offline` rather than `Session not found`. The id is valid, and retrying in a moment may well work.
  - A device that comes back under a different identity — which is what happens when the upgrade prompting the restart is the one that starts sending a machine id — ends the held session immediately rather than making its viewer wait out a window for a device that is demonstrably present.

  `agents:listed` has three other consumers, and a restarting Mac's devices are absent from all of them for the length of the window: `tapflow status` reads as no agents connected, and a one-shot `list_devices` over MCP or flow-runner returns nothing. Retrying after the window gives the normal answer. Shortening `TAPFLOW_AGENT_GRACE_MS` narrows it.

- f4235e5: Make app install/launch failures reach the caller that asked.

  Three paths through `handleBrowserAppInstall` / `handleBrowserAppLaunch` ended without a usable answer: an unknown session got a generic `error` with no `sessionId`, a missing build or bundle id got an app-specific error also without one, and an agent whose socket was not open got nothing at all — the `if` had no `else`. A dashboard viewer holds one session per socket, so an unattributed error still lands somewhere sensible and a human sees it. An MCP caller waits for the reply carrying its own `sessionId`, so all three looked the same from there: silence until the deadline. The caller was told "timed out" when the truth was "that build has no bundle ID".

  - **relay**: every exit from both handlers carries the request's `sessionId`, including `Session not found` — a generic `error` cannot be correlated by construction. An unreachable agent is answered immediately instead of being left to time out, matching what `open-url` and `clipboard:read` already do.
  - **relay**: `device:boot` gets the same treatment. A boot the agent never receives used to leave the viewer on "Waiting for first frame…" with nothing said. `device:shutdown` stays fire-and-forget — nothing waits on it, and inventing a reply type for it would grow the contract for a message no one reads.
  - **protocol**: `app:install-error` and `app:launch-error` now declare `sessionId` as required, and `device:boot-error` joins `RelayToBrowser`. Because `sendTo` is typed against that union, an omission at those call sites is a compile error rather than a silent gap. Messages the relay merely forwards, and the agents' own raw literals, stay outside that check — and nothing yet validates an inbound `sessionId` (#444), so this is a much tighter contract than before rather than an airtight one.
  - **relay**: `buildId` is checked before it reaches the query. `JSON.parse` does not honour `RelayMessage`, and an object or array there makes the driver throw — an exception the message loop used to swallow alongside genuine parse failures, leaving the caller with nothing. That loop no longer catches a parse failure and a routing failure in the same block, and it rejects payloads that are valid JSON but not messages (`null`, numbers, strings) before routing reads a field off them.
  - **dashboard**: the viewer ignores messages addressed to another session, and its local union carries the new field. Adding `sessionId` without a consumer that reads it would not have fixed a correlation bug.

- a391b85: Teach the viewer to recover from an agent restart — the receiving half.

  Restart a device agent today and the tab is told `session:terminated` and sent back to the Mac list. That is better than the silence it replaced (#446), but it makes the tester redo navigation for something that should be invisible.

  `session:rebound` carries the alternative: the relay keeps the session, re-points it at the new agent socket, and tells the viewer to ask for its device back. The relay cannot restart the stream itself — the codec negotiation and the downscale tier ride in the browser's own `device:boot` payload and exist nowhere the relay can see.

  The receiving half landed before the sending one, and on its own it changed nothing. The reverse order would have left the tab worse than it was: the viewer would drop a message it did not know, and `device:boot` is only re-sent from the `session:joined` branch, so there was no recovery path to fall back on — a frozen frame that looks live until someone refreshes. Both halves are in this release, along with the window that gives a restarting agent time to come back.

  On receipt the viewer tears down first, then re-boots:

  - Clears what a restart invalidates, including three flags `device:booting` never touches — `launching`, `swKeyboardPending`, `swKeyboardVisible`. Their acknowledgements died with the old agent. This was unreachable before: a dead agent unmounted the viewer, so nothing could outlive it.
  - Re-sends `device:boot` carrying `app-only`, never a reset. A restart is not a request to erase the device (#439).
  - Skips the reinstall when the build was already on the device. The simulator stayed up across the restart, and reinstalling would kill the app state the recovery exists to preserve. The skip cannot key off `installed` at that point — `device:booting` clears that flag and the agent sends it on every boot, so it is always false by the time `device:ready` arrives — so the state is captured when the rebind starts.
  - Restores `installed` when it skips. That flag gates the Launch control, and without `app:install-done` to set it the tester would silently lose the button.
  - Installs anyway when the rebind interrupted an install. An agent is at its most fragile mid-install, and there the app really is absent — skipping would leave a Launch button for something that is not on the device.
  - Counts pending rebinds rather than flagging one. A crash-looping agent rebinds repeatedly, each with its own boot and its own `device:ready`; a flag is spent by the first, and the second reinstalls. The count is also reset by `session:joined` and `device:boot-error`, so a rebind whose agent never answers cannot absorb a later ordinary boot and suppress installs for the rest of the mount.

  Also names the Launch button on both platforms. It was icon-only with no accessible name, so screen-reader and voice-control users had no way to reach it.
