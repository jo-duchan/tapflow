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

Environment variables always take precedence over the config file — useful for Docker/CI.

| Variable | Config key |
|----------|-----------|
| `TAPFLOW_PORT` | `server.port` |
| `JWT_SECRET` | `server.jwtSecret` |
| `TAPFLOW_DATA_DIR` | `server.dataDir` |
| `SMTP_HOST` | `smtp.host` |
| `SMTP_PORT` | `smtp.port` |
| `SMTP_USER` | `smtp.user` |
| `SMTP_PASS` | `smtp.pass` |
| `SMTP_FROM` | `smtp.from` |
