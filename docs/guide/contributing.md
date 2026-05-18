# Contributing

Contributions are welcome. See [`CONTRIBUTING.md`](https://github.com/jo-duchan/tapflow/blob/main/CONTRIBUTING.md) in the repository for branch strategy, commit conventions, and PR guidelines.

## Local development

**Requirements**: Node.js ≥ 20, pnpm ≥ 9

```sh
git clone https://github.com/jo-duchan/tapflow.git
cd tapflow
pnpm install
pnpm dev
```

`pnpm dev` starts the relay, dashboard, iOS agent, and Android agent concurrently.

## Project structure

```
packages/
  agent-core/     ← shared DeviceAgent interface
  ios-agent/      ← IOSAgent (macOS)
  android-agent/  ← AndroidAgent (macOS)
  relay/          ← relay server + REST API + SQLite
  dashboard/      ← React SPA (served by relay)
  cli/            ← tapflow CLI
docs/             ← this documentation site (VitePress)
internal/         ← team-internal docs (PRD, design system, architecture)
playground/       ← local integration test environment
```

## Running tests

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

Run the relevant package tests before opening a PR. New behavior should be covered by tests.

## Versioning

tapflow follows [Semantic Versioning](https://semver.org) (`MAJOR.MINOR.PATCH`).

| Bump | When |
|------|------|
| `patch` | Bug fixes, performance improvements, docs, refactors — no API change |
| `minor` | New features, backward-compatible |
| `major` | Breaking changes (public API, DB schema, WebSocket protocol, CLI flags) |

If a release contains mixed commit types, the highest bump wins (`major` > `minor` > `patch`).

**Before `v1.0.0`:** breaking changes may appear in `minor` releases. Once `v1.0.0` is tagged, the table above is strictly enforced.

### Pre-release versions

| Tag | Meaning |
|-----|---------|
| `v0.3.0-alpha.1` | Unstable, internal testing |
| `v0.3.0-beta.1` | Feature-complete, external testing |
| `v0.3.0-rc.1` | Release candidate, no new features |

To install a specific pre-release version:

```sh
npm install tapflow@0.3.0-beta.1
```

## Reporting bugs

Use the [Bug Report](https://github.com/jo-duchan/tapflow/issues/new?template=bug_report.yml) issue template. Include steps to reproduce, expected vs. actual behavior, and your environment (tapflow version, Node.js version, and Xcode version for iOS issues).
