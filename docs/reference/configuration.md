# Configuration

The relay reads `tapflow.config.json` from this machine's install directory — `~/.tapflow` unless `TAPFLOW_HOME` or an install in the current directory says otherwise ([which install a command uses](/operate/configure#which-install-a-command-uses)). Generate it by running `tapflow init`, then restart the relay after any changes.

Paths inside the file are relative to the file itself, the way a `tsconfig.json` or a `litestream.yml` reads its own: `"dataDir": "data"` in `~/.tapflow/tapflow.config.json` means `~/.tapflow/data`, wherever you run the command from.

## Example

```json
{
  "local": {
    "port": 4000,
    "dataDir": "data"
  },
  "relay": {
    "url": "wss://your-relay-url"
  },
  "smtp": {
    "host": "smtp.example.com",
    "port": 587,
    "secure": false,
    "user": "relay@example.com",
    "pass": "password"
  },
  "webhooks": [
    { "url": "https://ci.internal/hooks/tapflow", "secretEnv": "TAPFLOW_WEBHOOK_SECRET_CI" }
  ]
}
```

| Key | Description |
|-----|-------------|
| `local` | Settings for the relay server running on this machine. |
| `relay.url` | URL of the relay to connect to. Used by `tapflow agent start`, `tapflow admin init`, `tapflow status`, and `tapflow logs` as the default — no `--relay` flag needed when this is set. Leave empty for local mode (`ws://localhost:[local.port]`). Write it as `ws://` or `wss://`: `tapflow agent start` rejects any other scheme, and the other commands switch it to HTTP where they need to. |
| `tunnel` | The tunnel that `tapflow start` and `tapflow relay start` bring up alongside the relay. See the Tunnel section below. |
| `tls` | LAN HTTPS (secure context) settings, required for WebCodecs hardware decode. See the HTTPS section below. |
| `smtp` | SMTP settings for sending invitation and password reset emails. |
| `webhooks` | Outbound endpoints notified when a build's review status changes. Signing secrets are read from env vars named by `secretEnv`. See the Webhooks section below. |
| `agent.lean` | Lean mode for the iOS simulators and Android emulators this machine's agent boots. Read by the agent, not the relay. Default `false`. See the Lean mode section below. |

`smtp.from` defaults to `tapflow <smtp.user>` when `smtp.user` is set, and to `tapflow <noreply@tapflow.local>` otherwise. Override it explicitly if you need a different sender address.

## Environment variable overrides

Environment variables always take precedence over the config file — useful for server deployments and CI.

Secrets can also live in the data directory's `.env` file. The relay loads it first thing on start, so any variable below can come from there instead of the shell. Precedence is **shell env > `.env` > config file**. See [Configuring tapflow](/operate/configure) for the file format and the one exception (`TAPFLOW_DATA_DIR`).

