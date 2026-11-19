---
"@tapflowio/ios-agent": patch
---

The injected library no longer reads a process's bundle with Objective-C before `main`: two simulator daemons (`fileproviderd`, `GSSCred`) aborted on it whenever Flow Capture or the network control named an app, and Safari and every web view stopped loading. A process outside an app bundle now stops at its path, and an app's identifier is read through CoreFoundation.
