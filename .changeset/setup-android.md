---
"tapflow": minor
---

feat(cli): add `tapflow setup android` — guided Android environment setup

`tapflow doctor` diagnoses problems; `tapflow setup android` fixes them. It walks through the required Android dependencies and applies fixes where safe:

- **Homebrew** — checks `which brew`, prints the install URL if missing (cannot auto-install).
- **adb** — if present in PATH it passes; if found in a standard SDK location but missing from PATH it registers the `platform-tools` directory in your shell rc (`.zshrc`/`.bashrc`) inside an idempotent marker block; if absent it runs `brew install android-platform-tools`.
- **Android Studio** — checks `/Applications/Android Studio.app`; since the cask is large (~1GB+) it asks for confirmation before `brew install --cask android-studio`, and skips with guidance in non-interactive shells.
- **Emulator** — reports running emulators and hints how to start an AVD.

Each step is idempotent — re-running on a configured machine prints ✓ and makes no changes.
