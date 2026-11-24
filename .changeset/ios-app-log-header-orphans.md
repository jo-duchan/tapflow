---
'@tapflowio/ios-agent': patch
---

<!-- changelog: internal — fixes the iOS app log stream added in this unreleased cycle (#1132); the Unreleased "App logs are visible" entry already describes the feature as it now behaves -->

The iOS app log no longer starts with `log stream`'s own header ("Filtering the log data using …" and the column title), and a launch first ends any app log stream an earlier agent left running in that simulator, which otherwise ran until the simulator shut down (#1235).
