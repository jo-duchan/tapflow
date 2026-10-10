-- 015_flow_runs.sql
-- A record of each `tapflow flow run`: the runs page lists them (in progress and history), and a build's
-- runs go when the build goes. Written by the CLI over REST with a `builds:write` token.

CREATE TABLE IF NOT EXISTS flow_runs (
  -- `seq` orders and pages the list; `id` is what clients see, so a run's address does not count runs.
  seq              INTEGER PRIMARY KEY AUTOINCREMENT,
  id               TEXT NOT NULL UNIQUE,
  -- No ON DELETE: a build's runs are removed with it by `deleteBuildsWithDependents`, which also unlinks
  -- their screenshot files. A cascade would drop the rows and leave the files.
  build_id         INTEGER REFERENCES builds(id),
  -- The runner's `?client=` id. The run is live while a socket with that id is open — see `holderKeys`.
  holder_client    TEXT NOT NULL,
  -- SET NULL: removing a member keeps the team's history. Their PATs are gone, so nobody can write to it.
  created_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  -- Not a foreign key: revoking a token deletes its row, and the run must outlive that.
  pat_id           INTEGER,
  is_ci            INTEGER NOT NULL DEFAULT 0,
  ci_provider      TEXT,
  ci_branch        TEXT,
  ci_commit        TEXT,
  ci_job_url       TEXT,
  status           TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'passed', 'failed', 'aborted')),
  -- 'client' when the CLI finished it, 'relay' when the relay closed it because the holder went away.
  finished_by      TEXT CHECK (finished_by IN ('client', 'relay')),
  failure_kind     TEXT,
  error_message    TEXT,
  exit_code        INTEGER,
  flows_json       TEXT NOT NULL,
  flows_total      INTEGER NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  last_activity_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at      TEXT,
  -- Only for a run with no build; a build's runs follow the build's own lifecycle.
  delete_after     TEXT
);

CREATE INDEX IF NOT EXISTS idx_flow_runs_build ON flow_runs(build_id);
CREATE INDEX IF NOT EXISTS idx_flow_runs_ci ON flow_runs(is_ci, seq);
CREATE INDEX IF NOT EXISTS idx_flow_runs_status ON flow_runs(status, last_activity_at);
CREATE INDEX IF NOT EXISTS idx_flow_runs_delete_after ON flow_runs(delete_after);

CREATE TABLE IF NOT EXISTS flow_run_flows (
  run_seq          INTEGER NOT NULL REFERENCES flow_runs(seq) ON DELETE CASCADE,
  idx              INTEGER NOT NULL,
  name             TEXT NOT NULL,
  file             TEXT,
  device_id        TEXT,
  device_name      TEXT,
  platform         TEXT,
  status           TEXT NOT NULL CHECK (status IN ('passed', 'failed')),
  failure_kind     TEXT,
  failure_message  TEXT,
  duration_ms      INTEGER NOT NULL,
  steps_json       TEXT NOT NULL,
  screenshot_file  TEXT,
  screenshot_mime  TEXT,
  PRIMARY KEY (run_seq, idx)
);
