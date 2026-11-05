---
type: rules
topics: [mcp, ai-agent]
status: living
---

# mcp-server — AGENTS.md

> Common rules: [AGENTS.md](../../AGENTS.md) | Full index: [INDEX.md](../../INDEX.md)

---

## WHAT

`@tapflowio/mcp-server`: bridges tapflow to LLM agents via the [Model Context Protocol](https://modelcontextprotocol.io).

Published on the standard npm channel and versioned by changesets in the repo-wide fixed group (graduated from the `experimental` dist-tag in 2026-07). Publish only via the changesets flow — see [CONTRIBUTING.md § Branches & releases](../../CONTRIBUTING.md#branches--releases).

Connects to the relay over WebSocket + REST (`TapflowClient`), registers MCP tools, and exposes them to any MCP-compatible client (Claude Code, Codex, Cursor, etc.) via stdio transport.

## HOW

- Entry: `src/index.ts` → `src/startup.ts` — reads `TAPFLOW_RELAY_URL`, resolves the token (`TAPFLOW_TOKEN`, else the credentials file, flow-runner's `resolveToken`), connects `TapflowClient`, calls `registerTools`, starts `StdioServerTransport`.
- **A token is re-read, never read once** (T1). REST goes through flow-runner's `fetchWithToken`, which retries a 401 once when the file now holds a different token than the request carried. The socket cannot be retried in place: the relay closes it 1008 as a revocation lands (`onAuthChanged`; the heartbeat is the fallback), and at that moment the file is usually still old, so **`reconnectIfRotated` runs before every tool** (the `register` wrapper in `tools.ts`) and reconnects once when the token changed. A browser-role socket has no reconnect grace — the relay clears ownership on close — so held sessions are *not* re-joined silently; a tool on one answers "call connect_device again". **Start does not guess loopback from the URL**: it connects, and one `agents:list` round trip lets the relay decide (its tunnel port and a Docker bridge are not local though both are `localhost` here); a 1008 there exits 1 with the relay, the token's source and the fix; any other failure of that round trip (a slow relay) starts anyway, as before the check existed.
- Client: `src/client.ts` — WebSocket connection to relay + REST calls for build/app data. Its `send()` takes `BrowserToRelay` from [`@tapflowio/protocol`](../protocol/AGENTS.md), so a new outbound message goes in that union first. Receiving stays loose (`Record<string, unknown>` + a predicate) — a **deferral, not a settled decision**, tracked in #512. Narrowing it is a judgement about this file rather than a bug fix now: the defect it used to promise to catch — `error` matched on a `sessionId` that message did not have, so one session's refusal woke another's join — was closed by L5d addressing `error`, and `connectDevice` compares that field today. What narrowing would still do is make `message: string`, turning this file's `?? 'failed'` fallbacks into unreachable code. Deleting those used to remove a real defence, because nothing validated inbound JSON; #444 landed that validation at the relay, so the prerequisite this deferral named is met and #512 is now a judgement about this file alone.
- Tools: `src/tools.ts` — all MCP tool definitions. One `registerTools(server, client)` call registers everything.
- `src/guide.ts` — what the agent is told, at two costs. `INSTRUCTIONS` (server `instructions`) rides in every session, so it holds only what goes wrong when unknown, most important first (Claude Code cuts at 4,096 chars, Codex reads the first 512), and does not repeat tool descriptions. `TESTING_GUIDE` is returned by `get_testing_guide`, so it costs nothing until asked; it recommends only what these tools can do. `__tests__/guide.test.ts` holds both and the tool list to a size, and fails on a snake_case tool name that is not registered (a name misspelled out of that shape is not seen). A new tool that changes how to test belongs in the guide; one sentence in its own description is the rest.
- `src/inboundDisposition.ts` — what this client does with each message a browser socket can receive, or why it deliberately does not. `satisfies Record<BrowserInbound['type'], Disposition>`, so a message added to the wire breaks the file until someone decides. Most entries are `{ settles: '<method>' }` and carry no sentence on purpose: a symmetric request/reply pair has nothing to say its own name does not, and twenty lines of filler is how a table stops being read. `scripts/__tests__/clientInboundDisposition.test.mjs` holds it **both ways** — a handled entry needs a real comparison or `case` label somewhere in `src`, and an ignored one needs none, which is the half the dashboard's version lacks.
- **A session-scoped failure carries what the relay said about that session**, through `failed()`. `scripts/__tests__/sessionNoteCoverage.test.mjs` enforces it, and its rule is worth knowing before adding an error: it anchors on the **construction**, not the `throw`, and asks whether the expression reaches `failed()` / `sessionNote()` / `lifecycle`. Anchoring on `throw` misses the rejections inside closures — `waitFor`'s deadline is one deleted call away from stripping the cause off every request in the file — while allow-listing by class or exempting by method name both fail open.
- Screenshots are saved to a temp file and returned as MCP `image` content with base64 encoding.
- **The screenshot's format is read from its magic bytes, not from the request or the reply** (#508).
  The request's `format` is a preference (`ScreenshotRequest` in protocol) and the reply's is a claim, so
  neither can decide how to *parse* the bytes — and `getImageDimensions` picks a parser by format, feeding
  numbers the LLM hands back as `tap`'s divisors. Android produces PNG whatever is asked and used to echo
  the request, so a JPEG request was measured with a JPEG parser against PNG bytes, where a stray `ff c0`
  in the IDAT reads as a SOF0 marker and yields a wrong size. Sniffing here rather than trusting the
  agent's fix is what makes it work against an agent that has **not** been upgraded — separate processes,
  separate release lines, no version handshake. Unrecognised bytes fall back to the request and the
  response says so.



### Tool semantics (non-obvious)

`disconnect_device` only leaves the session (`session:leave`) — the device stays booted. It also **fails every request still waiting on that session**, with `SessionLeftError`: `session:leave` has no reply and the relay stops routing that session's replies as it processes one, so anything in flight would otherwise run to its full deadline — `BOOT_DEADLINE_MS` for a boot, which #549 raised past both agents' own boot ceilings, and 2s for the input ack this change's own test settles. The larger boot deadline is what makes this cancellation worth more than it was. The prose says the request may still have reached the device, because it may have. `shutdown_device` powers the device down (`device:shutdown` → agent runs simctl/adb shutdown → `device:shutdown-done`); use it to free resources or force a cold boot. Its waiter takes `device:shutdown-error` as well, which has two producers and covers four outcomes (listed at `DeviceShutdownError`): the relay, for a shutdown it could not deliver (#542) or whose session ended before the agent answered, and the agents, for one they attempted and could not confirm or had no state to attempt (#455). An agent older than #455 still answers a failure with nothing, so the deadline stays.

`run_flow` replays a `@tapflowio/flow-runner` YAML flow deterministically (no LLM at replay time) over this process's existing relay connection — it shares the session joined via `connect_device`, so it never opens a second WebSocket or hits "Session busy".

`query_ui_tree` returns the unified element schema (`role`/`label`/`identifier`/`placeholder`/`frame`/`enabled`/`rawRole`) via `GET /api/v1/sessions/:sessionId/ui-tree`. Frames are normalized 0-1, so a frame center multiplied by the screenshot pixel size feeds straight into `tap` — except on an iOS app drawn in landscape, where the frames are in the app's space and the screenshot is the portrait framebuffer (#1119). `run_flow` turns its points by the tree's `interfaceTurn`; these two tools do not.

### Input acks: silence is answered "could not confirm", and never retried here

`awaitInputAck` used to report **success** when no ack arrived within 2s. That fallback was for agents
predating the ack protocol and it outlived them, so a tap that never reached the device was reported as
landed to a model that then moved on (#457). Four things about the fix are easy to undo.

- **Silence *and a dropped connection* are both "could not confirm", not "dropped".** `ackInput` on both agents awaits a `simctl list` /
  `adb` device verify on the first input after a boot or reconnect, on the same Mac the relay gates at
  80% CPU — so an ack past the window can belong to an input that **did** land. Calling that a drop
  invites a retry, and a retry of a landed input duplicates it. The thrown text says the input may have
  landed and to check device state rather than repeat.
  The same holds when the socket closes mid-input, and that branch used to claim the opposite: every
  caller sends its input **before** awaiting the ack, so by then the input has left this process and the
  relay may have forwarded it. A close says nothing about whether the agent acks — only that we stopped
  being able to hear it — so it is unconfirmed regardless of the ledger.
- **Whether silence is fatal is decided by what the session has already done**, not by a negotiated
  flag: `ackedSessions` records a session that has answered an input with `input:done` **carrying a
  correlator**, and only those are judged strictly. L5c added that qualifier and it is the whole content of
  the rule: `strict` licenses exactly one inference — *silence here is an anomaly, not an agent that does not
  ack* — and for an agent that never carries a correlator, silence at the waiter is **structural**, since its
  acks can never match. Recording it would make every input after the first report a failure the agent never
  had a chance to avoid.
  It is not a provenance question. An id-less `input:done` is still the agent's word, because nothing else
  produces that message; what it lacks is *attribution*, and attribution is the waiter's question rather than
  this ledger's. Nor is the condition "an id **this client** issued" — recognising that after the fact needs a
  set of issued ids outliving their waiters, and the late ack is precisely the one worth recording, so the set
  would never shrink in a long-lived stdio process. A correlated ack for someone else's input still
  demonstrates that this agent echoes correlators, which is what the ledger is for.

  **`input:done` and not `input:error`**, because the relay originates
  `input:error` to this same socket for a terminal input it cannot dispatch — counting those would let
  one agent-offline blip mark a session as acking when its agent may never have answered anything, and
  then report every later input as unconfirmed on evidence the agent did not produce. Nothing in the
  relay originates an `input:done`. An agent that never acks is never judged, which is the safe
  direction, and it needs nothing on the wire. A capability flag was designed for this and discarded — it would have to be advertised by
  both agents, kept in step by a static check, and would then sit inert forever once every install had
  it, unremovable because consumers key on its absence. It would also have pre-decided the fork #491 is
  open on. The residual gap is any session that has never had an answer — usually just its first input,
  but **not bounded to one**: an agent whose acks never arrive keeps the optimistic path for as long as
  nothing else explains the silence. What the gate buys is that once a session answers, silence after that
  is reported.
  The ledger is written in `dispatch`, not where the ack is awaited, so an ack that missed its own
  window still counts — that is the case worth learning from, and a ledger kept at the waiter would see
  nothing.
- **The optimistic path is suspended while the relay says the agent is away**, and this is the one place
  the gap above is closed rather than merely bounded. `session:agent-away` means the agent's socket is
  gone; the relay refuses inputs sent *after* that, so an input already in flight gets nothing at all —
  and the exemption's usual case is the first input after a boot, which is that same input. Reporting it
  as landed is #457 with the evidence sitting unread in `dispatch`. So the return at `timedOut && !strict`
  carries `&& !away`, and the thrown text names the departure as the cause.
  **Narrowed to `away`, not to any lifecycle state**: a rebound session is answering again, so silence on
  it is once more the agent's to explain. `session:rebound` and `session:terminated` do not suppress it.
- **Nothing is retried here.** A per-reason retry was designed and discarded: `no-gesture` means either
  "nothing reached the device" or "the opening frames landed and only the last was refused", and the
  wire cannot tell them apart, so a client that retried would sometimes apply a drag twice with nobody
  able to see it had (tapflow#491 carries the vocabulary question). `TapflowClient` also drives
  `run_flow`, so a retry here makes deterministic replay non-deterministic. Retrying is the caller's
  decision, and `REASON_ADVICE` is what it decides on — including the warning that `no-gesture` may
  already have applied part of the input.

**That gap is closed (#499).** The ack used to carry no correlation id, so the waiter matched any ack for the
session and one that arrived after its own input had timed out was consumed by the *next* input's waiter —
which then reported the previous input's outcome, including reporting an unanswered input as landed. It was
the one way the gate above could still be defeated. `awaitInputAck` now matches on `requestId`, **with no
fallback for an absent one**: accepting an id-less ack would keep exactly the behaviour that defect was.

The cost lands on agents predating the correlator, and it is bounded by the ledger above rather than by a
version check — there is no protocol or agent version handshake anywhere in this system. Their acks never
match, so those sessions never become strict and keep the optimistic path: the residual exemption this file
already described, now widened from "agents predating the ack protocol" to "agents predating the correlator".
An id-less ack is therefore the only skew signal that exists, so it is recorded in `skewedSessions` — which
carries no strictness — and logged once per session. Dropping it silently would return the session to
optimistic reporting, which from an operator's seat is indistinguishable from the defect #457 fixed.

## HOW NOT

- Do not add relay-side logic to this package — it is a client only.
- **Do not retry an input inside `TapflowClient`.** See above — the reason vocabulary cannot express
  whether a refused gesture partially landed, so the client cannot know a retry is safe.
- Do not introduce stateful session management beyond what `TapflowClient` already tracks.
