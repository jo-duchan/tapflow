---
title: Troubleshooting
description: Fixes for tapflow problems, grouped by area — install and agents, iOS simulator, Android emulator, builds, streaming, and sign-in — and how to read the relay's logs.
---

# Troubleshooting

Problems are grouped by area, one page each:

- [Install & agents](/troubleshooting/install-and-agents)
- [iOS simulator](/troubleshooting/ios-simulator)
- [Android emulator](/troubleshooting/android-emulator)
- [Builds & uploads](/troubleshooting/builds)
- [Stream & sessions](/troubleshooting/streaming)
- [Sign-in & accounts](/troubleshooting/accounts)

## Viewing logs

On the relay host, inspect its activity with the commands below. The relay does not show its logs to other machines.

```sh
tapflow logs
tapflow logs --lines 200
```

Running under Docker, a CLI outside the container counts as remote; use `docker compose logs` instead.

## Moved sections {#moved-sections}

Sections that used to be on this page now live on these pages.

- [Install & agents](/troubleshooting/install-and-agents)
  - <a id="agent-connection-issues" data-moved-to="/troubleshooting/install-and-agents#agent-connection-issues"></a>[Agent connection issues](/troubleshooting/install-and-agents#agent-connection-issues)
  - <a id="agent-already-running" data-moved-to="/troubleshooting/install-and-agents#agent-already-running"></a>[It says an agent is already running](/troubleshooting/install-and-agents#agent-already-running)
  - <a id="agent-cannot-connect-to-the-relay" data-moved-to="/troubleshooting/install-and-agents#agent-cannot-connect-to-the-relay"></a>[Agent cannot connect to the relay](/troubleshooting/install-and-agents#agent-cannot-connect-to-the-relay)
  - <a id="tapflow-doctor-failures" data-moved-to="/troubleshooting/install-and-agents#tapflow-doctor-failures"></a>[`tapflow doctor` failures](/troubleshooting/install-and-agents#tapflow-doctor-failures)
  - <a id="all-ios-checks-fail" data-moved-to="/troubleshooting/install-and-agents#all-ios-checks-fail"></a>[All iOS checks fail](/troubleshooting/install-and-agents#all-ios-checks-fail)
  - <a id="xcode-not-found-—-xcode-is-not-installed" data-moved-to="/troubleshooting/install-and-agents#xcode-not-found-—-xcode-is-not-installed"></a>[`Xcode not found` — Xcode is not installed](/troubleshooting/install-and-agents#xcode-not-found-—-xcode-is-not-installed)
  - <a id="xcode-not-found-—-xcode-is-installed-but-xcode-select-is-not-configured" data-moved-to="/troubleshooting/install-and-agents#xcode-not-found-—-xcode-is-installed-but-xcode-select-is-not-configured"></a>[`Xcode not found` — Xcode is installed but `xcode-select` is not configured](/troubleshooting/install-and-agents#xcode-not-found-—-xcode-is-installed-but-xcode-select-is-not-configured)
  - <a id="no-simulator-is-running" data-moved-to="/troubleshooting/install-and-agents#no-simulator-is-running"></a>[No simulator is running](/troubleshooting/install-and-agents#no-simulator-is-running)
  - <a id="adb-not-found" data-moved-to="/troubleshooting/install-and-agents#adb-not-found"></a>[`adb not found`](/troubleshooting/install-and-agents#adb-not-found)
  - <a id="tapflow-init-says-config-kept" data-moved-to="/troubleshooting/install-and-agents#tapflow-init-says-config-kept"></a>[`tapflow init` says `CONFIG KEPT`](/troubleshooting/install-and-agents#tapflow-init-says-config-kept)
  - <a id="the-relay-is-using-a-configuration-or-database-you-did-not-expect" data-moved-to="/troubleshooting/install-and-agents#the-relay-is-using-a-configuration-or-database-you-did-not-expect"></a>[The relay is using a configuration or database you did not expect](/troubleshooting/install-and-agents#the-relay-is-using-a-configuration-or-database-you-did-not-expect)
- [iOS simulator](/troubleshooting/ios-simulator)
  - <a id="spawn-unknown-error" data-moved-to="/troubleshooting/ios-simulator#spawn-unknown-error"></a>[Opening a build fails with `spawn unknown error`](/troubleshooting/ios-simulator#spawn-unknown-error)
  - <a id="ios-simulator-service-version-mismatch" data-moved-to="/troubleshooting/ios-simulator#ios-simulator-service-version-mismatch"></a>[iOS Simulator service version mismatch](/troubleshooting/ios-simulator#ios-simulator-service-version-mismatch)
  - <a id="simulator-data-missing" data-moved-to="/troubleshooting/ios-simulator#simulator-data-missing"></a>[iOS Simulator fails to boot — "cannot be located on disk"](/troubleshooting/ios-simulator#simulator-data-missing)
  - <a id="ios-17-and-earlier-—-korean-text-splits-into-individual-characters" data-moved-to="/troubleshooting/ios-simulator#ios-17-and-earlier-—-korean-text-splits-into-individual-characters"></a>[iOS 17 and earlier — Korean text splits into individual characters](/troubleshooting/ios-simulator#ios-17-and-earlier-—-korean-text-splits-into-individual-characters)
- [Builds & uploads](/troubleshooting/builds)
  - <a id="ios-build-upload-errors" data-moved-to="/troubleshooting/builds#ios-build-upload-errors"></a>[iOS build upload errors](/troubleshooting/builds#ios-build-upload-errors)
  - <a id="_400-error-on-upload" data-moved-to="/troubleshooting/builds#_400-error-on-upload"></a>[`400` error on upload](/troubleshooting/builds#_400-error-on-upload)
  - <a id="install-failed-no-matching-abis-—-apk-not-compatible-with-apple-silicon-emulator" data-moved-to="/troubleshooting/builds#install-failed-no-matching-abis-—-apk-not-compatible-with-apple-silicon-emulator"></a>[`INSTALL_FAILED_NO_MATCHING_ABIS` — APK not compatible with Apple Silicon emulator](/troubleshooting/builds#install-failed-no-matching-abis-—-apk-not-compatible-with-apple-silicon-emulator)
  - <a id="an-apk-upload-shows-as-unversioned-or-merges-into-the-wrong-app" data-moved-to="/troubleshooting/builds#an-apk-upload-shows-as-unversioned-or-merges-into-the-wrong-app"></a>[An APK upload shows as 'Unversioned' or merges into the wrong app](/troubleshooting/builds#an-apk-upload-shows-as-unversioned-or-merges-into-the-wrong-app)
- [Android emulator](/troubleshooting/android-emulator)
  - <a id="android-emulator-issues" data-moved-to="/troubleshooting/android-emulator"></a>[Android emulator issues](/troubleshooting/android-emulator)
  - <a id="stream-does-not-start-or-encoder-crashes" data-moved-to="/troubleshooting/android-emulator#stream-does-not-start-or-encoder-crashes"></a>[Stream does not start or encoder crashes](/troubleshooting/android-emulator#stream-does-not-start-or-encoder-crashes)
  - <a id="colors-look-different-from-the-emulator-less-saturated" data-moved-to="/troubleshooting/android-emulator#colors-look-different-from-the-emulator-less-saturated"></a>[Colors look different from the emulator (less saturated)](/troubleshooting/android-emulator#colors-look-different-from-the-emulator-less-saturated)
  - <a id="emulator-is-slow-when-the-mac-is-unattended" data-moved-to="/troubleshooting/android-emulator#emulator-is-slow-when-the-mac-is-unattended"></a>[Emulator is slow when the Mac is unattended](/troubleshooting/android-emulator#emulator-is-slow-when-the-mac-is-unattended)
- [iOS network extension](/operate/network-extension)
  - <a id="network-not-set-up" data-moved-to="/operate/network-extension#network-not-set-up"></a>[iOS: the network extension is not installed](/operate/network-extension#network-not-set-up)
  - <a id="_1-install-it" data-moved-to="/operate/network-extension#_1-install-it"></a>[1. Install it](/operate/network-extension#_1-install-it)
  - <a id="_2-approve-it" data-moved-to="/operate/network-extension#_2-approve-it"></a>[2. Approve it](/operate/network-extension#_2-approve-it)
  - <a id="_3-when-a-restart-is-needed" data-moved-to="/operate/network-extension#_3-when-a-restart-is-needed"></a>[3. When a restart is needed](/operate/network-extension#_3-when-a-restart-is-needed)
  - <a id="checking-what-the-mac-has" data-moved-to="/operate/network-extension#checking-what-the-mac-has"></a>[Checking what the Mac has](/operate/network-extension#checking-what-the-mac-has)
  - <a id="if-it-still-does-not-work" data-moved-to="/operate/network-extension#if-it-still-does-not-work"></a>[If it still does not work](/operate/network-extension#if-it-still-does-not-work)
  - <a id="network-lost-on-replace" data-moved-to="/operate/network-extension#network-lost-on-replace"></a>[iOS: the Mac lost its network while the filter was being replaced](/operate/network-extension#network-lost-on-replace)
  - <a id="network-stopped" data-moved-to="/operate/network-extension#network-stopped"></a>[iOS: a device that was offline came back on the network by itself](/operate/network-extension#network-stopped)
- [Stream & sessions](/troubleshooting/streaming)
  - <a id="session-issues" data-moved-to="/troubleshooting/streaming#session-issues"></a>[Session issues](/troubleshooting/streaming#session-issues)
  - <a id="session-ends-automatically" data-moved-to="/troubleshooting/streaming#session-ends-automatically"></a>[Session ends automatically](/troubleshooting/streaming#session-ends-automatically)
  - <a id="stream-lag" data-moved-to="/troubleshooting/streaming#stream-lag"></a>[Stream lag or stuttering](/troubleshooting/streaming#stream-lag)
  - <a id="prefer-a-wired-lan" data-moved-to="/troubleshooting/streaming#prefer-a-wired-lan"></a>[Prefer a wired LAN](/troubleshooting/streaming#prefer-a-wired-lan)
  - <a id="periodic-hitching-every-0-5s-on-wi-fi-awdl" data-moved-to="/troubleshooting/streaming#periodic-hitching-every-0-5s-on-wi-fi-awdl"></a>[Periodic hitching every ~0.5s on Wi-Fi (AWDL)](/troubleshooting/streaming#periodic-hitching-every-0-5s-on-wi-fi-awdl)
  - <a id="host-cpu-ram-pressure" data-moved-to="/troubleshooting/streaming#host-cpu-ram-pressure"></a>[Host CPU / RAM pressure](/troubleshooting/streaming#host-cpu-ram-pressure)
  - <a id="display-sleep" data-moved-to="/troubleshooting/streaming#display-sleep"></a>[Display sleep](/troubleshooting/streaming#display-sleep)
  - <a id="blurry-or-low-resolution-stream-on-lan" data-moved-to="/troubleshooting/streaming#blurry-or-low-resolution-stream-on-lan"></a>[Blurry or low-resolution stream on LAN](/troubleshooting/streaming#blurry-or-low-resolution-stream-on-lan)
- [Sign-in & accounts](/troubleshooting/accounts)
  - <a id="auth-issues" data-moved-to="/troubleshooting/accounts"></a>[Auth issues](/troubleshooting/accounts)
  - <a id="tapflow-admin-init-fails-already-initialized" data-moved-to="/troubleshooting/accounts#tapflow-admin-init-fails-already-initialized"></a>[`tapflow admin init` fails (`Already initialized`)](/troubleshooting/accounts#tapflow-admin-init-fails-already-initialized)
  - <a id="invitation-link-expired" data-moved-to="/troubleshooting/accounts#invitation-link-expired"></a>[Invitation link expired](/troubleshooting/accounts#invitation-link-expired)
  - <a id="password-reset-link-expired" data-moved-to="/troubleshooting/accounts#password-reset-link-expired"></a>[Password reset link expired](/troubleshooting/accounts#password-reset-link-expired)
