-- 002_dashboard_foundation.sql
-- Phase 2 dashboard 기반: App Center 태그, 코멘트, PAT, 팀 설정

-- apps 테이블 확장
ALTER TABLE apps ADD COLUMN status_label TEXT CHECK (
  status_label IN ('Backlog', 'In Progress', 'Done', 'Rejected')
) DEFAULT NULL;
ALTER TABLE apps ADD COLUMN version_label TEXT DEFAULT NULL;
ALTER TABLE apps ADD COLUMN uploader_id INTEGER REFERENCES users(id);

-- users 테이블 확장
ALTER TABLE users ADD COLUMN password_hash TEXT;
ALTER TABLE users ADD COLUMN display_name TEXT;

-- 빌드별 QA 코멘트
CREATE TABLE IF NOT EXISTS comments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  build_id    INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  author_id   INTEGER NOT NULL REFERENCES users(id),
  body        TEXT NOT NULL,
  parent_id   INTEGER REFERENCES comments(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 코멘트 첨부 이미지
CREATE TABLE IF NOT EXISTS comment_attachments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  comment_id  INTEGER NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  file_path   TEXT NOT NULL,
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL
);

-- API 배포용 Personal Access Token
CREATE TABLE IF NOT EXISTS personal_access_tokens (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  scope        TEXT NOT NULL DEFAULT 'builds:write',
  last_used_at TEXT,
  expires_at   TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 팀 설정 (singleton row, id=1 고정)
CREATE TABLE IF NOT EXISTS team_settings (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  team_name  TEXT NOT NULL DEFAULT 'tapflow',
  logo_path  TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO team_settings (id, team_name) VALUES (1, 'tapflow');
