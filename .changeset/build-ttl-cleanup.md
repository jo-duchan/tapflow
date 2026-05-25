---
"@tapflowio/relay": patch
---

feat: auto-delete build files 7 days after done status

- Add `completed_at` column to builds table (migration 010)
- Record timestamp when build status changes to Done
- Block status changes on completed (Done) builds
- Run TTL cleanup on server start and every 24 hours
