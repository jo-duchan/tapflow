# Roadmap

> Live tracking → [GitHub Projects](https://github.com/users/jo-duchan/projects/1)

tapflow is currently in **alpha** (`v0.x`). The roadmap below reflects the path to a stable `v1.0.0`.
Breaking changes may appear in minor versions until `v1.0.0` is tagged.

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
| WebSocket backpressure | ❌ Missing |

---

## Phase 1 — Stability (pre-launch) `v0.1.0`

Critical bug fixes before the first public release.

- [x] Graceful child process shutdown — register `SIGINT`/`SIGTERM` handlers to call `agent.disconnect()`, preventing zombie processes for `touch-helper`, `keyboard-helper`, and `scrcpy`
- [x] `ScreenCaptureStreamer`: send `SIGTERM` first → wait 1s → `SIGKILL`
- [x] `ScrcpySession.start()`: wrap server process in try-finally to guarantee cleanup on error
- [x] `RelayServer.stop()`: call `clearInterval` for `purgeExpiredRecordings` and `flushResourceBuffers`

---

## Phase 2 — Quality `v0.2.0`

Developer experience and reliability improvements. `v0.2.0` drops the `-alpha` suffix — npm package is stable and all Phase 2 quality items are complete.

- [x] Pre-commit hooks — add Lefthook with lint + typecheck on staged files to catch errors before push
- [x] `logger.ts` abstraction — replace 66 direct `console.log/error` calls with a leveled logger (`debug` / `info` / `warn` / `error`)
- [ ] Custom error classes — `ValidationError`, `PlatformError`, `AuthError`
- [x] CLI smoke tests — `--version`, `--help` subprocess smoke tests via tsx
- [x] Zod-based config validation — catch `NaN` and invalid values at startup instead of silently at runtime
- [x] Migration atomic transactions — wrap all migrations in `db.transaction()` to prevent partial failure states
- [x] Coordinate transform unit tests — normalize (0–1), landscape rotation, display scale, bezel offset
- [x] `touch-helper` stdin protocol snapshot tests — lock byte layout to the spec in `ios-agent/CLAUDE.md`

---

## Phase 3 — Ecosystem `v0.3.0` and beyond

Scalability, extensibility, and CI/CD integration.

- [ ] WebSocket backpressure — check `ws.bufferedAmount` before sending frames; drop or queue frames for slow clients
- [ ] Runtime platform registration — replace `'ios' | 'android'` literal union with a dynamic registry so new platforms require zero changes to `agent-core`, CLI, or Dashboard
- [ ] CI/CD integration guide — end-to-end walkthrough: upload `.app.zip` / `.apk` via REST API from CI → view results in the dashboard
- [ ] PAT scope enforcement — apply `scope` checks consistently across all endpoints
- [ ] Tier 2 integration tests — real simulator / emulator touch and stream smoke tests in GitHub Actions (`macos-latest` for iOS, `ubuntu-latest` + `reactivecircus/android-emulator-runner` for Android)

---

## Not planned

The following are out of scope for tapflow's core mission ("browser-based simulator control, data on-premises"):

- **WebDriverAgent / Appium integration** — tapflow is a human QA tool, not an automation framework
- **Cloud hosting / SaaS mode** — tapflow is self-hosted by design
- **Video streaming via WebRTC** — DataChannel instability and lack of P2P benefit in a relay-intermediary architecture make this a net negative

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for branch strategy, commit conventions, and how to cut a release.
Feedback and PRs are welcome — especially for Phase 1 and Phase 2 items.
