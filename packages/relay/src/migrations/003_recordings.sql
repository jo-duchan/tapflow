-- 003_recordings.sql
-- 클라이언트 녹화 히스토리: 팀원 누구나 TTL 72h 내 다운로드 가능

CREATE TABLE IF NOT EXISTS recordings (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  filename    TEXT NOT NULL UNIQUE,
  session_id  TEXT,
  uploader_id INTEGER REFERENCES users(id),
  file_size   INTEGER NOT NULL,
  mime        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL,
  events_path TEXT
);
