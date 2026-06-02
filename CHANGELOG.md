# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- ios-agent: lower the default JPEG stream quality `0.95` → `0.8`, cutting iOS frame bandwidth ~40% on idle/simple screens to reduce relay→browser frame drops on LAN. Tune with the `TAPFLOW_JPEG_QUALITY` env var (`0`–`1`).

## [0.4.1] - 2026-06-01

### Security

- relay: fix path traversal in `/uploads/` — `serveUpload` now validates that the resolved file path stays within `uploadsDir`; requests that escape the directory return 403.
- relay: `/uploads/` route now requires view authentication — unauthenticated requests return 401 before file serving.
- relay: WebSocket connections from non-localhost clients without a valid JWT cookie or PAT are rejected with close code 1008.
- relay: WebSocket role gating — browser-role sockets that send agent-only messages (`agent:register`, `agent:resources`, etc.) are disconnected immediately.

## [0.4.0] - 2026-06-01

### Breaking Changes

- `tapflow init` no longer creates an admin account. It now scaffolds `tapflow.config.json`.
  - **Before:** `tapflow start` (auto-created config) → `tapflow init` (admin creation via CLI)
  - **After:** `tapflow init` (scaffold config) → `tapflow start` → open `/setup` in browser (admin creation)
  - **Migrate:** use the `/setup` page on first launch, or `tapflow admin init` in headless environments.
- `tapflow start` and `tapflow relay start` no longer create `tapflow.config.json` as a side effect. Run `tapflow init` explicitly, or skip it to use built-in defaults (port 4000, `.tapflow-data/`).

### Added

- `tapflow init` — scaffold `tapflow.config.json` interactively; `--tunnel tailscale|rathole` for non-interactive mode; `--force` to overwrite.
- `tapflow init` auto-updates `.gitignore` — creates the file if absent, appends `.tapflow-data/` if not already present.
- `tapflow admin init` — create the first admin account via CLI (headless / CI fallback).
- Dashboard `/setup` page — web-based first admin account creation; auto-redirected from `/login` when no accounts exist.
- `GET /api/v1/auth/status` — public endpoint returning `{ initialized: boolean }`.
- Tailscale tunnel provider (`tunnel.provider: "tailscale"`) — E2E encrypted, no VPS required.

### Removed

- Automatic `tapflow.config.json` creation as a side effect of `tapflow start` / `tapflow relay start`.

[Unreleased]: https://github.com/jo-duchan/tapflow/compare/v0.4.1...HEAD
[0.4.1]: https://github.com/jo-duchan/tapflow/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/jo-duchan/tapflow/compare/v0.3.1...v0.4.0
