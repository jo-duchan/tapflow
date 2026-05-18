# cli — CLAUDE.md

> Common rules: [CLAUDE.md](../../CLAUDE.md) | Full index: [INDEX.md](../../INDEX.md)

---

## WHAT

`tapflow` CLI: handles local dev environment checks and simulator / relay / agent startup.
Commands are registered in `src/index.ts`:

| Command | Behavior |
|---------|----------|
| `start [--device, --platform]` | Local-only shortcut — starts relay + agent together (same Mac) |
| `relay start [--port]` | Start relay only (for Docker/Linux server) |
| `agent start [--relay, --device, --platform]` | Start agent only — connects to an existing relay |
| `doctor` | Check system prerequisites (Xcode, simctl, adb, etc.) |
| `devices` | List available simulators and AVDs |
| `boot <name>` | Boot a simulator by name or UDID |
| `reset` | Shut down all simulators and emulators |
| `status [--relay]` | Show connected agents, devices, and session count (WebSocket `agents:listed`) |
| `logs [--relay] [--lines]` | Query the relay in-memory log buffer (`GET /api/v1/logs`) |
| `init [--relay]` | Create the first admin account on the relay |

### Command Design Principles

Each command has exactly one responsibility. `tapflow start` is for local development only and does not accept a `--relay` option.
"Connect to a relay" and "start a relay" are separate commands (`agent start` / `relay start`).

## HOW

- UX standard: one-line input → progress feedback → result message. Use spinners and banners for visual feedback.
- Config and cache are stored in `~/.tapflow/`.
- Package dependencies: `@tapflow/agent-core`, `@tapflow/ios-agent`, `@tapflow/relay`. Import as libraries — do not reimplement.

## HOW NOT

- Do not add commands that access external systems (cloud, remote infrastructure) — this is a local tool.
- Do not hardcode credentials or tokens.
- Do not make destructive state changes in any command other than `reset`.
