# Troubleshooting

## Agent connection issues

### Agent cannot connect to the relay

1. Verify the relay is running.
2. Check that the URL in the `--relay` option is correct (`ws://` for local, `wss://` for TLS).
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

Occurs when the AVD uses the `google_apis_playstore` image. Recreate the AVD with the `google_apis/arm64-v8a` image:

```sh
sdkmanager "system-images;android-34;google_apis;arm64-v8a"
avdmanager create avd -n Pixel_8 -k "system-images;android-34;google_apis;arm64-v8a"
```

## `tapflow doctor` failures

### All iOS checks fail

The iOS agent only runs on macOS (Apple policy). You cannot start an iOS agent on Linux or Windows.

### `Xcode not found` or `xcrun simctl not found`

Xcode is installed but the command-line tools are not configured:

```sh
xcode-select --install
# or
sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer
```

### `adb not found`

The Android SDK's `platform-tools` are not in `$PATH`. Set `ANDROID_HOME`:

```sh
export ANDROID_HOME=$HOME/Library/Android/sdk
export PATH=$PATH:$ANDROID_HOME/platform-tools
```

## Session issues

### Session ends automatically

Sessions auto-close after 30 minutes of inactivity. This timeout cannot be changed from settings. Reconnect from the dashboard.

### Low FPS or stream stuttering

- Check the network quality between the relay and the agent.
- Check CPU and RAM usage for the affected Mac in the **Mac Resources** tab.
- Reduce the number of simulators running simultaneously on one Mac.

## Auth issues

### `tapflow init` fails (`Already initialized`)

`tapflow init` only works when no accounts exist. If an admin account already exists, sign in and invite teammates from **Settings → Team**.

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
