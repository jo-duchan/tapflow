---
'@tapflowio/relay': patch
---

The QA session's app log viewer keeps about the newest 50,000 lines instead of 64 KiB (fewer when lines are very long: the held lines are also capped at about 16 million characters), and mounts only the rows in view (#1233). The rows are their own chunk, loaded on launch; if it fails to load, the box says so instead of taking the page down. Scrolled up, the line being read stays put while lines are appended and the oldest dropped; Copy takes every held line, through the copy command on a page with no clipboard API.
