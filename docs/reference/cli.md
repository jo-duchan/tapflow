# CLI Reference

## Installation

::: code-group

```sh [npm]
npm install -g tapflow
```

```sh [yarn]
yarn global add tapflow
```

```sh [pnpm]
pnpm add -g tapflow
```

:::

To update:

```sh
npm update -g tapflow
```

## `tapflow doctor`

Diagnose environment issues. Omit the platform to check all, or pass `ios` / `android` to check one.

```sh
tapflow doctor
tapflow doctor ios
tapflow doctor android
```

Checks (a device/AVD only needs to *exist* — booting is on-demand via the relay):

- **Common**: Node.js version
- **iOS** (macOS only): Xcode, `xcrun simctl`, an available simulator
- **Android**: Android SDK, adb, AVD

Use `--json` for machine-readable output. Exits with code `1` if any check fails.

| Option | Description |
|--------|-------------|
| `[platform]` | `ios` or `android`; omit to check all |
| `--json` | Emit `{ ok, common, ios, android }` as JSON (no ANSI) |

See [Environment Setup](/guide/environment-setup) for the full workflow.


## `tapflow setup`

Install and configure the local environment so a platform is ready to run. Omit the platform to auto-detect, or pass `ios` / `android`.

```sh
tapflow setup
tapflow setup ios
tapflow setup android
```

Runs in one pass, asking for consent before each install (interactive terminals only; non-interactive runs print the command instead):

- **iOS**: opens the App Store for Xcode, accepts the license / runs first-launch (needs sudo), downloads a simulator runtime.
- **Android**: installs a JDK, builds a self-contained SDK at `~/Library/Android/sdk` (command-line tools, platform-tools, emulator, system image — no Android Studio GUI), and creates a set of AVDs across form factors.

setup only ensures a bootable device/AVD exists; the relay boots it on demand when a session opens. After it registers `ANDROID_HOME`/PATH, open a new terminal (or `exec $SHELL`) before running `tapflow doctor`.

| Option | Description |
|--------|-------------|
| `[platform]` | `ios` or `android`; omit to auto-detect |

See [Environment Setup](/guide/environment-setup) for the full workflow.


## `tapflow init`

Scaffold `tapflow.config.json` interactively. Run this once before `tapflow start`.

If `tapflow.config.json` already exists, the command exits with an error unless `--force` is passed.

If no tunnel flag is given and the terminal is interactive, a prompt guides you through tunnel selection. In a non-interactive environment with no `--tunnel` flag, a config file with no tunnel section is created.

```sh
tapflow init
```

| Option | Description |
|--------|-------------|
| `--tunnel <provider>` | Tunnel provider: `tailscale` or `rathole` |
| `--force` | Overwrite existing `tapflow.config.json` |

Example (Tailscale):

```sh
tapflow init --tunnel tailscale
# ✓ tapflow.config.json created.
# Tunnel: tailscale
# → Next: tapflow start
```

Generating config with no tunnel (defaults):

```sh
tapflow init
# ✓ tapflow.config.json created.
# → Next: tapflow start
```


## `tapflow admin init`

Create the first admin account on the relay via CLI. Use this as a fallback when a browser is not available (headless servers, CI).

The relay must be running before executing this command.

```sh
tapflow admin init
```

| Option | Description |
|--------|-------------|
| `--relay <url>` | Relay URL (default: `relay.url` in config, or `http://localhost:4000`) |

Example:

```
  ? Admin email: admin@yourteam.com
  ? Password: ********
  ✓ Admin account created
  →  Open http://localhost:4000 to sign in
```

Password must be at least 8 characters.

::: tip Web onboarding
On first launch, the dashboard automatically redirects to `/setup` where you can create the admin account in the browser — no CLI required. Use `tapflow admin init` only when a browser is not available.
:::


## `tapflow start`

**Local development shortcut.** Starts the relay and agent together on the same Mac.

```sh
tapflow start
```

| Option | Description |
|--------|-------------|
| `--platform <ios\|android\|all>` | Platform to start (default: auto-detect) |
| `--device <name>` | Limit which iOS simulators are exposed to the relay, by name or UDID (default: all). The dashboard boots a device on demand. |

::: info For team deployments
If you are running the relay on a separate server, use `tapflow relay start` and `tapflow agent start` instead.
:::


## `tapflow relay start`

Start the relay server only. Used when deploying the relay to a server.

```sh
tapflow relay start
```

| Option | Default | Description |
|--------|---------|-------------|
| `--port <n>` | `4000` | Port to listen on |
| `--tunnel <provider>` | — | Tunnel provider to use (`tailscale` or `rathole`). Requires a `tunnel` section in `tapflow.config.json` |

