# Configuration

The relay reads `tapflow.config.json` from the directory where it is started. The file is auto-generated on first run — edit it and restart the relay to apply changes.

## Example

```json
{
  "server": {
    "port": 4000,
    "dataDir": ".tapflow-data"
  },
  "smtp": {
    "host": "smtp.example.com",
    "port": 587,
    "secure": false,
    "user": "relay@example.com",
    "pass": "password"
  }
}
```

`smtp.from` defaults to `tapflow <smtp.user>` when `smtp.user` is set. Override it explicitly if you need a different sender address.

## Environment variable overrides

Environment variables always take precedence over the config file — useful for server deployments and CI.

| Variable | Config key | Default | Description |
|----------|------------|---------|-------------|
| `TAPFLOW_PORT` | `server.port` | `4000` | Server port |
| `JWT_SECRET` | — | *(dev default)* | JWT signing key (env only) |
| `TAPFLOW_DATA_DIR` | `server.dataDir` | `.tapflow-data` | DB and uploads directory (supports relative paths) |
| `TAPFLOW_BUILD_TTL_DAYS` | — | `7` | Days before a Done build's files and record are automatically deleted. Set to a small value (e.g. `0.001`) to verify cleanup quickly in local testing. |
| `TAPFLOW_WS_BACKPRESSURE_BYTES` | — | `1048576` (1 MB) | Binary frame drop threshold per browser socket. Frames are silently dropped when the socket buffer exceeds this value. |
| `SMTP_HOST` | `smtp.host` | `` | SMTP host |
| `SMTP_PORT` | `smtp.port` | `587` | SMTP port |
| `SMTP_SECURE` | `smtp.secure` | `false` | Enable TLS (set to string `"true"`) |
| `SMTP_USER` | `smtp.user` | `` | SMTP username |
| `SMTP_PASS` | `smtp.pass` | `` | SMTP password |
| `SMTP_FROM` | `smtp.from` | `tapflow <smtp.user>` | Sender address |

::: warning Always replace JWT_SECRET
If `JWT_SECRET` is not set, the dev default is used. Using the default in production lets anyone forge valid auth tokens.

Generate a safe value:

```sh
openssl rand -hex 32
```
:::

## Data directory

The relay creates these files in the working directory on first run:

```text
your-directory/
  tapflow.config.json   ← relay configuration (auto-generated)
  .tapflow-data/
    tapflow.db          ← SQLite database
    uploads/
      builds/           ← .app.zip and .apk files
      avatars/
      comments/
```

To change the data directory location, set `TAPFLOW_DATA_DIR` or `server.dataDir`. Back up `.tapflow-data/` to preserve all data.

## SMTP

Without SMTP, invitation emails and password reset emails will not be sent. In that case, Admins can copy and share the invite link directly.

To send invitation emails, configure `smtp.host`, `smtp.user`, and `smtp.pass`.
