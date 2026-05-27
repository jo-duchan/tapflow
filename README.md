<div align="center">
  <img src="docs/public/logo-hero.svg" height="72" alt="tapflow" />

  <h3>Self-hosted iOS & Android simulator streaming for mobile QA</h3>

  <p>
    Anyone on your team can run simulators in the browser — no toolchain setup, no device management, no cloud uploads.<br />
    App data never leaves your network.
  </p>

  <p>
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="MIT License" /></a>
    <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen" alt="Node.js ≥ 20" /></a>
    <img src="https://img.shields.io/badge/platform-macOS-lightgrey" alt="macOS Agent" />
    <a href="https://github.com/jo-duchan/tapflow/blob/main/CONTRIBUTING.md"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs welcome" /></a>
    <a href="ROADMAP.md"><img src="https://img.shields.io/badge/roadmap-v0.x→v1.0-blueviolet" alt="Roadmap" /></a>
  </p>

  <p>
    <a href="https://www.tapflow.dev">📖 Docs</a>
    &nbsp;·&nbsp;
    <a href="https://www.tapflow.dev/guide/getting-started">🚀 Quick Start</a>
    &nbsp;·&nbsp;
    <a href="https://www.tapflow.dev/guide/introduction">🎥 Demo</a>
  </p>
</div>

> **alpha**: tapflow is in active development (v0.x). Breaking changes may appear in minor versions until v1.0.0. See [ROADMAP](./ROADMAP.md) for known gaps.

---

## Demo

<video src="https://github.com/user-attachments/assets/75652346-93cb-4261-9210-6a24b883d44a" controls width="100%"></video>

