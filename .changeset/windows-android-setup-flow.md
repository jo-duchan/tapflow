---
"tapflow": minor
---

`tapflow setup android` now works on Windows without Android Studio. It reuses a JDK 17+ or installs
Temurin 21 (winget, or the checksummed zip from Adoptium), installs Google's command-line tools
(checksummed against the repository manifest), adds only the SDK packages that are missing (retrying a dropped download up to three times), creates the
same `tapflow-*` AVDs as on macOS, and reports what `emulator -accel-check` says. As on macOS, it asks
before each download and install and runs only in an interactive terminal. It needs no administrator
rights and changes no Windows features. The Android Emulator does not run on Windows on Arm, so on such a
PC setup says so and downloads nothing.
