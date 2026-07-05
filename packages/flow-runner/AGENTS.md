# flow-runner — AGENTS.md

> Common rules: [AGENTS.md](../../AGENTS.md) | Full index: [INDEX.md](../../INDEX.md)

---

## WHAT

`@tapflowio/flow-runner`: deterministic YAML flow engine — the replay half of the automated QA axis.
Flows are authored once (by an agent via MCP, or by hand) and replayed with **zero LLM calls**: same input → same execution, no API cost in CI.

Published on the standard npm channel and versioned by changesets in the repo-wide fixed group. Never publish with raw `npm publish` — it does not rewrite the `workspace:*` dependency on agent-core; the changesets → pnpm publish path does.

Consumers: `tapflow flow run` (CLI) and the `run_flow` MCP tool — both drive the same engine, so results never diverge.

## HOW

- `schema.ts` — YAML → `Flow` (hand-rolled validation, indexed error messages `file: steps[i]: …`). Step vocabulary is deliberately minimal: `clearState / launchApp / tapOn / inputText / pressKey / swipe / scroll / openUrl / assertVisible / assertNotVisible`. No fixed `sleep` step — waiting is always condition-based (`assertVisible` + `timeout`).
- `engine.ts` — executes steps against the `FlowDriver` interface (DIP: relay transport, mcp adapter, and test fakes all satisfy it). Selector resolution: bare string → exact identifier → exact label → partial label; `{id}` / `{label}` are explicit. **Multiple matches on `tapOn` fail immediately** (no implicit first-pick); `assertVisible` accepts ≥1. Polls `queryUITree` every 500ms up to the timeout (default 10s, per-selector `timeout` override).
- `RelayClient.ts` / `RelayDriver.ts` — WS (session/input, message shapes shared with dashboard/mcp) + REST (`/ui-tree`, `/screenshot`). `launchApp` targets the CLI `--build` / `run_flow` `buildId`, so flow files never hardcode a buildId and stay portable across CI runs.
- `junit.ts` — one `<testcase>` per flow, step log in `system-out` / `<failure>`.
- `schema/tapflow-flow.schema.json` — JSON Schema shipped for editor autocomplete; keep it in sync with `schema.ts` when the vocabulary changes.
- Exit-code contract (CLI): `0` all passed · `1` flow failure · `2` environment/config error (parse errors, relay unreachable, no device). Never conflate 1 and 2 — CI dashboards rely on the distinction.
- Coordinates are normalized 0-1 everywhere, matching the touch path and `query_ui_tree` frames.
- `clearState` maps to `app:clear-state` (relay) → `pm clear` (Android) / data-container wipe (iOS `SimctlWrapper.clearAppData`).

## HOW NOT

- Do not call an LLM anywhere in this package — replay must stay deterministic and free.
- Do not add a fixed-sleep step; add condition-based waits instead.
- Do not resolve ambiguous selectors implicitly (first-match). Fail loudly with candidates.
- Do not put relay-side logic here — this is a client, like mcp-server.
- Do not let the engine depend on `RelayClient` — engine code touches only `FlowDriver`.
