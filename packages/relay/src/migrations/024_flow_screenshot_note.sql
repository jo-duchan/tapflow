-- Why a flow that ran has no screenshot, so the Flow Runs page can say it instead of leaving a gap (2026-11-22).
-- Written by the relay where it refuses the upload (too large, not an image, no disk room), or from the runner's report
-- when it tried to take one and got nothing. Cleared when a screenshot is stored. NULL is "nothing to say".
ALTER TABLE flow_run_flows ADD COLUMN screenshot_note TEXT
  CHECK (screenshot_note IN ('too-large', 'not-image', 'storage-full', 'not-taken'));
