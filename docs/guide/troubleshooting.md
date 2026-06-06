# Troubleshooting

## Agent connection issues

### Agent cannot connect to the relay

1. Verify the relay is running.
2. Check that the URL in the `--relay` option uses `ws://` — agents always connect over the local network.
3. Run `tapflow doctor` to inspect your environment.

### Connection drops when using a reverse proxy (nginx, etc.)

tapflow uses WebSocket for both the agent and the browser. nginx and similar reverse proxies do not handle HTTP upgrade by default.

Verify these headers are present in your nginx config:

```nginx
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
proxy_read_timeout 3600s;
```

See the configuration example in [Self-Hosting the Relay](/guide/self-hosting#nginx-example).

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

::: details Technical background
The Android emulator's H.264 encoder runs in software on the CPU. When the Mac throttles, the encoder can't keep up and fps drops. The iOS Simulator uses a hardware encoder (VideoToolbox) and is less affected.
:::

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

### Low FPS or stream stuttering

- Check the network quality between the relay and the agent.
- Check CPU and RAM usage for the affected Mac in the **Mac Resources** tab.
- Reduce the number of simulators running simultaneously on one Mac.

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
