# Troubleshooting

## Agent connection issues

### Agent cannot connect to the relay

1. Verify the relay is running.
2. Check that the URL in the `--relay` option uses `ws://` — agents always connect over the local network.
3. Run `tapflow doctor` to inspect your environment.

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
sdkmanager "system-images;android-34;google_apis;arm64-v8a"
avdmanager create avd -n Pixel_8 -k "system-images;android-34;google_apis;arm64-v8a"
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

tapflow automatically prevents the host Mac from idle-sleeping while the agent is running (`caffeinate -i`). The assertion is acquired when the agent connects and released when it exits.

If the emulator is still slow when the Mac is unattended, check the following.

| Check | Why it matters |
|-------|----------------|
| **Power adapter connected** | Battery mode lowers CPU performance — `caffeinate` does not override this scaling. |
| **Laptop lid is open** | Closing the lid triggers clamshell sleep, which `caffeinate` cannot prevent. |

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

`tapflow doctor` shows a warning when no simulator is booted. This does not block `tapflow start` — the warning is informational.

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

Sessions auto-close after 30 minutes of inactivity. This timeout cannot be changed from settings. Reconnect from the dashboard.

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

### `tapflow init` fails (`ALREADY INITIALIZED`)

`tapflow.config.json` already exists in the current directory. Use `--force` to overwrite it, or edit the existing file directly.

### `tapflow admin init` fails (`Already initialized`)

An admin account already exists on the relay. Sign in and invite teammates from **Settings → Team**.

### Invitation link expired

Invitation links expire after **7 days**. An Admin must send a new invitation from **Settings → Team**. If SMTP is not configured, copy the `token` from the API response to share the link manually.

### Password reset link expired

Password reset links expire after **2 hours**. An Admin can request a new link from **Settings → Team → select member → Send password reset**.

## Viewing logs

To inspect relay activity:

```sh
tapflow logs
tapflow logs --lines 200
```
