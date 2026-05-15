# Contributing

Contributions are welcome. See [`contributing/CONTRIBUTING.md`](https://github.com/jo-duchan/tapflow/blob/main/contributing/CONTRIBUTING.md) in the repository for branch strategy, commit conventions, and PR guidelines.

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
  android-agent/  ← AndroidAgent (Linux/Mac)
  relay/          ← relay server + REST API + SQLite
  dashboard/      ← React SPA (served by relay)
  cli/            ← tapflow CLI
docs/             ← this documentation site (VitePress)
contributing/     ← internal docs (PRD, design system, architecture)
playground/       ← local integration test environment
```

## Running tests

```sh
pnpm test
```
