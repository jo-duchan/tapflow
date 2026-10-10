---
type: rules
topics: [protocol, websocket, contract, types]
status: living
---

# protocol — AGENTS.md

> Common rules: [AGENTS.md](../../AGENTS.md) | Full index: [INDEX.md](../../INDEX.md)

---

## WHAT

The wire contract for tapflow's WebSocket traffic: the message types exchanged between the browser, the relay, and the device agents. One definition, three consumers — `relay`, `dashboard`, `mcp-server`.

It exists because the relay and the dashboard each kept their own copy and they drifted. Two drifts were found when this package was created:

- `stream:request-idr` was sent by the relay in two places but was absent from its `MessageType` union.
- `input:key` was declared as `payload: { key: string }` in the dashboard union while **every** sender — both viewers and mcp-server — sent `{ code, modifiers }`. The declaration was wrong, not merely incomplete, and nothing caught it because `send()` took `object`.

## Why this name

`protocol` is deliberately broader than what the package holds today, because the alternatives age worse.

- `protocol-types` became a lie the moment a runtime validator landed, and one did — `src/validate/` is the relay's inbound parser (#444). The broad name is what let it move in without renaming the package.
- `relay-protocol` reads narrower than the truth: these messages are exchanged by browser ↔ relay ↔ agent, not owned by the relay. It also sits one letter away from `@tapflowio/relay` at every import site.
- `messages` cannot hold anything that is not a message, which is the same corner `protocol-types` paints into.

The cost of a broad name is ambiguity about what belongs — answered by the two Scope sections below rather than by the name. In particular the repo has a *second* wire format (the binary frame envelope), and the name alone does not say which one this is.

## Scope — what belongs here

- **JSON message types** over the relay WebSocket, grouped by direction. That is all the package holds today, and the main entry point is **runtime-free** — see HOW NOT.
- **Runtime validation of inbound messages** lives in `src/validate/`, reached as
  `@tapflowio/protocol/validate` and imported only by the relay. It is here rather than in the relay for
  the reason the package exists: a schema file is a second copy of the contract, and a second copy
  drifts. The main entry stays runtime-free, so the erasure the dashboard depends on is unchanged.
  Two rules make the copy safe, and both are compile errors rather than conventions:
  - **Two tiers, with different static types.** `Validated` parses to the interface;
    `Envelope` parses to `EnvelopeOf<I>` — the interface projected onto `type`/`sessionId`/`requestId`
    — so a payload the door did not check **cannot be read** off the result. A field that was not
    validated must not appear in the type; anything else moves the lie somewhere quieter.
  - **`SchemaExact` ties each schema to its interface**, and refuses `z.custom<T>()` and a
    `const s: z.ZodType<T>` annotation by kind, because both produce `T` with no `any` for `IsAny` to
    catch and would compare `T` with itself.
  - **The envelope is judged before the payload**, so a payload failure on one of the thirteen correlated
    browser requests comes back as `bad-payload` carrying the address and the correlator — which is what
    lets the relay answer it instead of dropping it. `ANSWERABLE` is that set; keeping it equal to the
    correlated request set is `scripts/__tests__/correlatedRequestsGated.test.mjs`'s job, because
    nothing else compares the two.

