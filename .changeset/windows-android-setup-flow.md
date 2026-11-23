---
"tapflow": minor
---

`tapflow setup android` now works on Windows without Android Studio. It reuses a JDK 17+ or installs
Temurin 21 (winget, or the checksummed zip from Adoptium), installs Google's command-line tools
(checksummed against the repository manifest), adds only the SDK packages that are missing, creates the
same `tapflow-*` AVDs as on macOS, and reports what `emulator -accel-check` says. It needs no
administrator rights and changes no Windows features. `tapflow setup android --yes` (`-y`) answers its
download, install and create-AVD prompts, also without a terminal. It never elevates, so it skips winget
and uses the per-user zip for a missing JDK. Off Windows, `--yes` is ignored with a warning; it never
answers sudo, the iOS steps or the network-filter approval.
