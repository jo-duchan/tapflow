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

- **Common**: Node.js version, and whether port 4000 is free. This check fails while a relay is running on port 4000 on this Mac.
- **iOS** (macOS only): Xcode, `xcrun simctl`, an available simulator, the network filter, the network hook, the network hook symbols, and Lean mode
- **Android**: Android SDK, adb, aapt (build-tools), AVD, and Lean mode

The network filter is reported as two checks, because they fail for different reasons: whether it is
**installed, approved and switched on**, and whether the versions on this Mac are the ones this
tapflow carries. Switched on is a third thing with no version of its own — the extension stays listed
as activated when the filter is turned off, so that state has every version correct and nothing
filtering. The second is not implied by the first — replacing an extension only finishes when the Mac
restarts, so the app on disk can be current while the old one is still doing the filtering.

**There are two versions, and the check names whichever is behind.** The app in `/Applications` and
the system extension inside it are versioned separately, because a tapflow release that changes only
the app has no reason to make macOS replace a running filter. The app is the binary the agent calls,
so it matters on its own: a stale one meets requests it does not understand. Both are
warnings rather than failures: a session works without the filter, and only iOS network control does
not. See [Network Control](/guide/network-control).

The network hook is the library tapflow injects to tell an app it is offline. It comes with tapflow,
so a missing one means the install is damaged and reinstalling restores it. It is reported separately
because its absence is otherwise silent: macOS ignores an injection path that does not exist without a
word, so the app launches unhooked and the network control goes on asking you to launch an app through
tapflow — while the app you launched is running in front of you.

Use `--json` for machine-readable output. Exits with code `1` if any check fails; a check that only warns does not count as a failure.

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

Runs in one pass, asking for consent before each install (interactive terminals only; non-interactive runs print the command instead). On both platforms it installs Homebrew first when it is missing.

- **iOS**: opens the App Store for Xcode, accepts the license / runs first-launch (needs sudo), downloads a simulator runtime.
- **Android**: installs a JDK, builds a self-contained SDK at `~/Library/Android/sdk` (command-line tools, platform-tools, emulator, system image — no Android Studio GUI), and creates a set of AVDs across form factors.

Exits with code `0` when every step is ready and `1` whenever it prints `SETUP INCOMPLETE`. That is stricter than `doctor`, which passes a check that only warns: setup reports whether the work it was asked to do got done, not whether the Mac is usable.

