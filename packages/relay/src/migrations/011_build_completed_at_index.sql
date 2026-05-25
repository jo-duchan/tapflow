-- 010에서 인덱스가 누락된 기존 설치를 위한 보완 마이그레이션
CREATE INDEX IF NOT EXISTS idx_builds_completed_at ON builds(completed_at);
