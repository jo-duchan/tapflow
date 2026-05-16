# Android Agent Setup

The Android agent uses ADB and scrcpy to stream emulator screens.

## Prerequisites

- Android SDK installed (`ANDROID_HOME` set or `adb` in `$PATH`)
- An AVD using the `google_apis/arm64-v8a` system image (android-34)

::: warning AVD image matters
Use `google_apis/arm64-v8a` — **not** `google_apis_playstore`. The Play Store image causes the H.264 encoder to crash silently.
:::

## Create an AVD

Create an AVD using Android Studio's AVD Manager. See [Create and manage virtual devices](https://developer.android.com/studio/run/managing-avds) for a step-by-step guide. When selecting the system image, choose `google_apis/arm64-v8a` (android-34).

You can also create one from the command line:

```sh
sdkmanager "system-images;android-34;google_apis;arm64-v8a"
avdmanager create avd -n Pixel_8 -k "system-images;android-34;google_apis;arm64-v8a"
```

## Start the agent

```sh
tapflow agent start --platform android --relay wss://your-relay-url
```

The agent boots the emulator automatically, waits for `sys.boot_completed`, then begins streaming.

To start both iOS and Android agents together:

```sh
tapflow agent start --relay wss://your-relay-url
```

## Troubleshooting

```sh
tapflow doctor
# Common
#   ✓ Node v20.x
#
# Android
#   ✓ adb found: /usr/local/bin/adb
#   ✓ AVD: Pixel_8 (android-34 · google_apis/arm64-v8a)
```

See [Troubleshooting](/guide/troubleshooting) for more detailed solutions.
