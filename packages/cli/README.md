<div align="center">
  <img src="https://raw.githubusercontent.com/jo-duchan/tapflow/main/docs/public/logo-hero.svg" height="72" alt="tapflow" />

  <h3>A self-hosted Appetize / BrowserStack alternative for mobile QA teams</h3>

  <p>
    Run iOS simulators and Android emulators in any browser — no toolchain setup, no device pool, no cloud uploads.<br />
    Your builds, streams, and recordings stay on infrastructure you control.
  </p>

  <p>
    <a href="https://github.com/jo-duchan/tapflow/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="MIT License" /></a>
    <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen" alt="Node.js ≥ 20" /></a>
    <img src="https://img.shields.io/badge/platform-macOS%20agent-lightgrey" alt="macOS Agent" />
    <a href="https://github.com/jo-duchan/tapflow/releases"><img src="https://img.shields.io/github/v/release/jo-duchan/tapflow?include_prereleases&sort=semver" alt="Latest release" /></a>
    <a href="https://github.com/jo-duchan/tapflow/commits/main"><img src="https://img.shields.io/github/last-commit/jo-duchan/tapflow" alt="Last commit" /></a>
    <a href="https://github.com/jo-duchan/tapflow/blob/main/ROADMAP.md"><img src="https://img.shields.io/badge/roadmap-v0.x→v1.0-blueviolet" alt="Roadmap" /></a>
  </p>

  <p>
    <a href="https://www.tapflow.dev">📖 Docs</a>
    &nbsp;·&nbsp;
    <a href="https://www.tapflow.dev/guide/getting-started">🚀 Quick Start</a>
    &nbsp;·&nbsp;
    <a href="https://www.tapflow.dev/guide/introduction">🎥 Demo</a>
    &nbsp;·&nbsp;
    <a href="https://www.tapflow.dev/guide/environment-setup#tapflow-setup">🎬 Setup</a>
  </p>
</div>

<div align="center">
  <a href="https://github.com/user-attachments/assets/01914ed2-f35c-4230-ae01-166ffe6af395" target="_blank" rel="noopener noreferrer">
    <img src="https://raw.githubusercontent.com/jo-duchan/tapflow/main/docs/public/demo-thumbnail.png" alt="tapflow demo — click to play" width="100%" />
  </a>
  <p><em>Click to play</em></p>
</div>

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

## What tapflow does

tapflow connects three parts:

1. A **self-hosted relay** server (Linux or Mac)
2. A **macOS agent** that drives iOS simulators and Android emulators
3. A **browser dashboard** for the rest of the team

The agent connects outbound to the relay. Teammates open the dashboard, pick an available device, and interact with it remotely — while the simulators and emulators keep running on your own Macs.

## What tapflow is not

tapflow doesn't replace native mobile development tools. Mobile developers still use Xcode, Android Studio, and their build tooling. tapflow makes the *running* simulators and emulators accessible to the rest of the team through a browser — it isn't an automation framework or a device farm.

## How it works

```
Browser (your team)  ←─ WebSocket ─→  Relay Server  ←─ WebSocket (outbound) ─→  Mac Agent
                                    (Linux / Mac)                           (iOS · Android)
```

1. The **Mac Agent** connects _outbound_ to the relay — no inbound firewall rules needed.
2. Anyone on the team opens the **dashboard** in any browser and sees all available devices.
3. Touch events are forwarded in real time; the screen streams back to the browser.
4. The **relay** also serves the dashboard SPA on the same port — no separate web server needed.

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

