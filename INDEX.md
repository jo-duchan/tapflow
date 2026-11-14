---
type: index
topics: [meta, navigation]
status: living
---

# INDEX.md — AGENTS.md Reference Index

Each package's AGENTS.md is referenced hierarchically through this file.
Common rules are in the root [AGENTS.md](./AGENTS.md).

---

## Package Rules

| Package | AGENTS.md | Role |
|---------|-----------|------|
| protocol | [packages/protocol/AGENTS.md](./packages/protocol/AGENTS.md) | WebSocket wire contract shared by relay, dashboard and mcp-server (types only) |
| agent-core | [packages/agent-core/AGENTS.md](./packages/agent-core/AGENTS.md) | DeviceAgent interface design principles |
| ios-agent | [packages/ios-agent/AGENTS.md](./packages/ios-agent/AGENTS.md) | macOS-only simulator control rules |
| android-agent | [packages/android-agent/AGENTS.md](./packages/android-agent/AGENTS.md) | ADB-based emulator control rules |
| audiotap-helper | [packages/audiotap-helper/AGENTS.md](./packages/audiotap-helper/AGENTS.md) | shared macOS process-tap helper (iOS capture + Android host-mute) |
| relay | [packages/relay/AGENTS.md](./packages/relay/AGENTS.md) | WebSocket relay server rules |
| dashboard | [packages/dashboard/AGENTS.md](./packages/dashboard/AGENTS.md) | Vite + React SPA UI rules |
| cli | [packages/cli/AGENTS.md](./packages/cli/AGENTS.md) | CLI UX rules |
| mcp-server | [packages/mcp-server/AGENTS.md](./packages/mcp-server/AGENTS.md) | MCP server bridging tapflow to LLM agents |
| flow-runner | [packages/flow-runner/AGENTS.md](./packages/flow-runner/AGENTS.md) | Deterministic YAML flow engine (Automation) |
| test-utils | [packages/test-utils/AGENTS.md](./packages/test-utils/AGENTS.md) | Test-only helpers shared across packages (private, never published) |

## Local Only

| Directory | AGENTS.md | Purpose |
|-----------|-----------|---------|
| playground | [playground/AGENTS.md](./playground/AGENTS.md) | Full-stack local run and integration testing |
| .work | [.work/CLAUDE.md](./.work/CLAUDE.md) | Local work log conventions (plan/review/compound) |

## Documentation

| File | Contents |
|------|----------|
| [CONTRIBUTING.md](./CONTRIBUTING.md) | Branch, release, and commit conventions |
| [packages/dashboard/DESIGN.md](./packages/dashboard/DESIGN.md) | Dashboard design system — tokens, shared state rules, and the component list linking each spec in `design/components/` |
| [packages/ios-agent/netprobe/README.md](./packages/ios-agent/netprobe/README.md) | The network probe app — what it reports, why the reachability getter and listener are two separate lines, and how to arm layer 2 by hand |
| [packages/ios-agent/ios-netfilter/README.md](./packages/ios-agent/ios-netfilter/README.md) | The macOS network-filter system extension — why a content filter and not a transparent proxy, the container app's exit codes, and building it (paid Apple account, notarization, the load-bearing `CFBundleVersion` bump) |
| [.internal/PRD.md](./.internal/PRD.md) | Product requirements (local only) |
| [docs/AGENTS.md](./docs/AGENTS.md) | VitePress work rules — shiki code blocks, CSS customization notes |

### Engineering decision & rationale records — `contributing/`

Committed *why* behind non-obvious decisions. Read the relevant one **before** changing the code it describes. Schema and conventions: [contributing/README.md](./contributing/README.md).

