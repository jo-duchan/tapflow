# Changelog

## Unreleased

### Breaking Changes

#### `tapflow init` — config scaffolding (was: admin creation)

`tapflow init` now creates `tapflow.config.json` instead of creating the first admin account.

**Before:**
```sh
tapflow start          # starts relay (also created tapflow.config.json as a side effect)
tapflow init           # created the first admin account via CLI
```

**After:**
```sh
tapflow init           # scaffolds tapflow.config.json
tapflow start          # starts relay (no longer creates config as a side effect)
# open http://localhost:4000 → /setup page creates the first admin account in the browser
```

**Migration:**
- Admin account creation: use the web onboarding page (`/setup`) or `tapflow admin init`.
- Config file: run `tapflow init` once before `tapflow start`. If you skip it, tapflow uses built-in defaults (port 4000, `.tapflow-data/`).

### New

- `tapflow init` now updates `.gitignore` automatically — creates the file if absent, appends `.tapflow-data/` if not already present.
- `tapflow init --tunnel tailscale` — scaffold config with Tailscale tunnel section
- `tapflow init --tunnel rathole` — scaffold config with rathole tunnel section placeholder
- `tapflow init --force` — overwrite existing `tapflow.config.json`
- `tapflow init` (interactive TTY) — guided tunnel provider selection
- `tapflow admin init` — create the first admin account via CLI (headless / fallback path)
- Dashboard `/setup` page — web-based first admin account creation (GitLab/Grafana style)
- `GET /api/v1/auth/status` — public endpoint returning `{ initialized: boolean }`
- Tailscale tunnel provider (`tunnel.provider: "tailscale"`) — E2E encrypted, no VPS required

### Changed

- `tapflow start` and `tapflow relay start` no longer create `tapflow.config.json` as a hidden side effect.
- `tapflow init` is now a config scaffolding command, not an admin creation command.