Skip this on a relay-only server (Linux). See [Environment Setup](https://www.tapflow.dev/guide/environment-setup) for details.

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
| **Relay server** | Node.js ≥ 20, any OS (Linux/macOS), ~512 MB RAM |
| **iOS Agent** | macOS, Xcode + iOS Simulator runtime (or run `tapflow setup ios`), Node.js ≥ 20 |
| **Android Agent** | macOS, Java + Android SDK with an AVD (or run `tapflow setup android`), Node.js ≥ 20 |
| **Browser (QA)** | Any modern browser — Chrome, Firefox, Safari, Edge |

> Agents run on **macOS only** (they drive the iOS Simulator and Android emulator on a Mac). The relay runs anywhere.

## Features

- **No mobile toolchain for QA users** — teammates test from a browser without installing Xcode, Android Studio, or local simulator tooling.
- **Self-hosted by default** — app builds, device streams, recordings, and account data stay on infrastructure you control.
- **Use your existing Mac setup** — run agents on Macs that already have the iOS Simulator or Android emulator available.
- **API-first** — REST endpoints and Personal Access Tokens support CI/CD and AI-agent workflows.

What's included:

- **Browser streaming** — iOS & Android at ~30 fps, no extra app on the device. Both stream H.264 through a 2-tier decoder (WebCodecs on secure contexts, WASM/tinyh264 on plain HTTP), which removes the media-element buffer from the decode path. Resolution adapts to the connection — native on a secure context, downscaled on plain-HTTP LAN.<sup>[1](#latency-note)</sup>
- **Codec fallback** — the stream negotiates the codec per client and falls back to JPEG when a hardware or WASM decoder isn't available, so older browsers still work.
- **Touch, swipe & pinch** — real-time input forwarded to the simulator or emulator.
- **Deeplink toolbar** — open supported deeplinks directly from the QA toolbar.
- **Keyboard shortcuts** — trigger simulator toolbar actions from the keyboard.
- **App Center** — upload `.app.zip` / `.apk` and track builds by status (Backlog / In Progress / Done / Rejected).
- **Session recordings** — record and share QA sessions, kept on the relay for ~72 hours, then purged automatically.
- **Screenshot REST endpoint** — `GET /api/v1/sessions/:sessionId/screenshot` for CI and AI agents.
- **Mac resource monitoring** — CPU & RAM per agent, to spot overloaded hosts before assigning sessions.
- **Team management** — invite links, roles (Admin / Developer / QA / Viewer), and Personal Access Tokens.
- **MCP Server** *(experimental)* — `@tapflowio/mcp-server` lets Claude Code and other LLM agents control simulators as native tools.

<a name="latency-note"></a>
> <sup>1</sup> On localhost, decode-to-present is in the single-to-low-double-digit milliseconds (WebCodecs ~2.5 ms, WASM ~9–14 ms); end-to-end "glass-to-glass" latency also depends on your network. See the [streaming latency log](https://github.com/jo-duchan/tapflow/blob/main/contributing/streaming-latency-log.md) for the full pipeline analysis and measurements.

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
- **Authenticated by default off-host** — the relay accepts unauthenticated connections only from its own machine (`localhost`). Browsers reaching it from elsewhere sign in; agents on another machine present an `agent`-scope token.
- **PAT + roles** — Personal Access Tokens carry scopes (`builds:write` for CI uploads, `agent` for remote agents), and team roles (Admin / Developer / QA / Viewer) govern dashboard access.

Found a vulnerability? See [SECURITY.md](https://github.com/jo-duchan/tapflow/blob/main/SECURITY.md). For the full model, read [Security & Privacy](https://www.tapflow.dev/guide/security).

## Self-Hosting

### Local (single Mac)

Relay and agent on the same machine — ideal for a single developer or small team.

```sh
tapflow start
```

### Team (separate relay server)

Run the relay on a Linux server or dedicated Mac. Each Mac with simulators runs the agent.

**Relay server:**

```sh
# Recommended: PM2 for automatic restarts
npm install -g pm2 tapflow
JWT_SECRET=$(openssl rand -hex 32) pm2 start tapflow --name relay -- relay start
pm2 save && pm2 startup
```

**Each Mac agent:**

```sh
tapflow agent start --relay wss://your-relay-url --token <agent-token>
```

> A relay on a different machine accepts an agent only with an `agent`-scope token — create one in **Settings → Tokens** (Admin only). Agents on the relay's own machine (`tapflow start`) need no token. See [Remote relay authentication](https://www.tapflow.dev/guide/agent#remote-relay-authentication).
>
> For nginx / Caddy reverse proxy setup and external access, see [Self-Hosting the Relay](https://www.tapflow.dev/guide/self-hosting).

## CLI Reference

| Command | Description |
|---------|-------------|
| `tapflow start` | Start relay + agent together (local mode) |
| `tapflow relay start` | Start relay only |
| `tapflow agent start --relay <url> [--token <pat>]` | Start agent and connect to a relay (remote relays need an `agent`-scope token) |
| `tapflow init` | Scaffold `tapflow.config.json` |
| `tapflow admin init` | Create the first admin account (CLI fallback) |
| `tapflow doctor [platform]` | Diagnose prerequisites (Node, iOS, Android) |
| `tapflow setup [platform]` | Install & configure the local environment |
| `tapflow devices` | List available simulators and emulators |
| `tapflow boot <name\|udid>` | Boot a simulator or emulator |
| `tapflow status` | Show connected agents, devices, active sessions |
| `tapflow reset` | Shut down all simulators and emulators |
| `tapflow logs` | Show recent relay log entries |

Full reference → [CLI docs](https://www.tapflow.dev/reference/cli)

## Documentation

**[www.tapflow.dev](https://www.tapflow.dev)**

**Getting Started**
- [Introduction](https://www.tapflow.dev/guide/introduction)
- [Quick Start](https://www.tapflow.dev/guide/getting-started)
- [Requirements](https://www.tapflow.dev/guide/requirements)

**Setup**
- [Self-Hosting the Relay](https://www.tapflow.dev/guide/self-hosting)
- [Security & Privacy](https://www.tapflow.dev/guide/security)
- [Agent Setup](https://www.tapflow.dev/guide/agent)
- [Uploading Builds (CI/CD)](https://www.tapflow.dev/guide/upload-builds)
- [Scaling Mac Resources](https://www.tapflow.dev/guide/scaling)

**Dashboard**
- [First-time Setup](https://www.tapflow.dev/dashboard/setup)
- [Dashboard Overview](https://www.tapflow.dev/dashboard/overview)

**AI Agent**
- [MCP Server](https://www.tapflow.dev/guide/mcp-server) *(experimental)*

**Reference**
- [CLI Reference](https://www.tapflow.dev/reference/cli)
- [Configuration](https://www.tapflow.dev/reference/configuration)
- [REST API](https://www.tapflow.dev/reference/api)

**[Troubleshooting](https://www.tapflow.dev/guide/troubleshooting)**

## Contributing

tapflow is actively developed and PRs are welcome — see [CONTRIBUTING.md](https://github.com/jo-duchan/tapflow/blob/main/CONTRIBUTING.md) for branch strategy, commit conventions, and an architecture overview.

**Requirements**: Node.js ≥ 20, pnpm ≥ 9

```sh
git clone https://github.com/jo-duchan/tapflow.git
cd tapflow
pnpm install
pnpm dev
```

## License

[MIT](https://github.com/jo-duchan/tapflow/blob/main/LICENSE) — Copyright © 2026-present tapflow contributors

> tapflow bundles [scrcpy-server](https://github.com/Genymobile/scrcpy) (Apache-2.0) for Android screen streaming. See [NOTICE](https://github.com/jo-duchan/tapflow/blob/main/NOTICE) for full attribution.