**Tailscale (recommended)**

```sh
tapflow relay start
```

`tapflow.config.json`:

```json
{
  "tunnel": {
    "provider": "tailscale"
  }
}
```

tapflow reads the Tailscale MagicDNS hostname automatically. Set `"publicUrl"` to override the auto-detected URL.

**VPS + rathole**

Put `TAPFLOW_TUNNEL_TOKEN` in `.tapflow/data/.env`, then:

```sh
tapflow relay start
```

`tapflow.config.json`:

```json
{
  "tunnel": {
    "provider": "rathole",
    "serverAddr": "your-vps.com:2333",
    "publicUrl": "https://your-vps.com",
    "ssh": {
      "host": "your-vps.com",
      "user": "ubuntu",
      "keyPath": "~/.ssh/id_ed25519"
    }
  }
}
```

The `ssh` section lets tapflow connect to the VPS and manage the rathole server automatically — downloading, installing, and starting it on first run. If `ssh` is omitted, tapflow assumes the rathole server is already running on the VPS.

When the tunnel is ready, the public URL is printed in the banner. If the tunnel fails to connect, the relay continues to run — only the tunnel is unavailable.

See [Self-Hosting](/guide/self-hosting) for full setup instructions.


## `tapflow agent start`

Start the agent only and connect it to a relay. Does not start a local relay.

```sh
tapflow agent start --relay ws://192.168.x.x:4000 --token tflw_pat_xxxxxxxx
```

| Option | Default | Description |
|--------|---------|-------------|
| `--relay <url>` | `relay.url` in config, or `ws://localhost:4000` | Relay WebSocket URL. Omit if `relay.url` is set in `tapflow.config.json`. |
| `--platform <ios\|android\|all>` | auto-detect | Platform to start |
| `--device <name>` | all simulators | Limit which iOS simulators are exposed to the relay, by name or UDID |
| `--token <pat>` | `TAPFLOW_AGENT_TOKEN` env | Token with the `agent` scope, required by remote relays. See [Agent Setup](/guide/agent#remote-relay-authentication). |


## `tapflow devices`

List available simulators and emulators.

```sh
tapflow devices
```


## `tapflow boot`

Boot a simulator or emulator by name or UDID. Searches iOS simulators first, then Android AVDs.

```sh
# iOS
tapflow boot "iPhone 16 Pro"
tapflow boot 822F00B0-D9CF-4B78-8EDD-6322974E4079

# Android (AVD name)
tapflow boot Pixel_8
```

Android AVDs start in the background. Run `tapflow devices` to check status.


## `tapflow reset`

Shut down all simulators and emulators.

```sh
tapflow reset
```

A confirmation prompt is shown (`y/N`). Enter `y` to proceed.


## `tapflow status`

Show connected agents, devices, and active sessions.

```sh
tapflow status
```

| Option | Default | Description |
|--------|---------|-------------|
| `--relay <url>` | `relay.url` in config, or `ws://localhost:4000` | Relay WebSocket URL. Omit if `relay.url` is set in `tapflow.config.json`. |

::: info How it connects
`tapflow status` connects to the relay over WebSocket to fetch information. Times out after 5 seconds if there is no response. Use the `--relay` option when connecting to a remote relay.
:::

Example output:

```
  ● mac-mini-office
      ◉  iPhone 16 Pro   ← qa@company.com
      ○  iPhone 15

  1 agent(s) · 2 device(s) · 1 active session(s)
```


## `tapflow logs`

Show recent relay log entries (last 100 lines by default).

```sh
tapflow logs
```

| Option | Default | Description |
|--------|---------|-------------|
| `--relay <url>` | `relay.url` in config, or `http://localhost:4000` | Relay URL. Omit if `relay.url` is set in `tapflow.config.json`. |
| `--lines <n>` | `100` | Number of log lines to show (max 500) |

## `tapflow migrate data-dir`

Move a legacy `.tapflow-data/` into the unified `.tapflow/data/` layout. Run this once after upgrading; it is idempotent and safe to re-run.

```sh
tapflow migrate data-dir
```

What it does:

- Atomically renames `.tapflow-data/` → `.tapflow/data/` — a single filesystem rename, no copy and no half-moved state.
- Repoints `local.dataDir` in `tapflow.config.json` when it still pins the old default `.tapflow-data`. A custom path is left untouched.
- Adds `.tapflow/data/` and `.tapflow/artifacts/` to `.gitignore` so the moved secrets stay out of git.

Existing installs keep working without running this — a pinned `local.dataDir` is honored, and a config-less default install keeps reading `.tapflow-data/`. If the two paths are on different filesystems, or both already exist, the command stops and prints the manual step instead of guessing.
