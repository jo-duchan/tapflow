---
"tapflow": patch
---

`tapflow setup android` on Windows retries `sdkmanager` up to three times when a package download drops, and only retries packages that are still missing. A single dropped system-image transfer no longer fails the whole setup.
