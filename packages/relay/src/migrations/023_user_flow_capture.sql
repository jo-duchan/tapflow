-- Flow Capture (#1125): whether the relay keeps a person's QA steps in memory so they can be saved as a flow.
-- On by default; each person may turn it off, whatever their role.
ALTER TABLE users ADD COLUMN flow_capture INTEGER NOT NULL DEFAULT 1 CHECK (flow_capture IN (0, 1));
