<div align="center">
  <img src="https://raw.githubusercontent.com/jo-duchan/tapflow/main/docs/public/logo-hero.svg" height="72" alt="tapflow" />

  <h3>A self-hosted Appetize / BrowserStack alternative for mobile QA teams</h3>

  <p>
    Run iOS simulators and Android emulators in any browser — no toolchain setup, no device pool, no cloud uploads.<br />
    Your builds, streams, and recordings stay on infrastructure you control.
  </p>

  <p>
    <strong>No WebDriverAgent</strong>
    &nbsp;·&nbsp;
    <strong>2-line setup</strong>
    &nbsp;·&nbsp;
    <strong>MIT</strong>
  </p>

  <p>
    <a href="https://github.com/jo-duchan/tapflow/stargazers"><img src="https://img.shields.io/github/stars/jo-duchan/tapflow" alt="GitHub stars" /></a>
    <a href="https://hub.docker.com/r/tapflow/tapflow"><img src="https://img.shields.io/docker/pulls/tapflow/tapflow" alt="Docker pulls" /></a>
    <a href="https://github.com/jo-duchan/tapflow/releases"><img src="https://img.shields.io/github/v/release/jo-duchan/tapflow?include_prereleases&sort=semver" alt="Latest release" /></a>
    <a href="https://github.com/jo-duchan/tapflow/commits/main"><img src="https://img.shields.io/github/last-commit/jo-duchan/tapflow" alt="Last commit" /></a>
    <img src="https://img.shields.io/badge/platform-macOS%20agent-lightgrey" alt="macOS Agent" />
  </p>

  <p>
    <a href="https://www.tapflow.dev">📖 Docs</a>
    &nbsp;·&nbsp;
    <a href="https://www.tapflow.dev/get-started/quick-start">🚀 Quick Start</a>
    &nbsp;·&nbsp;
    <a href="https://www.tapflow.dev/get-started/introduction">🎥 Demo</a>
    &nbsp;·&nbsp;
    <a href="https://www.tapflow.dev/operate/environment-setup#tapflow-setup">🎬 Setup</a>
  </p>
</div>

<!-- readme-sync:exempt npm-has-no-video -->
<div align="center">
  <a href="https://github.com/user-attachments/assets/dbba8bde-74b6-4fb9-bdb6-3919bc4295c4" target="_blank" rel="noopener noreferrer">
    <img src="https://raw.githubusercontent.com/jo-duchan/tapflow/main/docs/public/demo-thumbnail.png" alt="tapflow demo — click to play" width="100%" />
  </a>
  <p><em>Click to play</em></p>
</div>
<!-- /readme-sync:exempt -->

<p align="center"><em>Streams over H.264 with a zero-buffer decoder (no MSE) — <a href="https://github.com/jo-duchan/tapflow/blob/main/contributing/streaming-latency-log.md">latency measurements ↗</a></em></p>

