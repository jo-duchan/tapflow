# Quick Start

This page walks you from installing tapflow to opening the dashboard. If Xcode or the Android SDK still needs downloading, the `tapflow setup` step adds that download time.

## 1. Install tapflow {#_1-install-tapflow}

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

## 2. Set up the environment {#_2-set-up-the-environment}

On the Mac that will run an agent, install the simulator/emulator prerequisites in one step:

```sh
tapflow setup
```

Skip this on a relay-only server (Linux). See [Environment Setup](/operate/environment-setup) for details.

## 3. Configure tapflow (optional) {#_3-configure-tapflow-optional}

Run `tapflow init` to set this machine up. It writes `tapflow.config.json` into `~/.tapflow`, asks for a tunnel and, on a plain LAN, your streaming performance (HTTP or HTTPS). On a machine that can run simulators or emulators, it also asks whether to turn on Lean mode. Skip this step if the defaults are fine — port 4000, no tunnel, HTTP.

```sh
tapflow init
```

Run it from anywhere: tapflow keeps one install per machine, and every command finds it the same way. To keep it somewhere else, such as a server's `/var/lib/tapflow`, set `TAPFLOW_HOME` and every command follows it.

`init` also writes an `AGENTS.md` and a `CLAUDE.md` in that directory, so a coding agent opened there answers tapflow questions from the documentation. For what each prompt sets, the `.env` credentials file, and the CI flags, see [Configuring tapflow](/operate/configure).

## 4. Start the relay + agent {#_4-start-the-relay-agent}

On your Mac, run:

```sh
tapflow start
```

It prints the install, config and data paths first, then a banner like the one below once the relay and agent are ready. If an Android environment is present, an `android` agent connects too. If the first agent fails to connect, `start` stops with an error banner; an agent that fails after another has connected is reported on a ⚠ line and the rest keep running.

```text
  →  Relay started on http://localhost:4000

  ✓  Connecting ios agent…

  ┌─────────────────────────────────────────────┐
  │  ✓  TAPFLOW READY                           │
  └─────────────────────────────────────────────┘
     Relay  : http://localhost:4000
     Open http://localhost:4000 in your browser.
     Press Ctrl+C to stop.
```

Leave this terminal open. `Ctrl+C` stops the relay and the agent together.

::: tip Running the relay on a separate server?
Use `tapflow relay start` and `tapflow agent start`. See [Self-Hosting the Relay](/guide/self-hosting).
:::

## 5. Create the admin account {#_5-create-the-admin-account}

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

## 6. Open the dashboard {#_6-open-the-dashboard}

Sign in at `http://localhost:4000` with the account you just created.

For the full onboarding flow — team invitations and your first build upload — see [First-time Setup](/dashboard/setup).

::: tip Environment check
If you run into issues during setup, run `tapflow doctor`. It automatically diagnoses prerequisites — Node.js version and platform-specific tools.
:::
