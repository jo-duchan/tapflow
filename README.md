# tapflow

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)

Self-hosted iOS/Android simulator streaming for QA teams.

Run simulators and emulators in the browser — no Appetize, no BrowserStack, no monthly fees. Your app data never leaves your network.

## How it works

```
Browser (QA team)  ←→  Relay Server  ←→  Mac Agent (iOS Simulator + Android Emulator)
```

- **Relay**: lightweight Node.js server you deploy once (fly.io, Docker, or bare metal)
- **Agent**: runs on your Mac, connects outbound to the relay — no firewall rules needed
- **Dashboard**: React SPA served by the relay, accessible from any browser

## Quick start

```sh
# Install
npm install -g tapflow

# Start relay + iOS agent
tapflow start

# Or connect to a remote relay
tapflow start --relay wss://your-relay-url

# Check environment
tapflow doctor
```

→ Full documentation: **[tapflow docs](https://github.com/jo-duchan/tapflow)**

## Installation

```sh
# npm
npm install -g tapflow

# yarn
yarn global add tapflow

# pnpm
pnpm add -g tapflow
```

## Development

**Requirements**: Node.js ≥ 20, pnpm ≥ 9

```sh
git clone https://github.com/jo-duchan/tapflow.git
cd tapflow
pnpm install
pnpm dev
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for branch strategy and commit conventions.

## License

[MIT](LICENSE) — Copyright © 2025-present tapflow contributors

> tapflow uses [scrcpy](https://github.com/Genymobile/scrcpy) (Apache-2.0) for Android screen streaming. See [NOTICE](NOTICE) for full attribution.
