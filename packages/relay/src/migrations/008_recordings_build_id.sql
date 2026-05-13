-- 008_recordings_build_id.sql
-- recordings에 build_id 추가 — 빌드 기준 필터링을 위해

ALTER TABLE recordings ADD COLUMN build_id INTEGER REFERENCES builds(id);
