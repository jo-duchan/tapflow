---
"tapflow": patch
"@tapflowio/agent-core": patch
"@tapflowio/android-agent": patch
"@tapflowio/relay": patch
---

Windows hosts can find an Android SDK (#1100). `tapflow doctor`, `devices`, `reset` and `boot`, the
Android agent's registration and SDK lookup, and the relay's `aapt` lookup now probe `adb.exe`, `emulator.exe`,
`aapt.exe` and `sdkmanager.bat`, check `%LOCALAPPDATA%\Android\Sdk`, and search PATH without `which`. The agent's
one-per-machine claim uses a named pipe on Windows.

macOS and Linux behaviour is unchanged. Windows remains community-supported and is not verified by the maintainers.

agent-core exports the shared helpers from `@tapflowio/agent-core/utils`: `hostExecutableName`, `findOnPath`
and `androidSdkCandidates`.
