---
"tapflow": minor
---

feat(cli): add `tapflow setup ios` and unify the setup command

`tapflow setup ios` guides iOS environment setup: Homebrew → Xcode → Xcode activation → Simulator.

- **Xcode** — since Xcode is App-Store-only, an interactive flow opens the App Store and waits for you to finish installing, then re-checks. Non-interactive shells print the App Store link instead.
- **Xcode activation** — detects the "installed but not usable" case (active developer dir on CommandLineTools, missing license, or first-launch) and prints the exact `sudo xcode-select -s …` / `xcodebuild -license accept` / `-runFirstLaunch` commands (these need sudo, so setup guides rather than auto-runs them).
- **Simulator** — boots the first available simulator if none is running.

The `setup` command now takes an optional platform: `tapflow setup ios`, `tapflow setup android`, or `tapflow setup` to auto-detect and run every supported platform (iOS on macOS, Android when adb is found).

Closes #144 (and completes #142 together with `setup android`).
