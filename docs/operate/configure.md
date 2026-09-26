# Configuring tapflow

`tapflow init` sets up this machine's tapflow: it writes `tapflow.config.json`, the agent documentation files, and, when you choose DNS auto-issue, the credentials `.env`. If the defaults (port 4000, no tunnel, HTTP) are fine, skip this step and go straight to `tapflow start`.

## Run tapflow init

Run it from anywhere. tapflow keeps one install per machine, in `~/.tapflow` by default, and every command finds it the same way.

```sh
tapflow init
```

The command can create up to five things, all inside the install directory.

| Output | Contents |
|--------|----------|
| `tapflow.config.json` | Relay configuration. Holds the port, tunnel, HTTPS settings you choose, the data directory, and Lean mode for this machine's agent. |
| `AGENTS.md` | A tapflow section for coding agents, between `<!-- tapflow:begin -->` markers. Anything you write outside them is kept when you run `init` again. |
| `CLAUDE.md` | One line, `@AGENTS.md`, for Claude Code. Written only when the install directory is tapflow's own — in a directory that is also something else, such as an app repository an older install lives in, a `CLAUDE.md` would stop Claude Code reading that repository's other `AGENTS.md` files. |
| `data/.env` | Holds DNS / ACME credentials. Created only when you pick DNS auto-issue. |
| `.gitignore` entry | Adds the data directory and `/.tapflow/artifacts/` when the install directory is inside a git repository, so runtime data and tokens are never committed (`.tapflow/flows/` stays tracked). |

Running `init` again keeps your configuration and refreshes only the tapflow section of `AGENTS.md`. Pass `--force` to write a fresh configuration.

The interactive prompts then appear in order. You pick a tunnel first; the streaming and certificate prompts only show when you run on the LAN with no tunnel, and the Lean mode prompt only where there is a simulator or emulator to make lean.

```text
1. Tunnel              None · Tailscale · rathole
2. Streaming           Only when tunnel is None — Standard (HTTP) · Smooth (HTTPS)
3. Certificate         Only when Smooth is chosen — DNS auto-issue · Existing cert
4. Lean mode           On a Mac, or where adb is installed — Off · On
```

## 1. Pick a tunnel

This decides how teammates reach the relay.

| Choice | Meaning |
|--------|---------|
| **None** | Reachable on the same LAN only. This is the default. |
| **Tailscale** | External access over an encrypted overlay network. No VPS required. |
| **rathole** | A fully public URL through a VPS you own. |

Each tunnel's setup steps and prerequisites are covered in [Self-Hosting the Relay](/guide/self-hosting#external-access).

::: tip Non-interactive environments (CI)
To set the tunnel without prompts, pass a flag: `tapflow init --tunnel tailscale` or `tapflow init --tunnel rathole`. Use `--force` to overwrite an existing file; without it, `--tunnel` on a configured install stops rather than ignoring the flag. `--tunnel rathole` writes `tunnel.serverAddr` and `tunnel.publicUrl` as empty values, and every `tapflow` command fails config validation until both are filled in, so fill them in `tapflow.config.json` right away.
:::

## 2. Streaming performance (LAN only)

This step appears only when you pick **None** for the tunnel. It sets the quality teammates on the same LAN stream at.

| Choice | Meaning |
|--------|---------|
| **Standard** | Starts instantly over HTTP. Uses software decode and needs no domain. |
| **Smooth** | Turns on hardware decode (WebCodecs) over HTTPS. Smoother, but needs a domain. |

Browser hardware decoding runs only in a secure context (HTTPS), so to give teammates a smoother, more responsive stream, choose **Smooth** and set up HTTPS. How each choice maps to the actual resolution and decoder is explained in [Streaming Quality](/operate/streaming-quality).