[▶ Watch demo](https://www.tapflow.dev/guide/introduction)

---

## Why tapflow?

If you work on a mobile product, you've probably seen this.

Physical devices are never enough. Covering every OS version is even harder — iOS doesn't support downgrading, so maintaining a range of versions means managing a pool of locked devices, which is overhead nobody wants.

But the bigger friction is access. Simulators only run on a developer's Mac, behind complex developer toolchains. Anyone on the team who isn't a mobile developer has to ask one every single time they need to verify something:

> **Server / FE developer** — "How do I install the sandbox build to check what was deployed?"
>
> **Product manager** — "I keep having to install and remove different versions just to compare behavior."
>
> **Designer** — "I need to check the layout across screen sizes, but I don't have the right devices."

Cloud simulator services exist. But uploading internal app builds to an external service — and paying monthly fees for simulators already running on Macs you own — was never something we wanted to do.

So we built tapflow.

| Solution | Problem |
|----------|---------|
| Appetize / BrowserStack | Expensive — app data leaves your network |
| Physical devices | Cost, loss, management overhead |
| Xcode / Android Studio | Every QA member needs their own Mac + full toolchain setup |
| **tapflow** | Use the Mac you already own — data stays on-prem, whole team does QA from a browser |

## Features

- **Browser-based** — Anyone on the team needs no installation. Any modern browser works.
- **iOS Simulator** — JPEG frame streaming at ~30 fps via SimulatorKit IOSurface. No WebDriverAgent required.
- **Android Emulator** — H.264 streaming via [scrcpy](https://github.com/Genymobile/scrcpy) at ~30 fps.
- **Touch, swipe & pinch** — real-time input forwarded to the simulator.
- **App Center** — upload `.app.zip` (iOS) or `.apk` (Android), manage builds by status (Backlog / In Progress / Done / Rejected).
- **Session Recordings** — record QA sessions, share with your team. Retained for 72 hours.
- **Mac Resources** — CPU & RAM monitoring per agent. Spot overloaded hosts before assigning sessions.
- **Team management** — invite links, roles (Admin / Developer / QA / Viewer), Personal Access Tokens for CI/CD.
- **MCP Server** — `@tapflowio/mcp-server` lets Claude Code and other LLM agents control simulators as native tools.
- **Self-hosted** — deploy anywhere. No cloud dependency.

## How it works

```
Browser (your team)  ←─ WebSocket ─→  Relay Server  ←─ WebSocket (outbound) ─→  Mac Agent
                                    (Linux / Mac)                           (iOS · Android)
```

1. The **Mac Agent** connects *outbound* to the relay — no inbound firewall rules needed.
2. Anyone on the team opens the **dashboard** in any browser and sees all available devices.
3. Touch events are forwarded in real time; the screen streams back to the browser.
4. The **relay** also serves the dashboard SPA on the same port — no separate web server needed.

## Quick Start

### 1. Install

```sh
npm install -g tapflow
# or: yarn global add tapflow  |  pnpm add -g tapflow
```

### 2. Start relay + agent

```sh
tapflow start
# ✓ Relay started on http://localhost:4000
# ✓ iOS Agent connected (3 simulators available)
```

This starts both the relay and the agent on the same Mac (local mode).

### 3. Create the first admin account

```sh
tapflow init
# ? Admin email: admin@yourteam.com
# ? Password: ********
# ✓ Admin account created
```

### 4. Open the dashboard

Navigate to `http://localhost:4000` and sign in with the account you just created.

> **Having issues?** Run `tapflow doctor` to auto-diagnose Node.js, Xcode, `adb`, and other prerequisites.

## Requirements

| Component | Requirements |
|-----------|-------------|
| **Relay server** | Node.js ≥ 20, any OS (Linux/macOS), ~512 MB RAM |
| **iOS Agent** | macOS, Xcode with iOS Simulator Runtime, Node.js ≥ 20 |
| **Android Agent** | macOS, Android SDK (`adb` in `$PATH` or `$ANDROID_HOME` set), AVD with `google_apis/arm64-v8a` (android-34), Node.js ≥ 20 |
| **Browser (QA)** | Any modern browser — Chrome, Firefox, Safari, Edge |

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
tapflow agent start --relay wss://your-relay-url
```

> For nginx / Caddy reverse proxy setup and external access, see [Self-Hosting the Relay](https://www.tapflow.dev/guide/self-hosting).

## CLI Reference

| Command | Description |
|---------|-------------|
| `tapflow start` | Start relay + agent together (local mode) |
| `tapflow relay start` | Start relay only |
| `tapflow agent start --relay <url>` | Start agent and connect to a relay |
| `tapflow init` | Create the first admin account |
| `tapflow doctor` | Diagnose environment (Node, Xcode, adb…) |
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
- [Agent Setup](https://www.tapflow.dev/guide/agent)
- [Uploading Builds (CI/CD)](https://www.tapflow.dev/guide/upload-builds)
- [Scaling Mac Resources](https://www.tapflow.dev/guide/scaling)

**Dashboard**
- [First-time Setup](https://www.tapflow.dev/dashboard/setup)
- [Dashboard Overview](https://www.tapflow.dev/dashboard/overview)

**AI Agent**
- [MCP Server](https://www.tapflow.dev/guide/mcp-server)

**Reference**
- [CLI Reference](https://www.tapflow.dev/reference/cli)
- [Configuration](https://www.tapflow.dev/reference/configuration)
- [REST API](https://www.tapflow.dev/reference/api)

**[Troubleshooting](https://www.tapflow.dev/guide/troubleshooting)**

## Development

**Requirements**: Node.js ≥ 20, pnpm ≥ 9

```sh
git clone https://github.com/jo-duchan/tapflow.git
cd tapflow
pnpm install
pnpm dev
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for branch strategy, commit conventions, and architecture overview.

## License

[MIT](LICENSE) — Copyright © 2025-present tapflow contributors

> tapflow bundles [scrcpy-server](https://github.com/Genymobile/scrcpy) (Apache-2.0) for Android screen streaming. See [NOTICE](NOTICE) for full attribution.
