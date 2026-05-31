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

## 2. Scaffold config (optional)

Run `tapflow init` to generate `tapflow.config.json`. Skip this step if you are happy with the defaults (port 4000, no tunnel).

```sh
tapflow init
# ✓ tapflow.config.json created.
# → Next: tapflow start
```

To set up a tunnel at the same time:

```sh
tapflow init --tunnel tailscale
```

::: tip Already have a config file?
`tapflow init` exits with an error if `tapflow.config.json` already exists. Use `--force` to overwrite.
:::

## 3. Start the relay + agent

On your Mac, run:

```sh
tapflow start
# ✓ Relay started on ws://localhost:4000
# ✓ iOS Agent connected (3 simulators available)
```

::: tip Running the relay on a separate server?
Use `tapflow relay start` and `tapflow agent start`. See [Self-Hosting the Relay](/guide/self-hosting).
:::

## 4. Create the admin account

tapflow has no default credentials. On first launch, the dashboard redirects you to the setup page:

1. Open `http://localhost:4000` in your browser.
2. You are redirected to `/setup` automatically.
3. Enter your email and password to create the admin account.

::: warning One-time only
The setup page only appears when no accounts exist. After this step, invite teammates from **Settings → Team** in the dashboard.
:::

::: tip Headless server?
If you cannot open a browser, use `tapflow admin init` to create the first admin account via CLI.
:::

## 5. Open the dashboard

Sign in at `http://localhost:4000` with the account you just created.

For the full onboarding flow — team invitations and your first build upload — see [First-time Setup](/dashboard/setup).

::: tip Environment check
If you run into issues during setup, run `tapflow doctor`. It automatically diagnoses prerequisites like Node.js version, Xcode, and adb.
:::
