# tapflow — CLAUDE.md (Common Rules)

> Package-specific rules are referenced via [INDEX.md](./INDEX.md).

---

## WHAT

tapflow is an **open-source self-hosted library** that lets QA teams control iOS/Android simulators and emulators directly from a browser.
It uses the Mac you already own — no external cloud dependency.

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

Before starting any task that requires code changes:
1. `git checkout main && git pull origin main` — always start from the latest main.
2. `git checkout -b <branch-name>` — work on a new branch, never directly on main.

### Workflow (Plan → Work → Review → Compound)

Work logs go in `.work/`. Conventions: [.work/CLAUDE.md](./.work/CLAUDE.md).

1. **Plan** — define requirements + test cases first (`type: plan`).
2. **Work** — write tests first, implement until they pass.
3. **Review** — edge cases + real data validation → PR (`type: review`).
4. **Compound** — extract repeating patterns into test + code + prompt bundles (`type: compound`).

Custom commands: `/work-plan {topic}` · `/deep-research {problem}` · `/qa {target}` · `/doc-sync` · `/compound`.

### Design Principles (SOLID — priority subset)

- **OCP**: New platforms and features are added without modifying existing code. `AgentRegistry.register()` is the example.
- **ISP**: `DeviceAgent` only contains methods every platform can implement. Platform-specific behavior goes in separate interfaces.
- **DIP**: Dependencies via constructor injection. Depend on interfaces, not implementations.

### Code Rules
- Comments only when the WHY is non-obvious: one line max.
- When changing an interface, update `agent-core` first, then align implementations.
- New platforms are added via `AgentRegistry.register()` only — relay and dashboard code stay unchanged.

---

## HOW NOT

- Do not write code that sends app data or streams to external services.
- Do not proactively add features not on the roadmap.
- Do not pollute the `agent-core` interface with platform-specific logic.
- Do not write implementation code before tests.
- Do not make changes based on guesses — no "this is probably the cause" code changes without evidence.