On macOS, `setup ios` also installs the network filter that iOS network control needs — it asks
first, like every other install here. When the Mac has no approved extension yet, it also asks whether
to open the approval screen when macOS asks. Unless you decline that offer, an approval that takes
longer than two minutes still finishes the install: it waits for the switch. If you decline the install, or the Mac was set up before the filter shipped,
[`tapflow migrate net-filter`](#tapflow-migrate-net-filter) installs it on its own.

Installing it ends with a wait of up to thirty seconds for the filter to report itself running, so
that step can pause before it reports. When nothing reports, setup says so rather than showing the
step as done — see
[the same behaviour under `migrate net-filter`](#tapflow-migrate-net-filter).

setup only ensures a bootable device/AVD exists; the relay boots it on demand when a session opens. After it registers `ANDROID_HOME`/PATH, open a new terminal (or `exec $SHELL`) before running `tapflow doctor`.

| Option | Description |
|--------|-------------|
| `[platform]` | `ios` or `android`; omit to auto-detect |

See [Environment Setup](/guide/environment-setup) for the full workflow.


## `tapflow init`

Set this machine's tapflow up: `tapflow.config.json`, the `AGENTS.md` and `CLAUDE.md` a coding agent reads, and the credentials `.env` when you choose DNS auto-issue. Run it from anywhere — it writes to the install directory, `~/.tapflow` unless `TAPFLOW_HOME` or an install in the current directory says otherwise ([which install a command uses](/guide/configure#which-install-a-command-uses)). It creates the directory when it is missing.

Running it again keeps the configuration and refreshes the tapflow section of `AGENTS.md`, so an existing install can pick that up; pass `--force` to write a fresh configuration. `--tunnel` on an install that already has a configuration stops with an error instead, because keeping the configuration would ignore the flag.

If no tunnel flag is given and the terminal is interactive, a prompt guides you through tunnel selection. If you pick no tunnel, it also asks about streaming performance (HTTPS). On a machine with simulators or emulators it asks about Lean mode too, whichever tunnel you pick. The answers go to `tls` and `agent.lean` in the config. In a non-interactive environment with no `--tunnel` flag, a config file with no tunnel section is created.

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
# ✓ CONFIG CREATED
# Install dir: /Users/you/.tapflow (default)
# tapflow.config.json created.
# AGENTS.md created for your coding agent.
# Tunnel: tailscale
# → Next: tapflow start
```

Generating config with no tunnel (defaults):

```sh
tapflow init
# ✓ CONFIG CREATED
# → Next: tapflow start
```

Setting the install up somewhere else:

```sh
TAPFLOW_HOME=/var/lib/tapflow tapflow init
```


## `tapflow admin init`

Create the first admin account on the relay via CLI. Use this as a fallback on a server where a browser is not available.

The relay must be running before executing this command. It prompts for an email and a password, so it needs an interactive terminal; without one (in CI, for example) it exits with code `1`. The relay only creates the first account for a request from its own machine (localhost), so pointing `--relay` at a remote relay gets a `403`. Run it on the machine where the relay runs.

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

Starts the relay and agent together on the same Mac. This is the command for running tapflow on a single Mac. When no platform is available, it starts the relay alone.

```sh
tapflow start
```

| Option | Description |
|--------|-------------|
| `--platform <ios\|android\|all>` | Platform to start (default: auto-detect) |
| `--device <name>` | Limit which devices are exposed to the relay (default: all): iOS simulators by name or UDID, Android emulators by AVD name or device ID. The dashboard boots a device on demand. |

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
| `--port <n>` | `local.port` (default `4000`) | Port to listen on |
| `--tunnel <provider>` | — | `tailscale` or `rathole`. Stops with an error when `tapflow.config.json` has no `tunnel` section. The tunnel that starts is decided by the `tunnel` section whatever this value is, and a `tunnel` section starts it without this flag too. |

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

Put `TAPFLOW_TUNNEL_TOKEN` in the data directory's `.env` (`~/.tapflow/data/.env` by default), then:

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

Every `tunnel` key is listed under [Configuration](/reference/configuration#tunnel). See [Self-Hosting](/guide/self-hosting) for full setup instructions.


## `tapflow agent start`

Start the agent only and connect it to a relay. Does not start a local relay.

```sh
tapflow agent start --relay ws://192.168.x.x:4000 --token tflw_pat_xxxxxxxx
```

| Option | Default | Description |
|--------|---------|-------------|
| `--relay <url>` | `relay.url` in config, or `ws://localhost:4000` | Relay WebSocket URL. Omit if `relay.url` is set in `tapflow.config.json`. |
| `--platform <ios\|android\|all>` | auto-detect | Platform to start |
| `--device <name>` | all devices | Limit which devices are exposed to the relay: iOS simulators by name or UDID, Android emulators by AVD name or device ID |
| `--token <pat>` | `TAPFLOW_AGENT_TOKEN` env | Token with the `agent` scope, required by remote relays. See [Agent Setup](/guide/agent#remote-relay-authentication). |

`--relay` must start with `ws://` or `wss://`. A Mac runs one agent per platform: when an agent for the same platform is already running, it prints `AGENT ALREADY RUNNING` and exits. When no platform is available, it exits with code `1`.


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
  ● mac-mini-office  (iOS)
      ◉  iPhone 16 Pro   ← qa@company.com
      ○  iPhone 15

  1 agent(s) · 2 device(s) · 1 active session(s)
```


## `tapflow logs`

Show the recent log entries the relay keeps in memory (last 100 lines by default). Few events are recorded in this buffer. The relay's full log goes to the terminal it runs in.

The relay shows these logs only to the relay host, so run this command there. Pointed at a remote relay from another machine, it gets `403` and the CLI tells you what to run on the relay host instead. Under Docker, a CLI outside the container counts as remote too; use `docker compose logs`.

```sh
tapflow logs
```

| Option | Default | Description |
|--------|---------|-------------|
| `--relay <url>` | `http://localhost:<local.port>` (4000 by default) | URL of the relay on this machine. Set it when the relay runs on another port. `relay.url` is not read. |
| `--lines <n>` | `100` | Number of log lines to show (max 500) |

## `tapflow flow run`

Replay saved flow files with no LLM involved. See the [Flow Reference](/guide/writing-flows) for how to write them.

```sh
tapflow flow run .tapflow/flows/login-smoke.yaml
```

| Option | Default | Description |
|--------|---------|-------------|
| `--relay <url>` | `ws://localhost:4000` | Relay WebSocket URL. Does not read `relay.url`. |
| `--token <token>` | `TAPFLOW_TOKEN` env | Personal access token (PAT) for a remote relay. Needs an API-type token (`view, builds:write`). |
| `--session <id>` | — | Target session ID (from the MCP server's `list_devices`) |
| `--device <name>` | — | Target device by name. Boots it when it is shut down. |
| `--build <id>` | — | Build under test. Installed before the run and launched by the `launchApp` step. |
| `--no-install` | — | Run without installing `--build` |
| `--junit <path>` | — | Where to write a JUnit XML report |
| `--artifacts <dir>` | `.tapflow/artifacts` | Directory for failure screenshots |
| `--timeout <seconds>` | `10` | Default wait per selector (seconds) |

With neither `--session` nor `--device`, it uses the booted device when exactly one is booted. With none booted, or more than one, it stops with an environment error.

| Exit code | Meaning |
|-----------|---------|
| `0` | Every flow passed |
| `1` | At least one flow failed on a product problem |
| `2` | Environment or config error, or every failed flow failed on an environment problem |

## `tapflow migrate`

Run every migration this install still needs, after an upgrade.

```sh
tapflow migrate
```

It checks each migration below and lists the ones that apply:

- `data-dir`, when the install directory has a `.tapflow-data/` with data in it.
- `net-filter`, on macOS, when the iOS network filter is installed but older than this version of tapflow, or installed and not filtering. A Mac that never installed the filter is left alone, because the filter is optional.

In a terminal it shows the list and asks once. Without one (CI, a provisioning script) it prints the list and runs it without asking, the same as each subcommand does on its own. The `net-filter` step can still stop to ask about the macOS approval.

Migrations run in order, and the first one that fails stops the rest with exit code 1. Nothing to do exits 0. When both `.tapflow-data/` and `.tapflow/data/` exist, `data-dir` is reported and skipped, because only you can tell which one holds your data. `net-filter` is reported and skipped the same way when the filter app was deleted but its extension is still running; `tapflow doctor ios` explains that state.

`--ignore-running-devices` is not accepted here. Run `tapflow migrate net-filter --ignore-running-devices` for that.

## `tapflow migrate data-dir`

Move a legacy `.tapflow-data/` into the unified `.tapflow/data/` layout. Run this once after upgrading; it is idempotent and safe to re-run.

Stop the relay first. If something is listening on the relay's port (`local.port`, or `TAPFLOW_PORT`), the command refuses and moves nothing: a relay running during the move would put later uploads back into `.tapflow-data/`. A relay started on another port with `tapflow relay start --port` is not detected, so stop that one yourself.

```sh
tapflow migrate data-dir
```

What it does:

- Atomically renames `.tapflow-data/` → `.tapflow/data/` — a single filesystem rename, no copy and no half-moved state.
- Repoints `local.dataDir` in `tapflow.config.json` when it still pins the old default `.tapflow-data`. A custom path is left untouched.
- Adds `.tapflow/data/` and `.tapflow/artifacts/` to `.gitignore` so the moved secrets stay out of git.

Existing installs keep working without running this — a pinned `local.dataDir` is honored, and a config-less default install keeps reading `.tapflow-data/`. If the two paths are on different filesystems, or both already exist, the command stops and prints the manual step instead of guessing. The config is rewritten before the move and put back if the move fails; if it cannot be put back, the command prints the value to set it back to.

## `tapflow migrate net-filter`

Install the iOS network filter on a Mac that was set up before tapflow shipped it. macOS only.

```sh
tapflow migrate net-filter
```

`tapflow setup ios` also installs the filter, but setup is the command you run to prepare a new
machine. A Mac that is already configured has no reason to run it again, so the extension would
arrive in `node_modules` and never reach the Mac. This is the command for that — and for a `setup`
run where you declined the filter.

It copies the signed extension that came with `@tapflowio/ios-agent` into `/Applications` and asks
macOS to activate it. Approving it is a step you take at that Mac, in **System Settings → General →
Login Items & Extensions → Network Extensions**; macOS offers no command-line equivalent, so the
command tells you when it is waiting on you.

**It offers the approval screen before installing, and opens it during the wait.** When no tapflow
extension is `[activated enabled]`, macOS is going to ask, so in an interactive terminal the command
asks first whether to open the approval screen when it does. The question also says that switching
the filter on can drop connections this Mac already has open, SSH sessions included. Say yes and the
screen opens as soon as `systemextensionsctl list` shows the request `waiting for user`. macOS does
not show its own prompt again for a request already waiting, so on a rerun this is the only pointer
there is. The device check runs after this question. Pressing Ctrl-C or Esc at it stops the command
with nothing installed.

**A late approval still finishes in the same run.** The install waits up to two minutes for approval
and ends there if the entry is switched on in time. Otherwise the command waits up to two more
minutes, and if the entry is switched on then, it switches the filter on and confirms it is running.
If it did not ask up front, because macOS was not expected to ask (replacing an approved extension,
for instance), it asks at this point. If macOS asks whether to allow tapflow to filter network
content when the filter goes on, allow it.

**It never says the screen opened.** The command has no way to know whether a window appeared, so it
shows the path alongside. If nothing appears, go there by that path.

**When the command switches the filter on itself, it checks for devices again first**, because
someone may have booted a simulator during the extra wait. If it finds one, it stops without
switching the filter on and says so if the filter is left off. With `--ignore-running-devices` it
does not check again. An approval within the first two minutes lets the extension switch the filter
on by itself, so on that path the only device check is the one when the install starts.

Outside an interactive terminal it does not ask; it counts as interactive only when stdin and
stdout are both terminals. There, and when you decline, it ends waiting for approval unless you
approve it yourself within the first two minutes, and a declined offer is not repeated. The same
happens when the entry is not switched on within the extra two minutes. It then tells you to approve
the extension and run the command again. That run switches the filter on.

It **refuses to replace a filter newer than the one it carries**. `/Applications` holds one copy for
the whole Mac while each install judges it by its own dependencies, so an older checkout would
otherwise downgrade the filter a newer agent depends on.

It **refuses while devices are in use.** Replacing the filter interrupts new connections on the Mac
while it happens, and the people affected are not necessarily the person at the keyboard. Booted
simulators, attached emulators and a relay serving on `:4000` all count. The command names what it
found and stops.

```sh
tapflow migrate net-filter --ignore-running-devices
```

That replaces it anyway. The flag belongs to `net-filter`; `tapflow migrate data-dir` rejects it
rather than ignoring it.

**The replace switches the filter off first, then back on.** A content filter sits in front of every
new connection on the Mac, not only the simulator's, and when it stops while it is still switched on
macOS blocks all of them rather than letting anything through unchecked. New connections fail
immediately with `No route to host`. Taking the filter out of the path first means that state never
happens.

It goes off **before the app is copied into `/Applications`**, not only before the extension is
activated, because both steps stop the filter: copying the app makes macOS restart the filter session
on its own timing. It goes off again after the copy, from the binary that was just copied, which is
the one that gates the activation.

If the command fails partway it says whether the filter was left off. The Mac's network works in that
state and iOS network control does not; running the command again turns it back on.

**It waits for the filter to report itself running before saying it worked.** macOS answers "not
refused" rather than "working" when an extension is installed — the configuration reaches the filter
afterwards, with nothing coming back — so the command watches for up to thirty seconds and leaves as
soon as a filter appears. `tapflow setup ios` does the same when it installs the filter.

When none appears the command says so and **exits non-zero**, because that state is the one where the
configuration is switched on and nothing is answering for it. Usually the filter is simply still
starting, and `tapflow doctor ios` will say so a moment later. If new connections on the Mac have
stopped working, see [Troubleshooting](/guide/troubleshooting#network-lost-on-replace) — the remedy is
to take the filter out of the path with `--off`.

Run `tapflow doctor ios` afterwards to confirm what the Mac ended up with.