- **The connection handshake's query parameters**, as prose rather than types — see
  [Connection handshake](#connection-handshake--what-the-upgrade-url-carries). No message carries them, but a
  client written outside this repo needs them as much as it needs the messages (#581).

## Scope — what does not

- **The binary frame envelope (TFFE).** That is a separate wire format with its own header layout — see [`contributing/frame-envelope.md`](../../contributing/frame-envelope.md). It is currently implemented separately in the relay and the dashboard, which is the same kind of drift risk, but unifying it is not this package's job today.
- **Domain types that are not on the wire.** `Build`, `ReleaseGroup`, UI view models — those stay in their own packages.

## Every message is a named `interface`, and naming cost two things

A message is `export interface AppInstallDone { type: 'app:install-done'; … }`, and the unions are
unions of those names. That is what lets a consumer refer to one message, and what gives shared
structure (`SessionScoped`) and per-message documentation somewhere to live.

**`interface`, not `type X = { … }`** — the alias form cannot be `extends`ed, and the intersection
workaround (`type X = SessionScoped & { … }`) stops `Extract<Union, { type: 'x' }>` resolving to a single
member, which `useClipboardBridge` depends on to read a reply without a cast.

Two properties were given up for that, neither visible to the type-equivalence check that proved the
conversion, so they are written down here instead:

- **An `interface` has no implicit index signature.** An anonymous `type X = { … }` is assignable to
  `Record<string, unknown>`; a named interface is not. Nothing broke, because the three
  `Record<string, unknown>` sinks then in this repo were only ever handed fresh object literals — and
  **the fix when one of them needs a typed value is to type the sink**, not to widen the message. Two
  have been: both clients' `send` takes `BrowserToRelay` (`7637be3`, L4c), and their `RelayMsg` is now
  inbound-only. The third, `test-utils/src/socket.ts`, is where this constraint bit in the other
  direction: its comment claimed the looseness accommodated each importer's richer view via
  `waitForType<T extends SocketMessage>`, and that extension point is what an interface having no index
  signature **broke** — no protocol type satisfies the constraint, so every call site that named a type
  (49 of them, measured) violated it invisibly while `src/__tests__` sat outside every tsconfig. #422 fixed both halves: the tree is
  type-checked now, and the constraint is `{ type: string }` while `SocketMessage` stays the *default*
  — a constraint only an anonymous literal can satisfy admits no named message at all.
- **An `interface` can be reopened by a consumer.** `declare module '@tapflowio/protocol'` can add a
  field to any message, which an anonymous union member could not. Measured: a consumer can give
  `session:joined` a `deviceId` and defeat the `typeAssertions.ts` assertion that says it has none —
  the file's only whole-message excess-property check. (That example used to be `GenericError` and a
  `sessionId`; L5d made that field **required**, so the augmentation it described is now the declaration.)
  It takes deliberate augmentation, so the risk is low — but the HOW NOT rule below ("do not widen a
  message") is now bypassable without editing this package.

### The name must be derivable from the literal

`InputDone` ↔ `input:done`: PascalCase over the literal's `:` and `-` segments. Six names deliberately
break the rule and are listed in `scripts/__tests__/protocolMessageNames.test.mjs` — count the list here
against `NAME_EXCEPTIONS`, because a number that stopped matching its own enumeration is a defect this
section has already shipped once:

- `GenericError`, because `Error` would shadow the global. Renaming the interface does not remove the
  exception — the derivation reads the **wire literal**, so only renaming `'error'` itself would, and that
  reaches every consumer.
- `AgentResourceReport`, because `agent:resources` derives `AgentResources`, which this package already
  exports as the *payload* shape the message carries. Renaming the payload is a breaking change to a
  published type that `agent-core`, `relay` and `dashboard` all re-export.
- `AppInstall`/`AppLaunch` × `ToAgent`/`ToRelay`, because those two literals travel in both directions
  carrying **different shapes**: the browser sends `buildId`, the relay resolves it into
  `payload: { filePath, bundleId }`. Naming forced that split into the open.

`device:shutdown` is the opposite case — identical in both directions, so it is **one** interface that
`RelayToAgent` and `BrowserToRelay` both reference, which states that the relay forwards it untouched.

The derivation is checked in source, and it is the only guard here that a regeneration cannot satisfy.
The per-message bindings in `typeAssertions.ts` (`_InputDone: InputDone['type'] = 'input:done'`) compare
two copies of one fact, so they catch an author who edits one of them; measured, editing both left every
assertion green.

## Connection handshake — what the upgrade URL carries

A browser cannot set headers on a WebSocket, so what a connection says about itself before its first
message rides on the upgrade URL's query string. One parameter today:

- **`?client=<id>` — who owns the sessions this socket starts** (#527). The relay keys ownership as
  `<userId>:<clientId>`, where the user comes from the connection's credential (cookie or PAT) and the
  client id is this parameter. **Omitting it is valid and changes the meaning**: the relay mints one per
  connection, so the caller gets per-socket ownership — a reconnect is a stranger to the sessions the
  previous socket held. **Sending a stable value** is what lets a reconnect resume its own sessions, and
  the user half is why a leaked client id is useless to anyone else.
- Read once at the upgrade, never re-read: the owner is a property of the connection, not of a join.
- Not validated, and not trusted for anything but grouping — `ownerKeyFor` in `RelayServer.ts` records
  why a caller-supplied string must not encode anything security-relevant.

The three in-repo clients send it: the dashboard (`useRelay.ts`, one value per *document*), `mcp-server`
(`client.ts`) and `flow-runner` (`RelayClient.ts`), one per client instance, so a reconnect of the same
instance resumes its sessions. Why the dashboard's is per document
rather than per tab-storage is a relay implementation decision and lives in
[relay/AGENTS.md](../relay/AGENTS.md).

## Request/response correlation — `requestId`, required on both sides

Correlated by `requestId` today: `screenshot`, `ui:tree`, `clipboard`, the app commands (`open-url`,
`app:install`, `app:launch`, `app:clear-state`), the device lifecycle (`device:boot`, `device:shutdown` — see
「Lifecycle correlation」), and **the inputs an ack answers** (see 「Input correlation」). What is left correlates
by `sessionId` + message type, and the reason a pair is *not* in the set is always one of the two below.

`#499` was the last of the defects that came from having no correlator, and it was the sharpest: the four pairs
above arrive at the speed a person clicks a button, while a swipe is dozens of frames, so an ack that missed
its own deadline being consumed by the **next** input's waiter was not a corner case.

**Required on the reply, not optional.** The tempting asymmetry is to leave the reply optional so an agent
predating the field does not falsify the declaration. It was measured and rejected:

- `required` yields complete, precise in-repo compile errors, because every agent send goes through a typed
  helper. Ten sites for `open-url`, nothing else.
- `optional` needs a static check to stand in for the compiler, and that check **cannot exist**. Presence is
  checkable; the property is *provenance* — that the id is the request's. A check built against the
  clipboard family, which is 100% correlated, produced seven false positives (a `respond` helper puts the
  `type` literal and the id in different object literals) and passed when an echo was replaced with a
  freshly minted id.
- Absence would carry **two** meanings wanting opposite handling: "an old agent", and "not a reply at all".
  The relay's `device:ready` replay is a permanent producer of the second.

**What enforces the echo, exactly.** Omission is a compile error — from `requestId: string` on the reply
interfaces, reached through the agents' send helper. A freshly minted id written as a *literal* at the
`respond(...)` call is an excess property — that is `<Pair>ReplyBody`, the reply minus the ids. Everything
else is tests, and **each pair needs its own**: an echo test per outcome and a concurrency test, because
hoisting the correlator out of per-request scope compiles clean and passes every other test in the suite.
The helper does not remove that work; a slice that assumed it did shipped six unverified `respond` helpers.

**Do not build a request-direction body type.** Four candidate guards were designed and broken. A branded
correlator is laundered by any cast to the brand, because a brand names a *kind* while provenance is a
property of the *instance* and TypeScript has no value-dependent types. A generic `Omit`-body helper does
not compile without a cast of its own, which is worse than the literal it replaces. The reply side earns its
type from ~20 literal sites; the request side has one per pair, on the line below the helper that builds it.

**A transformation carries the correlator.** `open-url` and `app:clear-state` are re-serialised whole, so it
rides for free. `app:install` / `app:launch` arrive with a `buildId` and the relay sends the agent a
*different* message after a DB lookup — the id must be copied, or the agent's reply, which the relay
forwards without inspecting, cannot be attributed. Required on the `…ToAgent` members makes dropping the
copy a compile error; only a test says the copied value is the request's.

**No fallback, and one policy at the door.** There is deliberately no fall-back to `sessionId` + type: a
second correlation strategy is what this work removes. Every browser request declaring a required
`requestId` is gated at the relay before it is forwarded, rebuilt or answered, because every reply it can
produce declares the correlator required too — answering without one means shipping a frame whose required
field `JSON.stringify` erases, which every correlating consumer then discards, turning a diagnosis into a
caller waiting out its deadline. That was a live defect twice (`open-url:error`, then `clipboard:error` a
slice later), so it is checked rather than asserted in prose:
`scripts/__tests__/correlatedRequestsGated.test.mjs` derives the request set from this file and fails if one
is ungated.

**Two properties make a correlator `optional` rather than absent**, and both were found by trying. They were
first written here as putting a pair *outside* correlation, which was wrong by one step: what they rule out is
`required`, and the pair still correlates — see 「Lifecycle correlation」 below.

- **The relay originates the request.** `device:shutdown` is sent by the relay itself when a browser socket
  closes, and it is one interface shared by both directions — so a required correlator would force the relay
  to invent an id for a request nobody made.
- **The reply is also sent unsolicited.** `device:shutdown-done` answers shutdowns nobody correlated (the
  relay's own on socket close, the dashboard's id-less teardowns); the relay replays `device:ready` from
  cache on a re-join, and `AndroidAgent.restartVideoStream` sends `device:boot-error` for a stream that died
  mid-session. A consumer that discards on a correlator mismatch stops learning about state it did not ask
  about — the cross-requester delivery that is a bug for `open-url` is the feature here.

## Lifecycle correlation — where the correlator is optional, and what that costs

`device:boot` / `device:shutdown` correlate, but not in the shape above: the **request** side of `device:boot`
is required and every reply is `requestId?`. Absence has exactly one meaning, and it is the one worth stating
at each declaration: **this frame is not the answer to a request.** Not "an old agent" — that reading is what
made the first draft of this pair wrong.

**The shutdown half had no failure member until #542, and that absence was doing work.** The relay resolved
that one command's session inline instead of through the shared resolver, so a shutdown it could not deliver
was dropped in silence — and there was no shape to answer with, which is what kept it a protocol change
rather than a relay one. `device:shutdown-error` is that shape, and `requestId?` because the request's own
correlator is optional. It was relay-produced only until #455, when both agents started answering a shutdown
they could not confirm and the relay started telling a caller whose session ended mid-shutdown. It now covers
four outcomes the wire does not tell apart — not delivered, outcome unknown, attempted and unconfirmed, not
attempted — listed at the declaration, so a consumer may say the device was not shut down and nothing more.
It is the one member of this pair a consumer **should** correlate — `shutdownDevice` awaits both halves on
one predicate, since matching only `-done` would leave the fix invisible to the caller it was written for.

**Optional means the reply's echo is enforced by tests alone.** `<Pair>ReplyBody` cannot be built for an
optional field — `Omit<T,'sessionId'|'requestId'>` is satisfied by an object that simply has no correlator, so
the excess-property trick that catches a freshly minted id has nothing to bite on. Everything the compiler does
for the app commands, tests do here. D24 applies at full strength, and the surface it applies to is wider than
the reply declarations, because **almost none of the fixtures constructing these five messages are typed.**
Deliberately no count here: three different greps for them disagree, and a number in this paragraph was wrong
within one commit of being written. The structural fact is what holds. The dashboard's are typed and checked —
its test channel is `useRef<(msg: BrowserToRelay) => void>` and its injected replies are annotated
`BrowserInbound`, which is why that package has a rule against `as never` and local shapes. Everyone else's
are `JSON.stringify({ … })` literals at an untyped `ws.send`, so they are `any` at the call site; the agent and
`mcp-server` tsconfigs also exclude `src/__tests__`, but typechecking those folders would not have helped,
because there is no annotation for a compiler to check against. The consequence is concrete: promoting
`DeviceBoot.requestId` to required produced no error in those files and instead **hung two agent suites**, and
several of those fixtures send `device:ready` with no `payload` at all — a shape the wire cannot produce.

**Because the correlator is optional, `correlatedRequestsGated` cannot see it.** That check derives its set
from *required* declarations (`/^ {2}requestId: string$/`), so every door gate and echo obligation on this pair
is outside its reach. The one that matters most is the relay's own: the relay answers a `device:boot` itself
when the agent is offline or the session is unknown, and that `device:boot-error` must echo the id or an MCP
caller reads a diagnosis as unsolicited and waits out its deadline instead. That is the defect this file already
records as having shipped twice, in a position no check reaches. A test is the only thing holding it.

**A consumer that requires a correlator on one of these replies is a bug, and one of them is load-bearing.**
The dashboard must **not** drop a `device:boot-error` for *lacking* an id — it is the sole surface reporting a
mid-session stream death, which carries no id by construction. Judging an id it *does* carry is a different
rule and became necessary in #526: the agents now answer a boot they abandon, so a viewer that replaced its
own boot receives that boot's failure while the replacement runs. `DeviceViewer` therefore reports every
uncorrelated one and, of the correlated, only the one answering the boot it is still waiting on — which is
the id it most recently sent, never `bootIdsRef` membership. The distinction to keep is *absent* versus
*mismatched*, not correlated versus not. `device:booting` is not correlated for a stronger reason than
"nobody waits on it": `DeviceViewer` **must** act on a boot another client requested, tearing down chrome and
in-flight install records whoever asked, so correlating it would suppress the case the message exists for.
What the correlator does buy on the consumer side is narrower and real — `DeviceViewer` decrements a pending
rebind on `device:ready`, and a replayed ready currently consumes one and fires a duplicate `app:install`.

**The request side is asymmetric for a mechanical reason, not a stylistic one.** A request passes *through* the
relay, so one door gates and logs every sender at once. A reply does not — the relay forwards it with
`JSON.stringify` without inspecting it — so "log the uncorrelatable frame" has to be written once per consuming
client, and one of those clients must not drop at all.

## Input correlation — the pair where the request is not one message

Five requests carry a required `requestId`: the four terminal frames (`input:touch:end`, `input:pinch:end`,
`input:key`, `input:button`) and `input:type`. The four replies do too — `input:done`, `input:error`,
`input:type-done`, `input:type-error`.

**Opening and move frames carry none, and neither does `input:rotate`.** Nothing acks them
(`ios-agent/AGENTS.md`: *"Opening frames stay silent: they carry no ack obligation"*), so an id there would
name a waiter that does not exist. `input:keyboard:toggle` is out for a different reason — see below.

**Required on both sides, unlike the lifecycle pair**, and the discriminator is the one this file already
uses: no producer of these four replies sends one unsolicited. `ackInput` on both agents fires on terminal
outcomes only; `ackNoSession` answers a terminal input for a session the agent lost; the relay answers a
terminal input it cannot dispatch. Six producers of `input:error`, every one of them behind a request.

**So the compiler holds more here than anywhere else in this work.** The relay's own `input:error` goes
through `sendTo(socket, msg: RelayOutbound)` and the agents' through `sendMsg(msg: AgentControlOutbound)`, so
with the reply required, omitting the echo is a **compile error** — not something only a test could see. That
is the position the lifecycle pair could not reach, and it is where the same defect had already shipped twice.

**`input:type-error` moved from `AgentToBrowser` to `RelayOrAgentToBrowser`.** The relay refuses an
`input:type` whose session the sender does not hold, and it has to refuse in *that* shape: the waiters in
`mcp-server` and `flow-runner` key on the `input:type-*` pair and ignore an `input:error` entirely. Answering
one would be the deadline-burning non-answer this reply replaced — which is also why widening the terminal
set was never the fix for it.

### The correlator is a parameter, never shared state

A gesture is dozens of frames and two can overlap, so `ackInput` and `ackNoSession` take the id as an
argument, beside `seq` and for the same reason: state moves under the awaited dispatch. A correlator read
from `DeviceState` would answer one input with another's id — #499 rebuilt inside the agent, where no test
downstream could see it.

`correlatorOf` on each agent is a **local capture**, not a guard at the top of the dispatcher. A guard there
does not narrow `msg.requestId` inside the case, so the shortest way to satisfy the reply's required field
would be `msg.requestId!` — the assertion removed from `open-url` and then from clipboard.

### The eleven input cases became two clauses

`input:*` shared one `case` body. Only five of them are answered, so a gate written into a shared body would
have dropped every opening and move frame with it: no swipe, no pinch, no rotation, and nothing said.
`correlatedRequestsGated` resolves fall-through by sharing the next non-empty body, so it would have read one
gate as covering all eleven. The split is what makes the gate unable to reach them, and
`TERMINAL_INPUT_TYPES` was deleted because the clause labels are now the definition — a second source of
truth for "which inputs are answered" is the thing this package exists to remove.

### The sender must hold the session, and a refusal is answered where a waiter exists

Not an input-only rule, though it was found there. The relay resolved the session and forwarded **every**
browser→agent command without asking whether the socket asking was the one the session is bound to —
`clipboard:data` asks the mirror-image question one branch up, with the reason beside it, and the browser
direction had no equivalent anywhere. So any authenticated client that knew a session id could drive a device
another tester was looking at, and the reply routed to that session's browser rather than to whoever asked.

Every branch that can take the check now has it: the five acked inputs, `device:boot`, `open-url`,
`app:install`, `app:launch`, `app:clear-state`, `clipboard:read`, `clipboard:write`, `session:leave`,
`session:end`. **`device:shutdown` takes a weaker gate than the ownership clause** (#527): refused when
another client holds the session, permitted when nobody does — because the dashboard's unmount teardown
races its own viewer socket's close on a different connection, and an owns-it gate would refuse the very
teardown that stops a device costing money. It is no longer an exception to being *answered* either: #542
gave the pair a failure member.

A refusal is **answered where a waiter exists** and dropped where none does — with `device:shutdown-error`
as the deliberate loosening, answered to the sender whether or not one is waiting. The relay cannot tell
whether an id-less sender is waiting: the dashboard's three teardown sends wait on nothing and its reboot
correlates, but `requestId` is optional on the wire, and a client that omits it and waits has nothing else
to act on. Sending to a socket that ignores it costs one frame; withholding it costs that client its answer.
Answering matters more than it
looks: `awaitInputAck` reports silence from a session that has never acked as *success* — unless the relay
has already said the session's agent went away — so a silent refusal would report a command that never left
the relay as landed, worse than the misrouting it replaced. The two
session commands have no reply at all, so they are dropped; the same asymmetry as the input frames nothing
acks, which is why the clause split matters twice.

One diagnosis improved for free. `open-url` answered `'agent offline'` for a session the relay does not have
— the wrong-diagnosis class #492 fixed for `device:boot` and `input:error`, still present here — and routing
it through the shared resolver corrected it.

`not-session-owner` is its own reason rather than folded into `channel-unavailable`, on this set's own rule —
a reason exists per thing a consumer must do differently. And it is the **only** member that can promise
nothing reached the device, because the refusal happens at the door; every other one leaves partial delivery
open, which is why none of them says "retry" without a hedge (#491).

### What this does not close

`input:keyboard:toggle` is **not** in the set, and the reason is not that it has no reply — it has one on
iOS, `keyboard:toggled`, with a consumer that sets session state. Its **failure half** is missing: the
agent's `.catch` only logs, and a session it holds no state for drops the message. The dashboard no longer
latches on that — the toggle's wait has an 8s deadline that releases the button and says the device did
not answer. The button keeps showing the last state the device confirmed; where the keyboard actually is,
is unknown (#517,
`DeviceViewer.keyboardDeadline.test.tsx`) — but the silence is still there, and a failure costs the tester
those 8 seconds.

So correlating this pair still needs the failure reply first. **This paragraph is that prerequisite now**, not
#517: the issue closed on the dashboard half, and older changelogs that name it as the prerequisite predate
that. Correlating one whose failure half does not
exist would leave it half-correlated, and the half that is missing is platform-asymmetric — Android's
toggle has no device-side effect at all, so what its failure even means is a decision that slice has to
make, together with the reply's shape.

## `error` is the session-start refusal, not an escape hatch

L5d ended a contradiction that sat in this file and in `index.ts` at once for two months. `GenericError`'s doc
claimed *"the escape hatch for a failure the relay cannot correlate to a session"*, while
`SessionStartFailure`'s claimed the reason has **a single producer inside `handleSessionStart`**. Both cannot
be true, and the program plan recorded that they were both in HEAD.

L5c settled it by removing the general role rather than the specific one. A request naming no session is
dropped at the relay's door — by the schema in `src/validate/` since #444, and by an `isAddressed`
predicate before that — because answering it would ship a frame whose own required
`sessionId` `JSON.stringify` erases — and `error` has no `requestId` either, so a caller could not attribute
the answer and would wait out the same deadline silence costs. With nothing left needing an unaddressed
failure, all five producers answer one specific join, and `error` **extends `SessionScoped`**: the shape is the
base verbatim, and the base's own definition — a failure a *session* is waiting on — is now exactly what it is.

**What the address buys.** The join waiters in `mcp-server` and `flow-runner` matched
`sessionId === undefined || sessionId === mine`, and with no such key the left half was *always* true — so any
refusal resolved any pending join. Two concurrent joins and the first refusal woke the wrong one, reported as a
failure that session never had, while the one that was actually refused waited out its deadline, because
`dispatch` resolves only the first matching waiter. That is #512's first finding, and the escape was it.

**The name stays `GenericError` even though the role narrowed.** The derivation rule would give `Error`, which
shadows the global, so the exception is anchored to the *literal* rather than to the role — `SessionStartError`
would need an exception entry just the same, and removing the entry needs a new wire literal. Renaming would
have cost every consumer plus `typeAssertions` and bought nothing.

**Skew is logged, not hedged.** A client newer than its relay sees unaddressed refusals, which now match
nothing, so the join runs to its deadline instead of reporting why. There is no version handshake anywhere in
this protocol, so the alternative was a fallback — the ambiguity this work exists to remove. Both clients log
instead, on the same reasoning as the input-ack skew record: logging is not matching.

**The same reasoning, a different cardinality — once per *client*, where the ack record is once per session.**
An agent is per session, so one old agent says nothing about the next device's; a relay is one per client for
the life of the process. Keying this one per session is not available either: the frame carries no address,
and naming the join in flight would mean guessing between pending ones, which is the false attribution L5d
removes. A first draft keyed on a literal and documented itself as per-session, which made it per-*process* —
so against an old relay the first refused session logged and every later one was silent.

## Watching a session — the holder declares, authentication decides

A teammate can watch, read-only, a session an AI client holds: `watch:start` / `watch:stop` from the
browser, `watch:started` / `watch:refused` in answer, then `watch:holder-left` and `watch:ended` as the
session moves under the watcher.

**Who is an AI client is declared, not inferred.** `session:start` carries `clientKind`. Reading it off the
credential (a PAT means a tool, a cookie means a person) was the first design and was dropped: a new auth
method would silently reclassify every session. The declaration is safe to trust because of what it grants
— it opens the *declarer's own* session to watchers and nothing else, so a false one can only expose
oneself. **Who may watch is decided by authentication instead** (a cookie, or a remote PAT with `view`),
never by anything a client says about itself. An absent `clientKind` — any client predating the field — is
not watchable, deliberately with no fallback.

**`holder` in the device list never carries the owner key or the client id.** The owner key is
`<userId>:<clientId>` with the client half off the handshake query, so a loopback socket that learned it
could claim it and pass the ownership gate. The list names the kind and a label for people (an email, or
`local`), which is all a viewer needs to offer Watch.

**The field is what a viewer offers Watch on.** First because it says the session is AI-held and so watchable.
Second as a version gate, for the cases `SessionInfo`'s "the dashboard cannot skew from the relay" does not
cover — a third-party viewer, or a relay downgraded under an open tab: an older relay drops `watch:start`
without a reply, and a relay that sends `holder` understands the message.

`watch:refused` extends `SessionScoped`; the other three carry `sessionId` directly, because the base is for a
failure a session is waiting on and they are not failures.

## Every direction is declared, and an agent's send is typed

The six unions cover the whole wire: `BrowserToRelay`, `AgentToRelay`, `RelayToAgent`, `RelayToBrowser`,
`AgentToBrowser`, `RelayToStream` / `StreamToRelay`. Both agents route every send through two typed helpers
rather than touching `ws.send`, and `scripts/__tests__/agentSendTyped.test.mjs` holds them to it — by matching
**serialization**, because three drafts keyed on the spelling `this.ws` were bypassed simply by giving the socket
another name.

**The helpers take `AgentControlOutbound = AgentToRelay | AgentToBrowser`, which excludes `StreamToRelay`.** A
union covering both sockets is the obvious thing to write and it undoes the direction split: the relay's
`case 'stream:register'` calls `setStreamSocket(session.id, ws)` with no role gate, so a control socket able to
type-check that message could take over the session's video path. The stream socket's one message is typed at its
own send site in `agent-core/src/utils/stream.ts`.

That mattered because an agent's literal was the one thing no compiler saw — the relay forwards replies with
`JSON.stringify(raw)` — the frame exactly as it arrived — so nothing typed re-creates them.
#489 and #490 are what the gap cost, and
`inputErrorReason.test.mjs` exists because a script had to stand in for a compiler.

**The browser side is the same rule and the same check shape.** All three browser-role producers — the dashboard's
`useRelay`, `mcp-server`'s client, `flow-runner`'s `RelayClient` — serialize through one `BrowserToRelay` sink, and
`scripts/__tests__/clientOutboundTyped.test.mjs` holds them to it. Its first draft asserted the *signature*
`private send(msg: BrowserToRelay)` and was defeated by a second helper named `sendRaw`: the assertion kept
passing on the typed one while the untyped one put a misspelled type on the wire. So it anchors on serialization
too, and derives its file list by inspection — the hardcoded pair it started with silently excluded the dashboard,
which has the most send sites of the three (47, against 32 for both clients).

Both checks read a union's *name* at the sink. Neither read its contents, and appending
`| Record<string, unknown>` to `BrowserToRelay` passed every static check while making all three clients accept
anything. Guards that name a type also have to assert the type is still a union of named messages.

**`screenshot:error` and `ui:tree:error` do not extend `SessionScoped`, and that is the boundary of the
family.** The base is for a failure a *session* is waiting on. Those two are request-scoped: the relay
resolves the pending promise by `requestId` alone and never reads their `sessionId`.

Their `sessionId` is nevertheless **required**, like every other producer field. A draft made it optional because
the agents passed through an optional id — true when written, and false by the end of the same change, which
required it on both dispatchers. A field weaker than every producer describes a message nobody sends, and here it
would also have removed the one field a symmetric ownership check could read: the clipboard replies beside these
verify `session.agentSocket === ws` before resolving, and these two do not.

## Browser-inbound messages are split by producer, and one union is shared

A browser receives every member of `BrowserInbound` — deliberately no count here; the disposition
tables pin it. They come from two producers, and the difference matters to the
**relay**, not to the consumer:

- **`RelayToBrowser`** — the relay builds these itself, so `sendTo(socket, msg: RelayOutbound)` holds
  them to the union. The compiler is the check.
- **`AgentToBrowser`** — an agent builds these and the relay forwards them with
  `JSON.stringify(raw)`, the frame exactly as it arrived. Nothing on the relay's send path references
  them, so **no compiler sees them.** That is why all twelve forward-only messages were absent from this file until L3, and why
  `scripts/__tests__/browserInboundRouting.test.mjs` exists: it compares the relay's forward case
  labels against this union in both directions.
- **`RelayOrAgentToBrowser`** — the ten with *both* producers (the relay replays session state to a
  re-joining viewer, and answers a request it cannot deliver). Declared **once** and referenced by
  both unions. Two copies of one message drift, which is not hypothetical: the dashboard kept its own
  copy of this whole surface and four members had diverged with nothing reporting it.

**Consumers should use `BrowserInbound`** — the union of both. A viewer does not care who sent it.

`RelayToStream` is its own direction for one message (`stream:registered`). It sat in
`RelayToBrowser` while that union meant "everything that is not an agent"; its consumer is
`agent-core`'s stream registration and no browser reads it.

### `sessionId` stays required, even where the relay cannot prove it

The relay used to reach eleven sessions through `msg.sessionId!` — an assertion the compiler cannot
verify — and `JSON.stringify` drops a key whose value is `undefined`. **`RelayServer.ts` now contains
none of them.** #444 made the inbound frame the product of a parse, so `sessionId` is a narrowed
`string` by the time any case reads it, and `.min(1)` refuses the empty string the old predicates were
written to catch. Two numbers stood in this paragraph before that — seven reply sites removed by L5c's
door predicates, then eleven reads — and each outlived its own basis, which is why there is no count
here now.

`device:shutdown` carries its own gate as of #527 — "not someone else's" rather than "mine"; that is still
a different question from addressing, and the parse does not answer it. The declaration was nevertheless right to
stay required rather than be widened:

- Every in-repo sender does supply one. `BrowserToRelay` declares `sessionId: string` on every member
  but `agents:list`, and since L4c all three senders are typed against that union, so the compiler
  enforces it rather than convention. (This bullet used to read "the untyped senders (`mcp-server`,
  `flow-runner`) set it too" — true when written, and falsified by the work that typed them.)
- `'Session not found'` answers a sessionId that did not **match** — a stale tab, a terminated
  session — not one that was absent.
- `{ type: 'error' }` **is not** an escape hatch, as of L5d — it is the answer to a `session:start` the relay
  refused, it extends `SessionScoped`, and it names the session it refuses. The paragraph that stood here said
  the right move with no sessionId was to send *that*; L5c settled it the other way, by dropping a request
  that names no session at the door. Both halves of the old advice are gone: there is no unaddressed failure
  left to send, and nothing left that would need one.

Widening would have let #444 delete those `!` with no consumer forced to care, and the guarantee would
have gone quietly with them — the door now enforces the declaration instead. It is also close to
irreversible: once optional, every consumer grows a guard.

The same reasoning applies to "no producer sends this yet, so leave it open." `mcp-server` has no
clipboard tool today; when one is added, `requestId` being **required** is what makes a missing id a
compile error instead of a reply the dashboard drops on `if (!msg.requestId) return`.

## `input:error` carries a reason

`input:error` used to travel with a human-readable `message` and nothing else, so a consumer could
not tell three different situations apart: an input that would land if retried in 200ms, one that
needs a reconnect, and one that will never work. All three read as the same failure, so a caller had
nothing to branch on and could only give up or blindly retry. (It is *not* why `mcp-server` falls
back to optimistic success on a timeout — that path fires when no ack arrives at all, and no field on
a message that never arrives could inform it. #457 is that one.)

`InputErrorReason` is the machine-readable half. Two rules make it usable:

- **The set comes from what a consumer must do differently**, not from how many internal states an
  agent has. iOS has one input path (a HID helper process); Android has three (a scrcpy socket, an
  emulator gRPC channel, `adb shell input`). Each agent maps its own states onto this smaller set —
  `android-agent`'s `wireReason()` is that map, and it collapses two of its reasons because a
  consumer's move is identical for them.
- **`message` stays free prose and `reason` is closed.** That is what lets iOS keep
  `` `unknown key code: ${code}` `` — the parameterised wording survives because the machine field is
  separate. Consumers switch on `reason`; they may show `message`, and since #491 made it optional a
  consumer that renders it needs a path for its absence — the dashboard drops the parenthetical rather
  than printing a placeholder.

The field is **required** as of #491, and `message` is the optional one. It shipped the other way
round on purpose — an agent predating `reason` omitted it and nothing broke — but that left the field
a consumer was guaranteed the one it must not depend on. The relay was the last in-repo producer
sending prose alone (#492); once it stopped, all six sent a reason and the flip cost no call site.

**Absence still means *unknown*, never *fine*, and a consumer meeting a reason it does not know must
treat it as `channel-unavailable`** — the conservative reading. Both clients keep that branch
deliberately: they read inbound as `Record<string, unknown>`, so the declaration obliges producers and
proves nothing at the call site, and an agent outside this repo predating the field is exactly the
producer a required declaration corrects going forward and cannot retroactively fix.

There is deliberately **no shared message table**. One would be a runtime value, and this entry point
must erase under `import type` (see HOW NOT) — so each agent owns its own wording. A static check in
`scripts/__tests__/inputErrorReason.test.mjs` holds both **agents** to the one union, since neither
agent's own test suite can see the other. The relay is the third producer and needs no such check: it
sends through `sendTo(socket, msg: RelayOutbound)`, so its literal is checked by the compiler.

## Changing what a value means — add a member, do not narrow one (#662)

Agents and the relay are installed separately — a Docker relay against a Mac agent installed months
earlier — and the dashboard ships inside the relay but a tab opened before an upgrade keeps running the
old bundle. So two pairs can skew: **relay ↔ agent** and **open tab ↔ relay**. There is no version
handshake (see *Skew is logged, not hedged* above), and adding one would not help the direction that
matters most: an old consumer has no code to read a new field.

So a change to what an existing wire value *means* is made like this:

1. **Add a new member rather than narrowing an old one.** #618 narrowed `unsupported-device` in place;
   it happened to be safe only because nothing had released either meaning yet.
2. **Write down what each released consumer renders for the new shape, and accept it only if that is
   the same as today or better.** `NetworkUnobserved` (#667) passed by this test and a third string value
   for `offline` failed it: released dashboards read `offline` as a truthy test, so an absent field draws
   online — what the `false` it replaced already drew — while `'unknown'` would have drawn *offline*.
   Consumers' `default` branches help only where they exist; that one was a ternary.
3. **If neither works, gate on a capability marker.** `capabilities` is an open `string[]` that the relay
   forwards verbatim to the viewer on `session:joined`, `session:rebound` and the device listing, so an
   agent can announce "I mean the new thing" with no schema change, and a viewer can fall back when the
   marker is absent. The relay must stay a conduit for the list for this to work — it checks its own
   gates through `hasCapability` and never filters the list.

#662 asked for a version field on `agent:register`. It was not added: the two skews it described never
shipped (network control, the reason split and `enforcement-lost` all first released together in
0.20.0), a version cannot fix an old consumer, and an optional field is non-breaking whenever a real use
for one — diagnostics, say — turns up.

## HOW NOT

- **No `enum`, no const objects, no runtime values of any kind — in the main entry.** They compile to JavaScript, so the moment a consumer references one as a value it stops being erased by `import type` and lands in the dashboard's browser bundle. String literal unions only. (`src/typeAssertions.ts` is checked by `tsconfig.assertions.json` and excluded from the build for exactly this reason — it declares values, so it must not reach `dist`.)
- **Do not add a dependency to the main entry.** It must stay importable from the browser bundle, the
  relay and mcp-server alike, and erasable under `import type`.
  `zod` is a dependency of the package (`./validate` needs it at runtime) and is deliberately **not**
  reachable from `./`. The cost is stated rather than hidden: `agent-core` and `flow-runner` import this
  package without importing `/validate`, so they carry zod in their install for nothing. It has no
  transitive dependencies and neither ships to a browser, which is why that was judged cheap — a second
  runtime dependency is not automatically the same trade.
- Do not widen a message to `unknown`/`Record<string, unknown>` to make a call site compile. That reopens the hole this package closes; fix the call site or correct the type.

## Consuming it

**Every `exports` subpath needs its own `source` condition.** `./validate` carries one, and without it
the relay's tests would validate against whatever was last *built* of this package — a stale parser
reporting green on a schema you just edited, which is the failure #459 shipped and the direction that
hides a validation hole rather than exposing one. `scripts/__tests__/testsReadSource.test.mjs` checks
that a package extends `sourceFirst`; it does **not** look at subpaths, so nothing would report the
omission.

The relay is composite (TS project references), so it needs both the dependency **and** a `references` entry pointing here — see [`contributing/monorepo-project-references.md`](../../contributing/monorepo-project-references.md). `dashboard` and `mcp-server` are not composite and need only the dependency — but they do **not** read `src` under `tsc`. Neither sets `customConditions` (`dashboard` is `moduleResolution: bundler`, `mcp-server` is `Node16`), so both take the first key in this package's `exports`, which is `./dist/index.d.ts`. The `source` condition is wired into **vitest** only, via `vitest.shared.ts`'s `ssr.resolve.conditions`.

That has a consequence worth knowing before measuring anything: **`pnpm typecheck` lies about these two until this package is rebuilt.** Tightening a field here and running the dashboard's typecheck against a stale `dist` reports 0 errors. And `tsc -b` never sees them at all — neither is in the root `references`, so a change whose fallout is entirely in `dashboard` builds clean.