> **v0.x, actively developed** — backward-compatible by default; breaking changes are rare and always noted in the [changelog](https://github.com/jo-duchan/tapflow/blob/main/CHANGELOG.md). [Roadmap →](https://github.com/jo-duchan/tapflow/blob/main/ROADMAP.md)

---

## Why tapflow?

Mobile QA usually depends on access to simulators, emulators, or physical devices — and that access is uneven across a team.

For mobile developers it means opening Xcode or Android Studio on a Mac. For everyone else, it often means asking a mobile developer every single time:

> **Backend developer** — "How do I install the sandbox build to check what was deployed?"
>
> **Product manager** — "I keep installing and removing versions just to compare behavior."
>
> **Designer** — "I need to check the layout across screen sizes, but I don't have the right devices."

Physical devices add their own overhead — OS-version coverage, availability, charging, storage, handoff. Cloud simulator services solve access, but they require uploading internal builds to a third-party service and paying for remote devices while your own Macs can already run the same simulators.

We hit this exact problem, so we built tapflow.

| Solution | The catch |
|----------|-----------|
| Appetize / BrowserStack | Recurring cost — and app builds are uploaded to a third-party cloud |
| Physical devices | Cost, availability, OS coverage, management overhead |
| Xcode / Android Studio | Each teammate needs a Mac and a full mobile toolchain |
| **tapflow** | Reuse your own Macs — data stays on infrastructure you control, and the whole team does QA from a browser |

## How it works

tapflow connects three parts:

1. A **self-hosted relay** (Linux or Mac) — also serves the dashboard on the same port, so there's no separate web server.
2. A **macOS agent** that drives the iOS Simulator and Android emulator — it connects *outbound* to the relay (no inbound firewall rules) and injects iOS touch directly, without WebDriverAgent.
3. A **browser dashboard** for the rest of the team — pick an available device and interact with it in real time while the simulators keep running on your Macs.

```text
Browser (your team)  ←─ WebSocket ─→  Relay Server  ←─ WebSocket (outbound) ─→  Mac Agent
                                    (Linux / Mac)                           (iOS · Android)
```

## What tapflow is not

tapflow doesn't replace native mobile development tools. Mobile developers still use Xcode, Android Studio, and their build tooling. tapflow makes the *running* simulators and emulators accessible to the rest of the team through a browser, and it is not a device farm. It does have an automated QA axis — a deterministic flow runner and an MCP server for LLM agents — but wiring in external automation frameworks like WebDriverAgent or Appium is out of scope; tapflow ships its own minimal runner instead.

Where this is heading is laid out in [VISION.md](https://github.com/jo-duchan/tapflow/blob/main/VISION.md): growing manual QA into automation, only when you need it.

## Quick Start

### 1. Install

```sh
npm install -g tapflow
# or: yarn global add tapflow  |  pnpm add -g tapflow
```

### 2. Set up the environment

On the Mac that will run an agent, install the simulator/emulator prerequisites in one step:

```sh
tapflow setup
```

Skip this on a relay-only server (Linux). See [Environment Setup](https://www.tapflow.dev/operate/environment-setup) for details.

### 3. Start relay + agent

```sh
tapflow start
# ✓ Relay started on http://localhost:4000
# ✓ iOS Agent connected (3 simulators available)
```

This starts both the relay and the agent on the same Mac (local mode).

### 4. Create the first admin account

Open `http://localhost:4000` in your browser. tapflow redirects you to `/setup` to create the admin account.

> **Headless server?** Use `tapflow admin init` to create the admin account via CLI instead.

### 5. Open the dashboard

Navigate to `http://localhost:4000` and sign in with the account you just created.

> **Having issues?** Run `tapflow doctor` to re-check prerequisites at any time.

## Requirements

| Component | Requirements |
|-----------|-------------|
| **Relay server** | Node.js ≥ 22, any OS (Linux/macOS), ~512 MB RAM |
| **iOS Agent** | macOS 26 or 27, Xcode 26 or 27 + iOS Simulator runtime (or run `tapflow setup ios`), Node.js ≥ 22 |
| **Android Agent** | macOS, Java + Android SDK with an AVD (or run `tapflow setup android`), Node.js ≥ 22 |
| **Browser (QA)** | Any modern browser — Chrome, Firefox, Safari, Edge |

> Agents run on **macOS only** (they drive the iOS Simulator and Android emulator on a Mac). The relay runs anywhere.

## Features

- **No mobile toolchain for QA users** — teammates test from a browser without installing Xcode, Android Studio, or local simulator tooling.
- **Self-hosted by default** — no third-party cloud and no external accounts; everything runs on hardware you already own.
- **Use your existing Mac setup** — run agents on Macs that already have the iOS Simulator or Android emulator available.
- **API-first** — REST endpoints and Personal Access Tokens support CI/CD and AI-agent workflows.

What's included:

- **Browser streaming** — iOS & Android at ~30 fps, no extra app on the device. Both stream H.264 through a 2-tier decoder (WebCodecs on secure contexts, WASM/tinyh264 on plain HTTP), which removes the media-element buffer from the decode path. Resolution adapts to the connection — native on a secure context, downscaled on plain-HTTP LAN.<sup>[1](#latency-note)</sup>
- **Codec fallback** — the stream negotiates the codec per client and falls back to JPEG when a hardware or WASM decoder isn't available, so older browsers still work.
- **Touch, swipe & pinch** — real-time input forwarded to the simulator or emulator.
- **Deeplink toolbar** — open supported deeplinks directly from the QA toolbar.
- **Keyboard shortcuts** — trigger simulator toolbar actions from the keyboard.
- **Clipboard sync** — copy and paste between your Mac and the device, in both directions. Copying *from* the device needs the dashboard on HTTPS or localhost; over plain HTTP the text lands on the device's own clipboard and the dashboard says so.
- **Device audio** — the app's sound comes back to the browser tab.
- **Network control** — take a device off the network and put it back, to test how the app behaves offline. iOS installs a network filter once; Android needs nothing.
- **App Center** — upload `.app.zip` / `.apk` and track builds by status (Backlog / In Progress / Done / Rejected).
- **Session recordings** — record and share QA sessions, kept on the relay for ~72 hours, then purged automatically.
- **Screenshot REST endpoint** — `GET /api/v1/sessions/:sessionId/screenshot` for CI and AI agents.
- **Mac resource monitoring** — CPU & RAM per agent, to spot overloaded hosts before assigning sessions.
- **Team management** — invite links, roles (Admin / Developer / QA / Viewer), and Personal Access Tokens.
- **Flow runner** — `tapflow flow run` replays a YAML flow with condition-based waits and a JUnit report, and calls no LLM at replay time. Experimental.
- **MCP Server** — `@tapflowio/mcp-server` lets Claude Code and other LLM agents control simulators as native tools. Experimental.

<span id="latency-note"></span>
> <sup>1</sup> On a real LAN, decode-to-present measures in the low tens of milliseconds (p50 ~11–17 ms with the WASM software decoder; faster with WebCodecs on HTTPS); end-to-end "glass-to-glass" latency adds your network's round trip on top. See the [streaming latency log](https://github.com/jo-duchan/tapflow/blob/main/contributing/streaming-latency-log.md) for the full measurements, conditions, and known limitations.

## Security & Privacy

tapflow is self-hosted by design — build files, device streams, and session recordings stay on infrastructure you control, never sent to a third-party service.

| Data | Where it stays |
|------|----------------|
| App binaries (`.app.zip` / `.apk`) | Relay storage |
| Device streams (video · touch) | The relay ↔ browser path you host |
| Session recordings | Relay storage; expire after 72h, then purged |
| Account & team data | The relay's SQLite DB |
| Third-party simulator cloud | Not required |

- **LAN-first** — the agent ↔ relay leg is internal traffic; the device stream never transits a third party.
- **The relay is the trust boundary** — it holds accounts, builds and live device control, so whoever can reach it is who you are exposing. The agent only dials out.
- **Authenticated by default off-host** — the relay accepts unauthenticated connections only from its own machine (`localhost`). Browsers reaching it from elsewhere sign in; agents on another machine present an `agent`-scope token. Traffic through a tunnel counts as off-host, even though the tunnel client runs on the relay's machine.
- **PAT + roles** — Personal Access Tokens carry scopes (`builds:write` for CI uploads, `agent` for remote agents), and team roles (Admin / Developer / QA / Viewer) govern dashboard access.

Found a vulnerability? See [SECURITY.md](https://github.com/jo-duchan/tapflow/blob/main/SECURITY.md). For the full model, read [Security & Privacy](https://www.tapflow.dev/reference/security).

## Self-Hosting

A single Mac needs nothing beyond `tapflow start` (see [Quick Start](#quick-start)). For a team, run the relay on a separate Linux server or dedicated Mac, and point each Mac agent at it.

**Relay server:**

```sh
# Recommended: PM2 for automatic restarts
npm install -g pm2 tapflow
JWT_SECRET=$(openssl rand -hex 32) pm2 start tapflow --name relay -- relay start
pm2 save && pm2 startup
```

**Or run the relay with Docker:**

```sh
docker run -d -p 4000:4000 -v "$PWD/data:/app/.tapflow/data" tapflow/tapflow:latest
```

> The image is the relay only — agents stay on your Macs. The volume is required (it holds the sign-in secret), and invite links need `TAPFLOW_RELAY_URL`. See [Docker Compose](https://www.tapflow.dev/operate/docker) for the full setup.

**Each Mac agent:**

```sh
tapflow agent start --relay wss://your-relay-url --token <agent-token>
```

> A relay on a different machine accepts an agent only with an `agent`-scope token — create one in **Settings → Tokens** (Admin only). Agents on the relay's own machine (`tapflow start`) need no token. See [Remote relay authentication](https://www.tapflow.dev/operate/agents#remote-relay-authentication).
>
> For nginx / Caddy reverse proxy setup and external access, see [External access](https://www.tapflow.dev/operate/external-access).

## CLI Reference

| Command | Description |
|---------|-------------|
| `tapflow start` | Start relay + agent together (local mode) |
| `tapflow relay start` | Start relay only |
| `tapflow agent start --relay <url> [--token <pat>]` | Start agent and connect to a relay (remote relays need an `agent`-scope token) |
| `tapflow init` | Configure this machine's tapflow (`~/.tapflow` by default) |
| `tapflow admin init` | Create the first admin account (CLI fallback) |
| `tapflow doctor [platform]` | Diagnose prerequisites (Node, iOS, Android) |
| `tapflow setup [platform]` | Install & configure the local environment |
| `tapflow devices` | List available simulators and emulators |
| `tapflow boot <name\|udid>` | Boot a simulator or emulator |
| `tapflow status` | Show connected agents, devices, active sessions |
| `tapflow reset` | Shut down all simulators and emulators |
| `tapflow logs` | Show recent relay log entries (run on the relay host) |

Full reference → [CLI docs](https://www.tapflow.dev/reference/cli)

## Documentation

Full docs: **[www.tapflow.dev](https://www.tapflow.dev)**

- **Guides** — [Quick Start](https://www.tapflow.dev/get-started/quick-start) · [Environment Setup](https://www.tapflow.dev/operate/environment-setup) · [Self-Hosting](https://www.tapflow.dev/operate/deployment) · [Uploading Builds (CI/CD)](https://www.tapflow.dev/testing/app-center) · [Troubleshooting](https://www.tapflow.dev/troubleshooting)
- **Reference** — [CLI](https://www.tapflow.dev/reference/cli) · [Configuration](https://www.tapflow.dev/reference/configuration) · [REST API](https://www.tapflow.dev/reference/api) · [Security & Privacy](https://www.tapflow.dev/reference/security)
- **AI Agent** — [MCP Server](https://www.tapflow.dev/automation/mcp-server)

## Contributing

tapflow is actively developed and PRs are welcome — see [CONTRIBUTING.md](https://github.com/jo-duchan/tapflow/blob/main/CONTRIBUTING.md) for branch strategy, commit conventions, and an architecture overview. For deep dives, the [contributor notes](https://github.com/jo-duchan/tapflow/blob/main/CONTRIBUTING.md#technical-internals) cover the SimulatorKit reverse-engineering and the streaming render pipeline. Everyone taking part is expected to follow the [Code of Conduct](https://github.com/jo-duchan/tapflow/blob/main/CODE_OF_CONDUCT.md).

**Requirements**: Node.js ≥ 22, pnpm ≥ 9

```sh
git clone https://github.com/jo-duchan/tapflow.git
cd tapflow
pnpm install
pnpm dev
```

## License

[MIT](https://github.com/jo-duchan/tapflow/blob/main/LICENSE) — Copyright © 2026-present tapflow contributors

> tapflow bundles [scrcpy-server](https://github.com/Genymobile/scrcpy) (Apache-2.0) for Android screen streaming. See [NOTICE](https://github.com/jo-duchan/tapflow/blob/main/NOTICE) for full attribution.
