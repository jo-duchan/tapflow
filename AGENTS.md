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

For the product direction and philosophy behind these — Manual First, Flow Capture as the moat, AI as an additive harness — see [VISION.md](./VISION.md).

---

## Core Principles

- **Evidence-based**: verify a root cause with code, logs, or tests before fixing — no guess-driven changes.
- **Minimal changes**: stay within the requested scope; follow the file's existing conventions. Scope
  is decided by [what a reviewer has to hold in their head](#an-adjacent-defect-is-fixed-here-unless-it-needs-its-own-decision),
  not by which file a line sits in.
- **Verifiable goal**: know how success will be measured before starting (a reproducing test, same tests passing after a refactor, etc.).
- **Stop before risky actions** — get user confirmation before any hard-to-reverse operation (`git push --force`, `git reset --hard`, sending messages to external systems, DB drops, etc.). Specifically:
  - Only create commits or PRs when the user explicitly requests it.
  - **Do not merge PRs.** Always leave merging to the user — even with `--admin`. Create the PR and stop.
    Enforced by the PreToolUse hook `.claude/hooks/pr-merge-guard.sh`, which blocks `gh pr merge` and
    `gh pr review` in command position. It does not cover the `gh api` and git plumbing equivalents:
    same threat model, a cooperative agent rather than an adversary.
  - **Avoid breaking changes.** If unavoidable, report to the user and get approval before proceeding. Breaking change scope: public API / interface signature changes, DB schema changes, WebSocket message protocol changes, CLI command / flag changes.

---

## HOW

### Language & Stack
- TypeScript throughout. No `any`. Node.js ≥ 22. Everything else is in each package's `package.json`.

### Branches, Commits & Releases
→ [CONTRIBUTING.md](./CONTRIBUTING.md)

Write GitHub PR and issue titles/bodies in **English**, and write new code comments in **English** too. (Conversation and docs follow the existing KO/EN rules.) Code comments default to English so contributors of any language can read and extend them — existing Korean comments stay until the line they sit on is changed.

The PR and issue half is enforced by `.claude/hooks/gh-language-gate.sh`, which reads the title, the
body, the contents of a `--body-file`, and the heredoc behind `--body-file -` — so the form
CONTRIBUTING recommends is covered rather than only the text typed inline. **A line counts as Korean
only when its Hangul outnumbers its Latin letters**, so an English sentence naming a Korean UI label
passes; #660 shipped one. `gh pr comment` is deliberately out of scope, because a review comment is a
conversation and the rule is about titles and bodies.

**Docs prose is checked before the session ends.** Editing any Markdown under `docs/` — nested too,
so `docs/ko/operate/agents.md` counts — and finishing without running
`/ai-tells detect` is blocked by `.claude/hooks/docs-aitells-gate.sh`, with
`docs-aitells-reminder.sh` nudging at the moment of the edit. The check is a **lint, not a
laundry**: it flags AI-writing tells in prose a human wrote, and `rewrite` stays manual and
docs-only. Stopping a second time passes, so the block is a prompt rather than a wall.

**A skipped accessibility check is followed up before the session ends.** The `a11y-lens`
pre-commit job never blocks on its own infrastructure, so a timeout passes with the same ✔️ as a
clean run (#827). a11y-lens records the files it could not review, and
`.claude/hooks/a11y-lens-pending-gate.sh` blocks finishing while any are recorded, until
`pnpm exec a11y-lens check --pending` has run in the session after the latest one was recorded.
Stopping a second time passes.

When starting a **new** task that requires code changes (not when continuing work on an existing branch):
1. `git checkout main && git pull origin main` — start from the latest main.
2. `git checkout -b <branch-name>` — work on a new branch, never directly on main.

### The PR body follows the repo's template, and `--body` bypasses it

**Read `.github/pull_request_template.md` before opening one.** It exists, and 212 of the last 220 PRs did
not follow it because nobody went looking — not because anything stopped them. That is the whole cause, and
it is worth stating plainly, because the mechanism below reads like an excuse and is not one.

The mechanism explains only why nothing said so: the template is applied when a PR is opened in the browser,
and `gh pr create --body` replaces it wholesale. A PR opened from a terminal carries whatever the author
typed, and no gate looks at it. So write the body into a file that starts from the template, and pass
`--body-file`.

**The body is a pointer, not a copy.** Depth already lives in three places that outlast it — the reasoning
beside the code, the release note in the changeset, and the findings in `.work/reviews/`, which the template
has a slot for. A body that reproduces all three is noise to the reviewer who has the diff open, and it
tells a first-time contributor that *this* is the bar for opening a PR. Keep `## Summary` to a few sentences
and link the rest.

### Workflow (Plan → Work → Review → Compound)

Work logs go in `.work/`. Conventions: [.work/CLAUDE.md](./.work/CLAUDE.md).

1. **Plan** — define requirements + test cases first (`type: plan`).
2. **Work** — write tests first, implement until they pass.
3. **Review** — edge cases + real data validation → **adversarial review** (below) → PR (`type: review`).
4. **Compound** — extract repeating patterns into test + code + prompt bundles (`type: compound`).

**Before writing a static check, or a test that asserts something does *not* happen, read
[contributing/test-and-guard-coverage.md](./contributing/test-and-guard-coverage.md).** A test asserting
absence passes when nothing happens — that is its definition — so it cannot tell a working drop from a bug
that produces the same silence; and a check whose header cites a lesson usually reads as having applied it.
Four measured shapes, each of which shipped a hole behind a fully green suite.

### Adversarial Review (required before every code-change PR)

The authoring session inherits its own assumptions, so before creating a PR the diff must be refuted by an **independent context** that has NOT seen the working conversation. Docs-only PRs may skip the review itself, but still write the record (with the skip reason) — the gate always requires it.

- **A blocked hook stops the whole `Bash` command, not the part it objected to.** A `gh pr create`
  written in the same command as the heredoc that built its `--body-file` leaves no body file behind
  when the gate refuses: the file write never ran either. Write the file in one command and publish in
  the next. Same for `gh issue create` and the comment gates.
- **The gate resolves your work tree from the session's cwd**, which this harness resets to the project
  root after every command — so a PR cannot be created from a worktree even though the hook supports
  one. The way through is to bring the branch to the main checkout: stash what is there, remove the
  worktree, check the branch out, create the PR, then restore.
- **Record**: findings + dispositions (fixed, or skipped with a reason) go in `.work/reviews/<branch>.md` (slashes → `__`), including the **full 40-character HEAD hash** (`git rev-parse HEAD` — an abbreviated hash will not pass the gate). Mention the review in the PR body.
- **Enforcement**: the PreToolUse hook `.claude/hooks/adversarial-review-gate.sh` blocks PR creation unless that record exists and references the current HEAD — any commit after the review invalidates the record until it is refreshed against the new diff.
- **A change spanning two or more packages, or both platforms, needs a second, earlier review — of the design, before the code.** One adversarial pass over the plan, in addition to the pre-PR one.

**Read [contributing/adversarial-review.md](./contributing/adversarial-review.md) before launching a reviewer.** It covers how to design the channels, how to run the cross-cutting design pass, why a reviewer's "checked and cleared" list expires as soon as you fix the findings, why the reason written beside the code is part of the fix rather than documentation of it, and how to keep the cost in minutes rather than hours — the same review can take 4 minutes or 106 depending only on what its prompt makes it execute.

### An adjacent defect is fixed here unless it needs its own decision

A good review produces findings next to the one you came for. Deferring each of them is the default
that feels safe and is not: **one four-issue session deferred six, and three of those were a single
line each** — a `format?` that should have been required, a package missing from `changeset`'s
`ignore`, one sentence in an AGENTS.md. Each cost a branch, a review, a PR and a CI run to land
later. The overhead was an order of magnitude larger than the fix.

The line is what a reviewer has to hold in their head, not which file a line sits in:

| Fix it in this PR | Split it out |
|---|---|
| Under ~10 lines and judged by the lens already running | It needs a design decision |
| The other half of the same defect in another package, **when the running lens can judge both sides** | It needs a different lens (perf, security, a11y) |
| Prose the change just made false | It is hard to reverse, or breaking |

Two habits keep this honest:

- **Ask the reviewer to classify.** A findings list with no now/later column leaves the split to
  whoever is holding the diff, which is the person least able to see the cost of deferring.
- **What is split out becomes an issue in the same session, not a line in `.work/reviews/`.** That
  directory is gitignored and nobody reads it looking for work. Six deferrals lived only in one
  conversation until someone asked what was left. The reviewer prompt asks for the issue title and
  body alongside the reason, so writing "later" costs the same as filing it.

Splitting is still right when it is right — `#508`'s relay type drift genuinely belongs elsewhere.
The rule is that it must be a decision with a reason, and the reason may not be "it was in a
different file".

#### A reviewer's `later` is an input, not a verdict — and deferring has a budget

The rule above was written for a session choosing its own deferrals. Once the findings arrive from
review channels, the choosing is quietly delegated: a reviewer writes `later`, and it becomes an
issue because that is what the column said.

**Measured on one day of work on #607: nine issues, from three PRs.** That is not bad luck, it is
arithmetic — two or three channels per PR, a cap of four or five findings each, and a `later` rate of
about a third. Two of the nine were closed within the hour as things that should never have been
filed, and one of them (`#673`, a missing `timeout`) was a few lines in a file the running lens was
already reading, which the section above says is fixed in place.

Three things keep it honest, and none of them is remembering harder:

- **Re-grade every `later` yourself.** Severity was already being re-graded; disposition was not.
  Hold each one against the same two questions: under ~10 lines, and judgable by the lens already
  running? Then it is fixed here, whatever the column says.
- **Give the reviewer a `later` budget** — at most two per channel, each justified against that rule.
  A cap on findings with no cap on deferrals makes deferring free, and free is what it was.
- **Every split-out issue names its parent**, on a line of its own: `Parent: #607`. Prose like "raised
  by the review of #647" is not it — nothing can build a checklist from a mention, which is how the
  nine above became unreachable from the issue they all came from. `.claude/hooks/issue-parent-gate.sh`
  blocks an issue that carries neither a `Parent:` line nor an explicit
  `<!-- standalone: reason -->`.

**Re-grading is a step that leaves no trace, and steps like that get skipped** — one session later,
three issues filed and all three closed again (#754, #755, #756). Not one needed to exist. Nothing was
missing: each reviewer had supplied its reasoning, and each was re-graded correctly in well under a
minute once somebody asked. The bullet above was already in this file and was read; the step just
never happened, the way any step with no artifact does not happen. In the same session mutation
testing was run every single time, because `run-tests.sh --mutate` prints a line per mutation and
fails loudly.

A candidate answer is **not more emphasis on that bullet** — writing a lesson down reads as having
applied it ([test-and-guard-coverage.md](./contributing/test-and-guard-coverage.md) rule 1). It is to
ask the reviewer for facts instead of a verdict: **a reaching path** (a concrete consumer or sequence,
or "none found"), **the fix in lines**, and **which lens it needs**. No reaching path is not an issue,
it is a comment beside the code. The three fields are defined in
[adversarial-review.md](./contributing/adversarial-review.md).

**Nothing above changes yet.** The `now`/`later` column and the budget stay exactly as the three
bullets describe them, and a reviewer prompt should still ask for them — that shape has nine measured
issues behind it and this one has three, from one author in one area. It is written down because the
count is worth knowing, not because it has earned a replacement. What decides it is the next few
reviews: fewer issues that close within the hour, or the same rate with a longer prompt.

And the parent keeps a checklist. Asked whether #607 was finished, nobody could answer — the feature's
remaining surface existed only as unlinked rows in a tracker sorted by date.

### Design Principles (SOLID — priority subset)

- **OCP**: New platforms and features are added without modifying existing code — platforms register via `AgentRegistry.register()` only; relay and dashboard code stay unchanged.
- **ISP**: `DeviceAgent` only contains methods every platform can implement. Platform-specific behavior goes in separate interfaces.
- **DIP**: Dependencies via constructor injection. Depend on interfaces, not implementations.

### Code Rules
- Comments only when the WHY is non-obvious. Write new comments in English; leave existing Korean comments unless you're already editing that line.
- When changing an interface, update `agent-core` first, then align implementations.

### A package whose tests import a sibling extends `vitest.shared.ts`

Cross-package imports resolve through `exports` to `dist/`, so without it a test in one package
exercises whatever was last *built* of another. #459 shipped a regression behind a green 1889-test
run for exactly that reason: `ios-agent` stands up a real `RelayServer`, and the relay it stood up
was the previous one. It surfaced only when the pre-commit `tsc -b` refreshed the build.

`ssr.resolve`, not `resolve` — vitest runs in node and takes the SSR resolution path. Measured:
`resolve.conditions`, `NODE_OPTIONS=--conditions=source` and `server.deps.inline` all still loaded
`dist`. And `source` is **prepended** to vite's defaults rather than replacing them; a replacement
list applies to every dependency, and dropping `node` from it sent jsdom to the wrong entry of
`decimal.js`.

Adding a package that imports a sibling in its tests means adding the config too.
`scripts/__tests__/testsReadSource.test.mjs` finds those packages by inspection and fails if one is
missing it — and separately plants a marker in a built artifact to prove the resolution actually
lands on source, because a config can be present and not work.

**Not** solved by pointing the manifests at source with `publishConfig`, which needs no per-tool
config at all and was tried first. `pnpm deploy` does not apply `publishConfig`
([pnpm#6693](https://github.com/pnpm/pnpm/issues/6693), open), so the Docker image would ship
`node_modules` full of `.ts` and die on boot — and `packages/cli/bin/tapflow.js` is plain node too.
Covering every consumer uniformly means covering the ones that cannot read TypeScript. Opting in
per tool is the point, not the cost.

### Tests are type-checked and linted, and the tsconfig lives in the test folder

Every package whose build tsconfig **excludes** `src/__tests__` has `src/__tests__/tsconfig.json`,
wired into its `typecheck` script. Tests still must not reach `dist`, so they are not added to the
build's `include` — the same shape as `protocol/tsconfig.assertions.json`. `dashboard` is the
exception and needs no second file: its tsconfig already includes `src`, so its tests were type-checked
all along and only the lint half was off.

`scripts/__tests__/testTreeChecked.test.mjs` holds that by inspection — a new package that copies the
exclude and forgets the tsconfig would otherwise put its whole test tree outside every project with
`pnpm typecheck` still green, which is the failure #422 exists to end.

**The file name and location are load-bearing.** typescript-eslint's `projectService` resolves a
file's project the way tsserver does, by walking up for a `tsconfig.json`, so a `tsconfig.test.json`
at the package root is invisible to it and every rule fails as `was not found by the project service`
rather than reporting. One file serves both gates only in this position.

`moduleResolution: bundler`, not the build's Node16: vitest resolves through vite and does not
require the `.js` suffix. Under Node16 a further 166 errors were nothing but that suffix missing, on
top of the 247 real ones — checking tests under a resolution they never run with would mean rewriting
every import to satisfy a compiler no test obeys.

The two exclusions used to compound: nothing typed the test tree and nothing linted it, so a double
could drift from the interface it doubled with both gates green. What that hid, measured when the
gates went on: `AgentRegistry.test.ts` declared `implements DeviceAgent` while missing two members,
`EmulatorVideo.test.ts` was short three on `RawEmulatorController`, five duplicate object keys sat in
`SimctlWrapper.test.ts`, a `clearAppData` call passed one argument to a two-argument method, and
`test-utils`' `waitForType` constraint was one no named message could satisfy — which all 49 call
sites naming a type violated.

### Test Hygiene
Tests run through `pnpm --filter <pkg> test`; use `pnpm test:scripts` for the root scripts suite. Never use `npx vitest` — not even from inside the package directory, and not for a single file. npm rewrites the root `package.json` on its way through and collapses `pnpm.overrides` to `pnpm: {}`, leaving `pnpm-lock.yaml` rewritten beside it, and it reports none of that. Reviewing #474 cost exactly this: one `npx vitest` on one test file, and the entire override block was gone with only `git status` to say so. `git checkout HEAD -- package.json pnpm-lock.yaml` puts both back — check `git diff` on them first if you were editing either on purpose, since that discards everything uncommitted in both.

After running tests (especially repeated or looped runs), always check for zombie vitest processes and kill them:
```bash
ps aux | grep vitest | grep -v grep
pkill -f "vitest"
```
Zombie worker processes accumulate silently from `pnpm test` loops and consume memory. Kill them before starting new test runs.

### Dev Server Hygiene
Same rule, different processes. **Anything you start with `pnpm dev` you stop before the session ends:**
```bash
pnpm dev:down          # stops relay / agents / vite for THIS checkout
```
`pnpm dev` refuses to start when :4000 or :3001 is already held, and names the pid — because the failure it produces otherwise mentions neither. A relay left running once survived a day and cost a debugging session: it failed with `EADDRINUSE`, `concurrently` SIGTERMed the dashboard and both agents, and the visible symptom was four processes dying for no stated reason.

`concurrently -k` cleans up on a normal exit, not when the terminal goes away or the machine sleeps.

### Changesets
A PR that changes published source needs a changeset. The CI `changeset` job fails without one, and it is a required status check on the `protect-main` ruleset, so that failure blocks the merge. **The same job also demands an entry in the root `CHANGELOG.md`** under `## [Unreleased]`, in one of the sections CONTRIBUTING lists — the per-package changelogs are generated and cannot be forgotten, the root one is hand-written and is what a self-hoster reads to decide whether to upgrade. A changeset with no changelog entry fails the job, which reads as "no changeset" and sends you looking in the wrong place; #733 lost a CI cycle to exactly that. Opt out only for a change nobody can observe, with `<!-- changelog: internal — reason -->` in the changeset. Note that the job is *skipped* for bot PRs, and a skipped required check counts as passing — the gate is deliberately not applied to them. Opt out only by writing the reason in the PR body, on its own line:
```
<!-- no-changeset: comment-only follow-up to #123 -->
```
A dashboard change names **`@tapflowio/relay`**, never `@tapflowio/dashboard`. The dashboard is `ignore`d in `.changeset/config.json` because it is private — but it is built into the relay's `public/` and ships inside that package, so that is where its release note belongs. Naming both in one changeset is rejected outright by `changeset version`, and nothing catches it until release day: the CI gate only checks that a changeset exists.

`pnpm changeset:check` runs the same check locally, against committed work. A changeset written for an EARLIER PR must say so — `Backfills: #413` on its own line — or the audit keeps reporting that merge for the rest of the cycle. That gate cannot see anything already on main, so `/release` audits the merges too (`pnpm changeset:audit`) — four merged PRs once got as far as release preparation with no changelog entry between them, and only the audit would have caught it.

### A security bump is `pnpm update` first, and an override only if that fails

Reach for `pnpm.overrides` last: try `pnpm update <pkg>` first, which usually takes the patch with no
permanent entry to maintain, because the problem is normally a stale lockfile rather than a
forbidding range. **The block is empty, and that is the finished state rather than a gap**: it held
fourteen entries on 2026-08-06 and eight on 2026-09-03, and on both dates every one of them was
inert. They were retired once the audit could say so — deleting them and resolving cold moved no
resolved version, and every package they named was already at or above its advisory floor.
`pnpm overrides:audit` judges whatever is there — still needed, correct, reaching production — so run
it before adding the first one back, and when one is added, plan to remove it. **Derive the
override key from the GHSA advisory, never from the Dependabot alert**, and scope both the key and
its replacement to one major line.

**Read [contributing/security-bumps.md](./contributing/security-bumps.md) before adding an entry.**
It has the why behind each of those — how to page the full advisory set, and the two PRs (#469, #471)
that shipped a key leaving the current major unguarded.

---

## HOW NOT

- Do not write code that sends app data or streams to external services.
- Do not proactively add features not on the roadmap.
