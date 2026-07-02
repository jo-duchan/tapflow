---
type: index
topics: [meta, documentation, contributing]
status: living
---

# contributing/ — Engineering Decision & Rationale Records

This directory is tapflow's **committed** engineering memory: the *why* behind
non-obvious decisions, the reverse-engineering notes, the diagnoses, and the
measurement references that a contributor (human or LLM) should read **before**
changing the code they describe.

It is the public counterpart to `.work/` (local, gitignored, throwaway). When a
decision recorded in a `.work/` plan turns out to be worth sharing (someone would
otherwise re-walk a dead end or "fix" a deliberate asymmetry), it is promoted here,
curated in English. `.work/` stays private; this stays committed and kept.

> These are **not** user docs. User-facing guides and references live in `docs/`
> (VitePress). A file here often has a user-facing sibling in `docs/` — this side
> holds the engineering backing (method, evidence, dead ends) deliberately kept out
> of the user docs.

## Frontmatter schema

Every file here carries a two-tier frontmatter block. The same schema governs the
other retrieval-hot docs in the repo (`AGENTS.md` files, `INDEX.md`). It exists so an
agent can filter docs by a single predictable protocol (`read frontmatter.topics`)
instead of special-casing which files carry metadata.

```yaml
# Tier 1 — universal, static (does not go stale)
type:   guide | reference | rationale | log | diagnosis | rules | index
topics: [ios, audio, streaming, ...]   # stable subject tags; how docs are found

# Tier 2 — lifecycle, only where a lifecycle actually exists
status:  living | stable | draft | in-progress | done | superseded
updated: YYYY-MM-DD                     # optional; set only when known, never guessed
related: [slug, ...]                    # sibling filenames without .md
```

Rule of thumb: **lifecycle fields (`status`/`updated`) go only on docs that have a
lifecycle.** A settled rationale note is `stable`; an append-only log or a
per-issue diagnosis is `living`. Static reference docs need no `status` beyond that.
A stale `status` misleads grep-based retrieval, worse than none, so omit what you
cannot keep true.

### `type` vocabulary

| type | meaning |
|------|---------|
| `rationale` | *why it's this way* — read before "fixing" the thing it explains |
| `reference` | a settled fact surface (internals, instrumentation, tuning knobs) |
| `log` | append-only chronological engineering record |
| `diagnosis` | a traced-to-root-cause investigation, one section per issue |
| `index` | a map/entry point (this file) |
| `rules` | agent instructions (`AGENTS.md`) |

## Current records

| File | type | topics |
|------|------|--------|
| [simulator-audio.md](./simulator-audio.md) | rationale | audio, ios, android |
| [legacy-browser-fallback-ios-only.md](./legacy-browser-fallback-ios-only.md) | rationale | ios, streaming, browser-compat |
| [monorepo-project-references.md](./monorepo-project-references.md) | rationale | monorepo, typescript, build |
| [android-sdk-bootstrap.md](./android-sdk-bootstrap.md) | rationale | android, setup, sdk |
| [runtime-platform-registration.md](./runtime-platform-registration.md) | rationale | agent-core, architecture, extensibility |
| [codec-negotiation.md](./codec-negotiation.md) | rationale | streaming, codec, browser-compat |
| [android-rotation.md](./android-rotation.md) | rationale | android, rotation, scrcpy |
| [ios-device-recovery.md](./ios-device-recovery.md) | rationale | ios, lifecycle, recovery |
| [agent-keep-awake.md](./agent-keep-awake.md) | rationale | macos, performance, power |
| [relay-heartbeat.md](./relay-heartbeat.md) | rationale | relay, websocket, reliability |
| [relay-resource-rejection.md](./relay-resource-rejection.md) | rationale | relay, resource-management, session |
| [relay-backpressure-frame-drop.md](./relay-backpressure-frame-drop.md) | rationale | relay, streaming, backpressure |
| [build-status-deletion-decoupling.md](./build-status-deletion-decoupling.md) | rationale | relay, builds, storage |
| [relay-tunnel-access.md](./relay-tunnel-access.md) | rationale | relay, deployment, tunnel |
| [relay-agent-auth.md](./relay-agent-auth.md) | rationale | relay, auth, security |
| [relay-secret-loading.md](./relay-secret-loading.md) | rationale | relay, config, secrets |
| [simkit-internals.md](./simkit-internals.md) | reference | ios, simulator, reverse-engineering |
| [measurement.md](./measurement.md) | reference | performance, measurement, instrumentation |
| [downscale-tuning.md](./downscale-tuning.md) | reference | streaming, performance, downscale |
| [frame-envelope.md](./frame-envelope.md) | reference | streaming, protocol, instrumentation |
| [streaming-latency-log.md](./streaming-latency-log.md) | log | streaming, latency, performance |
| [android-video-streaming-diagnosis.md](./android-video-streaming-diagnosis.md) | diagnosis | android, video, streaming |
| [awdl-wifi-latency-diagnosis.md](./awdl-wifi-latency-diagnosis.md) | diagnosis | network, latency, relay, wifi |

## Adding a record

Write it in English, prepend the frontmatter block, and register it in the table
above **and** in the root [INDEX.md](../INDEX.md) Documentation section. A promotion
from `.work/archive/` crosses the private→public boundary and is irreversible once
pushed — review each file for anything that should stay private before committing.
