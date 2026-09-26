---
title: iOS simulator
description: "`spawn unknown error`, the CoreSimulator service version mismatch, a simulator that cannot be located on disk, and Korean input on iOS 17 and earlier."
---

# iOS simulator

Fixes for an iOS simulator that will not open or boot, and for broken Korean input.

## Opening a build fails with `spawn unknown error` {#spawn-unknown-error}

Check the Mac's architecture:

```bash
uname -m                       # arm64 = Apple Silicon, x86_64 = Intel or Rosetta
sysctl -n sysctl.proc_translated   # 1 = this shell runs under Rosetta
```

If `sysctl` prints `1`, the Mac is Apple Silicon and the shell is running under Rosetta: open a Terminal that
is not set to "Open using Rosetta", check that `node -p process.arch` prints `arm64`, and start the agent from
there.

If `uname -m` reports `x86_64` and `sysctl` prints `0` or nothing, this is an **Intel Mac and the agent does not support it**. The native helper
binaries are built for arm64 only, so macOS refuses to exec them (`EBADARCH`), which Node surfaces as
`Unknown system error -86` and the dashboard shows as `spawn unknown error`.

There is no workaround on the agent side today. Run the agent on an Apple Silicon Mac — the relay and
the dashboard have no such constraint, so only the machine driving the simulators has to change.

Intel support is possible and tracked in
[#464](https://github.com/jo-duchan/tapflow/issues/464); it needs a universal build and verification on
hardware the maintainers do not have, so it is not scheduled. See
[Requirements](/operate/requirements#agent).

If `uname -m` says `arm64`, this is a different problem — a helper that is missing or not executable
produces the same message. Check that the agent package installed completely.

## iOS Simulator service version mismatch {#ios-simulator-service-version-mismatch}

After updating Xcode, you may see a macOS alert:

> "Loaded CoreSimulatorService is no longer valid for this process … Service version (X) does not match expected service version (Y)."

tapflow automatically detects this and restarts the service. If the automatic recovery fails (the alert still appears after retrying), run this command manually:

```sh
killall -9 com.apple.CoreSimulator.CoreSimulatorService
```

`launchd` will restart the service immediately. Then re-run `tapflow start`.

::: details Why this happens
Xcode ships a newer `CoreSimulator.framework` but the old `CoreSimulatorService` daemon is still running from the previous session. After the first `xcrun simctl` call notices the version mismatch, tapflow force-kills the daemon so launchd can restart it with the new version. If the daemon is stuck and does not die on the first attempt, the manual `killall -9` above is needed.
:::

## iOS Simulator fails to boot — "cannot be located on disk" {#simulator-data-missing}

When an Xcode or macOS update prunes an old runtime, a simulator can linger in the device list while its data directory is gone from disk. `simctl list` still reports it as available, but booting fails:

> Unable to boot device because it cannot be located on disk. The device's data is no longer present …

tapflow recovers from this automatically — when you open the device in the dashboard, the agent erases the broken simulator to regenerate its data and retries the boot once. A healthy simulator is never erased.

If the automatic recovery does not clear it, remove the stale devices manually. This deletes simulators whose runtime is gone:

```sh
xcrun simctl delete unavailable
```

If one specific simulator still fails, delete it by UDID and let Xcode recreate a fresh one:

```sh
xcrun simctl delete 822F00B0-D9CF-4B78-8EDD-6322974E4079
```

## iOS 17 and earlier — Korean text splits into individual characters

On iOS 17 and earlier simulators, Korean input does not combine into syllables — characters appear separated (e.g., "안녕" → "ㅇㅏㄴㄴㅕㅇ").

This is a bug in the iOS Simulator's IME, not in tapflow. It also reproduces in system apps like Messages.

**Upgrade to an iOS 18+ Simulator Runtime.**  
Install it from Xcode → Settings → Platforms.

::: details References
- [React Native #41494](https://github.com/facebook/react-native/issues/41494)
- [Flutter #135825](https://github.com/flutter/flutter/issues/135825)
:::
