-- ============================================================================
-- 043 — The academic calendar becomes editable  (R-4, docs/11-MASTER-PLAN.md)
--
-- `calendar_days` has existed since migration 003 and has never had a screen.
-- It is already load-bearing: sms-svc reads it twice to suppress attendance
-- and notice SMS on holidays, so a row in this table already stops messages
-- going to nine hundred guardians. R-4 gives it a UI, and three things have
-- to change first.
--
-- ── 1. Anyone in the school could declare a holiday ─────────────────────
-- Like `classes`, `sections` and `guardianships` before migration 042,
-- `calendar_days` carries ONLY the PERMISSIVE `tenant_isolation` policy that
-- 010 applies in a loop to every table with a tenant_id, plus the blanket
-- GRANT. Complete tenant isolation, no role scope.
--
-- Here that is worse than it was for classes. A student inserting one row
-- with kind='holiday' would silently suppress the whole school's attendance
-- SMS for that day — the suppression query is
-- `SELECT 1 FROM calendar_days WHERE tenant_id = $1 AND day = $2 AND kind =
-- 'holiday'`, and it does not care who wrote the row. Nothing had exercised
-- this because nothing in the product wrote to the table; R-4 is the phase
-- that adds the write path, so the scope has to exist before the screen does.
--
-- ── 2. One event per kind per day was too few ───────────────────────────
-- The old UNIQUE (tenant, year, day, kind) permits exactly one 'event' on any
-- given date. A school with a sports day and a parents' meeting on the same
-- Thursday could record one of them. The constraint gains `title_bn`: the
-- same title twice on one day is a duplicate, two different titles are two
-- events. Holidays are still effectively one per day because a school does
-- not declare "ঈদুল ফিতর" twice.
--
-- ── 3. A calendar entry with no description is a word ───────────────────
-- "পরীক্ষা" tells a guardian nothing about which exam, where, or what to
-- bring. `description_bn` is nullable — a holiday genuinely needs no body.
--
-- ── What this migration deliberately does NOT add ───────────────────────
-- No start/end time columns, and no audience column.
--
-- Times: every consumer of this table is date-grained. The SMS suppression
-- asks "is this day a holiday", attendance asks the same, and the month view
-- draws a day cell. A start_time nothing reads would be a field the office
-- fills in and no part of the product honours — which is worse than its
-- absence, because they would plan around it.
--
-- Audience: `applies_to_shifts` already exists and is the audience this
-- schema has. A morning-shift-only holiday is a real Bangladeshi case; a
-- "guardians only" calendar entry is not — a holiday applies to the
-- institution. Notices are how you address a subset of people, and R-2
-- already does that properly. See services/ops-svc/api/calendar.ts.
--
-- ── And no new table ────────────────────────────────────────────────────
-- Exams are NOT copied in here. The calendar reads `exams` and
-- `exam_subjects.exam_date` directly and merges them at read time, so there
-- is one source of truth for when an exam is. A calendar row per exam would
-- go stale the first time a coordinator moved a paper.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. The columns a usable calendar entry needs
-- ---------------------------------------------------------------------
ALTER TABLE calendar_days
  ADD COLUMN description_bn text,
  ADD COLUMN created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN created_at     timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN updated_at     timestamptz NOT NULL DEFAULT now();

CREATE TRIGGER trg_caldays_touch BEFORE UPDATE ON calendar_days
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

COMMENT ON COLUMN calendar_days.applies_to_shifts IS
  'Which shifts this entry applies to; NULL means all of them. This is the '
  'audience the calendar has, and it is the right one: a morning-shift-only '
  'holiday is a real case, whereas addressing a subset of PEOPLE is what '
  'notices are for (R-2).';

-- ---------------------------------------------------------------------
-- 2. Two events on one day
--
-- Found by name rather than hardcoded: PostgreSQL truncates generated
-- constraint names to 63 characters, and the truncation point is not
-- something a migration should depend on.
-- ---------------------------------------------------------------------
DO $$
DECLARE v_name text;
BEGIN
  SELECT con.conname INTO v_name
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
   WHERE rel.relname = 'calendar_days'
     AND con.contype = 'u'
     AND (SELECT array_agg(att.attname::text ORDER BY att.attname::text)
            FROM unnest(con.conkey) AS k(attnum)
            JOIN pg_attribute att
              ON att.attrelid = con.conrelid AND att.attnum = k.attnum)
         = ARRAY['academic_year_id','day','kind','tenant_id'];

  IF v_name IS NULL THEN
    RAISE EXCEPTION
      'expected a UNIQUE constraint over (tenant_id, academic_year_id, day, kind) on calendar_days, found none';
  END IF;

  EXECUTE format('ALTER TABLE calendar_days DROP CONSTRAINT %I', v_name);
END $$;

ALTER TABLE calendar_days
  ADD CONSTRAINT uq_calendar_entry
  UNIQUE (tenant_id, academic_year_id, day, kind, title_bn);

-- The month view's only query: everything in a date range for this school.
CREATE INDEX ix_calendar_range ON calendar_days (tenant_id, academic_year_id, day);

-- ---------------------------------------------------------------------
-- 3. Who may write it
--
-- Read stays open to the whole institution, deliberately: every role sees
-- the calendar, and sms-svc's suppression check runs in whatever context the
-- worker holds. Narrowing SELECT would break both.
--
-- Written as the three write commands rather than FOR ALL, because a
-- RESTRICTIVE FOR ALL applies its USING to reads too and would hide the
-- calendar from students.
-- ---------------------------------------------------------------------
CREATE POLICY calendar_insert_scope ON calendar_days
  AS RESTRICTIVE FOR INSERT TO shikhon_app
  WITH CHECK (app.has_role('principal','school_owner','academic_coordinator','it_admin'));

CREATE POLICY calendar_update_scope ON calendar_days
  AS RESTRICTIVE FOR UPDATE TO shikhon_app
  USING (app.has_role('principal','school_owner','academic_coordinator','it_admin'))
  WITH CHECK (app.has_role('principal','school_owner','academic_coordinator','it_admin'));

-- Unlike `classes` and `sections` (042), DELETE is permitted here — to the
-- same four roles. A calendar entry is a PLAN, not a record of something that
-- happened: nothing references it, no history hangs off it, and a holiday
-- entered on the wrong date is a mistake a school must be able to withdraw
-- without a support request. The audit log keeps who removed it.
CREATE POLICY calendar_delete_scope ON calendar_days
  AS RESTRICTIVE FOR DELETE TO shikhon_app
  USING (app.has_role('principal','school_owner','academic_coordinator','it_admin'));

-- ---------------------------------------------------------------------
-- 4. A calendar entry is a thing a notice can be ABOUT
--
-- `notices.source_kind` is an allowlist — 040 admitted exam_routine, result
-- and invoice. R-4 announces holidays and closures through the same
-- `app.emit_auto_notice()` the other three use, so 'calendar' has to join it.
--
-- The allowlist stays an allowlist rather than becoming free text. It is what
-- makes `uq_notice_source` a meaningful idempotency key and what stopped this
-- very insert when the value was unrecognised — the constraint caught a real
-- mistake during R-4's development, which is the argument for keeping it
-- narrow and widening it one deliberate value at a time.
-- ---------------------------------------------------------------------
ALTER TABLE notices DROP CONSTRAINT notices_source_kind_check;
ALTER TABLE notices
  ADD CONSTRAINT notices_source_kind_check
  CHECK (source_kind IS NULL
         OR source_kind IN ('exam_routine', 'result', 'invoice', 'calendar'));

COMMIT;
