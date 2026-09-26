---
title: Install & agents
description: An agent that will not start or connect, `tapflow doctor` failures, and a relay that uses a configuration you did not expect.
---

# Install & agents

Problems that come up while preparing an agent Mac and connecting its agent to the relay.

## Agent connection issues

### It says an agent is already running {#agent-already-running}

`tapflow agent start` stopping with **AGENT ALREADY RUNNING** means a tapflow agent for that platform
is already running on this Mac.

One agent manages **every** simulator on its machine. Running several simulators and having several
people each test on their own, at the same time, is what one agent does — and it still is. Starting a
second agent is a different thing: it would compete with the first for the same device list and the
same network filter, and the relay treats the two as one agent anyway.

Stop the one that is running, or use the session it already serves.

### Agent cannot connect to the relay

1. Verify the relay is running.
2. Check the scheme of the URL in the `--relay` option: `ws://` for a plain-HTTP relay, `wss://` when the relay has `tls` configured and serves HTTPS. The agent command that `tapflow relay start` prints (and `tapflow start`, when this Mac runs no agent) already carries the right scheme, as does the one in the **Agent** token dialog.
3. Run `tapflow doctor` to inspect your environment. If the relay is running on the same Mac, the `Port 4000` check fails because the relay holds the port. You can ignore that one.

## `tapflow doctor` failures

### All iOS checks fail

The iOS agent only runs on macOS (Apple policy). You cannot start an iOS agent on Linux or Windows.

### `Xcode not found` — Xcode is not installed

Install Xcode from the Mac App Store or the Apple Developer site, then run:

```sh
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
```

### `Xcode not found` — Xcode is installed but `xcode-select` is not configured

This commonly happens after installing Xcode from the Mac App Store. Xcode is present but the developer tools path is not registered:

```sh
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
```

Run `tapflow doctor` again to confirm the check passes.

### No simulator is running

`tapflow doctor` does not pass or fail on whether a simulator is booted. It passes as long as at least one simulator is available, and warns only when there are none. The agent boots simulators on demand when a session starts.

To boot a simulator before starting:

```sh
tapflow devices        # list available simulators
tapflow boot "iPhone 16 Pro"
```

### `adb not found`

Android Studio is installed but `adb` is not in `$PATH`. Add the Android SDK `platform-tools` directory to your shell profile:

```sh
export ANDROID_HOME=$HOME/Library/Android/sdk
export PATH=$PATH:$ANDROID_HOME/platform-tools
```

Add these lines to `~/.zshrc` (or `~/.bashrc`) to make the change permanent, then run `source ~/.zshrc`.

## `tapflow init` says `CONFIG KEPT`

The install already has a `tapflow.config.json`, so `init` left it alone and refreshed only the tapflow section of `AGENTS.md`. Pass `--force` to write a fresh configuration, or edit the existing file directly.

## The relay is using a configuration or database you did not expect

`tapflow start` and `tapflow relay start` print the install directory, the configuration file and the data directory they resolved. Commands take the install named by `TAPFLOW_HOME`, then the current directory when it already is an install, and `~/.tapflow` otherwise ([which install a command uses](/operate/configure#which-install-a-command-uses)) — so running from a directory that holds an older install picks that one up. Set `TAPFLOW_HOME` to be explicit.