| Variable | Config key | Default | Description |
|----------|------------|---------|-------------|
| `TAPFLOW_PORT` | `local.port` | `4000` | Server port |
| `TAPFLOW_TUNNEL_PORT` | `local.tunnelPort` | `4001` when a tunnel is configured, otherwise off | Loopback-only port for tunnel clients such as rathole, `tailscale serve` and `cloudflared`. A connection on this port counts as remote even though it comes from the relay's own machine, so it signs in or presents a token. `tapflow start` and `tapflow relay start` open it whenever a `tunnel` is configured. Everywhere else, including the Docker image, it opens only when this variable or `local.tunnelPort` names a port — set it there for any tunnel or proxy that reaches the relay from the relay's own network namespace. If the relay itself uses `4001`, the default moves to `4002`. Inside a container, only something that shares the relay's network namespace can reach it. |
| `JWT_SECRET` | — | *(auto-generated)* | JWT signing key (env only). If unset, a strong per-install secret is generated on first boot and persisted to the data directory. A value you set must be at least 32 characters; a shorter one stops the relay from starting. |
| `TAPFLOW_HOME` | — | `~/.tapflow` | The install directory: where `tapflow.config.json` and, by default, the data directory live. Every command reads it. A relative value is taken from the current directory; an empty one counts as unset. A command that runs or reaches the relay stops when it names a directory that does not exist — `tapflow init` creates it instead. |
| `TAPFLOW_DATA_DIR` | `local.dataDir` | `<install>/data` | DB and uploads directory. Relative to the current directory here, and to the config file in `local.dataDir`. An install that already holds `.tapflow/data` or `.tapflow-data` keeps using it. |
| `TAPFLOW_RELAY_URL` | `relay.url` | *(empty)* | Relay URL used as default by CLI commands |
| `TAPFLOW_AGENT_TOKEN` | — | *(empty)* | Token with the `agent` scope for remote relay authentication. The `--token` flag takes precedence. See [Agent Setup](/operate/agents#remote-relay-authentication). |
| `TAPFLOW_TOKEN` | — | *(empty)* | Personal access token (PAT) that `tapflow flow run` and the MCP server use to reach a remote relay. For `flow run`, the `--token` flag takes precedence. |
| `TAPFLOW_TUNNEL_TOKEN` | — | *(empty)* | Shared secret that authenticates the rathole tunnel. Required when `tunnel.provider` is `rathole`. |
| `TAPFLOW_LEAN` | `agent.lean` | `off` | `on` or `off`. Any other value is ignored with a warning, and the config file's value is used. |
| `TAPFLOW_TRUSTED_PROXIES` | — | *(empty)* | Comma-separated IPs of trusted reverse proxies (e.g. `127.0.0.1,::1`). Set this when the relay runs behind a same-host reverse proxy so it reads the real client IP from `X-Forwarded-For` instead of the proxy's address. Empty disables forwarded-header parsing. |
| `TAPFLOW_BUILD_TTL_DAYS` | — | `7` | Days a build is kept after its deletion is scheduled before the files and record are purged. Scheduling is a manual action — marking a build **Done** no longer deletes it. Set to a small value (e.g. `0.001`) to verify cleanup quickly in local testing. |
| `TAPFLOW_MAX_BUILD_BYTES` | — | `524288000` (500 MB) | Maximum build upload size (bytes). |
| `TAPFLOW_MAX_UNPACKED_BYTES` | — | 4× the upload limit | Maximum unpacked size of an iOS `.tar.gz` build (bytes). |
| `TAPFLOW_MAX_COMMENT_BYTES` | — | `5242880` (5 MB) | Maximum size of a comment's image attachment (bytes). |
| `IDLE_TIMEOUT_MS` | — | `300000` (5 min) | Milliseconds a session waits after its browser leaves before it ends. |
| `TAPFLOW_RESOURCE_THRESHOLD_PERCENT` | — | `80` | When CPU or memory use on the agent's Mac is above this percentage, new session joins are refused. |
| `TAPFLOW_WS_BACKPRESSURE_BYTES` | — | `1048576` (1 MB) | Binary frame drop threshold per browser socket. Frames are silently dropped when the socket buffer exceeds this value. |
| `TAPFLOW_AGENT_GRACE_MS` | — | `15000` (15 s) | Milliseconds a session stays alive after its agent's connection drops, waiting for that agent to come back. An agent registers about a second after its process starts, so the default covers a restart several times over; the open tab says it is waiting rather than showing a frame that has stopped updating, and the device is not offered to anyone else until the window closes. `0` disables the hold — the session ends the moment the agent's socket does, as it did before this existed. A blank, non-numeric or negative value falls back to the default and logs a warning at startup. |
| `TAPFLOW_CLOUDFLARE_TOKEN` | — | *(empty)* | Cloudflare API token for DNS-01 issuance when `tls.dnsProvider` is `cloudflare`. |
| `TAPFLOW_VERCEL_TOKEN` | — | *(empty)* | Vercel API token for DNS-01 issuance when `tls.dnsProvider` is `vercel`. |
| `TAPFLOW_VERCEL_TEAM_ID` | — | *(empty)* | Vercel team ID, required when the domain belongs to a team scope. |
| `TAPFLOW_ACME_EMAIL` | — | *(empty)* | Optional contact email for the Let's Encrypt account. |
| `TAPFLOW_ACME_STAGING` | — | *(empty)* | `1` issues from the Let's Encrypt staging environment. For testing; browsers do not trust the certificate it produces. |
| `TAPFLOW_ADMIN_EMAIL` | — | *(empty)* | Email for the first Admin account, created while the relay boots. Set it **together with** `TAPFLOW_ADMIN_PASSWORD`. Does nothing on an install that already has an owner. |
| `TAPFLOW_ADMIN_PASSWORD` | — | *(empty)* | Password for that account, at least 8 characters. |
| `SMTP_HOST` | `smtp.host` | `` | SMTP host |
| `SMTP_PORT` | `smtp.port` | `587` | SMTP port |
| `SMTP_SECURE` | `smtp.secure` | `false` | Enable TLS (set to string `"true"`) |
| `SMTP_USER` | `smtp.user` | `` | SMTP username |
| `SMTP_PASS` | `smtp.pass` | `` | SMTP password |
| `SMTP_FROM` | `smtp.from` | `tapflow <smtp.user>` (`tapflow <noreply@tapflow.local>` without `smtp.user`) | Sender address |
| `LOG_LEVEL` | — | `info` | Log level: `debug`, `info`, `warn` or `error`. Read by both the relay and the agents. |

::: tip JWT_SECRET is optional
If `JWT_SECRET` is not set, the relay generates a strong per-install secret on first boot and stores it in the data directory (`jwt-secret`, owner-only). Set `JWT_SECRET` explicitly only when you need a fixed key — for example, to share one secret across multiple relay instances:

```sh
openssl rand -hex 32
```

Put the value in the data directory's `.env` (`~/.tapflow/data/.env` by default) or inject it as a shell environment variable. A value shorter than 32 characters is rejected.
:::

::: warning Point same-host proxies and tunnels at the tunnel port
The relay does not ask connections that reach it over loopback to sign in. A reverse proxy (nginx, Caddy), `cloudflared` or `tailscale serve` does exactly that when it runs beside the relay: on the same machine for a native install, or in the relay's own network namespace for a container. Pointed at the relay port, it makes **every client it forwards look local**. Point it at the tunnel port instead (`127.0.0.1:4001`, see `TAPFLOW_TUNNEL_PORT`). Every connection there counts as remote. A proxy on another host is remote already and needs no change, and that includes one reaching a container over Docker's bridge.

To log and rate-limit by the real client address, also set `TAPFLOW_TRUSTED_PROXIES` to the proxy's address (e.g. `127.0.0.1,::1`) and have the proxy forward `X-Forwarded-For`. A proxy that stays on the relay port needs this setting for its clients to count as remote. A tunnel that forwards raw TCP, like rathole, adds no header, so only the tunnel port helps there.

For proxied or tunneled deployments, also set a public URL (`tunnel.publicUrl` or `relay.url`). Otherwise the CORS/CSRF allowlist is loopback-only and the dashboard's cross-origin requests can be blocked.
:::

## Create the first Admin account in a Docker container (`TAPFLOW_ADMIN_EMAIL`) {#create-the-first-admin-account-in-a-docker-container-tapflow-admin-email}

Set both variables and the relay creates the first Admin account while it starts — the path for a Docker install, where neither the browser onboarding nor `tapflow admin init` can reach.

Normally you create that first account through the `/setup` page in a browser, and `tapflow admin init` stands in for it on a server with no browser. A container closes both doors: `/setup` only answers a request from loopback — the check that stops a stranger claiming a public instance first — and a container reaches the relay through its bridge gateway, while the relay-only image carries no CLI.

How it behaves:

- **It does nothing on an install that already has an owner.** Your account is never replaced, restarts do not repeat it, and none of the three checks below run.
- On an install with no owner, set both variables together. One without the other stops the relay starting.
- The password must be at least 8 characters. A shorter one also stops it starting.
- If the account you asked for could not be created, the relay does not start. An ownerless relay is claimable by anything that reaches loopback, so stopping is safer than serving.

Leave both unset and nothing changes.

There are two places to keep the values and **they do not combine.** Compose looks for what it interpolates in your shell or in the `.env` beside your compose file. The relay reads `.tapflow/data/.env` inside the volume. Different files.

### In your compose file

```yaml
services:
  relay:
    image: tapflow/tapflow:latest
    environment:
      - TAPFLOW_ADMIN_EMAIL=admin@yourteam.com
      - TAPFLOW_ADMIN_PASSWORD=${TAPFLOW_ADMIN_PASSWORD:?set this before starting}
```

`${...:?}` makes Compose refuse to start when the value is missing — a literal here would be copied unchanged and become a known password. Supply it as a shell environment variable, or in the `.env` next to your compose file.

### In the relay's own `.env`

Leave both lines out of `environment:` and write them inside the volume you already mount. That keeps the password out of your compose file and your shell history.

```ini
# Paste your own password after the =. Left empty, the relay does not start.
TAPFLOW_ADMIN_EMAIL=admin@yourteam.com
TAPFLOW_ADMIN_PASSWORD=
```

Narrow the permissions on a file you create yourself.

```sh
chmod 600 .tapflow/data/.env
```

`tapflow init` creates that file with mode 0600, but the relay-only image has no CLI — so a container operator writes it under their own umask. The relay checks the mode at startup and warns when other users can read it.

```text
.tapflow/data/.env is readable by other users (mode 644). Run: chmod 600 .tapflow/data/.env
```

It is a warning rather than a refusal.

## Streaming tuning (agent)

These variables are set on the **agent** process (`tapflow agent start` / `tapflow start`), not the relay, and tune the video stream's LAN bandwidth ↔ fidelity trade-off. Diagnostic flags for *measuring* the stream (`TAPFLOW_STREAM_METRICS`, the `?perf=1` panel) are a contributor tool — see [measurement.md](https://github.com/jo-duchan/tapflow/blob/main/contributing/measurement.md).

| Variable | Default | Description |
|----------|---------|-------------|
| `TAPFLOW_IOS_CODEC` | `h264` | iOS stream codec — `h264` (default) or `jpeg`. H.264 also needs browser support; unsupported browsers fall back to JPEG automatically. |
| `TAPFLOW_IOS_H264_BITRATE` | `8000000` | iOS H.264 target bitrate (bits/s, soft cap). Lower = fewer LAN drops, more motion blockiness. |
| `TAPFLOW_JPEG_QUALITY` | `0.8` | iOS JPEG quality (0–1), JPEG path only. Lower = fewer drops, more artifacts. |
| `TAPFLOW_MAX_SIZE` | *(per connection)* | Downscale cap for the longest side (px), both platforms. Lower = less bandwidth and viewer decode load, lower fidelity. When unset, the viewer's connection decides: native on localhost and LAN HTTPS, `TAPFLOW_MAX_SIZE_LAN` on LAN HTTP, `TAPFLOW_MAX_SIZE_EXTERNAL` on an external connection. `0` means native on every connection. |
| `TAPFLOW_MAX_SIZE_LAN` | `1280` | Cap (px) for LAN HTTP connections when `TAPFLOW_MAX_SIZE` is unset. |
| `TAPFLOW_MAX_SIZE_EXTERNAL` | `1000` | Cap (px) for external connections when `TAPFLOW_MAX_SIZE` is unset. |
| `TAPFLOW_IOS_MAX_SIZE` / `TAPFLOW_ANDROID_MAX_SIZE` | *(per connection)* | Per-platform override of `TAPFLOW_MAX_SIZE`. |
| `TAPFLOW_ANDROID_FPS` | `30` | Android emulator capture frame rate (gRPC path). |
| `TAPFLOW_ANDROID_BACKEND` | *(auto)* | Force the Android backend — `grpc` or `scrcpy`. Auto-selected by device type when unset. |
| `TAPFLOW_ANDROID_GRPC_PORT` | `8554` | First port tried when picking a gRPC port for an emulator tapflow boots. The first free port from here, stepping by 2, is used. |
| `TAPFLOW_AUDIO` | *(on)* | `off` turns off device audio streaming. See [Audio](/testing/audio). |
| `TAPFLOW_ALLOW_DISPLAY_SLEEP` | *(empty)* | Any value lets the host display sleep during a session. System sleep is still prevented. See [Agent Setup](/operate/agents#host-display-and-sleep). |

## Lean mode (agent)

With `agent.lean` set to `true`, the agent turns off a fixed list of background services on every iOS simulator it boots, and a few bundled apps on Android emulators (see below). Measured on iOS 27, a simulator then uses about a quarter less memory, roughly 0.5 GB, so a Mac holds more simulators before it starts swapping.

```json
{ "agent": { "lean": true } }
```

**What turns off:** Siri and Apple Intelligence background work, iCloud Keychain and backup, the Health app, fitness and HomeKit, photo analysis, Family Sharing and Screen Time, News, Maps sync and Tips, iMessage and FaceTime, AirDrop, Continuity, CarPlay, Watch and Find My, Safari bookmark sync, and telemetry.

**What stays on:** the services apps commonly rely on and what a tester sees on screen. That covers the wallpaper and widgets, dictation, speech and keyboard suggestions, Sign in with Apple, CloudKit and iCloud Drive, StoreKit, push and Wallet, HealthKit, the photo picker, Contacts and Calendar, Spotlight and Settings search, universal links, WeatherKit, MapKit, Game Center and CallKit. The list is fixed rather than worked out from your app, so if an app under test needs a service from the list above, turn Lean mode off. tapflow's own features, including streaming, input, the UI tree, the clipboard, audio, installs, deep links and the network control, were checked on a lean simulator.

It only applies while tapflow runs the simulator:

- The agent writes the setting just before it boots a simulator that is shut down, and removes it when it shuts the simulator down. Booting that simulator later from Xcode or Simulator.app starts it with every service running.
- A simulator that is already running when a session asks for it is used as it is. Lean mode applies from its next boot through tapflow.
- If the agent stops without shutting a simulator down, that simulator stays lean while it keeps running, whoever opens it. Once it is shut down, the next agent to connect removes the setting.
- `tapflow boot` starts a simulator without going through the agent, so it boots it as it is.

It needs an iOS 18.5 or later runtime; other runtimes, tvOS and watchOS simulators are left alone. `tapflow doctor ios` shows whether Lean mode is on and how many simulators are lean right now.

### Android emulators

On Android the agent disables four bundled Google apps: the Google app, YouTube, YouTube Music and Digital Wellbeing. They start on their own at boot. Measured on an API 34 emulator, the guest then takes about 350 MB less of the Mac's memory, just under a fifth.

The emulator gives memory back to the Mac only when it exits, so the apps have to be disabled before a boot to save anything. That is why this works differently from iOS: the apps stay disabled for as long as Lean mode is on, and the saving starts from an emulator's second boot through tapflow.

- The home screen loses the Google search bar, and the assistant is gone. An app that sends `ACTION_WEB_SEARCH` finds nothing to handle it. Voice input keeps working, because other apps provide it.
- Photos, Messages, Gmail and Maps stay on, because apps open images, texts, mail and maps through them.
- An emulator that is already running when a session asks for it is not made lean until its next boot through tapflow.
- The apps are disabled in the emulator itself, so they stay disabled when you open it from Android Studio. While Lean mode is on, an app you re-enable by hand is disabled again the next time tapflow boots the emulator.
- When Lean mode is turned off, the apps come back the next time tapflow boots that emulator. To restore them without tapflow, run `adb shell pm enable <package>` for each one, then `adb shell rm /data/local/tmp/tapflow-lean.json`.
- `tapflow doctor android` shows whether Lean mode is on. Which emulators are lean is recorded inside each emulator, so doctor cannot count them.

In a setup with several Macs, each Mac's `tapflow.config.json` decides for the agent on that Mac.

## Tunnel

With `tunnel` set, `tapflow start` and `tapflow relay start` bring up a tunnel alongside the relay. The supported `provider` values are `tailscale` and `rathole`. Example configs are under [`tapflow relay start`](/reference/cli#tapflow-relay-start), and the full setup is in [External access](/operate/external-access).

| Key | Description |
|-----|-------------|
| `tunnel.provider` | `tailscale` or `rathole` (required) |
| `tunnel.publicUrl` | Public URL your team opens. Required for rathole. For Tailscale, the MagicDNS hostname is used when it is omitted. |
| `tunnel.serverAddr` | rathole server address (`host:port`). rathole only, required. |
| `tunnel.ssh.host` / `tunnel.ssh.user` | Host and user for managing the rathole server over SSH. Without `ssh`, tapflow assumes the server is already running. |
| `tunnel.ssh.keyPath` | Path to the SSH private key (optional). |

rathole also needs the `TAPFLOW_TUNNEL_TOKEN` environment variable.

## HTTPS (secure context) {#https-secure-context}

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

API tokens go in the `.env` file that `tapflow init` scaffolds in the data directory (`~/.tapflow/data/.env` by default), not in the config file. Cloudflare uses `TAPFLOW_CLOUDFLARE_TOKEN` and Vercel uses `TAPFLOW_VERCEL_TOKEN`, plus `TAPFLOW_VERCEL_TEAM_ID` for a team domain. When the install directory is inside a git repository, `tapflow init` adds the data directory to `.gitignore` so the file is not committed. If you point the data directory somewhere else, make sure that path is ignored too. A value set directly in the environment takes precedence over the file. See [Configuring tapflow](/operate/configure) for how the file is scaffolded and read.

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

At startup, tapflow advertises the first concrete DNS SAN other than `localhost`; when the SAN extension is absent, it uses a concrete subject CN. If DNS SANs are present but none is usable — for example, a wildcard-only certificate — it advertises `localhost` and prints a warning. IP-only SANs and malformed certificates also fall back to `localhost`, without that DNS-SAN warning. The advertised name must resolve to the relay's LAN address for teammates to use it.

::: tip Access and known limits
- The certificate is bound to the domain, so open `https://[domain]:[port]`. Connecting via `localhost` or an IP raises a name-mismatch warning.
- Some routers block responses where a public domain points to a private IP (DNS rebinding). Add a router exception, or map the domain to the LAN IP via local DNS.
- On networks with WiFi client isolation, device-to-device traffic is blocked and LAN access is impossible. Use a normal home or office LAN.
- A staging certificate (`TAPFLOW_ACME_STAGING=1`) is untrusted, so browsers warn. Right after switching the same domain from staging to production, the browser may cache the old certificate error — re-check in a private window or after clearing history.
:::

## Data directory

The install directory is laid out as follows. `tapflow init` writes `tapflow.config.json`, `AGENTS.md` and `CLAUDE.md`, plus `data/.env` when you choose HTTPS with a DNS API token; the relay creates the rest of `data/` as it runs.

```text
~/.tapflow/
  tapflow.config.json   ← relay configuration (run tapflow init to generate)
  AGENTS.md             ← tapflow section for coding agents
  CLAUDE.md             ← @AGENTS.md
  data/                 ← relay runtime state
    tapflow.db          ← SQLite database
    jwt-secret          ← per-install signing key
    .env                ← credentials, when DNS auto-issue is used
    uploads/
      builds/           ← .app.zip, .tar.gz and .apk files
      avatars/
      comments/
      team/             ← team logo
    recordings/         ← session recordings (deleted after 72h)
```

Flow files are not part of the install: keep them in your app repository under `.tapflow/flows/`, where failure screenshots land in `.tapflow/artifacts/`.

To change the data directory location, set `TAPFLOW_DATA_DIR` or `local.dataDir`. Back up the data directory to preserve all data.

Upgrading from a version that kept its data in the directory you started the relay from? Nothing moves. That directory still counts as the install while it holds `tapflow.config.json`, `.tapflow/data` or `.tapflow-data`, so running the relay there uses exactly what it used before — and `local.dataDir`, including the `.tapflow/data` older `init` and `tapflow migrate data-dir` write, resolves against the config file beside it. To adopt the unified layout, stop the relay and run `tapflow migrate data-dir` once: it atomically renames `.tapflow-data/` → `.tapflow/data/` (no copy, no data loss), repoints `local.dataDir` when it pinned the old default, and updates `.gitignore`.

## SMTP

Without SMTP, invitation emails and password reset emails will not be sent. In that case, Admins can copy and share the invite link directly.

To send invitation emails, configure `smtp.host`, `smtp.user`, and `smtp.pass`.

## Webhooks

tapflow POSTs to registered URLs when a build's review status changes to `Done` or `Rejected`. Declare endpoints in the `webhooks` array; the REST API can register more at runtime. The full payload, signature verification, and firing rules are in [Webhooks](/operate/webhooks).

| Key | Description |
|-----|-------------|
| `webhooks[].url` | Destination that receives the POST (required). |
| `webhooks[].secretEnv` | Name of the env var holding the HMAC signing secret. Secrets never go in config.json. |
| `webhooks[].enabled` | Whether the endpoint is active. Defaults to `true`. |

Changes to `webhooks` take effect after a relay restart.
