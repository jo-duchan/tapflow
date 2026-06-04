# cli — AGENTS.md

> Common rules: [AGENTS.md](../../AGENTS.md) | Full index: [INDEX.md](../../INDEX.md)

---

## WHAT

`tapflow` CLI: handles local dev environment checks and simulator / relay / agent startup.
Commands are registered in `src/index.ts`:

| Command | Behavior |
|---------|----------|
| `init [--tunnel, --force]` | Scaffold `tapflow.config.json` interactively; auto-adds `.tapflow-data/` to `.gitignore` |
| `admin init [--relay]` | Create the first admin account on the relay (CLI fallback for headless servers; web `/setup` is the default path) |
| `start [--device, --platform]` | Local-only shortcut — starts relay + agent together (same Mac) |
| `relay start [--port, --tunnel]` | Start relay only (for Docker/Linux server) |
| `agent start [--relay, --device, --platform]` | Start agent only — connects to an existing relay |
| `doctor` | Check system prerequisites (Xcode, simctl, adb, etc.) |
| `devices` | List available simulators and AVDs |
| `boot <name>` | Boot a simulator by name or UDID |
| `reset` | Shut down all simulators and emulators |
| `status [--relay]` | Show connected agents, devices, and session count (WebSocket `agents:listed`) |
| `logs [--relay] [--lines]` | Query the relay in-memory log buffer (`GET /api/v1/logs`) |

### Command Design Principles

Each command has exactly one responsibility. `tapflow start` is for local development only and does not accept a `--relay` option.
"Connect to a relay" and "start a relay" are separate commands (`agent start` / `relay start`).
"Scaffold config" and "create the admin account" are separate commands (`init` / `admin init`) — `init` never touches the relay or creates accounts.

## HOW

- UX standard: one-line input → progress feedback → result message. Use spinners and banners for visual feedback (`print.ts`: `banner`, `step`, `warn`, `createSpinner`). Interactive prompts use `@clack/prompts`.
- `tapflow.config.json` lives in the working directory (created by `tapflow init`); runtime data goes in `.tapflow-data/`. Downloaded tunnel binaries are cached in `~/.tapflow/bin`.
- Package dependencies: `@tapflowio/agent-core`, `@tapflowio/ios-agent`, `@tapflowio/android-agent`, `@tapflowio/relay`. Import as libraries — do not reimplement.

## HOW NOT

- Do not add commands that access external systems (cloud, remote infrastructure) — this is a local tool.
- Do not hardcode credentials or tokens.
- Do not make destructive state changes in any command other than `reset`.
