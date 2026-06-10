---
"tapflow": patch
---

fix(cli): doctor no longer triggers the macOS "install Command Line Tools" popup

On a Mac without Xcode, `tapflow doctor` called `xcodebuild`/`xcrun`, which makes macOS pop up the Command Line Tools installer. doctor now checks for `/Applications/Xcode.app` first (no popup) and only invokes those tools when Xcode is present — otherwise it reports "Install Xcode / run tapflow setup ios" directly.
