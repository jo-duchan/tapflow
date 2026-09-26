---
type: rules
topics: [cli, ux]
status: living
---

# cli — AGENTS.md

> Common rules: [AGENTS.md](../../AGENTS.md) | Full index: [INDEX.md](../../INDEX.md)

---

## WHAT

`tapflow` CLI: handles local dev environment checks and simulator / relay / agent startup.
Commands are registered in `src/program.ts` (`index.ts` only parses argv); user-facing reference: [`docs/reference/cli.md`](../../docs/reference/cli.md), held to the registered commands and flags in both directions by `src/__tests__/cliDocsParity.test.ts`. Non-obvious contracts:

- `init` never touches the relay; it scaffolds the install dir's config, the `AGENTS.md`/`CLAUDE.md` a coding agent reads, and the `.gitignore` entries for the runtime dirs. `admin init` is the CLI fallback for headless servers (web `/setup` is the default path).
- **Every command resolves the install dir the same way** — `resolveInstallDir` in `@tapflowio/relay`: `TAPFLOW_HOME`, else the cwd when it already is an install, else `~/.tapflow`. No command takes a path for it. `init` re-resolves at call time rather than reading the relay's import-time `install`, because it can be pointed elsewhere in the same process and it creates the dir. Commands that run or reach the relay call `assertInstallDir()`; deciding at import would refuse `setup` and `init` too, since `program.ts` imports every command's module at startup.
- **`init` pins `local.dataDir` in the config it writes.** A new install in tapflow's own dir gets `data`; one sharing a dir with something else gets `.tapflow/data`, where that repo's `.gitignore` already covers it. Pinned so the layout cannot change later under a different resolution rule.
- `agent start --token` (or `TAPFLOW_AGENT_TOKEN`) carries an `agent`-scope PAT, required when the relay is on a different machine; flag wins over env. Its "create an agent-scope PAT" hint is shown only for the relay's missing-credential refusal; any other 1008 carries its own instruction in the reason, which is printed as-is.
- `logs` defaults to `http://localhost:<local.port>`, never `relay.url`: the relay serves `/api/v1/logs` to its own host only, so a remote default would always answer 403 on an agent-only Mac.
- `flow run` exit codes: `0` passed · `1` any product or mixed flow failure · `2` env/config error, including relay/agent/session failures when every failed flow is environmental. Always sends `device:boot` (idempotent — it initializes the agent's touch/stream state). `--token` needs a `view`-scope PAT; REST (`/ui-tree`, `/screenshot`) requires auth even on localhost.
- `migrate data-dir` moves a legacy `.tapflow-data/` into the unified `.tapflow/data/` (atomic rename) **inside the resolved install dir**, repoints `local.dataDir` in `tapflow.config.json` when it pinned the old default, and updates `.gitignore`. Idempotent; the relay itself never moves data (read-only fallback only). Refused while the relay port answers `EADDRINUSE`, because a running relay keeps writing uploads to the directory it started with.
- Bare `migrate` runs the `MIGRATIONS` list in `commands/migrate.ts`: each entry's `check()` reads only and decides whether it is offered. A migration that would fail on every run is `blocked`, reported and not counted. A new migration is a new entry there, with its subcommand keeping the standalone banner and exit code.

### Command Design Principles

Each command has exactly one responsibility. `tapflow start` is for local development only and does not accept a `--relay` option.
"Connect to a relay" and "start a relay" are separate commands (`agent start` / `relay start`).
"Scaffold config" and "create the admin account" are separate commands (`init` / `admin init`) — `init` never touches the relay or creates accounts.
`doctor` diagnoses prerequisites; `setup` installs/fixes them. Both take an optional `[platform]` (`ios` | `android`) and mirror each other in shape; device booting is left to the relay (on-demand on QA Session join), so `setup` only ensures a bootable device/AVD exists.

**They do not mirror each other in what counts as failure, and they share a type that hides it.** `SetupStepResult` is `DoctorCheck` plus `state`, so both carry `ok` and `warn` — but `doctor` fails on `!ok && !warn` (`hasFailures`), while `setup` fails on `!ok` alone, which is the predicate its `SETUP INCOMPLETE` banner already used. In `doctor`, `warn` means *not fatal*; in `setup` it is presentation, and `ok` carries the whole meaning. A Mac with no simulator runtime therefore passes `tapflow doctor` and exits 1 from `tapflow setup`. That is deliberate: `doctor` answers whether the Mac is usable, `setup` answers whether the work it was asked to do got done. Do not "align" them without deciding which question changes — and do not cite one as the reason for the other, which is how a false justification shipped in three places once.

## HOW

- UX standard: one-line input → progress feedback → result message. Use spinners and banners for visual feedback (`print.ts`: `banner`, `step`, `warn`, `createSpinner`). Interactive prompts use `@clack/prompts`.
- `tapflow.config.json` lives in the install dir (created by `tapflow init`); runtime data goes in `<install>/data` on a new install, or the `.tapflow/data` / `.tapflow-data` an existing one already has. Downloaded tunnel binaries are cached in `~/.tapflow/bin`.
- Package dependencies: `@tapflowio/agent-core`, `@tapflowio/ios-agent`, `@tapflowio/android-agent`, `@tapflowio/relay`. Import as libraries — do not reimplement.

## HOW NOT

- Do not add commands that access external systems (cloud, remote infrastructure) — this is a local tool.
- Only `reset` tears down running state (shutting down simulators/emulators). `setup` may install/configure the local environment (Homebrew packages, JDK, Android SDK, shell rc) but only after explicit consent and only in interactive (TTY) sessions — non-interactive runs print guidance instead. No command deletes user data.
