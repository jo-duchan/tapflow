# Contributing to tapflow

> Common rules: [CLAUDE.md](./CLAUDE.md) | Full index: [INDEX.md](./INDEX.md)

## Development setup

**Requirements**: Node.js ≥ 20, pnpm ≥ 9

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

## Branches & releases

- `main` is always deployable. Direct commits are not allowed. Start work on a `feature/{topic}` branch → PR → merge.
- Always create new branches from `origin/main` (`git fetch origin && git checkout -b feature/{topic} origin/main`). Your local `main` may be behind.
- Releases are driven by [changesets](https://github.com/changesets/changesets). A tag push triggers GitHub Actions → npm publish + GitHub Release. Merging to main does not auto-publish.

### Versioning (Semver)

Versions follow `MAJOR.MINOR.PATCH`. Determine the bump from the commits since the last release:

| Bump | When |
|------|------|
| `patch` | `fix`, `perf`, `docs`, `chore`, `refactor` — no API change |
| `minor` | `feat` — new functionality, backward-compatible |
| `major` | Any breaking change (see [CLAUDE.md](./CLAUDE.md) Principle 4 for scope) |

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

- [Android video streaming diagnosis](./contributing/android-video-streaming-diagnosis.md) — scrcpy H.264 encoder investigation notes
- [SimulatorKit internals](./contributing/simkit-internals.md) — iOS touch injection reverse-engineering notes
- [Streaming latency engineering log](./contributing/streaming-latency-campaign.md) — glass-to-glass low-latency render-path log: pipeline/bottleneck analysis, measurements, and decisions (JPEG vs H.264, MSE vs WebCodecs vs WASM)

## Commit messages — Conventional Commits

```
<type>(<scope>): <subject>
```

- type: `feat` · `fix` · `test` · `refactor` · `docs` · `chore` · `perf`
- scope: the changed package name (`agent-core` · `ios-agent` · `android-agent` · `relay` · `dashboard` · `cli` · `playground`)

## Reporting bugs

Use the [Bug Report](https://github.com/jo-duchan/tapflow/issues/new?template=bug_report.yml) issue template. Include steps to reproduce, expected vs. actual behavior, and your environment (tapflow version, Node.js version, and Xcode version for iOS issues).
