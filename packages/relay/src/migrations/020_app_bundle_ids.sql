-- 020_app_bundle_ids.sql
-- An app can have a different bundle ID on each platform (#1086). The IDs move from apps.bundle_id_key into their own
-- table, one row per (app, platform). Rules the table cannot hold are kept in code (api/builds.ts): an ID belongs to
-- one app whatever the platform, and an app has at most one ID per platform.
--
-- No table rebuild: migrations run in a transaction with foreign_keys on, where PRAGMA foreign_keys = OFF does
-- nothing, so dropping apps would fail on builds.app_id. DROP COLUMN needs SQLite 3.35.

CREATE TABLE app_bundle_ids (
  app_id    INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  platform  TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
  bundle_id TEXT NOT NULL,
  UNIQUE (bundle_id, platform)
);
CREATE INDEX idx_app_bundle_ids_app ON app_bundle_ids(app_id);

-- A key can sit on more than one row: POST /apps checked only (key, platform) before 2026-10-19, and 004 grouped
-- legacy rows by (key, platform), '__unknown__' included. The oldest row takes the key on every platform any of them
-- covered — the row upsertApp's `LIMIT 1` already sent uploads to. The others keep their builds and get no ID.
INSERT INTO app_bundle_ids (app_id, platform, bundle_id)
SELECT w.winner, p.platform, a.bundle_id_key
FROM apps a
JOIN (SELECT bundle_id_key AS k, MIN(id) AS winner FROM apps WHERE bundle_id_key IS NOT NULL GROUP BY bundle_id_key) w
  ON w.k = a.bundle_id_key
JOIN (SELECT 'ios' AS platform UNION ALL SELECT 'android') p
  ON a.platform = p.platform OR a.platform = 'both'
GROUP BY w.winner, p.platform, a.bundle_id_key;

UPDATE apps SET platform = 'both'
WHERE id IN (SELECT app_id FROM app_bundle_ids GROUP BY app_id HAVING COUNT(DISTINCT platform) = 2);

-- A build's platform is what its file is. The upload used to take a caller's `platform` field, 004 filled missing ones
-- with 'ios', and 007 copied the app's down — so an APK could be on record as iOS. Moving a platform's builds between
-- apps reads this column. Stored names keep the original extension.
UPDATE builds SET platform = CASE WHEN lower(file_path) LIKE '%.apk' THEN 'android' ELSE 'ios' END;

ALTER TABLE apps DROP COLUMN bundle_id_key;
