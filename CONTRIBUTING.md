# Contributing to tapflow

> Common rules: [AGENTS.md](./AGENTS.md) | Full index: [INDEX.md](./INDEX.md) | Community standards: [Code of Conduct](./CODE_OF_CONDUCT.md)

## Development setup

**Requirements**: Node.js ≥ 22, pnpm ≥ 9

```sh
git clone https://github.com/jo-duchan/tapflow.git
cd tapflow
pnpm install
pnpm dev
```

`pnpm dev` starts the relay, dashboard, iOS agent, and Android agent concurrently.

### Dev & test commands

All dev/test commands run **from the repo root**. The `playground/` package holds the underlying implementations (relay, agents, seeders) — you do not run them from there directly.

| Command | What it runs |
|---------|--------------|
| `pnpm dev` | relay + dashboard + iOS agent + Android agent |
| `pnpm dev:pool` | relay + iOS agent + mock agents (multi-device testing without real simulators) |
| `pnpm dev:relay` / `pnpm dev:ios` / `pnpm dev:android` | a single component |
| `pnpm seed` / `pnpm seed:demo` | seed the local DB with test / demo data |
| `pnpm doctor` / `pnpm reset` | run the CLI `doctor` / `reset` against your local environment |
| `pnpm mcp` | start the MCP server (AI-agent path) |
| `pnpm pre-release` | build the dashboard and serve it from the relay — mirrors the installed-user experience at `http://localhost:4000` |

The dashboard runs on `http://localhost:3001` (Vite dev server) and the relay API on `http://localhost:4000`.

## Project structure

```text
packages/
  agent-core/     ← shared DeviceAgent interface
  ios-agent/      ← IOSAgent (macOS)
  android-agent/  ← AndroidAgent (macOS)
  relay/          ← relay server + REST API + SQLite
  dashboard/      ← React SPA (served by relay)
  cli/            ← tapflow CLI
docs/             ← documentation site (VitePress)
playground/       ← local integration test environment
```

## The two READMEs are one document

`packages/cli/README.md` is what npm renders for the published CLI, and it is `README.md` with two URL
prefixes absolutised — npm resolves neither repo-relative paths nor `blob/main` links. **Edit both, and
write the cli copy's links absolute.** `scripts/__tests__/readmeSync.test.mjs` compares them and runs in
CI; a block that genuinely has to differ goes between `<!-- readme-sync:exempt <reason> -->` markers in
both files. Today one does: GitHub renders `<video>` and npm does not.

## Claiming an issue

Issues are not assigned in advance. Open a draft PR or post your findings on the issue and it is yours — a comment reserving one does not hold it, so no issue sits blocked behind an intent that never lands.

Check the labels before you start: `requires: macOS` means the change runs against a real simulator or emulator and cannot be verified without a Mac (Xcode / Android SDK). A `good first issue` without that label needs only Node.js and pnpm.

## Branches & releases

