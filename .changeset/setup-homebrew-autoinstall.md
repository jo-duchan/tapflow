---
"tapflow": minor
---

feat(cli): `tapflow setup` can install Homebrew after confirmation

When Homebrew is missing, `tapflow setup android` (and upcoming `setup ios`) now offers to install it via the official script after an explicit confirmation prompt, instead of only printing the install URL. In non-interactive shells it still just prints guidance — no remote script runs without consent. This makes Homebrew the shared first step for all platform setups.
