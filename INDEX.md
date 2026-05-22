# INDEX.md — CLAUDE.md Reference Index

Each package's CLAUDE.md is referenced hierarchically through this file.
Common rules are in the root [CLAUDE.md](./CLAUDE.md).

---

## Package Rules

| Package | CLAUDE.md | Role |
|---------|-----------|------|
| agent-core | [packages/agent-core/CLAUDE.md](./packages/agent-core/CLAUDE.md) | DeviceAgent interface design principles |
| ios-agent | [packages/ios-agent/CLAUDE.md](./packages/ios-agent/CLAUDE.md) | macOS-only simulator control rules |
| android-agent | [packages/android-agent/CLAUDE.md](./packages/android-agent/CLAUDE.md) | ADB-based emulator control rules |
| relay | [packages/relay/CLAUDE.md](./packages/relay/CLAUDE.md) | WebSocket relay server rules |
| dashboard | [packages/dashboard/CLAUDE.md](./packages/dashboard/CLAUDE.md) | Vite + React SPA UI rules |
| cli | [packages/cli/CLAUDE.md](./packages/cli/CLAUDE.md) | CLI UX rules |

## Local Only

| Directory | CLAUDE.md | Purpose |
|-----------|-----------|---------|
| playground | [playground/CLAUDE.md](./playground/CLAUDE.md) | Full-stack local run and integration testing |
| .work | [.work/CLAUDE.md](./.work/CLAUDE.md) | Local work log conventions (plan/review/compound) |
| .internal/marketing | [.internal/marketing/CLAUDE.md](./.internal/marketing/CLAUDE.md) | Marketing context — product positioning, copy bank, channel tone guide |

## Documentation

| File | Contents |
|------|----------|
| [CONTRIBUTING.md](./CONTRIBUTING.md) | Branch, release, and commit conventions |
| [packages/dashboard/DESIGN.md](./packages/dashboard/DESIGN.md) | Dashboard design system — color tokens, typography, elevation, component specs |
| [.internal/PRD.md](./.internal/PRD.md) | Product requirements (local only) |
| [docs/CLAUDE.md](./docs/CLAUDE.md) | VitePress work rules — shiki code blocks, CSS customization notes |

---

## Hierarchy

```
CLAUDE.md (common rules — WHAT/WHY/HOW/HOW NOT)
└── INDEX.md (this file — package & doc reference index)
    ├── packages/agent-core/CLAUDE.md
    ├── packages/ios-agent/CLAUDE.md
    ├── packages/android-agent/CLAUDE.md
    ├── packages/relay/CLAUDE.md
    ├── packages/dashboard/CLAUDE.md
    ├── packages/cli/CLAUDE.md
    ├── playground/CLAUDE.md
    ├── .work/CLAUDE.md
    ├── .internal/marketing/CLAUDE.md
    ├── docs/CLAUDE.md
    └── CONTRIBUTING.md
```
