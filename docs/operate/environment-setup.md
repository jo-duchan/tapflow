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
| Common | Node version, whether port 4000 is free |
| iOS | Xcode, `xcrun simctl`, an available simulator, network filter (installed state and version), network hook, Lean mode |
| Android | Android SDK, adb, build-tools (aapt), AVD, Lean mode |

Each item shows as **✓ ready**, **⚠ attention**, or **✗ needs install**. It does not check whether a device is running — booting happens automatically when someone opens a session in the dashboard, so a single bootable device is enough to pass.

The port check always looks at 4000, whatever port your config sets. If something already holds port 4000 (such as a relay on the default port), that check fails and doctor exits with code `1`, so run it with the relay stopped or ignore that line.

To parse the result from automation or CI, use `--json` for machine-readable output.

```sh
tapflow doctor --json
```

## tapflow setup

`tapflow setup` installs and configures whatever `doctor` reported as missing. Run it without an argument to detect the environment and set up every supported platform.

<VideoPlayer src="/media/tapflow-setup.mp4" />

```sh
tapflow setup
```

You can also target a single platform.

```sh
tapflow setup ios
tapflow setup android
```

setup is designed to finish in one run. For steps that require installation, it asks for consent in an interactive terminal and then runs the command for you; in non-interactive environments (CI and the like) it prints the command to run instead of installing, and the run ends with exit code `1` because the work is still outstanding.

### iOS

- **Homebrew** is installed if missing.
- **Xcode** can only be installed from the App Store, so setup opens the App Store and guides you. Press Enter after the install completes to continue.
- The **Xcode activation** step accepts the license and runs the first-launch setup (`xcode-select`, `xcodebuild -runFirstLaunch`) after consent. These steps require administrator (sudo) access.
- It downloads a **simulator runtime** when no device is available yet.
- **Audio permission**: requests the permission simulator audio capture needs, ahead of time. See [Audio](/testing/audio).
- **Network filter**: installs the filter that network control uses. See [Network Control](/testing/network-control).

### Android

- **Homebrew** is installed if missing; the JDK and SDK command-line tools steps below use it.
- **JDK**: installs a JDK with `brew install --cask temurin` if the one required to run the SDK tools is missing.
- **Android SDK**: builds a self-contained SDK at `~/Library/Android/sdk` with the command-line tools, platform-tools, emulator, build-tools (aapt), and a system image. The `aapt` from build-tools reads an APK's app name, version, and package name at upload time. The Android Studio GUI is not required.
- **AVDs**: creates four devices across form factors (compact phone, standard phone, large phone, tablet) so you can test across resolutions.

When setup adds `ANDROID_HOME` and PATH to your shell config, the current terminal doesn't pick them up. Open a new terminal (or run `exec $SHELL`), then verify with `tapflow doctor`.

## Booting is automatic

setup only goes as far as preparing a bootable device or AVD. The actual boot is handled by the relay when a teammate opens a QA session in the dashboard, so there's no need to launch a device yourself right after setup.
