# Configuring tapflow

`tapflow init` interactively generates `tapflow.config.json`, and scaffolds the `.env` file that holds your credentials along with a `.gitignore` entry. If the defaults (port 4000, no tunnel, HTTP) are fine, skip this step and go straight to `tapflow start`.

## Run tapflow init

Run it from the directory where the relay will start.

```sh
tapflow init
```

The command creates three things.

| Output | Contents |
|--------|----------|
| `tapflow.config.json` | Relay configuration. Holds the port, tunnel, and HTTPS settings you choose. |
| `.tapflow-data/.env` | Holds DNS / ACME credentials. Created only when you opt into automatic HTTPS issuance. |
| `.gitignore` entry | Adds `.tapflow-data/` so runtime data and tokens are never committed. |

The interactive prompts then appear in order. You pick a tunnel first; the streaming and certificate prompts only show when you run on the LAN with no tunnel.

```text
1. Tunnel              None · Tailscale · rathole
2. Streaming           Only when tunnel is None — Standard (HTTP) · High (HTTPS)
3. Certificate         Only when High is chosen — DNS auto-issue · Existing cert
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
| **High performance** | Turns on hardware decode (WebCodecs) over HTTPS. Smoother, but needs a domain. |

Browser hardware decoding runs only in a secure context (HTTPS), so to give teammates a sharper, smoother stream, choose **High performance** and set up HTTPS. How each choice maps to the actual resolution and decoder is explained in [Streaming Quality](/guide/streaming).

::: info This step is skipped when you pick a tunnel
Tailscale and rathole handle HTTPS at the tunnel layer — Tailscale with its own certificate, rathole with Caddy terminating TLS on the VPS. So the relay terminates HTTPS itself only on a direct LAN connection, which is why this step is asked only then.
:::

## 3. Certificate method (when High performance is chosen)

If you turn on HTTPS, choose how the certificate is provided.

| Choice | Meaning |
|--------|---------|
| **DNS auto-issue** | Auto-issues and renews a Let's Encrypt certificate with a Cloudflare or Vercel API token. Just enter your domain. |
| **Existing certificate (import)** | Point to an internal PKI or a certificate file you already hold. You manage renewal yourself. |

When you choose DNS auto-issue, you select a provider and enter a domain, and a `.tapflow-data/.env` for the token is scaffolded alongside. The full reference for issuance modes and config keys is in [Configuration — HTTPS](/reference/configuration#https-secure-context).

## .tapflow-data/.env — holding credentials

When you choose DNS auto-issue, `init` scaffolds an `.env` file as an empty template for the token. Tokens are secrets, so they stay out of `tapflow.config.json` and live in this gitignored file instead.

The file is created with key names only and empty values. Paste the token you obtained after each `=`.

```ini
# tapflow DNS/ACME credentials — do not commit. Paste each token after the =.
TAPFLOW_CLOUDFLARE_TOKEN=
```

| Aspect | Detail |
|--------|--------|
| What goes in | The API token for your chosen DNS provider. Cloudflare uses `TAPFLOW_CLOUDFLARE_TOKEN`, Vercel uses `TAPFLOW_VERCEL_TOKEN` (plus `TAPFLOW_VERCEL_TEAM_ID` for a team domain). |
| When it's read | The relay reads it on start and uses it for certificate issuance. |
| Permissions | Created with `0600` so only the owner can read it. |
| Precedence | A shell environment variable set for the same key overrides the file value. |

This way you don't re-export the token every time you restart the relay. Put it in the file once, and the relay reads it on boot.

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
