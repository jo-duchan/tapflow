-- 022_build_version_override.sql
-- A build's version and build number can be set by a person (#1084). The values read from the build file stay in
-- version_name / build_number and never change after upload; what a person sets goes beside them, NULL meaning
-- "not overridden". Named _override rather than display_ (users.display_name): these values also decide the release
-- a build is grouped under, search, sorting, webhooks and MCP list_builds, not only what is shown.
--
-- The CHECKs keep NULL the only way to say "not overridden": an empty or blank string would be a third state.

ALTER TABLE builds ADD COLUMN version_name_override TEXT CHECK (trim(version_name_override) <> '');
ALTER TABLE builds ADD COLUMN build_number_override TEXT CHECK (trim(build_number_override) <> '');

-- The one place the value in use is made. Every read of a build goes through this view, so a query cannot forget
-- the override; the file's values are kept under binary_*. Nothing references a view, so a later migration that adds
-- a column to builds drops and recreates it.
CREATE VIEW builds_effective AS
SELECT
  id, app_id, bundle_id, status_label, file_path, label, version_label, uploader_id, uploaded_at, platform,
  completed_at, delete_after,
  COALESCE(version_name_override, version_name) AS version_name,
  COALESCE(build_number_override, build_number) AS build_number,
  version_name AS binary_version_name,
  build_number AS binary_build_number
FROM builds;
