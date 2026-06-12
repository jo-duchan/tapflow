---
"tapflow": patch
"@tapflowio/relay": patch
---

Harden the relay for public and proxied exposure:

- A per-install JWT secret is generated and persisted automatically when `JWT_SECRET` is unset, replacing the shared development default.
- Authentication endpoints apply rate limiting with exponential backoff.
- Bootstrap (`auth/init`) is restricted to localhost — on headless servers, run `tapflow admin init` on the relay host.
- New `TAPFLOW_TRUSTED_PROXIES` resolves the real client IP from `X-Forwarded-For` when the relay runs behind a same-host reverse proxy.
