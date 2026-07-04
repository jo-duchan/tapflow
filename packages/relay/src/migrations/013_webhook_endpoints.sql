-- 013_webhook_endpoints.sql
-- Outbound webhooks: notify registered URLs when a build's review status
-- transitions to Done/Rejected. Payload carries metadata only (build id, status,
-- platform, version) — never app binaries or screen data (see AGENTS.md).
-- secret is optional; when set, deliveries are HMAC-SHA256 signed.

CREATE TABLE webhook_endpoints (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  url        TEXT NOT NULL,
  secret     TEXT,
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
