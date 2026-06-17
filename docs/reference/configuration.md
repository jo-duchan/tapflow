# Configuration

The relay reads `tapflow.config.json` from the directory where it is started. Generate it by running `tapflow init`, then restart the relay after any changes.

## Example

```json
{
  "local": {
    "port": 4000,
    "dataDir": ".tapflow-data"
  },
  "relay": {
    "url": "https://your-relay-url"
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

| Key | Description |
|-----|-------------|
| `local` | Settings for the relay server running on this machine. |
| `relay.url` | URL of the relay to connect to. Used by `tapflow agent start`, `tapflow admin init`, `tapflow status`, and `tapflow logs` as the default — no `--relay` flag needed when this is set. Leave empty for local mode (`ws://localhost:[local.port]`). |
| `tls` | LAN HTTPS (secure context) settings, required for WebCodecs hardware decode. See the HTTPS section below. |
| `smtp` | SMTP settings for sending invitation and password reset emails. |

`smtp.from` defaults to `tapflow <smtp.user>` when `smtp.user` is set. Override it explicitly if you need a different sender address.

## Environment variable overrides

Environment variables always take precedence over the config file — useful for server deployments and CI.

| Variable | Config key | Default | Description |
|----------|------------|---------|-------------|
| `TAPFLOW_PORT` | `local.port` | `4000` | Server port |
| `JWT_SECRET` | — | *(auto-generated)* | JWT signing key (env only). If unset, a strong per-install secret is generated on first boot and persisted to the data directory. |
| `TAPFLOW_DATA_DIR` | `local.dataDir` | `.tapflow-data` | DB and uploads directory (supports relative paths) |
| `TAPFLOW_RELAY_URL` | `relay.url` | *(empty)* | Relay URL used as default by CLI commands |
| `TAPFLOW_AGENT_TOKEN` | — | *(empty)* | Token with the `agent` scope for remote relay authentication. The `--token` flag takes precedence. See [Agent Setup](/guide/agent#remote-relay-authentication). |
| `TAPFLOW_TRUSTED_PROXIES` | — | *(empty)* | Comma-separated IPs of trusted reverse proxies (e.g. `127.0.0.1,::1`). Set this when the relay runs behind a same-host reverse proxy so it reads the real client IP from `X-Forwarded-For` instead of the proxy's address. Empty disables forwarded-header parsing. |
| `TAPFLOW_BUILD_TTL_DAYS` | — | `7` | Days before a Done build's files and record are automatically deleted. Set to a small value (e.g. `0.001`) to verify cleanup quickly in local testing. |
| `TAPFLOW_WS_BACKPRESSURE_BYTES` | — | `1048576` (1 MB) | Binary frame drop threshold per browser socket. Frames are silently dropped when the socket buffer exceeds this value. |
| `TAPFLOW_CLOUDFLARE_TOKEN` | — | *(empty)* | Cloudflare API token for DNS-01 issuance when `tls.dnsProvider` is `cloudflare`. |
| `TAPFLOW_VERCEL_TOKEN` | — | *(empty)* | Vercel API token for DNS-01 issuance when `tls.dnsProvider` is `vercel`. |
| `TAPFLOW_VERCEL_TEAM_ID` | — | *(empty)* | Vercel team ID, required when the domain belongs to a team scope. |
| `TAPFLOW_ACME_EMAIL` | — | *(empty)* | Optional contact email for the Let's Encrypt account. |
| `SMTP_HOST` | `smtp.host` | `` | SMTP host |
| `SMTP_PORT` | `smtp.port` | `587` | SMTP port |
| `SMTP_SECURE` | `smtp.secure` | `false` | Enable TLS (set to string `"true"`) |
| `SMTP_USER` | `smtp.user` | `` | SMTP username |
| `SMTP_PASS` | `smtp.pass` | `` | SMTP password |
| `SMTP_FROM` | `smtp.from` | `tapflow <smtp.user>` | Sender address |

::: tip JWT_SECRET is optional
If `JWT_SECRET` is not set, the relay generates a strong per-install secret on first boot and stores it in the data directory (`jwt-secret`, owner-only). Set `JWT_SECRET` explicitly only when you need a fixed key — for example, to share one secret across multiple relay instances:

```sh
openssl rand -hex 32
```
:::

::: warning Behind a reverse proxy, set TAPFLOW_TRUSTED_PROXIES
If the relay runs behind a same-host reverse proxy (nginx, Caddy) and `TAPFLOW_TRUSTED_PROXIES` is left unset, the proxy's loopback address makes **every remote client look like localhost** — and localhost is unauthenticated. Set `TAPFLOW_TRUSTED_PROXIES` to the proxy's address (e.g. `127.0.0.1,::1`) and configure the proxy to forward `X-Forwarded-For`.

For proxied or tunneled deployments, also set a public URL (`tunnel.publicUrl` or `relay.url`). Otherwise the CORS/CSRF allowlist is loopback-only and the dashboard's cross-origin requests can be blocked.
:::

## HTTPS (secure context)

Hardware-accelerated video decode (WebCodecs) only runs in a secure context (HTTPS). Over HTTP the dashboard falls back to software decode, so to give teammates on the LAN a smoother stream, terminate the relay over HTTPS. With `tls` set, the relay terminates HTTPS and WSS on the same port.

There are two issuance modes.

### Auto-issue with your own DNS account (`byo-api-token`)

With your own domain and a DNS provider API token, the relay auto-issues and renews a Let's Encrypt certificate over DNS-01.

```json
{
  "local": { "port": 4000 },
  "tls": {
    "mode": "byo-api-token",
    "domain": "tap.yourcompany.com",
    "dnsProvider": "cloudflare"
  }
}
```

| Key | Description |
|-----|-------------|
| `tls.mode` | `byo-api-token` (auto-issue via Let's Encrypt DNS-01) or `import-cert` (your own files). |
| `tls.domain` | Domain the certificate is issued for. Teammates open `https://[domain]:[port]`. |
| `tls.dnsProvider` | `cloudflare` or `vercel`. The matching API token is read from the environment. |
| `tls.publishAddress` | Auto-publish the domain's A record to this machine's LAN IP. Default `true`; set `false` to manage DNS yourself. |
| `tls.address` | IP to use instead of the auto-detected LAN IP, for multi-NIC or VPN overrides. |

API tokens go in the `.tapflow-data/.env` file that `tapflow init` scaffolds, not in the config file. Cloudflare uses `TAPFLOW_CLOUDFLARE_TOKEN` and Vercel uses `TAPFLOW_VERCEL_TOKEN`, plus `TAPFLOW_VERCEL_TEAM_ID` for a team domain. The file stays out of git because `.tapflow-data/` is gitignored. A value set directly in the environment takes precedence over the file. See [Configuring tapflow](/guide/configure) for how the file is scaffolded and read.

When `publishAddress` is on, the relay publishes its LAN IP to the domain's A record on boot and refreshes it periodically, so teammates just open the domain without touching DNS.

### Bring your own certificate (`import-cert`)

To use an internal PKI or a wildcard certificate you already hold, point to the files. You manage renewal yourself.

```json
{
  "tls": {
    "mode": "import-cert",
    "certPath": "/path/to/fullchain.pem",
    "keyPath": "/path/to/privkey.pem"
  }
}
```

| Key | Description |
|-----|-------------|
| `tls.certPath` | Path to the fullchain certificate PEM. |
| `tls.keyPath` | Path to the private key PEM. |

::: tip Access and known limits
- The certificate is bound to the domain, so open `https://[domain]:[port]`. Connecting via `localhost` or an IP raises a name-mismatch warning.
- Some routers block responses where a public domain points to a private IP (DNS rebinding). Add a router exception, or map the domain to the LAN IP via local DNS.
- On networks with WiFi client isolation, device-to-device traffic is blocked and LAN access is impossible. Use a normal home or office LAN.
- A staging certificate (`TAPFLOW_ACME_STAGING=1`) is untrusted, so browsers warn. Right after switching the same domain from staging to production, the browser may cache the old certificate error — re-check in a private window or after clearing history.
:::

## Data directory

The relay creates these files in the working directory on first run:

```text
your-directory/
  tapflow.config.json   ← relay configuration (run tapflow init to generate)
  .tapflow-data/
    tapflow.db          ← SQLite database
    uploads/
      builds/           ← .app.zip and .apk files
      avatars/
      comments/
```

To change the data directory location, set `TAPFLOW_DATA_DIR` or `local.dataDir`. Back up `.tapflow-data/` to preserve all data.

## SMTP

Without SMTP, invitation emails and password reset emails will not be sent. In that case, Admins can copy and share the invite link directly.

To send invitation emails, configure `smtp.host`, `smtp.user`, and `smtp.pass`.
