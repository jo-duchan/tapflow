---
title: Builds & uploads
description: iOS upload errors (.ipa vs .app.zip), INSTALL_FAILED_NO_MATCHING_ABIS on Apple Silicon, and an APK that shows as Unversioned or merges into the wrong app.
---

# Builds & uploads

## iOS build upload errors

### `400` error on upload

| Cause | Fix |
|-------|-----|
| `.ipa` file uploaded | `.ipa` is for real devices. Build with `xcodebuild -sdk iphonesimulator` and zip the `.app` folder. |
| `.app` not at the zip root | Extracting the zip must produce `MyApp.app` directly — not inside a subfolder. |
| Device-only slices | Confirm it is a simulator build. `lipo -info MyApp.app/MyApp` must include `x86_64` or `arm64` (simulator). |

## `INSTALL_FAILED_NO_MATCHING_ABIS` — APK not compatible with Apple Silicon emulator

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

## An APK upload shows as 'Unversioned' or merges into the wrong app

The relay reads an APK's app name, version, and package name with `aapt` from the Android build-tools. Without build-tools it can't read them, so the build is stored with no version or package name.

- An upload that specifies an `app_id` is rejected with `400` in this case, so an unidentifiable build can't be filed under the app you named.
- `tapflow doctor` flags this as a warning on the Android `aapt (build-tools)` check.

Install build-tools on the machine that runs the relay to fix it.

```sh
tapflow setup android
```

If you've already run `tapflow setup`, run it again to add build-tools. To install by hand, use `sdkmanager --sdk_root="$ANDROID_HOME" "build-tools;35.0.0"`.

If build-tools is already installed and a targeted upload still returns `400`, the APK itself is likely corrupt or not a valid package — rebuild or re-export it. `aapt dump badging your-app.apk` should print a `package: name=...` line for a valid APK.
