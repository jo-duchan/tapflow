---
"tapflow": patch
"@tapflowio/relay": patch
---

Further harden the relay for public exposure:

- CORS is restricted to the configured origins (public URL + loopback) instead of `*`, so an `Authorization` token can't be used from an unlisted cross-origin script.
- Cookie-authenticated state-changing requests must come from a same-origin or allowlisted origin (lightweight CSRF guard); PAT-authenticated requests are exempt.
- Invite links are built from the configured base URL (tunnel public URL / relay URL) instead of the request `Host` header.
- Uploads that exceed the size limit are rejected and their partial files removed (builds and comment attachments). Limits are configurable via `TAPFLOW_MAX_BUILD_BYTES` / `TAPFLOW_MAX_COMMENT_BYTES`.
