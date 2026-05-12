-- 004_app_build_split.sql
-- Phase 3 구조 정비: apps(앱 엔티티) + builds(빌드 산출물) 분리
-- 기존 apps 데이터를 builds로 이관, bundle_id 기준 apps row 자동 생성

PRAGMA foreign_keys = OFF;

-- Step 1. 기존 apps를 임시 테이블로 이동
ALTER TABLE apps RENAME TO _apps_v3_legacy;

-- Step 2. 새 apps 테이블 — 앱 엔티티
CREATE TABLE apps (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  bundle_id_key TEXT NOT NULL,
  platform      TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (bundle_id_key, platform)
);

-- Step 3. 앱 엔티티 생성 (bundle_id + platform 기준 dedup)
-- NULL bundle_id → '__unknown__' 그룹, NULL platform → 'ios' fallback
INSERT INTO apps (name, bundle_id_key, platform, created_at)
SELECT
  COALESCE(name, bundle_id, 'Unknown App') AS name,
  COALESCE(bundle_id, '__unknown__')       AS bundle_id_key,
  COALESCE(platform, 'ios')               AS platform,
  MIN(uploaded_at)                         AS created_at
FROM _apps_v3_legacy
GROUP BY COALESCE(bundle_id, '__unknown__'), COALESCE(platform, 'ios');

-- Step 4. builds 테이블
-- id는 기존 apps.id 보존 → comments.build_id FK 값 그대로 유지
CREATE TABLE builds (
  id            INTEGER PRIMARY KEY,
  app_id        INTEGER NOT NULL REFERENCES apps(id),
  version_name  TEXT,
  build_number  TEXT,
  bundle_id     TEXT,
  status_label  TEXT CHECK (status_label IN ('Backlog', 'In Progress', 'Done', 'Rejected')),
  file_path     TEXT NOT NULL,
  label         TEXT,
  version_label TEXT,
  uploader_id   INTEGER REFERENCES users(id),
  uploaded_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Step 5. 기존 데이터 이관
-- version_name / build_number는 이 이전 데이터에서 추출 불가 → NULL
INSERT INTO builds (
  id, app_id, version_name, build_number,
  bundle_id, status_label, file_path, label, version_label,
  uploader_id, uploaded_at
)
SELECT
  l.id,
  a.id,
  NULL,
  NULL,
  l.bundle_id,
  l.status_label,
  l.file_path,
  l.label,
  l.version_label,
  l.uploader_id,
  l.uploaded_at
FROM _apps_v3_legacy l
JOIN apps a
  ON  a.bundle_id_key = COALESCE(l.bundle_id, '__unknown__')
  AND a.platform      = COALESCE(l.platform, 'ios');

-- Step 6. comments 테이블을 builds(id) FK로 재생성
-- build_id 값은 builds.id = 구 apps.id 이므로 그대로 유효
CREATE TABLE _comments_rebuild (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  build_id    INTEGER NOT NULL REFERENCES builds(id) ON DELETE CASCADE,
  author_id   INTEGER NOT NULL REFERENCES users(id),
  body        TEXT NOT NULL,
  parent_id   INTEGER REFERENCES _comments_rebuild(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO _comments_rebuild SELECT * FROM comments;
DROP TABLE comments;
ALTER TABLE _comments_rebuild RENAME TO comments;

-- Step 7. legacy 삭제
DROP TABLE _apps_v3_legacy;

PRAGMA foreign_keys = ON;
