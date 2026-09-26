---
title: Backups & uptime
description: Back up the relay's data directory (Litestream for SQLite), and keep the relay running with PM2 on a Mac or systemd on Linux.
---

# Backups & uptime

## Backup

The relay keeps its durable state under the resolved data directory — `~/.tapflow/data/` on a default install, or `<install>/.tapflow/data/` for one that lives in its own folder from an earlier version. `tapflow start` and `tapflow relay start` print the directory they resolved; `TAPFLOW_DATA_DIR` overrides `local.dataDir`. Back that directory up before OS upgrades, relay migration, or any long-running team pilot.

If you are upgrading from a version that stored state in `.tapflow-data/`, nothing breaks: a pinned `local.dataDir` is honored and a config-less install keeps reading the existing `.tapflow-data/`. Stop the relay and run `tapflow migrate data-dir` once to adopt the unified layout: it atomically renames `.tapflow-data/` → `.tapflow/data/` (no copy, no data loss), repoints `local.dataDir` when it pinned the old default, and updates `.gitignore`.

The paths below are inside that data directory — the one on the `Data →` line `tapflow start` prints.

Important paths:

| Path | Why it matters |
|------|----------------|
| `tapflow.db` | SQLite database for accounts, apps, builds, sessions, comments, tokens, and settings. |
| `tapflow.db-wal` / `tapflow.db-shm` | SQLite WAL sidecar files. Include them in filesystem snapshots, or use Litestream so changes are captured safely. |
| `uploads/` | Uploaded build artifacts served by the relay. |
| `recordings/` | Session recordings uploaded through the relay. |
| `.env` and `jwt-secret` | Relay secrets. Keep them private and restore them with the data directory so existing sessions and integrations keep working. |

### Recommended: Litestream for SQLite

