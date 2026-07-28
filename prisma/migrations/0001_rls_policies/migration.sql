-- Run after `prisma db push` to enable Row Level Security.
-- Every policy checks that the row's org_id matches app.org_id set by the API layer.
-- The API sets it via: SET LOCAL app.org_id = '<uuid>';

-- Enable RLS on every business table
ALTER TABLE orgs           ENABLE ROW LEVEL SECURITY;
ALTER TABLE users          ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects       ENABLE ROW LEVEL SECURITY;
ALTER TABLE meetings       ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_areas  ENABLE ROW LEVEL SECURITY;
ALTER TABLE minutes        ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log      ENABLE ROW LEVEL SECURITY;

-- Helper: returns the currently-scoped org id as a UUID
CREATE OR REPLACE FUNCTION current_org_id() RETURNS uuid AS $$
  SELECT NULLIF(current_setting('app.org_id', true), '')::uuid;
$$ LANGUAGE sql STABLE;

-- Every user only sees their own org's rows
CREATE POLICY orgs_read       ON orgs          FOR SELECT USING (id = current_org_id());

CREATE POLICY users_all       ON users         FOR ALL    USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());
CREATE POLICY projects_all    ON projects      FOR ALL    USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());
CREATE POLICY meetings_all    ON meetings      FOR ALL    USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());
CREATE POLICY areas_all       ON meeting_areas FOR ALL    USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());
CREATE POLICY minutes_all     ON minutes       FOR ALL    USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());
CREATE POLICY audit_read      ON audit_log     FOR SELECT USING (org_id = current_org_id());
CREATE POLICY audit_insert    ON audit_log     FOR INSERT WITH CHECK (org_id = current_org_id());
