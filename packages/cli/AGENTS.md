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
| `agent start [--relay, --device, --platform, --token]` | Start agent only — connects to an existing relay. `--token` (or `TAPFLOW_AGENT_TOKEN`) carries an `agent`-scope PAT, required when the relay is on a different machine; flag wins over env. |
| `doctor [platform]` | Check system prerequisites (`ios` \| `android`; omit for all): iOS Xcode/simctl/Simulator, Android SDK/adb/AVD |
| `setup [platform]` | Guided environment setup (`ios` \| `android`; omit to auto-detect): installs/repairs JDK, Android SDK (self-contained at `~/Library/Android/sdk`), simulator runtime / AVDs |
| `devices` | List available simulators and AVDs |
| `boot <name>` | Boot a simulator by name or UDID |
| `reset` | Shut down all simulators and emulators |
| `status [--relay]` | Show connected agents, devices, and session count (WebSocket `agents:listed`) |
| `logs [--relay] [--lines]` | Query the relay in-memory log buffer (`GET /api/v1/logs`) |

### Command Design Principles

Each command has exactly one responsibility. `tapflow start` is for local development only and does not accept a `--relay` option.
"Connect to a relay" and "start a relay" are separate commands (`agent start` / `relay start`).
"Scaffold config" and "create the admin account" are separate commands (`init` / `admin init`) — `init` never touches the relay or creates accounts.
`doctor` diagnoses prerequisites; `setup` installs/fixes them. Both take an optional `[platform]` (`ios` | `android`) and mirror each other; device booting is left to the relay (on-demand on QA Session join), so `setup` only ensures a bootable device/AVD exists.

## HOW

- UX standard: one-line input → progress feedback → result message. Use spinners and banners for visual feedback (`print.ts`: `banner`, `step`, `warn`, `createSpinner`). Interactive prompts use `@clack/prompts`.
- `tapflow.config.json` lives in the working directory (created by `tapflow init`); runtime data goes in `.tapflow-data/`. Downloaded tunnel binaries are cached in `~/.tapflow/bin`.
- Package dependencies: `@tapflowio/agent-core`, `@tapflowio/ios-agent`, `@tapflowio/android-agent`, `@tapflowio/relay`. Import as libraries — do not reimplement.

## HOW NOT

- Do not add commands that access external systems (cloud, remote infrastructure) — this is a local tool.
- Do not hardcode credentials or tokens.
- Only `reset` tears down running state (shutting down simulators/emulators). `setup` may install/configure the local environment (Homebrew packages, JDK, Android SDK, shell rc) but only after explicit consent and only in interactive (TTY) sessions — non-interactive runs print guidance instead. No command deletes user data.
