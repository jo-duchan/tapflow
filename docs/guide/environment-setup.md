# Environment Setup

The Mac that will run an agent needs an environment that can launch iOS simulators or Android emulators. Use `tapflow doctor` to diagnose the current state, and `tapflow setup` to install and configure whatever is missing.

## tapflow doctor

`tapflow doctor` checks whether the environment is ready.

```sh
tapflow doctor
```

Pass a platform to check only that one.

```sh
tapflow doctor ios
tapflow doctor android
```

It checks the following:

| Area | Checks |
|------|--------|
| Common | Node version |
| iOS | Xcode, `xcrun simctl`, an available simulator |
| Android | Android SDK, adb, build-tools (aapt), AVD |

Each item shows as **✓ ready**, **⚠ attention**, or **✗ needs install**. It does not check whether a device is running — booting happens automatically when someone opens a session in the dashboard, so a single bootable device is enough to pass.

To parse the result from automation or CI, use `--json` for machine-readable output.

```sh
tapflow doctor --json
```

## tapflow setup

`tapflow setup` installs and configures whatever `doctor` reported as missing. Run it without an argument to detect the environment and set up every supported platform.

<VideoPlayer src="/tapflow-setup.mp4" />

```sh
tapflow setup
```

You can also target a single platform.

```sh
tapflow setup ios
tapflow setup android
```

setup is designed to finish in one run. For steps that require installation, it asks for consent in an interactive terminal and then runs the command for you; in non-interactive environments (CI and the like) it prints the command to run instead of installing.

### iOS

- **Xcode** can only be installed from the App Store, so setup opens the App Store and guides you. Press Enter after the install completes to continue.
- The **Xcode activation** step accepts the license and runs the first-launch setup (`xcode-select`, `xcodebuild -runFirstLaunch`) after consent. These steps require administrator (sudo) access.
- It downloads a **simulator runtime** when no device is available yet.

### Android

- **JDK**: installs a JDK if the one required to run the SDK tools is missing.
- **Android SDK**: builds a self-contained SDK at `~/Library/Android/sdk` with the command-line tools, platform-tools, emulator, build-tools (aapt), and a system image. The `aapt` from build-tools reads an APK's app name, version, and package name at upload time. The Android Studio GUI is not required.
- **AVDs**: creates four devices across form factors (compact phone, standard phone, large phone, tablet) so you can test across resolutions.

When setup adds `ANDROID_HOME` and PATH to your shell config, the current terminal doesn't pick them up. Open a new terminal (or run `exec $SHELL`), then verify with `tapflow doctor`.

## Booting is automatic

setup only goes as far as preparing a bootable device or AVD. The actual boot is handled by the relay when a teammate opens a QA session in the dashboard, so there's no need to launch a device yourself right after setup.