::: info This step is skipped when you pick a tunnel
A tunnel handles HTTPS at its own layer, so this step only appears for a direct LAN connection. rathole terminates TLS with Caddy on the VPS; Tailscale terminates it with `tailscale serve` (free, optional). The relay needs no `tls` config either way. For the per-tunnel HTTPS setup, see [Self-Hosting the Relay](/guide/self-hosting#external-access).
:::

## 3. Certificate method (when Smooth is chosen)

If you turn on HTTPS, choose how the certificate is provided.

| Choice | Meaning |
|--------|---------|
| **DNS auto-issue** | Auto-issues and renews a Let's Encrypt certificate with a Cloudflare or Vercel API token. Just enter your domain. |
| **Existing certificate (import)** | Point to an internal PKI or a certificate file you already hold. You manage renewal yourself. |

When you choose DNS auto-issue, you select a provider and enter a domain, and a `.env` for the token is scaffolded in the data directory. The full reference for issuance modes and config keys is in [Configuration — HTTPS](/reference/configuration#https-secure-context).

## 4. Lean mode

This decides whether the simulators and emulators your agent boots run lighter.

| Choice | Meaning |
|--------|---------|
| **Off** | Simulators run every background service. This is the default. |
| **On** | On iOS, a fixed list of background services is turned off while tapflow runs the simulator; measured on iOS 27, each simulator uses about a quarter less memory. On Android, four bundled Google apps are kept disabled; measured on API 34, each emulator uses a little under a fifth less. |

The answer is saved as `agent.lean` in `tapflow.config.json`, and you can change it there later. What turns off, what stays on and when it applies are listed in [Configuration — Lean mode](/reference/configuration#lean-mode-agent).

## The data directory's .env — holding secrets

`<data directory>/.env` — `~/.tapflow/data/.env` on a default install — is the **default home for every relay secret**. Choosing DNS auto-issue makes `init` scaffold an empty template for the token, but this file holds more than DNS tokens — `JWT_SECRET`, the SMTP password, and any other secret go here too, one per line. Secrets stay out of `tapflow.config.json` and live in this gitignored file instead.

The file `init` creates holds only the token lines for the DNS provider you chose. Add a line for any other secret, as in the example below, and paste each value after the `=`.

```ini
# tapflow secrets — do not commit. Paste each value after the =.
TAPFLOW_CLOUDFLARE_TOKEN=
JWT_SECRET=
SMTP_PASS=
```

| Aspect | Detail |
|--------|--------|
| What goes in | Any relay secret — DNS provider tokens (`TAPFLOW_CLOUDFLARE_TOKEN` / `TAPFLOW_VERCEL_TOKEN`), `JWT_SECRET`, `SMTP_PASS`, and so on. |
| When it's read | The relay reads it first thing on start, before applying any other setting. |
| Permissions | Created with `0600` so only the owner can read it. |
| Precedence | **Shell env > `.env` > `tapflow.config.json`.** A shell variable set for the same key overrides the file value. |

`TAPFLOW_DATA_DIR` is the one exception: it decides where `.env` lives (`<dataDir>/.env`), so it can't be read from `.env`. Set the data directory in `tapflow.config.json` or the shell instead.

This way you don't re-export secrets every time you restart the relay. Put them in the file once, and the relay reads them on boot — handy for long-running setups under PM2 or launchd.

## What gets created

After `tapflow init` finishes, the install directory looks like this.

```text
~/.tapflow/
  tapflow.config.json    ← relay configuration
  AGENTS.md              ← tapflow section for coding agents
  CLAUDE.md              ← @AGENTS.md
  data/                  ← relay runtime state: db, uploads, secrets
    .env                 ← only when DNS auto-issue is chosen
```

The relay fills `data/` in on first start.

## What lives where

Flow files are not part of the install. They belong to your app repository, next to the code they test.

```text
~/.tapflow/              ← this machine: one install, whatever you run
  tapflow.config.json
  data/                  ← database, uploaded builds, secrets

your-app/                ← your repository: reviewed, committed, run in CI
  .tapflow/
    flows/               ← the flow YAML you commit
    artifacts/           ← failure screenshots from `tapflow flow run` (gitignored)
```

The line between them is how each side comes back. The repository half is restored by `git clone`; the machine half from a backup, because a database, uploaded builds and a signing key cannot be committed. Flow files also have to be in the repository for CI to run them at all — a runner checks out your app, not your home directory.

Uploaded builds are the part that grows, and on a Mac they sit inside your home directory, so Time Machine backs them up with everything else. Set `TAPFLOW_HOME` to put the install somewhere else — `/var/lib/tapflow` on a server, as the [systemd example](/guide/self-hosting#systemd-linux-relay-server) does.

## Which install a command uses

Every command answers this the same way, in this order:

| | Install directory |
|---|---|
| `TAPFLOW_HOME` is set | that directory |
| the current directory is already an install — it holds a `tapflow.config.json`, or a `.tapflow/data` or `.tapflow-data` with data in it | the current directory |
| otherwise | `~/.tapflow` |

The second rule is what keeps an install created before tapflow had a home working exactly where it is. `tapflow start` and `tapflow relay start` print the directory, the configuration file and the data directory they resolved, so you can always see which one is in use.

Set `TAPFLOW_HOME` for a server or a second install: `TAPFLOW_HOME=/var/lib/tapflow tapflow init` creates that directory, and every later command that carries the same variable uses it. A `TAPFLOW_HOME` naming a directory that does not exist stops any command that runs the relay, as well as `agent start`, `status`, `logs` and `admin init`, rather than quietly starting an empty install somewhere else.

Data lives at `<install>/data` on a new install. An install that already has `.tapflow/data` or `.tapflow-data` keeps reading it, and `init` writes whichever one it found into `local.dataDir`, so the layout cannot change under you later.

Every key in `tapflow.config.json` and its environment-variable overrides are detailed in [Configuration](/reference/configuration).

## Asking a coding agent about tapflow

`init` writes an `AGENTS.md` into the install directory with a tapflow section between `<!-- tapflow:begin -->` and `<!-- tapflow:end -->`. It tells a coding agent to answer from [the documentation index](https://www.tapflow.dev/llms.txt) rather than from memory, how to read any page as markdown, which files hold this install's secrets, and to compare `tapflow --version` against the changelog. Open your agent in that directory (`cd ~/.tapflow`) and it can also read your configuration and run `tapflow doctor`, `tapflow status` and `tapflow logs`.

Write your own notes outside the markers — `init` replaces only what is between them.

Claude Code reads `AGENTS.md` directly. A session that cannot (an older version, a third-party provider such as Amazon Bedrock, or telemetry turned off) reads `CLAUDE.md` instead, which is why `init` writes one containing `@AGENTS.md`. If your install directory already has a `CLAUDE.md`, add that line to it yourself; `init` says so rather than editing a file you wrote.

## Next step

Once configured, start the relay and agent.

```sh
tapflow start
```

For how to start in each deployment scenario (single Mac, separate server, tunnel), see [Self-Hosting the Relay](/guide/self-hosting).
