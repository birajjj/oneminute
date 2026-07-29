-- Governance classification flag for minutes (Governance | Decision | Scope).
-- Ports the on-prem OneMinute minute-flag concept so decisions and scope items
-- can be found across meetings. The column is nullable (null = unflagged), so
-- existing rows need no backfill.
--
-- No new RLS policy is required: the existing minutes_all policy (see
-- 0001_rls_policies) is FOR ALL and covers every column of this table.

CREATE TYPE "MinuteFlag" AS ENUM ('Governance', 'Decision', 'Scope');

ALTER TABLE minutes ADD COLUMN flag "MinuteFlag";

-- Keep "find all decisions / scope items in this org" queries index-backed.
CREATE INDEX minutes_org_id_flag_idx ON minutes (org_id, flag);
