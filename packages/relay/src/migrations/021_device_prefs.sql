-- 021_device_prefs.sql
-- What people set on devices from the dashboard (#1085). Devices themselves are not stored — they live as sessions for
-- as long as their agent is connected — so these key on what identifies one across agent restarts: the Mac
-- (`agent_key`, its machine id or else its name, the identity the relay dedups agents by) and the device's own id
-- (a simulator's UDID, `avd:<name>` for an emulator). A row for a device that no longer exists is left alone: it does
-- no harm, and applies again if the same device comes back.

-- Team-wide, set by an Admin.
CREATE TABLE device_prefs (
  agent_key    TEXT NOT NULL,
  device_id    TEXT NOT NULL,
  hidden       INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
  display_name TEXT,
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (agent_key, device_id)
);

-- Per person.
CREATE TABLE device_favourites (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_key  TEXT NOT NULL,
  device_id  TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, agent_key, device_id)
);
