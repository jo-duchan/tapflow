---
"tapflow": patch
---

feat(cli): setup highlights "open a new terminal" after registering ANDROID_HOME/PATH

When `tapflow setup android` adds `ANDROID_HOME`/PATH to your shell rc, the current shell doesn't pick them up — so running `tapflow doctor` right away showed confusing adb/AVD warnings. setup now prints a clear "open a new terminal (or run `exec zsh`), then `tapflow doctor`" note after the summary banner, only when the env was just registered.
