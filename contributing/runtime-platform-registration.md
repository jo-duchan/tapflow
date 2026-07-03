---
type: rationale
topics: [agent-core, architecture, extensibility]
status: stable
---

# Why platforms register at runtime instead of a `'ios' | 'android'` union

> Read this before adding a hardcoded platform branch, narrowing `Platform` back to a
> literal union, or wiring a new platform through agent-core / relay / cli / dashboard.
> The registry exists so a new platform touches none of them. Origin: [#41](https://github.com/jo-duchan/tapflow/issues/41).

## The design

`Platform` is `string`, not `'ios' | 'android'`. Each agent package self-registers at
import time through `AgentRegistry.register(platform, AgentClass, { canRun })`. The
registry answers two questions: `platforms()` (everything registered) and `available()`
(those whose `canRun()` returns true or is undefined). The CLI drives startup from
`available()` instead of `runIOS`/`runAndroid` branches.

Adding a platform is then: a new agent package plus one `register()` call. agent-core,
relay, cli, and dashboard source stay untouched. That is the OCP payoff the whole shape
buys.

## Decisions worth keeping

- **`canRun` is synchronous** (`() => boolean`). iOS checks `process.platform ===
  'darwin'`, Android checks `hasAdb()`; both are already sync. Making it async would turn
  `available()` into a promise and force `await` on every caller, for a cost nothing yet
  needs.
- **Environment detection lives in the agent package.** `hasAdb()` belongs to
  android-agent, the darwin check to ios-agent. agent-core stays platform-neutral (see its
  AGENTS.md), so the registry never learns what any platform's `canRun` means.
- **Self-registration is a top-level side effect.** The CLI imports the agent packages so
  their `register()` calls run. `package.json` `sideEffects` must keep those calls from
  being tree-shaken away; the import-then-`platforms()` tests guard against that regression.

## Deliberately left out

True plugin discovery (loading platforms from `package.json` without an explicit import)
is out of scope. The CLI still imports ios-agent and android-agent by name. Per-platform
display metadata (label, icon, tone) also stays on a fallback for now; the registry
carries behavior, not presentation, until the first real new platform needs it.
