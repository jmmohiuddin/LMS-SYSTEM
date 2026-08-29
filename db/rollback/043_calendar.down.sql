-- Rollback for 043 — the editable academic calendar (R-4).
--
-- Loses two things, and the second is the dangerous one.
--
-- DATA: `description_bn` and `created_by` on every calendar entry. The
-- entries themselves survive; only the body text and the attribution go.
--
-- SAFETY: dropping the write policies returns `calendar_days` to
-- tenant-isolated-but-not-role-scoped — the state it was in from migration
-- 003 until 043, where any authenticated session in a school could insert
-- kind='holiday' and silently suppress the whole institution's attendance
-- SMS for that day. That was harmless only because nothing in the product
-- wrote to the table. After R-4 there is a screen, so this rollback is safe
-- ONLY if ops-svc/api/calendar.ts is rolled back with it — which a code
-- deploy does and a database-only rollback does not.
--
-- The UNIQUE constraint narrows back to one entry per (day, kind), so any
-- school that recorded two events on one date loses all but one of them.
-- Those rows are deleted first, deterministically (oldest kept), because the
-- constraint cannot be restored while they exist.

BEGIN;

-- Narrow notices.source_kind back to 040's three values. Any notice raised
-- from a calendar entry must lose its provenance first, or the CHECK cannot
-- be restored — the notice itself stays, because it was really delivered and
-- people really read it; only the link back to the calendar entry goes.
UPDATE notices SET source_kind = NULL, source_ref = NULL WHERE source_kind = 'calendar';

ALTER TABLE notices DROP CONSTRAINT IF EXISTS notices_source_kind_check;
ALTER TABLE notices
  ADD CONSTRAINT notices_source_kind_check
  CHECK (source_kind IS NULL
         OR source_kind IN ('exam_routine', 'result', 'invoice'));

DROP POLICY IF EXISTS calendar_delete_scope ON calendar_days;
DROP POLICY IF EXISTS calendar_update_scope ON calendar_days;
DROP POLICY IF EXISTS calendar_insert_scope ON calendar_days;

DROP TRIGGER IF EXISTS trg_caldays_touch ON calendar_days;
DROP INDEX  IF EXISTS ix_calendar_range;

-- Collapse to one entry per (tenant, year, day, kind) before restoring the
-- old constraint. Keeping the earliest is arbitrary but deterministic, which
-- matters more than which one survives: a rollback that picks differently on
-- two replicas is worse than one that loses a predictable row.
DELETE FROM calendar_days c
 USING calendar_days keep
 WHERE c.tenant_id = keep.tenant_id
   AND c.academic_year_id = keep.academic_year_id
   AND c.day = keep.day
   AND c.kind = keep.kind
   AND c.ctid > keep.ctid;

ALTER TABLE calendar_days DROP CONSTRAINT IF EXISTS uq_calendar_entry;

ALTER TABLE calendar_days
  DROP COLUMN IF EXISTS updated_at,
  DROP COLUMN IF EXISTS created_at,
  DROP COLUMN IF EXISTS created_by,
  DROP COLUMN IF EXISTS description_bn;

ALTER TABLE calendar_days
  ADD CONSTRAINT calendar_days_tenant_id_academic_year_id_day_kind_key
  UNIQUE (tenant_id, academic_year_id, day, kind);

COMMIT;
