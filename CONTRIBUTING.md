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
- Releases are triggered by a git tag (Semver) → GitHub Release + npm publish. Merging to main does not auto-publish. Before `v1.0.0`, breaking changes may land in minor versions.

## Tests

All packages:

```sh
pnpm test
```

A specific package:

```sh
pnpm --filter @tapflow/ios-agent test
pnpm --filter @tapflow/android-agent test
pnpm --filter @tapflow/relay test
pnpm --filter @tapflow/cli test
```

Run the tests for any changed packages before opening a PR. New behavior must be covered by tests written first, passing before the PR is opened.

## Commit messages — Conventional Commits

```
<type>(<scope>): <subject>
```

- type: `feat` · `fix` · `test` · `refactor` · `docs` · `chore` · `perf`
- scope: the changed package name (`agent-core` · `ios-agent` · `android-agent` · `relay` · `dashboard` · `cli` · `playground`)
