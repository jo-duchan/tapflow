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

To connect a Mac agent to a remote relay instead:

```sh
tapflow agent start --relay wss://relay.myteam.example.com
```

## 3. Create the admin account

tapflow has no default credentials. Create the first admin account:

```sh
tapflow init
  ? Admin email: admin@yourteam.com
  ? Password: ********
  ✓ Admin account created
  →  Open http://localhost:4000 to sign in
```

## 4. Open the dashboard

Navigate to `http://localhost:4000` (or your relay URL) in any browser, then sign in with the credentials you just created.

For the full first-time setup flow — inviting your team and uploading a first build — see [First-time Setup](/dashboard/setup).

## 5. Check your environment

```sh
tapflow doctor
```
