-- 001_initial.sql
-- 기본 스키마: apps, users, invitations, sessions, bug_reports, test_cases

CREATE TABLE IF NOT EXISTS apps (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  version     TEXT,
  bundle_id   TEXT,
  platform    TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
  file_path   TEXT NOT NULL,
  label       TEXT,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  email       TEXT NOT NULL UNIQUE,
  role        TEXT NOT NULL DEFAULT 'QA' CHECK (role IN ('Admin', 'Developer', 'QA', 'Viewer')),
  joined_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS invitations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  token       TEXT NOT NULL UNIQUE,
  email       TEXT,
  role        TEXT NOT NULL DEFAULT 'QA',
  expires_at  TEXT NOT NULL,
  used_at     TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id       TEXT NOT NULL,
  started_at      TEXT NOT NULL DEFAULT (datetime('now')),
  duration        INTEGER,
  recording_path  TEXT
);

CREATE TABLE IF NOT EXISTS bug_reports (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id      INTEGER REFERENCES sessions(id),
  screenshot_path TEXT,
  memo            TEXT,
  steps           TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS test_cases (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  steps       TEXT,
  result      TEXT,
  run_at      TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
