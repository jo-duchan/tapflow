-- 012_build_delete_after.sql
-- Decouple the deletion lifecycle from the "Done" review status (issue #258).
-- delete_after is the sole purge driver; status_label / completed_at no longer
-- schedule deletion. Deletion is now an explicit, manual action.

ALTER TABLE builds ADD COLUMN delete_after TEXT;
CREATE INDEX IF NOT EXISTS idx_builds_delete_after ON builds(delete_after);

-- Grandfather: builds already on the old deletion clock keep their schedule, so
-- upgrading doesn't silently stop reclaiming disk. 7 = the default
-- TAPFLOW_BUILD_TTL_DAYS at the time of this migration (pure SQL can't read env).
UPDATE builds
   SET delete_after = datetime(completed_at, '+7 days')
 WHERE completed_at IS NOT NULL;
