---
type: rationale
topics: [android, setup, sdk]
status: stable
---

# Why `setup android` bootstraps a self-contained SDK

> Read this before changing how `setup android` installs the Android toolchain, or
> before reintroducing an "install Android Studio" step. The design trades a familiar
> GUI install for a deterministic, unattended one on purpose.

## The problem

During prerelease validation, `setup android` reported `Android Studio installed ✓` yet
AVD creation failed with `SETUP INCOMPLETE — AVD`. The root cause: **installing
Android Studio.app is not the same as installing the SDK.** The SDK is a manual step on
the GUI's first run, so a headless setup cannot depend on Android Studio being enough.

So setup stopped relying on Android Studio and instead builds the SDK directly through
`cmdline-tools`, deterministically, with no GUI interaction.

## The real insight — three causes of a fragile Android setup

Verified by research (Flutter, React Native, GitHub Actions) plus measurement on a clean
Mac, not by guessing:

1. **No JDK.** Unattended `cmdline-tools` install is the CI standard, but it assumes a
   JDK; a clean Mac has none, and `sdkmanager` cannot run without it.
2. **Unaccepted licenses.** `sdkmanager` refuses to install components until licenses are
   accepted.
3. **Split paths.** `brew --cask android-commandlinetools` puts `sdkmanager`/`avdmanager`
   in `/opt/homebrew/bin` but defaults the SDK root to `/opt/homebrew/share/...`, a
   non-standard location that later commands do not expect.

Setup removes all three by control rather than leaving them to the environment.

## The decisions

- **JDK**: install `temurin` (via cask) when `/usr/libexec/java_home` fails.
- **Fixed SDK path**: `~/Library/Android/sdk` (`ANDROID_SDK_DIR`). The brew non-standard
  path is never used.
- **Self-contained**: install `cmdline-tools;latest` *inside* that SDK, then use only the
  SDK-internal `sdkmanager`/`avdmanager`. This is what makes the split-path problem
  disappear.
- **Auto-accept licenses** non-interactively.
- **Image**: `google_apis`, not `google_apis_playstore` — the Play Store image crashes
  under tapflow's use.
- **adb**: taken from the SDK's `platform-tools`; the separate brew step is dropped.
- **No boot**: the emulator is started on demand by the relay, not by setup.

## Verified unattended sequence

This is the sequence the setup code encodes. It is kept here because it is a reproducible
spec, not visible from reading `lib/setup.ts` alone:

```sh
brew install --cask temurin                  # 1) JDK — sdkmanager cannot run without it
brew install --cask android-commandlinetools # 2) bootstrap sdkmanager (/opt/homebrew/bin)
# 3) self-contained SDK — putting cmdline-tools inside the SDK is what resolves split paths
yes | sdkmanager --sdk_root="$HOME/Library/Android/sdk" --licenses
sdkmanager --sdk_root="$HOME/Library/Android/sdk" \
  "cmdline-tools;latest" "platform-tools" "emulator" "system-images;android-35;google_apis;arm64-v8a"
# 4) from here every command uses the SDK-internal binary (SDK root auto-detected)
"$HOME/Library/Android/sdk/cmdline-tools/latest/bin/avdmanager" create avd \
  -n tapflow-phone -k "system-images;android-35;google_apis;arm64-v8a" -d pixel_7 --force <<< "no"
"$HOME/Library/Android/sdk/emulator/emulator" -list-avds   # → AVD is listed
```

The example shows the Apple Silicon ABI (`arm64-v8a`); the setup code derives it from the
host arch and uses `x86_64` on an Intel Mac, so the image name is not actually hardcoded.
