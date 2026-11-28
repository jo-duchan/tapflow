# Roadmap

> Live tracking → [GitHub Projects](https://github.com/users/jo-duchan/projects/1)
> Why we build this way → [VISION.md](./VISION.md)

tapflow is currently at `v0.x`. The roadmap below reflects the path to a stable `v1.0.0`.
Breaking changes may appear in minor versions until `v1.0.0` is tagged.

**How to read this file.** ROADMAP.md owns *direction* — the phases, what each one is for,
and what is out of scope. The *live status* of individual work items lives in
[GitHub Projects](https://github.com/users/jo-duchan/projects/1) and the linked issues. Completed
foundation phases are kept as a checked record; active phases name their themes and link the
issue label, so the board stays the single source of truth.

**Phases are direction, not release numbers.** Phases 1–3 shipped as `v0.1.0`–`v0.3.0` and keep
those tags as a record. Everything since has shipped continuously across the `v0.x` line, so the
active phases carry no version of their own — Phase 4 and Phase 5 work lands in whichever release
it is ready for.

---

## Three ways to use tapflow

**tapflow Core** is the layer every part of tapflow shares: devices, sessions, UI trees, builds, run records, and resource management. It is a concept, not a separate package or product. There are three ways to use it, and a team can start from any of them (see [VISION.md](./VISION.md) for the why).

- **Manual QA** — the browser dashboard: the team tests by hand on a real simulator or emulator. Shipping today (Phases 1–4).
- **AI Agent QA (via MCP)** — the MCP server lets an LLM agent drive a device, in the same session a person can open and watch. Shipping today but **experimental** (Phase 5 foundation).
- **Automation QA** — the deterministic flow runner (`tapflow flow run`), mainly in CI. Shipping today but **experimental** (Phase 5 foundation).

**Experimental** means the names, options and behavior can still change in a minor release, and every such change is listed in the CHANGELOG; the docs mark each experimental page with a banner ([Page status](https://www.tapflow.dev/get-started/introduction#page-status)). What decides each move to stable: the MCP server after [#1119](https://github.com/jo-duchan/tapflow/issues/1119) settles the `query_ui_tree` output, and the flow format and Flow Runs after the official CI recipe ([#1211](https://github.com/jo-duchan/tapflow/issues/1211)).

What sets tapflow apart is how the three connect. An agent can author a flow through the MCP tools and replay it, and a failed run is a record a person or an agent can read. **Flow Capture** turns what a person did in a QA Session into a flow, checked by replaying it on the device with no model involved (shipped in 0.33). The same for a coding agent over MCP is in the next release. It drops the cost of turning QA already done into automation to nearly zero.

## Current status

| Area | Status |
|------|--------|
| iOS Simulator streaming | ✅ Working |
| Android Emulator streaming | ✅ Working |
| Low-latency H.264 streaming (WebCodecs / WASM, JPEG fallback) | ✅ Working |
| Touch / swipe / pinch, hardware buttons, rotation | ✅ Working |
| Keyboard input and clipboard in both directions | ✅ Working |
| Device audio in the browser | ✅ Working |
| Take a device off the network, and put it back | ✅ Working (iOS needs the bundled network filter) |
| Restart a device without leaving the session | ✅ Working |
| App Center (upload + manage builds) | ✅ Working |
| Session recordings | ✅ Working |
| Team management + PAT | ✅ Working |
| Mac resource monitoring | ✅ Working |
| CLI (`start`, `setup`, `doctor`, `devices`, …) | ✅ Working |
| Relay over HTTPS / WSS on a domain you own | ✅ Working |
| Relay as a Docker image | ✅ Working |
| macOS 26–27 with Xcode 26–27 | ✅ Supported |
| `@tapflowio/mcp-server` (MCP tools + screenshot REST) | ✅ Working — experimental |
| UI tree query (`query_ui_tree`) | ✅ Working — experimental |
| Deterministic flow runner (`tapflow flow run`, `run_flow`) | ✅ Working — experimental |
| Flow Capture (QA Session → flow YAML) | ✅ Working |

The groundwork behind these (structured logging, WebSocket backpressure, the platform registry,
test coverage) is the record kept in Phases 1–3 below.

---

## Foundation — Phases 1–3 (complete)

The structural groundwork: a stable, well-tested, extensible base. These phases are done; kept
here as a record.

### Phase 1 — Stability `v0.1.0`

Critical bug fixes before the first public release.

- [x] Graceful child process shutdown — register `SIGINT`/`SIGTERM` handlers to call `agent.disconnect()`, preventing zombie processes for `touch-helper`, `keyboard-helper`, and `scrcpy`
- [x] `ScreenCaptureStreamer`: send `SIGTERM` first → wait 1s → `SIGKILL`
- [x] `ScrcpySession.start()`: wrap server process in try-finally to guarantee cleanup on error
- [x] `RelayServer.stop()`: call `clearInterval` for `purgeExpiredRecordings` and `flushResourceBuffers`

### Phase 2 — Quality `v0.2.0`

Developer experience and reliability. `v0.2.0` drops the `-alpha` suffix.

- [x] Pre-commit hooks — Lefthook with lint + typecheck on staged files
- [x] `logger.ts` abstraction — replace 66 direct `console.log/error` calls with a leveled logger
- [x] Custom error classes — `ValidationError`, `PlatformError`, `AuthError`
- [x] CLI smoke tests — `--version`, `--help` subprocess smoke tests via tsx
- [x] Zod-based config validation — catch `NaN` and invalid values at startup
- [x] Migration atomic transactions — wrap all migrations in `db.transaction()`
- [x] Coordinate transform unit tests — normalize (0–1), landscape rotation, display scale, bezel offset
- [x] `touch-helper` stdin protocol snapshot tests — lock byte layout to spec

### Phase 3 — Ecosystem `v0.3.0`

Scalability, extensibility, and CI/CD integration.

- [x] WebSocket backpressure — check `ws.bufferedAmount` before sending frames; drop or queue for slow clients
- [x] Runtime platform registration — dynamic registry so new platforms need zero changes to `agent-core`, CLI, or Dashboard
- [x] PAT scope enforcement — apply `scope` checks consistently across all endpoints
- [x] CI/CD integration guide — upload `.app.zip` / `.apk` via REST API from CI → view in the dashboard

---

## Phase 4 — Experience (DX + UX)

Polish the **manual path**: a team opens a browser and tests on a real simulator/emulator with
no friction. It is the most mature part, so most of the work lands here release to release. The open items live under the
[`phase-4` label](https://github.com/jo-duchan/tapflow/issues?q=is%3Aopen+label%3Aphase-4) rather
than in this file, because that list changes every week.

### UX — browser testing experience

The people who test (PO, PM, designers, QA). The headline is **low-latency streaming**: operating
the simulator/emulator in the browser should feel nearly as direct as touching it locally
(tier1 north star). H.264 with WebCodecs/WASM and relay drop-to-keyframe got it most of the way,
and the remaining work is fidelity and observability during a session.

- [#202](https://github.com/jo-duchan/tapflow/issues/202) — iOS session recording at native resolution (match Android fidelity)
- [#153](https://github.com/jo-duchan/tapflow/issues/153) — app log viewer in the QA session
- [#156](https://github.com/jo-duchan/tapflow/issues/156) — evaluate WebTransport for relay→browser streaming

### DX — self-hosting & contributor experience

The people who install, operate, and contribute. Guided setup (`tapflow setup`, `doctor --json`,
the port check), the Litestream backup guide and dashboard code splitting have shipped. What is
left: keep the install honest about what it is doing, and stay current with the platforms
underneath.

- [#797](https://github.com/jo-duchan/tapflow/issues/797) — track the yearly platform releases: macOS 27 / Xcode 27 (shipped in v0.22.0), then foldables (iPhone Duo, Android)
- [#799](https://github.com/jo-duchan/tapflow/issues/799) — network control setup and offline behaviour: a silent install, a permission step that is easy to miss, connections that survive going offline
- [#44](https://github.com/jo-duchan/tapflow/issues/44) — Tier 2 integration tests: real simulator/emulator smoke tests in CI

Platform support is a standing cost, not a project. Apple and Google ship a major toolchain
every year, and tapflow drives private frameworks that move with them: Xcode 27 relocated
SimulatorKit and took the screen dimensions out of the device profile, and both had to be found
and fixed before an agent would run on it. Expect one of these a year, verified on a Mac whose
only toolchain is the new one.

---

## Phase 5 — Agent Experience (AX)

Phase 5 covers the two ways of using tapflow beyond the dashboard: **AI Agent QA**, where a coding
agent drives a device through MCP, and **Automation QA**, the flow runner whose main stage is CI/CD. Both run on the
same session infrastructure as manual QA (relay, agents, dashboard observation), are opt-in, and
never affect the manual path.

The guiding principle: **an LLM is involved only at authoring time — replay
is deterministic.** Agents explore the app through MCP tools and generate flow files; CI replays
those flows with zero LLM calls, which keeps runs idempotent and API cost at zero. Flow files are
a generated artifact, not a language users must learn.

The foundation shipped, and both are still experimental (see [Three ways to use tapflow](#three-ways-to-use-tapflow)
for what that means and what moves each to stable). Hardening is tracked under the
[`phase-5` label](https://github.com/jo-duchan/tapflow/issues?q=is%3Aopen+label%3Aphase-5).

- [x] Screenshot REST endpoint — `GET /api/v1/sessions/:sessionId/screenshot` for programmatic capture
- [x] `@tapflowio/mcp-server` — LLM-driven simulator control via MCP tools
- [x] [#133](https://github.com/jo-duchan/tapflow/issues/133) — UI accessibility tree query (`query_ui_tree`) — unified element schema with normalized frames, so agents tap by element instead of guessing coordinates
- [x] Deterministic YAML flow format + headless CLI runner — `tapflow flow run`, with state reset, condition-based waits, JUnit report and failure screenshots, and no LLM at replay time ([flow reference](https://www.tapflow.dev/automation/flows))
- [x] `run_flow` MCP tool — agents replay verified flows through the same deterministic engine
- [x] **Flow Capture** (the manual↔AI bridge) — a person operates the app in a QA Session; tapflow names each step by a selector from the UI tree where something there can be named, keeps a point marked fragile where nothing can, and replays the flow on the device before it is exported, no agent required (0.33, [Flow Capture](https://www.tapflow.dev/testing/flow-capture))
- [x] **MCP Flow Capture** — the same for an AI agent: `capture_flow` resets the device, replays the captured steps and returns the YAML only if it passes. With an agent that cannot reset the device, it clears only the app's data, or nothing, and its reply says so in `resetNote` (unreleased)

### Reviewable automation

What an agent or a flow run does should be something a person can see, and the same record should
be readable by an agent ([VISION.md](./VISION.md#always-reviewable-what-ai-does-a-person-can-see)).
A device an agent held used to show only as "In use", and a flow run's result exists only as JUnit and
screenshots in the CI job. This track ships in two stages. **First make it usable,
then refine it.** Every step is additive, so a team picks it up by upgrading.

Usable:

- [x] **AI session page**: watch a device an MCP or flow-runner client is driving, live and read-only,
  through the link the client hands to the person who started it. The QA session page stays built for
  manual testing, and the two share the device view.
- [ ] **Agent action timeline** on that page. The relay passes the agent's actions to watchers as they
  happen and does not store them.
- [x] **Flow run records**: the flow, per-step results, the failure screenshot, and whether the product
  or the environment failed. Records attach to the build and are deleted with it. The Flow Runs page is where
  CI runs are seen, live and afterwards, filtered by build, status and flow.
- [x] **Run recording** that works without a browser, as in CI.

Refine:

- [ ] Product vs environment failure shown first on a run record.
- [ ] Selector fix suggestions. When a selector fails, tapflow suggests a YAML patch built from the UI
  tree at that moment, with no LLM involved.
- [x] Run records readable through MCP, so an agent can repair a failed flow and replay it
  deterministically.

---

## Phase 5+ / Not yet scheduled

Larger tracks that fit tapflow's mission but are not yet committed to a version.

- **Physical device connection** — stream and control real, USB-connected devices alongside simulators/emulators
  - [#152](https://github.com/jo-duchan/tapflow/issues/152) — physical device connection (umbrella)
  - [#150](https://github.com/jo-duchan/tapflow/issues/150) — physical device connection — iOS
  - [#151](https://github.com/jo-duchan/tapflow/issues/151) — physical device connection — Android
- **Wider hosts and hardware**
  - [#464](https://github.com/jo-duchan/tapflow/issues/464) — the native helper binaries are arm64-only, so Intel Macs cannot run an agent
  - [#334](https://github.com/jo-duchan/tapflow/issues/334) — audio input (browser → device), the counterpart to the audio that already comes back

---

## Not planned

The following are out of scope for tapflow's core mission ("browser-based simulator control, data on-premises"):

- **External automation framework integration (WebDriverAgent, Appium, Selenium)** — Automation is served by tapflow's own minimal, deterministic flow runner (Phase 5); wiring in external drivers is not planned
- **Cloud hosting / SaaS mode** — tapflow is self-hosted by design
- **Video streaming via WebRTC** — DataChannel instability and lack of P2P benefit in a relay-intermediary architecture make this a net negative

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for branch strategy, commit conventions, and how to cut a release.
Feedback and PRs are welcome — especially for Phase 4 items.
