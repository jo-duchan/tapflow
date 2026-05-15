-- 009_agent_resources.sql
-- Mac 에이전트 CPU·RAM 시계열 데이터 — 1분 집계, 30일 보존

CREATE TABLE agent_resources (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_name  TEXT NOT NULL,
  cpu_percent REAL NOT NULL,
  mem_percent REAL NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_agent_resources_agent_at ON agent_resources (agent_name, recorded_at);
