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

## Reporting bugs

Use the [Bug Report](https://github.com/jo-duchan/tapflow/issues/new?template=bug_report.yml) issue template. Include steps to reproduce, expected vs. actual behavior, and your environment (tapflow version, Node.js version, and Xcode version for iOS issues).
