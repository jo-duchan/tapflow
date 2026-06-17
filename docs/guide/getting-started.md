# Quick Start

Get tapflow running in under 5 minutes.

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

## 2. Set up the environment

On the Mac that will run an agent, install the simulator/emulator prerequisites in one step:

```sh
tapflow setup
```

Skip this on a relay-only server (Linux). See [Environment Setup](/guide/environment-setup) for details.

## 3. Configure tapflow (optional)

Run `tapflow init` to generate `tapflow.config.json`. It interactively asks for a tunnel and, on a plain LAN, your streaming performance (HTTP or HTTPS). Skip this step if the defaults are fine — port 4000, no tunnel, HTTP.

```sh
tapflow init
```

For what each prompt sets, the `.env` credentials file, and the CI flags, see [Configuring tapflow](/guide/configure).

## 4. Start the relay + agent

On your Mac, run:

```sh
tapflow start
# ✓ Relay started on ws://localhost:4000
# ✓ iOS Agent connected (3 simulators available)
```

::: tip Running the relay on a separate server?
Use `tapflow relay start` and `tapflow agent start`. See [Self-Hosting the Relay](/guide/self-hosting).
:::

## 5. Create the admin account

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

## 6. Open the dashboard

Sign in at `http://localhost:4000` with the account you just created.

For the full onboarding flow — team invitations and your first build upload — see [First-time Setup](/dashboard/setup).

::: tip Environment check
If you run into issues during setup, run `tapflow doctor`. It automatically diagnoses prerequisites — Node.js version and platform-specific tools.
:::