| File | type | Contents |
|------|------|----------|
| [simulator-audio.md](./contributing/simulator-audio.md) | rationale | Simulator audio capture (iOS/Android) — design, whole-sim dynamic tap, sim-volume, rejected approaches |
| [legacy-browser-fallback-ios-only.md](./contributing/legacy-browser-fallback-ios-only.md) | rationale | Why the JPEG legacy-browser (~5%) fallback exists only on iOS — historical, not a bug |
| [monorepo-project-references.md](./contributing/monorepo-project-references.md) | rationale | Why library packages use TS project references — the `exports.types→src` bug (#345), rejected alternatives |
| [android-sdk-bootstrap.md](./contributing/android-sdk-bootstrap.md) | rationale | Why `setup android` bootstraps a self-contained SDK — Android Studio ≠ SDK, the three fragility causes |
| [runtime-platform-registration.md](./contributing/runtime-platform-registration.md) | rationale | Why platforms self-register at runtime (`AgentRegistry.register`) instead of a literal `Platform` union — the OCP payoff |
| [codec-negotiation.md](./contributing/codec-negotiation.md) | rationale | Why the browser negotiates H.264 capability before the agent streams — the ~95%/5% floor, black-screen prevention |
| [android-rotation.md](./contributing/android-rotation.md) | rationale | Why rotation uses `wm user-rotation` + pinned scrcpy 3.3 — legacy command ignored on API 35+ |
| [android-foldable-touch-coordinates.md](./contributing/android-foldable-touch-coordinates.md) | diagnosis | Why a folded foldable's taps miss — the divisor is the emulator's display, not the guest's panel |
| [ios-device-recovery.md](./contributing/ios-device-recovery.md) | rationale | Why `tapflow start` does not pre-boot iOS, and where zombie-simulator recovery lives |
| [capture-lag-attached-runner.md](./contributing/capture-lag-attached-runner.md) | diagnosis | Why a person's iOS device has no XCUITest runner attached — an idle runner lagged the app; measure Manual QA on and off |
| [agent-keep-awake.md](./contributing/agent-keep-awake.md) | rationale | Why the agent holds a `caffeinate` assertion during a session — idle throttle drops the emulator to ~4-5 fps |
| [agent-event-loop-blocking.md](./contributing/agent-event-loop-blocking.md) | diagnosis | Why the agents never run a child process synchronously on a timer — a stream that stutters at a steady interval, and how to find the call |
| [relay-heartbeat.md](./contributing/relay-heartbeat.md) | rationale | Why the relay runs a ping/pong heartbeat — dead sockets otherwise linger to the TCP timeout |
| [relay-resource-rejection.md](./contributing/relay-resource-rejection.md) | rationale | Why the relay rejects new sessions above a CPU/RAM threshold, evaluated relay-side |
| [relay-backpressure-frame-drop.md](./contributing/relay-backpressure-frame-drop.md) | rationale | Why the relay silently drops frames on `bufferedAmount` backpressure — bounds memory |
| [build-status-deletion-decoupling.md](./contributing/build-status-deletion-decoupling.md) | rationale | Why a build's `Done` status is decoupled from its `delete_after` deletion lifetime |
| [relay-tunnel-access.md](./contributing/relay-tunnel-access.md) | rationale | Why the relay stays inside the agent's network and tunneling is an opt-in plugin |
| [relay-agent-auth.md](./contributing/relay-agent-auth.md) | rationale | Why remote agents authenticate with an `agent`-scope PAT instead of an IP check |
| [relay-secret-loading.md](./contributing/relay-secret-loading.md) | rationale | Why the relay loads `.env` before evaluating its module-singleton config |
| [simkit-internals.md](./contributing/simkit-internals.md) | reference | SimulatorKit reverse-engineering notes — binary layout, symbols, touch/button injection |
| [ios-orientation-sources.md](./contributing/ios-orientation-sources.md) | reference | Where an iOS simulator's physical orientation can be read and written, per host Xcode — and the sources that only give the interface orientation |
| [measurement.md](./contributing/measurement.md) | reference | Every performance metric emitter — how to enable it, its output, what it means |
| [downscale-tuning.md](./contributing/downscale-tuning.md) | reference | Encode-resolution downscale lever — QA fidelity vs decode/bandwidth, recommended default |
| [frame-envelope.md](./contributing/frame-envelope.md) | reference | Frame envelope wire format (TFFE v1) — 22-byte per-frame timestamp header, magic-byte backward compat |
| [sustainability-carbon-math.md](./contributing/sustainability-carbon-math.md) | reference | Carbon arithmetic behind the Sustainability page — measured session increment, Apple PER inputs, sensitivity, and the comparisons we dropped |
| [streaming-latency-log.md](./contributing/streaming-latency-log.md) | log | Append-only glass-to-glass latency log — pipeline analysis, attempts, decisions |
| [android-video-streaming-diagnosis.md](./contributing/android-video-streaming-diagnosis.md) | diagnosis | Android emulator streaming issues traced to root cause, one section per issue |
| [awdl-wifi-latency-diagnosis.md](./contributing/awdl-wifi-latency-diagnosis.md) | diagnosis | Periodic Wi-Fi stream hitch traced to AWDL via ICMP ping — method and evidence |
| [macos-settings-deep-link-diagnosis.md](./contributing/macos-settings-deep-link-diagnosis.md) | diagnosis | Which `x-apple.systempreferences:` URL opens the Network Extensions **approval sheet** on macOS 27 — the three that do not, why `open`'s exit code proves nothing, and why an already-open window invalidates the reading |
| [simulator-boot-contention.md](./contributing/simulator-boot-contention.md) | diagnosis | What a simulator boot does to other sessions on the same Mac — the harm is the boot, not a memory percentage; priority demotion stalls the boot; fewer services at boot shrinks it |
| [workshop-lab-fork-observations.md](./contributing/workshop-lab-fork-observations.md) | reference | Third-party workshop-lab fork: independent iOS-sim capacity data (~4 seats/32GB) + where our extension seams stop |
| [adversarial-review.md](./contributing/adversarial-review.md) | rules | How to run the pre-PR review and the cross-cutting design pass — channel design, prompt skeleton, why a cleared list ages with the diff, why a fix falsifies the prose beside it, why the same review costs 4 minutes or 106 |
| [test-and-guard-coverage.md](./contributing/test-and-guard-coverage.md) | rules | What a test or a static check must **execute** to hold its claim — absence assertions verified only by the mutation that creates the absence, four ways a guard gets bypassed, why the success path gets the first mutation, and the three ways a probe passes for the wrong reason — including the one no mutation can find |
| [security-bumps.md](./contributing/security-bumps.md) | rules | Why a security bump is `pnpm update` before `pnpm.overrides` — fourteen inert entries measured, why the override key comes from the GHSA advisory and not the Dependabot alert, why the key and its replacement are both capped to one major |
