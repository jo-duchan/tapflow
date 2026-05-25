-- 010_build_completed_at.sql
-- Done 상태 전환 시각 기록 → 7일 TTL 자동 삭제에 사용

ALTER TABLE builds ADD COLUMN completed_at TEXT;
CREATE INDEX IF NOT EXISTS idx_builds_completed_at ON builds(completed_at);
