# Roadmap

> Live tracking → [GitHub Projects](https://github.com/users/jo-duchan/projects/1)

tapflow is currently at `v0.x`. The roadmap below reflects the path to a stable `v1.0.0`.
Breaking changes may appear in minor versions until `v1.0.0` is tagged.

**How to read this file.** ROADMAP.md owns *direction* — the phases, what each one is for,
version goals, and what is out of scope. The *live status* of individual work items lives in
[GitHub Projects](https://github.com/users/jo-duchan/projects/1) and the linked issues. Completed
foundation phases are kept as a checked record; active phases list their issues so the issue/board
stays the single source of truth.

---

## Current status

| Area | Status |
|------|--------|
| iOS Simulator streaming | ✅ Working |
| Android Emulator streaming | ✅ Working |
| Touch / swipe / pinch | ✅ Working |
| App Center (upload + manage builds) | ✅ Working |
| Session recordings | ✅ Working |
| Team management + PAT | ✅ Working |
| CLI (`start`, `doctor`, `devices`, …) | ✅ Working |
| Test coverage (cli, dashboard) | ✅ Working |
| Structured logging | ✅ Working |
| WebSocket backpressure | ✅ Working |
| Low-latency H.264 streaming (WebCodecs / WASM) | ✅ Working |
| `@tapflowio/mcp-server` (MCP tools + screenshot REST) | ✅ Working |

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

## Phase 4 — Experience (DX + UX) `v0.4.0`

Polish the **primary path**: a team opens a browser and tests on a real simulator/emulator with
no friction. This is tapflow's core value, so it comes first.

### UX — browser testing experience

The people who test (PO, PM, designers, QA). The headline is **low-latency streaming**: operating
the simulator/emulator in the browser should feel nearly as direct as touching it locally
(tier1 north star). Most recent work has driven this — H.264 + WebCodecs/WASM, relay
drop-to-keyframe — and it continues here.

- [#102](https://github.com/jo-duchan/tapflow/issues/102) — streaming performance improvements (encoding + transport)
- [#195](https://github.com/jo-duchan/tapflow/issues/195) — optimize capture cadence + touch input path
- [#156](https://github.com/jo-duchan/tapflow/issues/156) — evaluate WebTransport for relay→browser streaming
- [#153](https://github.com/jo-duchan/tapflow/issues/153) — app log viewer in the QA session

### DX — self-hosting & contributor experience

The people who install, operate, and contribute. Make setup, diagnosis, and operations smooth.

- [#142](https://github.com/jo-duchan/tapflow/issues/142) — `tapflow setup` — guided environment setup (iOS + Android)
- [#144](https://github.com/jo-duchan/tapflow/issues/144) — `tapflow setup ios` — guided iOS setup
- [#145](https://github.com/jo-duchan/tapflow/issues/145) — `tapflow setup android` — guided Android setup
- [#140](https://github.com/jo-duchan/tapflow/issues/140) — `tapflow doctor --json` for machine-readable output
- [#141](https://github.com/jo-duchan/tapflow/issues/141) — port-availability check in `tapflow doctor`
- [#166](https://github.com/jo-duchan/tapflow/issues/166) — backup guide (Litestream) for self-hosting
- [#154](https://github.com/jo-duchan/tapflow/issues/154) — changelog page on the docs site
- [#44](https://github.com/jo-duchan/tapflow/issues/44) — Tier 2 integration tests: real simulator/emulator smoke tests in CI
- [#168](https://github.com/jo-duchan/tapflow/issues/168) — dashboard code splitting to reduce initial bundle size

---

## Phase 5 — Agent Experience (AX) `v0.5.0` and beyond

Treat the LLM agent as a first-class user. The **additive** MCP path — opt-in, never affecting the
manual testing path — gets optimized here. The foundation already exists (`@tapflowio/mcp-server`
with MCP tools, plus the screenshot REST endpoint); Phase 5 builds on top.

- [x] Screenshot REST endpoint — `GET /api/v1/sessions/:sessionId/screenshot` for programmatic capture
- [x] `@tapflowio/mcp-server` — LLM-driven simulator control via MCP tools
- [#133](https://github.com/jo-duchan/tapflow/issues/133) — UI accessibility tree query for semantic commands (tap by element, not coordinates)

---

## Phase 5+ / Not yet scheduled

Larger tracks that fit tapflow's mission but are not yet committed to a version.

- **Physical device connection** — stream and control real, USB-connected devices alongside simulators/emulators
  - [#152](https://github.com/jo-duchan/tapflow/issues/152) — physical device connection (umbrella)
  - [#150](https://github.com/jo-duchan/tapflow/issues/150) — physical device connection — iOS
  - [#151](https://github.com/jo-duchan/tapflow/issues/151) — physical device connection — Android

---

## Not planned

The following are out of scope for tapflow's core mission ("browser-based simulator control, data on-premises"):

- **WebDriverAgent / Appium integration** — tapflow is a human QA tool, not an automation framework
- **Cloud hosting / SaaS mode** — tapflow is self-hosted by design
- **Video streaming via WebRTC** — DataChannel instability and lack of P2P benefit in a relay-intermediary architecture make this a net negative

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for branch strategy, commit conventions, and how to cut a release.
Feedback and PRs are welcome — especially for Phase 4 items.
