# Troubleshooting

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

## Opening a build fails with `spawn unknown error` {#spawn-unknown-error}

Check the Mac's architecture:

```bash
uname -m        # arm64 = Apple Silicon, x86_64 = Intel
```

If it reports `x86_64`, this is an **Intel Mac and the agent does not support it**. The native helper
binaries are built for arm64 only, so macOS refuses to exec them (`EBADARCH`), which Node surfaces as
`Unknown system error -86` and the dashboard shows as `spawn unknown error`.

There is no workaround on the agent side today. Run the agent on an Apple Silicon Mac — the relay and
the dashboard have no such constraint, so only the machine driving the simulators has to change.

Intel support is possible and tracked in
[#464](https://github.com/jo-duchan/tapflow/issues/464); it needs a universal build and verification on
hardware the maintainers do not have, so it is not scheduled. See
[Requirements](/guide/requirements#agent).

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

## iOS build upload errors

### `400` error on upload

| Cause | Fix |
|-------|-----|
| `.ipa` file uploaded | `.ipa` is for real devices. Build with `xcodebuild -sdk iphonesimulator` and zip the `.app` folder. |
| `.app` not at the zip root | Extracting the zip must produce `MyApp.app` directly — not inside a subfolder. |
| Device-only slices | Confirm it is a simulator build. `lipo -info MyApp.app/MyApp` must include `x86_64` or `arm64` (simulator). |

## Android emulator issues

### Stream does not start or encoder crashes

Most often the AVD uses an untested `google_apis_playstore` image. Recreate the AVD with the tested `google_apis/arm64-v8a` image:

```sh
sdkmanager "system-images;android-35;google_apis;arm64-v8a"
avdmanager create avd -n Pixel_8 -k "system-images;android-35;google_apis;arm64-v8a"
```

### `INSTALL_FAILED_NO_MATCHING_ABIS` — APK not compatible with Apple Silicon emulator

```
INSTALL_FAILED_NO_MATCHING_ABIS: Failed to extract native libraries, res=-113
```

Apple Silicon Macs (M1/M2/M3) run Android Emulator in a native ARM64 environment. An APK must include the `arm64-v8a` ABI to run on it.

Check which ABIs your APK supports:

```sh
aapt dump badging your-app.apk | grep native-code
```

| Result | Compatible |
|--------|-----------|
| `native-code: 'arm64-v8a'` | ✅ |
| `native-code: 'armeabi-v7a' 'arm64-v8a'` | ✅ |
| `native-code: 'armeabi-v7a' 'x86'` | ❌ |
| `native-code: 'x86' 'x86_64'` | ❌ |

If `arm64-v8a` is missing, the app was built targeting 32-bit ARM or Intel emulators only. Ask your development team to add `arm64-v8a` to the ABI split configuration.

::: details ABI reference

| ABI | Architecture | Apple Silicon Emulator |
|-----|-------------|----------------------|
| `arm64-v8a` | 64-bit ARM | ✅ Required |
| `armeabi-v7a` | 32-bit ARM | ❌ |
| `x86_64` | 64-bit Intel | ❌ |
| `x86` | 32-bit Intel | ❌ |

:::

### An APK upload shows as 'Unversioned' or merges into the wrong app

The relay reads an APK's app name, version, and package name with `aapt` from the Android build-tools. Without build-tools it can't read them, so the build is stored with no version or package name.

- An upload that specifies an `app_id` is rejected with `400` in this case, so an unidentifiable build can't be filed under the app you named.
- `tapflow doctor` flags this as a warning on the Android `aapt (build-tools)` check.

Install build-tools on the machine that runs the relay to fix it.

```sh
tapflow setup android
```

If you've already run `tapflow setup`, run it again to add build-tools. To install by hand, use `sdkmanager --sdk_root="$ANDROID_HOME" "build-tools;35.0.0"`.

If build-tools is already installed and a targeted upload still returns `400`, the APK itself is likely corrupt or not a valid package — rebuild or re-export it. `aapt dump badging your-app.apk` should print a `package: name=...` line for a valid APK.

### Colors look different from the emulator (less saturated)

Colors in tapflow may look slightly less saturated than the Android emulator window. **This is expected — and tapflow is actually the more faithful reference.**

- **tapflow** renders the pixel values from the agent's H.264 stream as-is, so it stays close to your design source (Figma, etc.).
- **The emulator window** runs the image through an extra display color-processing step when drawing to the screen, which boosts saturation above the source.

For reviewing design colors, **tapflow is the more trustworthy reference**.

::: details Measured example
Measuring a flat solid orange swatch with a color picker:

| Source (Figma) | tapflow | Emulator |
|----------------|---------|----------|
| `#FF8000` (G=128) | `#FF7700` (G=119) | `#FF6C00` (G=108) |

tapflow (G=119) stays closer to the source (G=128), while the emulator (G=108) drifts further from it, rendering a more saturated orange.

Black (`#000000`), white (`#FFFFFF`), and pure R/G/B are identical across all three — the difference appears only in midtone saturation, not from a corrupted stream.
:::

### Emulator is slow when the Mac is unattended

tapflow automatically prevents the host Mac from idle-sleeping while the agent is running (`caffeinate -di`, or `caffeinate -i` when `TAPFLOW_ALLOW_DISPLAY_SLEEP` is set). The assertion is acquired when the agent connects and released when it exits.

If the emulator is still slow when the Mac is unattended, check the following.

| Check | Why it matters |
|-------|----------------|
| **Power adapter connected** | Battery mode lowers CPU performance — `caffeinate` does not override this scaling. |
| **Laptop lid is open** | Closing the lid triggers clamshell sleep, which `caffeinate` cannot prevent. |

## iOS: the network extension is not installed {#network-not-set-up}

Network control on an iOS simulator needs the tapflow network extension installed on the agent Mac. **It comes with tapflow, so there is nothing to download.** One command installs the copy already in the package.

### 1. Install it

On a Mac you are setting up for the first time, the iOS setup covers the extension too.

```sh
tapflow setup ios
```

On a Mac that already ran setup, setup does not run again, so a machine configured before this feature existed needs its own command.

```sh
tapflow migrate net-filter
```

### 2. Approve it

Requesting the install brings up a macOS approval prompt. Choose **Open System Settings**. The highlighted **OK** only closes the prompt and approves nothing.

Go to **System Settings → General → Login Items & Extensions → Network Extensions** and switch the tapflow entry on. (An administrator password is required.)

Approval happens at the Mac. macOS offers no path a browser could click instead.

**The command can open the approval screen for you.** When this Mac has no approved tapflow extension, it asks before the install starts whether to open the screen when macOS asks. Say yes and the screen opens as soon as macOS starts waiting; switch TapflowNetFilter on there and the install finishes. macOS does not show its prompt again for an extension that is already waiting, so on a rerun this screen is the quickest way there.

It asks only when both its input and output are a terminal, so a pipe or a redirect stops it from asking even in one.

**Missing the first two minutes is not the end of it.** The install waits up to two minutes for approval. If the entry is not switched on by then, and the command can ask and you did not decline its offer, it waits up to two more minutes and switches the filter on once the entry is on. If it did not ask up front, because macOS was not expected to ask (replacing an approved extension, for instance), it asks at this point whether to open the screen.

Switching the filter on can briefly drop connections this Mac already has open, SSH sessions included — if you are connected over SSH, run it at the Mac. If macOS asks whether to allow tapflow to filter network content when it switches on, allow it.

If no screen appears, go there by the path above. The command cannot tell whether the window opened, so it shows the path alongside.

If you declined, or ran it where it cannot ask, the command ends still waiting for approval unless you approve it yourself within the first two minutes. A declined offer is not repeated. Not switching it on within the two extra minutes ends the same way. Approve it and run the same command once more. That run switches the filter on.

If a device came into use during the two extra minutes (a simulator booted, say), it stops without switching the filter on. It names what it found; stop that and run the command again. An approval within the first two minutes lets the extension switch the filter on by itself, so the only device check on that path is the one when the install starts.

### 3. When a restart is needed

Replacing an already-installed extension finishes only after the Mac restarts. **Until then the previous version keeps running** — the file on disk is the new one while macOS is still running the old one, so the dashboard goes on saying the Mac is not set up.

### Checking what the Mac has

```sh
tapflow doctor ios
```

It reports four things separately: whether it is **installed**, whether it is **approved**, whether it is **switched on**, and whether the versions on this Mac are the **ones this tapflow carries**. The last two are separate because the ones before them can all be right while the control still does not work — a replacement waiting for a restart is one such state, and a filter switched off is another. Switched off has no version of its own: the extension stays listed as activated, so every version reads correctly while nothing is being filtered.

**Two things carry a version**: the app in `/Applications` and the system extension inside it. They move independently, because a release that changes only the app has no reason to make macOS replace a running filter. The check names whichever is behind, and they need different things.

| What it says is behind | What to do |
|---|---|
| The app in `/Applications` | `tapflow migrate net-filter`. It copies the app; macOS skips the activation, so nothing is interrupted. The agent calls that binary, which is why a stale one matters |
| The extension, with a restart mentioned | Restart the Mac. The replacement is installed and finishes then |
| The extension, with no restart mentioned | `tapflow migrate net-filter` |
| This Mac is set up for a newer tapflow | Upgrade this checkout instead. Migrate refuses that direction, because replacing a newer filter breaks the agent depending on it |

**If the app is gone but the extension is still running, tapflow refuses to reinstall.** The extension's version says which filter is running, not which app it came from, so nothing can tell whether that Mac was set up by a newer tapflow than yours — and installing over it would replace a working filter someone else may depend on. Reinstall from the tapflow whose version matches, or clear the extension and start again. `tapflow doctor ios` and the command that refused both print the steps:

1. Switch the filter off. The app is gone, so this uses the binary inside the package, and the command prints its exact path.
2. Click the ⋯ button beside TapflowNetFilter and choose **Delete Extension**, in System Settings → General → Login Items & Extensions → Network Extensions. This works with the app already gone from `/Applications`.
3. Restart the Mac. The removal finishes then.

`systemextensionsctl uninstall` is not an option: macOS refuses it on any Mac with System Integrity Protection (SIP) on.

### If it still does not work

Installing ends with a distinct code per kind of failure.

| Code | Meaning |
|---|---|
| 1 | Activation failed |
| 2 | Could not read the configuration |
| 3 | Could not save the configuration |
| 4 | Not approved within 120 seconds. With input and output both on a terminal, the command keeps waiting, first asking whether to open the approval screen if it has not asked yet. If it is still not switched on after that, it could not ask, or the offer was declined, the command ends waiting for approval: approve it in System Settings and run it again |
| 5 | The Mac has to restart for this to finish |
| 6 | The system extension manager gave no answer within 45 seconds |
| 7 | The running filter did not answer |
| 8 | An argument this build does not understand. Can happen when the installed filter app is older than the agent |

What the extension can and cannot see is in [Network Control](/guide/network-control#what-you-are-trusting).

## iOS: the Mac lost its network while the filter was being replaced {#network-lost-on-replace}

The filter decides on **every new connection the Mac makes**, not only the simulator's. When it stops
while it is still switched on, macOS does not let traffic through unchecked. It blocks all of it,
which is the safe choice for a filter and a sudden one for you. Replacing the extension stops the
filter for a moment, so the replacement is where this happens.

The failures are immediate rather than slow: **`No route to host`**, not a long wait. Connections
already open keep working, which is why some things carry on while a browser stops.

`tapflow migrate net-filter` switches the filter off twice on the way through: once before it copies
the new app in, and once before it activates. The second is a gate — rather than activate over a filter
it could not switch off, the command stops and tells you. The first is best effort, so on a Mac where
it does not take you are back to the narrow window this section describes rather than clear of it.

When the command does stop, it says whether the filter was left switched off. Your network works in
that state and only iOS network control is missing.

**Getting the network back does not need a restart.**

```sh
/Applications/TapflowNetFilter.app/Contents/MacOS/TapflowNetFilter --off
```

That takes the filter out of the path and traffic returns. iOS network control stays unavailable
until the filter is on again, which is what running the migration again does.

```sh
tapflow migrate net-filter
```

## iOS: a device that was offline came back on the network by itself {#network-stopped}

A notice saying the device went back on the network while you were checking means **the offline behaviour you have checked so far needs checking again.** Requests may have been succeeding between the moment traffic started passing and the moment the notice appeared.

What stopped is the filter on the agent Mac that was blocking the traffic — either the extension was switched off in System Settings, or the filter process died and macOS is bringing it back. Bringing it back takes about six seconds, and nothing is blocked for any of them.

**Check**

```sh
systemextensionsctl list
```

If `dev.tapflow.netfilter.ext` is not `[activated enabled]`, go back to [installing and approving it](#network-not-set-up).

If it is enabled and this keeps happening, the filter process is dying repeatedly.

```sh
log show --last 10m --predicate 'subsystem == "dev.tapflow.netfilter"' --info --debug --style compact
```

**What to do**

Take the device offline again and redo the check from the start. The button draws normally once the filter is back. If the same notice keeps appearing, offline checks on that Mac cannot be trusted until the cause is found, so use another agent Mac in the meantime.

Logs are at `/tmp/tapflow-netfilter-host.log`.

For the feature itself, see [Network Control](/guide/network-control).

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

## Session issues

### Session ends automatically

5 minutes after the browser disconnects, the relay asks the agent to shut the device down. While a browser stays connected, nothing times out, even with no input. Change the delay with the relay's `IDLE_TIMEOUT_MS` environment variable (in milliseconds). Reconnect from the dashboard.

## Stream lag or stuttering {#stream-lag}

Narrow it to one of three causes — the network between agent and relay, the agent Mac's resources, or display sleep.

### Prefer a wired LAN

The agent streams video frames to the relay continuously, so the link between them sets the baseline smoothness. **Wired Ethernet is recommended** for the relay and agent machines. Wi-Fi works, but it adds latency and jitter — and on the relay Mac it can cause the periodic hitching below.

### Periodic hitching every ~0.5s on Wi-Fi (AWDL)

If the stream stutters in a steady rhythm (roughly twice a second) over Wi-Fi, the likely cause is **AWDL** (Apple Wireless Direct Link), the interface behind AirDrop, AirPlay, Handoff, and Sidecar. It periodically hops Wi-Fi channels, leaving the data channel for ~90 ms each time, which surfaces as a sawtooth latency spike and a visible hitch.

The robust fix is a **wired connection**: over Ethernet the data never rides Wi-Fi, so AWDL is irrelevant.

If you must stay on Wi-Fi, quiet AWDL from System Settings (reversible, no admin needed):

- **AirDrop** → "No One"
- **AirPlay Receiver** → off (System Settings → General → AirDrop & Handoff)
- **Handoff** → off (same pane)
- **Bluetooth** → off

AWDL only hops when something triggers it (AirDrop browsing, AirPlay, Handoff, Bluetooth proximity); with those quiet it stays idle.

To confirm, ping the router at a tight interval from the relay Mac and watch for the sawtooth: run `ping -i 0.01 <router-ip>`, and if the sawtooth disappears on a wired connection, AWDL was the cause.

::: tip Advanced: disabling awdl0 directly
`sudo ifconfig awdl0 down` disables AWDL for the session. It's temporary (reverts on reboot or the next time you use AirDrop) and needs admin, so prefer the toggles above or a wired link.
:::

### Host CPU / RAM pressure

The simulator and the H.264 encoder are the heavy consumers; when the agent Mac is starved (especially under memory pressure), capture and encode fall behind.

- Check CPU and RAM for the affected Mac in the **Mac Resources** tab.
- Run the relay and the agent on **separate Macs** so they don't compete for resources (this also scales agent capacity).
- Reduce the number of simulators running at once on one Mac.

### Display sleep

By default the agent keeps the host display awake while a session is active, because a sleeping display parks the GPU and throttles the simulator. If you set `TAPFLOW_ALLOW_DISPLAY_SLEEP=1`, expect the stream to slow whenever the display turns off. See [Agent Setup](/guide/agent#host-display-and-sleep).

### Blurry or low-resolution stream on LAN

A plain-HTTP LAN connection uses the **Standard** profile, which caps the stream at 1280 px (longest side) so the WASM decoder stays responsive. To stream at the simulator's native resolution, serve the relay over HTTPS — that moves you to the **Smooth** profile (hardware decoding, native resolution). See [Self-Hosting the Relay](/guide/self-hosting). You can also raise the cap without HTTPS by setting `TAPFLOW_MAX_SIZE_LAN` on the agent; see [Streaming Quality](/guide/streaming).

## Auth issues

### `tapflow init` says `CONFIG KEPT`

The install already has a `tapflow.config.json`, so `init` left it alone and refreshed only the tapflow section of `AGENTS.md`. Pass `--force` to write a fresh configuration, or edit the existing file directly.

### The relay is using a configuration or database you did not expect

`tapflow start` and `tapflow relay start` print the install directory, the configuration file and the data directory they resolved. Commands take the install named by `TAPFLOW_HOME`, then the current directory when it already is an install, and `~/.tapflow` otherwise ([which install a command uses](/guide/configure#which-install-a-command-uses)) — so running from a directory that holds an older install picks that one up. Set `TAPFLOW_HOME` to be explicit.

### `tapflow admin init` fails (`Already initialized`)

An admin account already exists on the relay. Sign in and invite teammates from **Settings → Team**.

### Invitation link expired

Invitation links expire after **7 days**. An Admin must create a new invitation from **Settings → Team**. If SMTP is not configured, copy the link shown in the invite dialog and share it manually.

### Password reset link expired

Password reset links expire after **2 hours**. An Admin can send a new link with **Reset pwd** on the member's row in **Settings → Team**. Reset links go out by email only, so SMTP must be configured.

## Viewing logs

On the Mac the relay runs on, inspect its activity with the commands below. The relay does not show its logs to other machines.

```sh
tapflow logs
tapflow logs --lines 200
```

Running under Docker, a CLI outside the container counts as remote; use `docker compose logs` instead.
