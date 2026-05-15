# Quick Start

Get tapflow running in under 10 minutes.

## 1. Install tapflow

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

## 2. Start the relay + agent

On your Mac, run:

```sh
tapflow start
# ✓ Relay started on ws://localhost:4000
# ✓ iOS Agent connected (3 simulators available)
```

To connect to a remote relay instead:

```sh
tapflow start --relay wss://relay.myteam.example.com
```

## 3. Open the dashboard

Navigate to `http://localhost:4000` (or your relay URL) in any browser.

Sign in with your team credentials, select a device, and start a session.

## 4. Check your environment

```sh
tapflow doctor
```
