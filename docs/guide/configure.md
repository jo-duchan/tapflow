# Configuring tapflow

`tapflow init` interactively generates `tapflow.config.json`. Depending on the options you choose and whether you're in a git repo, it can also scaffold the credentials `.env` file and update `.gitignore`. If the defaults (port 4000, no tunnel, HTTP) are fine, skip this step and go straight to `tapflow start`.

## Run tapflow init

Run it from the directory where the relay will start.

```sh
tapflow init
```

The command can create up to three things.

| Output | Contents |
|--------|----------|
| `tapflow.config.json` | Relay configuration. Holds the port, tunnel, and HTTPS settings you choose. |
| `.tapflow-data/.env` | Holds DNS / ACME credentials. Created only when you pick DNS auto-issue. |
| `.gitignore` entry | Adds `.tapflow-data/` when run inside a git repo, so runtime data and tokens are never committed. |

The interactive prompts then appear in order. You pick a tunnel first; the streaming and certificate prompts only show when you run on the LAN with no tunnel.

```text
1. Tunnel              None · Tailscale · rathole
2. Streaming           Only when tunnel is None — Standard (HTTP) · Smooth (HTTPS)
3. Certificate         Only when Smooth is chosen — DNS auto-issue · Existing cert
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
To set the tunnel without prompts, pass a flag: `tapflow init --tunnel tailscale` or `tapflow init --tunnel rathole`. Use `--force` to overwrite an existing file.
:::

## 2. Streaming performance (LAN only)

This step appears only when you pick **None** for the tunnel. It sets the quality teammates on the same LAN stream at.

| Choice | Meaning |
|--------|---------|
| **Standard** | Starts instantly over HTTP. Uses software decode and needs no domain. |
| **Smooth** | Turns on hardware decode (WebCodecs) over HTTPS. Smoother, but needs a domain. |

Browser hardware decoding runs only in a secure context (HTTPS), so to give teammates a smoother, more responsive stream, choose **Smooth** and set up HTTPS. How each choice maps to the actual resolution and decoder is explained in [Streaming Quality](/guide/streaming).

::: info This step is skipped when you pick a tunnel
A tunnel handles HTTPS at its own layer, so this step only appears for a direct LAN connection. rathole terminates TLS with Caddy on the VPS; Tailscale terminates it with `tailscale serve` (free, optional). The relay needs no `tls` config either way. For the per-tunnel HTTPS setup, see [Self-Hosting the Relay](/guide/self-hosting#external-access).
:::

## 3. Certificate method (when Smooth is chosen)

If you turn on HTTPS, choose how the certificate is provided.

| Choice | Meaning |
|--------|---------|
| **DNS auto-issue** | Auto-issues and renews a Let's Encrypt certificate with a Cloudflare or Vercel API token. Just enter your domain. |
| **Existing certificate (import)** | Point to an internal PKI or a certificate file you already hold. You manage renewal yourself. |

When you choose DNS auto-issue, you select a provider and enter a domain, and a `.tapflow-data/.env` for the token is scaffolded alongside. The full reference for issuance modes and config keys is in [Configuration — HTTPS](/reference/configuration#https-secure-context).

## .tapflow-data/.env — holding secrets

`.tapflow-data/.env` is the **default home for every relay secret**. Choosing DNS auto-issue makes `init` scaffold an empty template for the token, but this file holds more than DNS tokens — `JWT_SECRET`, the SMTP password, and any other secret go here too, one per line. Secrets stay out of `tapflow.config.json` and live in this gitignored file instead.

Paste each value after the `=`.

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

After `tapflow init` finishes, your working directory looks like this.

```text
your-directory/
  tapflow.config.json    ← relay configuration
  .gitignore             ← .tapflow-data/ entry added
  .tapflow-data/
    .env                 ← only when DNS auto-issue is chosen
```

Every key in `tapflow.config.json` and its environment-variable overrides are detailed in [Configuration](/reference/configuration).

## Next step

Once configured, start the relay and agent.

```sh
tapflow start
```

For how to start in each deployment scenario (single Mac, separate server, tunnel), see [Self-Hosting the Relay](/guide/self-hosting).
