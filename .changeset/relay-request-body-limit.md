---
"@tapflowio/relay": patch
---

A JSON request body is limited to 1 MiB and an invitation form to its own fields; a request over the limit is answered `413` instead of being read into memory whole.
