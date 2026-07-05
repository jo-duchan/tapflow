---
type: rules
topics: [meta, contributing, conventions]
status: living
---

# tapflow — AGENTS.md (Common Rules)

> Package-specific rules are referenced via [INDEX.md](./INDEX.md).

---

## WHAT

tapflow is an **open-source self-hosted library** that lets the entire team — PO, PM, designers, backend engineers, and QA — test iOS/Android apps directly from a browser.
It uses the Mac you already own — no external cloud dependency.

### Core value

Remove friction. Anyone on the team can open a browser and test the app on a real simulator, without Xcode, without device setup, without accounts on external services.

### Two testing modes

- **Manual testing** (primary): CI uploads a build → team reviews in the browser. This is tapflow's main use case.
- **AI Agent via MCP** (experimental): An LLM agent controls the simulator automatically using `@tapflowio/mcp-server`. This is a separate, opt-in feature — it does not affect the manual testing path.

When designing features or writing docs, default to the manual testing perspective. The AI Agent path is additive, not a replacement.

## WHY

- Appetize / BrowserStack are expensive and send app data outside your network.
- Reuses infrastructure (Mac) the team already owns.
- Fully open-source and customizable.

---

## Core Principles

Check these four before every task. The cost of violating them — wrong fixes, reverts, rework — always exceeds the cost of following them.

### 1. No guessing — evidence-based

Do not conclude a root cause before verifying it with code, logs, or tests.

- For bugs: reproduce → diagnostic log → validate hypothesis → fix. No jumping to conclusions.
- When in doubt about package behavior or API signatures, read `package.json`, source code, or runtime output directly.
- If "this is probably why" comes to mind, stop and verify first.
- Every hypothesis must come with a validation method (`console.log`, unit test, `git log`, direct invocation, etc.).

### 2. Minimal changes — stay within scope

Only touch lines directly connected to the requested change.

- Do not "improve" adjacent code, comments, or formatting.
- Follow the file's existing conventions even if they differ from your preferences.
- Only clean up unused imports or functions introduced by the current change. Leave existing dead code as-is (note it if needed).

### 3. Hypothesis → verifiable goal

Before starting, define in one sentence how success will be measured.

- "Bug fix" → "write a reproducing test → confirm it passes"
- "Refactor" → "same tests pass before and after"
- For multi-step tasks, specify the verification method at each step.

### 4. Stop before risky actions

Get user confirmation before any hard-to-reverse operation.

- `git push --force`, `git reset --hard`, sending messages to external systems, DB drops, etc.
- Only create commits or PRs when the user explicitly requests it.
- **Do not merge PRs.** Always leave merging to the user — even with `--admin`. Create the PR and stop.
- **Avoid breaking changes.** If unavoidable, report to the user and get approval before proceeding. Breaking change scope: public API / interface signature changes, DB schema changes, WebSocket message protocol changes, CLI command / flag changes.

---

## HOW

### Language & Stack
- TypeScript throughout. No `any`.
- Node.js ≥ 20.
- WebSocket: `ws`. Dashboard: Vite + React 19 + React Router v7. Tests: vitest.

### Branches, Commits & Releases
→ [CONTRIBUTING.md](./CONTRIBUTING.md)

Write GitHub PR and issue titles/bodies in **English**, and write new code comments in **English** too. (Conversation and docs follow the existing KO/EN rules.) Code comments default to English so contributors of any language can read and extend them — existing Korean comments stay until the line they sit on is changed.

Before starting any task that requires code changes:
1. `git checkout main && git pull origin main` — always start from the latest main.
2. `git checkout -b <branch-name>` — work on a new branch, never directly on main.

### Workflow (Plan → Work → Review → Compound)

Work logs go in `.work/`. Conventions: [.work/CLAUDE.md](./.work/CLAUDE.md).

1. **Plan** — define requirements + test cases first (`type: plan`).
2. **Work** — write tests first, implement until they pass.
3. **Review** — edge cases + real data validation → **adversarial review** (below) → PR (`type: review`).
4. **Compound** — extract repeating patterns into test + code + prompt bundles (`type: compound`).

Custom commands: `/work-plan {topic}` · `/deep-research {problem}` · `/qa {target}` · `/doc-sync` · `/compound` · `/promote-decision {topic}` · `/release {major|minor|patch}`.

### Adversarial Review (required before every code-change PR)

The authoring session inherits its own assumptions, so before creating a PR the diff must be refuted by an **independent context** that has NOT seen the working conversation. Docs-only PRs may skip the review itself, but still write the record (with the skip reason) — the gate always requires it.

- **Default reviewer**: a fresh subagent given only the diff, repo access, and a refute-first prompt — "find bugs, contract violations, and missing cases; verify every claim with commands; report findings with severity and evidence, plus a checked-and-cleared list". Do not share the authoring session's reasoning with it.
- **Escalation**: protocol / public-interface / release-infrastructure changes get a second independent channel (a second subagent with a different lens, or Codex for cross-model independence).
- **Record**: write findings + dispositions (fixed, or skipped with a reason) to `.work/reviews/<branch>.md` (slashes → `__`), including the **full 40-character HEAD hash** (`git rev-parse HEAD` — an abbreviated hash will not pass the gate). Mention the review in the PR body.
- **Enforcement**: the PreToolUse hook `.claude/hooks/adversarial-review-gate.sh` blocks PR creation unless that record exists and references the current HEAD — any commit after the review invalidates the record until it is refreshed against the new diff.

### Design Principles (SOLID — priority subset)

- **OCP**: New platforms and features are added without modifying existing code. `AgentRegistry.register()` is the example.
- **ISP**: `DeviceAgent` only contains methods every platform can implement. Platform-specific behavior goes in separate interfaces.
- **DIP**: Dependencies via constructor injection. Depend on interfaces, not implementations.

### Code Rules
- Comments only when the WHY is non-obvious: one line max. Write new comments in English; leave existing Korean comments unless you're already editing that line.
- When changing an interface, update `agent-core` first, then align implementations.
- New platforms are added via `AgentRegistry.register()` only — relay and dashboard code stay unchanged.

### Test Hygiene
After running tests (especially repeated or looped runs), always check for zombie vitest processes and kill them:
```bash
ps aux | grep vitest | grep -v grep
pkill -f "vitest"
```
Zombie worker processes accumulate silently from `pnpm test` loops and consume memory. Kill them before starting new test runs.

---

## HOW NOT

- Do not write code that sends app data or streams to external services.
- Do not proactively add features not on the roadmap.
- Do not pollute the `agent-core` interface with platform-specific logic.
- Do not write implementation code before tests.
- Do not make changes based on guesses — no "this is probably the cause" code changes without evidence.