[Litestream](https://litestream.io/) is an external process; tapflow does not bundle, install, or supervise it. Litestream streams SQLite WAL changes to object storage such as AWS S3, Cloudflare R2, Backblaze B2, or any S3-compatible endpoint. It does not require tapflow schema changes or a separate database server.

Install Litestream on the relay host:

```sh
brew install litestream
```

On Linux, install the Litestream release binary for your architecture from the official releases page.

Create `litestream.yml` next to your tapflow config, with an absolute database path — Litestream resolves a relative one against its own working directory, which is not necessarily the install:

```yaml
dbs:
  - path: /Users/you/.tapflow/data/tapflow.db
    replicas:
      - type: s3
        bucket: YOUR_BUCKET
        path: tapflow/relay/tapflow.db
        endpoint: YOUR_S3_ENDPOINT
```

Set the credentials required by your storage provider, then run Litestream alongside the relay:

```sh
litestream replicate -config litestream.yml
```

If you use PM2, keep the relay and Litestream as separate processes so each can restart independently:

```sh
pm2 start tapflow --name relay -- relay start
pm2 start litestream --name relay-backup -- replicate -config litestream.yml
pm2 save
```

Restore the database before starting tapflow on a new host:

```sh
DATA_DIR=/Users/you/.tapflow/data   # ~/.tapflow/data, $TAPFLOW_HOME/data, or your TAPFLOW_DATA_DIR
litestream restore -config litestream.yml -if-replica-exists "$DATA_DIR/tapflow.db"
```

Work the directory out from those rules rather than by starting tapflow to see what it prints: the first start creates an empty `tapflow.db`, and `litestream restore` will not overwrite a database that already exists.

Then restore `uploads/`, `recordings/`, `.env`, and `jwt-secret` inside that same data directory from your file backup. Litestream protects the SQLite database only; build files, recordings, and secrets still need a normal filesystem or object-storage backup.

## PM2 (keeping the relay Mac always on)

Handles automatic restart on crash, restart on server reboot, and log management — run this on the relay Mac.

```sh
npm install -g pm2 tapflow
```

With `JWT_SECRET` in the data directory's `.env` (`~/.tapflow/data/.env` on a default install), or left unset to auto-generate, start:

```sh
pm2 start tapflow --name relay -- relay start
pm2 save
pm2 startup
```

To update tapflow:

```sh
npm update -g tapflow
pm2 restart relay
```

::: tip Next step
Once the relay is running, open `http://localhost:4000` in a browser — the dashboard redirects to the setup page automatically. For headless servers, use `tapflow admin init` instead. It asks for an email and a password, so run it from a terminal rather than from a provisioning script. For team invitations and your first build upload, see [First-time Setup](/dashboard/setup).
:::

## systemd (Linux relay server)

Use systemd when the relay runs on a Linux host and you want it to start at boot, restart after crashes, and write logs to journald. Install tapflow globally first:

```sh
npm install -g tapflow
```

Create a dedicated user and data directory:

```sh
sudo useradd --system --create-home --home-dir /var/lib/tapflow --shell /usr/sbin/nologin tapflow
sudo mkdir -p /etc/tapflow /var/lib/tapflow/.tapflow/data
sudo chown -R tapflow:tapflow /var/lib/tapflow
```

Put relay secrets in `/etc/tapflow/relay.env`. The existing [JWT_SECRET](/operate/configure#jwt-secret) section also describes the `.env` convention that the relay reads directly from its data directory:

```ini
TAPFLOW_DATA_DIR=/var/lib/tapflow/.tapflow/data
JWT_SECRET=YOUR_JWT_SECRET
```

`TAPFLOW_HOME` alone would put the data in `/var/lib/tapflow/data`. `TAPFLOW_DATA_DIR` is named here anyway, so this unit matches a server set up before the install directory existed and keeps its data where it already is. To use the shorter layout on a fresh server, drop the line and change `/var/lib/tapflow/.tapflow/data` in the `mkdir` above to `/var/lib/tapflow/data`. As long as a `.tapflow/data` folder exists, even an empty one, the relay treats it as existing data and keeps using it.

Generate `JWT_SECRET` with `openssl rand -hex 32`, then keep `/etc/tapflow/relay.env` readable only by root:

```sh
sudo chmod 600 /etc/tapflow/relay.env
```

Create `/etc/systemd/system/tapflow-relay.service`:

```ini
[Unit]
Description=tapflow relay
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=tapflow
Group=tapflow
WorkingDirectory=/var/lib/tapflow
Environment=TAPFLOW_HOME=/var/lib/tapflow
EnvironmentFile=/etc/tapflow/relay.env
ExecStart=/usr/bin/env tapflow relay start
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/tapflow

[Install]
WantedBy=multi-user.target
```

The hardening directives keep the filesystem read-only except for
`/var/lib/tapflow`, which contains the `TAPFLOW_DATA_DIR` set above. The relay
writes nowhere else, so nothing further needs opening — but if you move
`TAPFLOW_DATA_DIR`, add its new path to `ReadWritePaths` too.

With one exception: `ProtectHome=true` makes `/home`, `/root` and `/run/user`
unreachable outright, and `ReadWritePaths` cannot open a path back up inside
them. A data directory in any of those is invisible to the service no matter
what you list. Keep it elsewhere, or switch to `ProtectHome=read-only`. This is
also why the `tapflow` user is given a home in `/var/lib/tapflow` above rather
than under `/home`.

Place `tapflow.config.json` in `/var/lib/tapflow` if you need to customize the port or other settings, because `TAPFLOW_HOME` above makes that the install directory. Set the same variable in your own shell before running `tapflow` commands by hand, or they will read the default install in your home directory instead of the service's.

Run a smoke test before enabling the service, so a problem arrives as a message
you can read instead of a unit that restarts every five seconds. `systemd-run`
applies the same sandbox the unit will, which a plain `sudo -u tapflow` would
not — the directives above are what most often turn out to be the problem:

```sh
sudo systemd-run --pty --unit=tapflow-smoke   --property=User=tapflow --property=Group=tapflow   --property=WorkingDirectory=/var/lib/tapflow   --property=Environment=TAPFLOW_HOME=/var/lib/tapflow   --property=EnvironmentFile=/etc/tapflow/relay.env   --property=NoNewPrivileges=true   --property=ProtectSystem=strict   --property=ProtectHome=true   --property=PrivateTmp=true   --property=ReadWritePaths=/var/lib/tapflow   /usr/bin/env tapflow relay start
```

In another shell, confirm the relay answers. Give it the URL rather than relying
on the default: `tapflow status` reads *your* configuration to find the relay,
not the service's, so a port set in `/var/lib/tapflow/tapflow.config.json` is
one this shell does not know about.

Copy the address the command above printed on startup — `Relay : …`. `--relay`
accepts it as-is and switches the scheme itself, so a TLS deployment needs no
edit:

```sh
tapflow status --relay http://localhost:4000   # whatever `Relay :` said
```

Stop the foreground relay with Ctrl-C once the status check passes.

Enable and start the service:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now tapflow-relay
sudo systemctl status tapflow-relay
```

View logs with:

```sh
journalctl -u tapflow-relay -f
```

After updating the global package, restart the service:

```sh
npm update -g tapflow
sudo systemctl restart tapflow-relay
```
