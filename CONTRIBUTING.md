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

## Commit messages — Conventional Commits

```
<type>(<scope>): <subject>
```

- type: `feat` · `fix` · `test` · `refactor` · `docs` · `chore` · `perf`
- scope: the changed package name (`agent-core` · `ios-agent` · `android-agent` · `relay` · `dashboard` · `cli` · `playground`)
