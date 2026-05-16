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

::: tip Running the relay on a separate server?
Use `tapflow relay start` and `tapflow agent start`. See [Self-Hosting the Relay](/guide/self-hosting).
:::

## 3. Create the admin account

tapflow has no default credentials. Create the first admin account:

```sh
tapflow init
  ? Admin email: admin@yourteam.com
  ? Password: ********
  ✓ Admin account created
  →  Open http://localhost:4000 to sign in
```

::: warning One-time only
`tapflow init` only works when no accounts exist. After this step, invite teammates from **Settings → Team** in the dashboard.
:::

## 4. Open the dashboard

Navigate to `http://localhost:4000` (or your relay URL), then sign in with the account you just created.

For the full onboarding flow — team invitations and your first build upload — see [First-time Setup](/dashboard/setup).

::: tip Environment check
If you run into issues during setup, run `tapflow doctor`. It automatically diagnoses prerequisites like Node.js version, Xcode, and adb.
:::