- `main` is always deployable. Direct commits are not allowed. Start work on a `feature/{topic}` branch → PR → merge.
- Always create new branches from `origin/main` (`git fetch origin && git checkout -b feature/{topic} origin/main`). Your local `main` may be behind.
- **Backfilling a changeset for an earlier PR?** Name what it covers, on its own line: `Backfills: #413` (quoting it inside a code block does not count, same as the marker below). The release-time audit judges each merge on its own, so without that line it keeps reporting the original merge as a gap for the rest of the cycle — and the only way to tell a real gap from a filled one is to match them up by hand.
- **Every PR that changes published source needs a changeset.** The CI `changeset` job fails otherwise, and it is a required status check on the `protect-main` ruleset, so that failure blocks the merge; `pnpm changeset:check` runs the same check locally against committed work. Skip it only by stating why in the PR body, on a line of its own: `<!-- no-changeset: reason -->` (quoting it inside a code block does not count). A comment-only or test-only change is a fair skip — the point is that it is a decision, not an omission.
- **A dashboard change names `@tapflowio/relay`**, never `@tapflowio/dashboard`. The dashboard is private and `ignore`d in `.changeset/config.json`, so `pnpm changeset` does not offer it in the package list at all. It is built into the relay's `public/` and ships inside that package, which is where its release note belongs. Naming both in one changeset is rejected by `changeset version`.
- Releases are driven by [changesets](https://github.com/changesets/changesets). A tag push triggers GitHub Actions → npm publish + GitHub Release. Merging to main does not auto-publish.
- Never publish with raw `npm publish` — it does not rewrite `workspace:*` dependencies between packages; the changesets → pnpm publish path does.

### Publishing the Docker image from a fork

If you are publishing a fork of tapflow to a custom Docker registry namespace, you need two repository secrets set up in GitHub:

- `DOCKERHUB_USERNAME` — your Docker Hub username.
- `DOCKERHUB_TOKEN` — your Docker Hub personal access token (Read & Write permissions).

The `.github/workflows/docker-publish.yml` workflow will automatically detect these secrets and publish multi-platform images (`linux/amd64`, `linux/arm64`) to `your-username/tapflow` on every push to `main` and on version tags. Without these secrets, the CI will only build and smoke-test the image for validation, without attempting to publish it.

### Versioning (Semver)

Versions follow `MAJOR.MINOR.PATCH`. Determine the bump from the commits since the last release:

| Bump | When |
|------|------|
| `patch` | `fix`, `perf`, `docs`, `chore`, `refactor` — no API change |
| `minor` | `feat` — new functionality, backward-compatible |
| `major` | Any breaking change (see [AGENTS.md](./AGENTS.md) Core Principles for scope) |

**Before `v1.0.0`:** breaking changes may land in `minor` versions. Once `v1.0.0` is tagged, the table above is strictly enforced.

If a single release contains commits of mixed types, the highest bump wins (`major` > `minor` > `patch`).

#### Pre-release tags

Use the following suffixes for staged rollouts:

```
v0.3.0-alpha.1   # unstable, internal testing
v0.3.0-beta.1    # feature-complete, external testing
v0.3.0-rc.1      # release candidate, no new features
```

### CHANGELOG

`CHANGELOG.md` follows the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

**Sections** (use only what applies — omit empty ones):

| Section | When to use |
|---------|-------------|
| `### Breaking Changes` | Any change requiring user action to migrate |
| `### Added` | New features or commands |
| `### Changed` | Changes to existing behaviour |
| `### Deprecated` | Features that will be removed in a future release |
| `### Removed` | Features removed in this release |
| `### Fixed` | Bug fixes |
| `### Security` | Security-related fixes |

**On every PR that touches user-facing behaviour**, add an entry under `## [Unreleased]`. Keep entries concise — one line per item, starting with a backtick-quoted identifier when applicable.

**Not every changeset earns an entry.** Protocol typing and internal refactors would fill the file with noise a self-hoster cannot act on, so a changeset opts out from inside its own body, on a line of its own:

```markdown
<!-- changelog: internal — protocol typing, nothing a user can observe -->
```

The marker goes in the changeset rather than the PR body, because it classifies that one change — a PR carrying two changesets can need it for only one of them. `internal` is matched literally, so `<!-- changelog: docs-only -->` does not opt out. The CI `changeset` job checks only that `CHANGELOG.md` was touched; no check can tell whether the prose matches the diff.

**Breaking Changes** go in `### Breaking Changes` with a one-line description and a `Migrate:` hint. For complex migrations, a separate `MIGRATION.md` may be added, but prefer keeping it inline unless the guide exceeds ~10 lines.

**At release time**, rename `## [Unreleased]` to `## [x.y.z] - YYYY-MM-DD`, add a fresh empty `## [Unreleased]` above it, and append a comparison link at the bottom:

```markdown
[x.y.z]: https://github.com/jo-duchan/tapflow/compare/vPREV...vx.y.z
[Unreleased]: https://github.com/jo-duchan/tapflow/compare/vx.y.z...HEAD
```

## Tests

All packages:

```sh
pnpm test
```

Repository scripts suite (cross-package static checks):

```sh
pnpm test:scripts
```

A specific package:

```sh
pnpm --filter @tapflowio/ios-agent test
pnpm --filter @tapflowio/android-agent test
pnpm --filter @tapflowio/relay test
pnpm --filter @tapflowio/cli test
```

Run the tests for any changed packages before opening a PR. New behavior must be covered by tests written first, passing before the PR is opened.

### Test principles

**No Potemkin tests.** A test must be able to fail. If no production code change could break it, delete it. `expect(result).toBeDefined()` alone is not a test — assert the actual value.

**No flaky tests.** Use `vi.useFakeTimers()` instead of `setTimeout` waits. Fix `Date.now()` with `vi.setSystemTime()`. Clean up global state in `beforeEach`/`afterEach`. Never depend on real network ports or file paths.

**Mock only at system boundaries** — real network, OS calls, external processes. Internal module interactions run against real code.

## Technical internals

Platform-specific implementation notes for contributors:

- [Measuring performance](./contributing/measurement.md) — the instrumentation reference: every metric emitter (`TAPFLOW_STREAM_METRICS`, relay drops, `?perf=1` panel, console tags), its exact output, and how to measure on localhost vs cross-machine
- [Android video streaming diagnosis](./contributing/android-video-streaming-diagnosis.md) — scrcpy H.264 encoder investigation notes
- [SimulatorKit internals](./contributing/simkit-internals.md) — iOS touch injection reverse-engineering notes
- [Streaming latency engineering log](./contributing/streaming-latency-log.md) — glass-to-glass low-latency render-path log: pipeline/bottleneck analysis, measurements, and decisions (JPEG vs H.264, MSE vs WebCodecs vs WASM)
- [Wi-Fi relay latency diagnosis (AWDL)](./contributing/awdl-wifi-latency-diagnosis.md) — tracing a periodic ~0.5 s Wi-Fi stream hitch to AWDL with ping-only triangulation; fix tiers, excluded approaches, reusable method

## Commit messages — Conventional Commits

```
<type>(<scope>): <subject>
```

- type: `feat` · `fix` · `test` · `refactor` · `docs` · `chore` · `perf`
- scope: the changed package name (`agent-core` · `ios-agent` · `android-agent` · `relay` · `dashboard` · `cli` · `playground`)

## Language

Write PRs, issues, and commit messages in English (internal `.work/` and `CLAUDE.md` docs may be in any language).

## Reporting bugs

Use the [Bug Report](https://github.com/jo-duchan/tapflow/issues/new?template=bug_report.yml) issue template. Include steps to reproduce, expected vs. actual behavior, and your environment (tapflow version, Node.js version, and Xcode version for iOS issues).
