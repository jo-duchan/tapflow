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
| agent-core | [packages/agent-core/AGENTS.md](./packages/agent-core/AGENTS.md) | DeviceAgent interface design principles |
| ios-agent | [packages/ios-agent/AGENTS.md](./packages/ios-agent/AGENTS.md) | macOS-only simulator control rules |
| android-agent | [packages/android-agent/AGENTS.md](./packages/android-agent/AGENTS.md) | ADB-based emulator control rules |
| audiotap-helper | [packages/audiotap-helper/AGENTS.md](./packages/audiotap-helper/AGENTS.md) | shared macOS process-tap helper (iOS capture + Android host-mute) |
| relay | [packages/relay/AGENTS.md](./packages/relay/AGENTS.md) | WebSocket relay server rules |
| dashboard | [packages/dashboard/AGENTS.md](./packages/dashboard/AGENTS.md) | Vite + React SPA UI rules |
| cli | [packages/cli/AGENTS.md](./packages/cli/AGENTS.md) | CLI UX rules |
| mcp-server | [packages/mcp-server/AGENTS.md](./packages/mcp-server/AGENTS.md) | MCP server bridging tapflow to LLM agents — experimental |

## Local Only

| Directory | AGENTS.md | Purpose |
|-----------|-----------|---------|
| playground | [playground/AGENTS.md](./playground/AGENTS.md) | Full-stack local run and integration testing |
| .work | [.work/CLAUDE.md](./.work/CLAUDE.md) | Local work log conventions (plan/review/compound) |
| .internal/marketing | [.internal/marketing/CLAUDE.md](./.internal/marketing/CLAUDE.md) | Marketing context — product positioning, copy bank, channel tone guide |

## Documentation

| File | Contents |
|------|----------|
| [CONTRIBUTING.md](./CONTRIBUTING.md) | Branch, release, and commit conventions |
| [packages/dashboard/DESIGN.md](./packages/dashboard/DESIGN.md) | Dashboard design system — color tokens, typography, elevation, component specs |
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
| [simkit-internals.md](./contributing/simkit-internals.md) | reference | SimulatorKit reverse-engineering notes — binary layout, symbols, touch/button injection |
| [measurement.md](./contributing/measurement.md) | reference | Every performance metric emitter — how to enable it, its output, what it means |
| [downscale-tuning.md](./contributing/downscale-tuning.md) | reference | Encode-resolution downscale lever — QA fidelity vs decode/bandwidth, recommended default |
| [streaming-latency-log.md](./contributing/streaming-latency-log.md) | log | Append-only glass-to-glass latency log — pipeline analysis, attempts, decisions |
| [android-video-streaming-diagnosis.md](./contributing/android-video-streaming-diagnosis.md) | diagnosis | Android emulator streaming issues traced to root cause, one section per issue |
| [awdl-wifi-latency-diagnosis.md](./contributing/awdl-wifi-latency-diagnosis.md) | diagnosis | Periodic Wi-Fi stream hitch traced to AWDL via ICMP ping — method and evidence |

---

## Hierarchy

```text
AGENTS.md (common rules — WHAT/WHY/HOW/HOW NOT)
└── INDEX.md (this file — package & doc reference index)
    ├── packages/agent-core/AGENTS.md
    ├── packages/ios-agent/AGENTS.md
    ├── packages/android-agent/AGENTS.md
    ├── packages/audiotap-helper/AGENTS.md
    ├── packages/relay/AGENTS.md
    ├── packages/dashboard/AGENTS.md
    ├── packages/cli/AGENTS.md
    ├── packages/mcp-server/AGENTS.md
    ├── playground/AGENTS.md
    ├── .work/CLAUDE.md
    ├── .internal/marketing/AGENTS.md
    ├── docs/AGENTS.md
    └── CONTRIBUTING.md
```
