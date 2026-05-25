# Contributing

Contributions are welcome. See [`CONTRIBUTING.md`](https://github.com/jo-duchan/tapflow/blob/main/CONTRIBUTING.md) in the repository for the full contributing guide — development setup, branch strategy, test principles, versioning, and commit conventions.

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
playground/       ← local integration test environment
```

## Reporting bugs

Use the [Bug Report](https://github.com/jo-duchan/tapflow/issues/new?template=bug_report.yml) issue template. Include steps to reproduce, expected vs. actual behavior, and your environment (tapflow version, Node.js version, and Xcode version for iOS issues).
