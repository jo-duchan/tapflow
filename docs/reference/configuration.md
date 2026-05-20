# Configuration

The relay reads `tapflow.config.json` from the directory where it is started.

## Example

```json
{
  "server": {
    "port": 4000,
    "dataDir": ".tapflow",
    "jwtSecret": "CHANGE_THIS_TO_A_LONG_RANDOM_SECRET"
  },
  "smtp": {
    "host": "smtp.example.com",
    "port": 587,
    "secure": false,
    "user": "relay@example.com",
    "pass": "password",
    "from": "tapflow <noreply@example.com>"
  }
}
```

A template is included at `tapflow.config.example.json`.

## Environment variable overrides

Environment variables always take precedence over the config file — useful for server deployments and CI.

| Variable | Config key | Default | Description |
|----------|------------|---------|-------------|
| `TAPFLOW_PORT` | `server.port` | `4000` | Server port |
| `JWT_SECRET` | `server.jwtSecret` | *(dev default)* | JWT signing key |
| `TAPFLOW_DATA_DIR` | `server.dataDir` | `.tapflow` | DB and uploads directory (supports relative paths) |
| `SMTP_HOST` | `smtp.host` | `` | SMTP host |
| `SMTP_PORT` | `smtp.port` | `587` | SMTP port |
| `SMTP_SECURE` | `smtp.secure` | `false` | Enable TLS (set to string `"true"`) |
| `SMTP_USER` | `smtp.user` | `` | SMTP username |
| `SMTP_PASS` | `smtp.pass` | `` | SMTP password |
| `SMTP_FROM` | `smtp.from` | `tapflow <noreply@tapflow.local>` | Sender address |

::: warning Always replace JWT_SECRET
If `JWT_SECRET` is not set, the dev default is used. Using the default in production lets anyone forge valid auth tokens.

Generate a safe value:

```sh
openssl rand -hex 32
```
:::

## Data directory

The relay stores all data in `.tapflow/` by default:

```
.tapflow/
  tapflow.db        ← SQLite database
  uploads/
    builds/         ← .app.zip and .apk files
    avatars/
    comments/
```

To change the location, set `TAPFLOW_DATA_DIR` or `server.dataDir`. Back up this directory to preserve all data.

## SMTP

Without SMTP, invitation emails and password reset emails will not be sent. In that case, Admins can copy and share the invite link directly.

To send invitation emails, configure `smtp.host`, `smtp.user`, and `smtp.pass`.
