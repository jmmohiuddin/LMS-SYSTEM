-- ---------------------------------------------------------------------------
-- 063 — the teacher register, and the two places that were already waiting for it.
--
-- ── What was found ──────────────────────────────────────────────────────
-- The substitute finder refuses to offer a teacher who is on approved leave
-- (`teacher_leaves`) or declared unavailable (`teacher_availability`). The
-- invigilator ranker in migration 030 applies the same two filters. Both
-- have been correct since migration 006.
--
-- Nothing has ever written to either table. A repo-wide grep for
-- `INSERT INTO teacher_leaves` finds exactly one hit and it is a test
-- fixture. So the filters are real, tested, and inert: on a live school the
-- substitute finder will happily propose the one teacher everybody knows is
-- at a funeral, because nothing in the product can say so.
--
-- This is the same shape as the three defects P7 found and the one the final
-- audit found in `refresh`: a control that exists, is audited, returns
-- success, and does nothing.
--
-- ── What this adds ──────────────────────────────────────────────────────
-- `teacher_attendance` — one row per teacher per day. A register, not a
-- leave-management system: the office marks who came in, and that is all.
-- `present` is a real recorded state rather than the absence of a row,
-- because "nobody has marked today yet" and "everyone was here" are
-- different facts and the substitute finder must not confuse them.
--
-- ── Why not reuse teacher_leaves ────────────────────────────────────────
-- It cannot express `present`, and its `status` column is an approval
-- workflow — `requested → approved → taken`, with `approved_by`. Writing a
-- daily register through it would mean either auto-approving every row
-- (making the workflow a lie) or building the approval screens, which is
-- the HR module this is deliberately not. `teacher_leaves` stays exactly as
-- it is, still read by both consumers, for the day a leave workflow is
-- actually wanted.
--
-- ── One definition of "absent", not three ───────────────────────────────
-- `app.teacher_absent_on()` is the single test, and both consumers call it.
-- The alternative — pasting a fourth NOT EXISTS into two places — is how
-- the calendar-date bug in P8 survived being fixed twice: the third and
-- fourth copies had not heard. A future consumer gets the answer by calling
-- the function rather than by remembering.
--
-- ── The rank_invigilators body ──────────────────────────────────────────
-- Reproduced whole from `pg_get_functiondef`, changed in exactly one way:
-- one `AND NOT app.teacher_absent_on(...)` added next to the leave filter it
-- belongs beside. One substitution, asserted when this file was generated.
--
-- Migration 059 explains at length why a body is never retyped from memory,
-- and this file is the second time that rule paid for itself. The first
-- draft of this section was assembled from a partial quotation of migration
-- 030 with the unquoted half supplied from memory. It invented a different
-- RETURNS TABLE (`full_name_bn`, `score integer`), returned quietly instead
-- of raising on a missing hall, dropped the computation of `v_end` from the
-- longest paper in the session, and rebuilt the hall's subjects and sections
-- from the wrong tables. It would have applied cleanly. The diff against
-- `pg_get_functiondef` is what caught it, which is the whole argument for
-- generating these rather than writing them.
-- ---------------------------------------------------------------------------

BEGIN;

-- ── 1. The register ─────────────────────────────────────────────────────

CREATE TABLE teacher_attendance (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  teacher_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  attendance_date date NOT NULL DEFAULT app.today_dhaka(),
  -- Deliberately smaller than the student `attendance_status` enum. A school
  -- office needs to answer one question for the substitute finder — is this
  -- person here today — and every extra state is a state somebody has to be
  -- trained to choose. `on_leave` is separated from `absent` only because
  -- the head teacher wants to see the difference on the register.
  status          text NOT NULL CHECK (status IN ('present', 'absent', 'on_leave')),
  -- Free text, optional, shown back on the register. Not a leave type, not
  -- an approval: the office writes "মাতৃত্বকালীন ছুটি" or nothing.
  reason          text,
  marked_by       uuid NOT NULL REFERENCES users(id),
  marked_at       timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- One mark per teacher per day. Re-marking corrects the row rather than
  -- appending a second opinion; the audit log carries the history.
  CONSTRAINT uq_teacher_attendance UNIQUE (tenant_id, teacher_id, attendance_date)
);

COMMENT ON TABLE teacher_attendance IS
  'Daily staff register. One row per teacher per day. Read by '
  'app.teacher_absent_on(), which the substitute finder and the invigilator '
  'ranker both consult. Not a leave-management system — see migration 063.';

-- The register is read per-day for the whole school (the office screen) and
-- per-teacher-per-day (the absence test). The unique constraint above already
-- indexes (tenant_id, teacher_id, attendance_date), which serves the second;
-- this serves the first. Partial, because a full register is mostly
-- `present` rows and only the other two ever exclude anybody.
CREATE INDEX ix_teacher_attendance_day
  ON teacher_attendance (tenant_id, attendance_date);
CREATE INDEX ix_teacher_attendance_away
  ON teacher_attendance (tenant_id, attendance_date, teacher_id)
  WHERE status <> 'present';

CREATE TRIGGER trg_teacher_attendance_tenant
  BEFORE INSERT OR UPDATE ON teacher_attendance
  FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant();

-- ── 2. Row-level security ───────────────────────────────────────────────
--
-- Migration 010 loops every tenant_id-bearing table and gives it isolation,
-- but 010 ran sixty migrations ago and will not see this table. Stating it
-- here explicitly is exactly the repair migration 061 had to make for two
-- P7 tables that were created the same way and left ENABLE without FORCE.

ALTER TABLE teacher_attendance ENABLE ROW LEVEL SECURITY;
ALTER TABLE teacher_attendance FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON teacher_attendance
  AS PERMISSIVE FOR ALL TO shikhon_app
  USING (app.tenant_guard(tenant_id))
  WITH CHECK (app.tenant_guard(tenant_id));

-- Every member of staff may READ the register — a teacher looking for who
-- can cover their period needs it, and it holds nothing private. Writing is
-- the office's. RESTRICTIVE, so it ANDs with isolation above and cannot be
-- satisfied by adding another permissive policy later.
--
-- This mirrors `substitution_write_scope` (migration 010), with `it_admin`
-- added because the office computer is often theirs.
CREATE POLICY teacher_attendance_write_scope ON teacher_attendance
  AS RESTRICTIVE FOR ALL TO shikhon_app
  USING (true)
  WITH CHECK (app.has_role('principal', 'school_owner', 'it_admin', 'academic_coordinator'));

-- ── 3. The one definition of absent ─────────────────────────────────────

CREATE OR REPLACE FUNCTION app.teacher_absent_on(p_teacher uuid, p_date date)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  -- Only a recorded non-present mark excludes anybody. An unmarked day is
  -- not an absence: on the first morning a school uses this, the register is
  -- empty and every teacher must still be offerable.
  SELECT EXISTS (
    SELECT 1 FROM teacher_attendance ta
     WHERE ta.teacher_id = p_teacher
       AND ta.attendance_date = p_date
       AND ta.status <> 'present'
  );
$$;

COMMENT ON FUNCTION app.teacher_absent_on(uuid, date) IS
  'True when the daily register says this teacher is away on this date. The '
  'single definition of staff absence — call it rather than re-deriving it. '
  'RLS on teacher_attendance still applies, so it answers only for the '
  'calling tenant. See migration 063.';

GRANT EXECUTE ON FUNCTION app.teacher_absent_on(uuid, date) TO shikhon_app;

-- ── 4. The invigilator ranker, now consulting the register ──────────────
--
-- Body from pg_get_functiondef; one clause added. Nothing else differs.

CREATE OR REPLACE FUNCTION app.rank_invigilators(p_hall uuid)
 RETURNS TABLE(teacher_id uuid, teacher_name_bn text, score numeric, duties_this_exam integer, reason_bn text)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'app'
AS $function$
DECLARE
  v_exam uuid; v_date date; v_start time; v_end time; v_dow smallint;
BEGIN
  SELECT h.exam_id, h.exam_date, h.start_time
    INTO v_exam, v_date, v_start
    FROM exam_halls h WHERE h.id = p_hall;
  IF v_exam IS NULL THEN
    RAISE EXCEPTION 'hall % not found', p_hall USING ERRCODE = 'no_data_found';
  END IF;

  -- The session ends when its longest paper ends.
  SELECT max(es.start_time + make_interval(mins => COALESCE(es.duration_minutes, 0)))
    INTO v_end
    FROM exam_subjects es
   WHERE es.exam_id = v_exam AND es.exam_date = v_date AND es.start_time = v_start;
  v_end := COALESCE(v_end, v_start + interval '3 hours');

  -- 0 = Sunday, matching routine_slots.day_of_week (006 §routine_slots).
  v_dow := EXTRACT(DOW FROM v_date)::smallint;

  RETURN QUERY
  WITH hall_subject AS (
    SELECT DISTINCT es.subject_id
      FROM exam_seats s JOIN exam_subjects es ON es.id = s.exam_subject_id
     WHERE s.hall_id = p_hall
  ),
  hall_section AS (
    SELECT DISTINCT e.section_id
      FROM exam_seats s JOIN enrolments e ON e.id = s.enrolment_id
     WHERE s.hall_id = p_hall
  ),
  teacher AS (
    SELECT u.id, u.full_name_bn
      FROM users u
      JOIN user_roles ur ON ur.user_id = u.id
     WHERE u.status = 'active'
       AND ur.role_code IN ('subject_teacher','class_teacher','dept_head')
       AND (ur.valid_until IS NULL OR ur.valid_until >= v_date)
     GROUP BY u.id, u.full_name_bn
  ),
  eligible AS (
    SELECT t.id, t.full_name_bn
      FROM teacher t
     WHERE
       -- HARD 1 (§6.7). Never their own subject's paper. Competency, not
       -- the timetable: a teacher who has taught the syllabus should not be
       -- in the room whether or not they teach this particular section.
       NOT EXISTS (
         SELECT 1 FROM teacher_competencies tc JOIN hall_subject hs ON hs.subject_id = tc.subject_id
          WHERE tc.teacher_id = t.id AND tc.is_active
       )
       AND NOT EXISTS (
         SELECT 1 FROM routine_slots rs JOIN routines ro ON ro.id = rs.routine_id
                  JOIN hall_subject hs ON hs.subject_id = rs.subject_id
          WHERE rs.teacher_id = t.id AND rs.status = 'active' AND ro.status = 'active'
       )
       -- HARD 2 (§6.7). An existing routine obligation in the same slot.
       AND NOT EXISTS (
         SELECT 1 FROM routine_slots rs JOIN routines ro ON ro.id = rs.routine_id
          WHERE rs.teacher_id = t.id AND rs.status = 'active' AND ro.status = 'active'
            AND rs.day_of_week = v_dow
            AND rs.starts_at < v_end AND v_start < rs.ends_at
       )
       -- Carried over from §6.5: free-in-this-slot is a filter, not a
       -- weight. A teacher already standing in another hall this session,
       -- on approved leave, or declared unavailable is excluded outright.
       AND NOT EXISTS (
         SELECT 1 FROM exam_invigilations ei JOIN exam_halls h2 ON h2.id = ei.hall_id
          WHERE ei.teacher_id = t.id AND h2.exam_id = v_exam
            AND h2.exam_date = v_date AND h2.start_time = v_start
       )
       AND NOT EXISTS (
         SELECT 1 FROM teacher_leaves tl
          WHERE tl.teacher_id = t.id AND tl.status IN ('approved','taken')
            AND v_date BETWEEN tl.starts_on AND tl.ends_on
       )
       -- 063. And not marked away on the day's register, which is the one
       -- of these four filters a school actually keeps day to day.
       AND NOT app.teacher_absent_on(t.id, v_date)
       AND NOT EXISTS (
         SELECT 1 FROM teacher_availability ta
          WHERE ta.teacher_id = t.id AND ta.kind = 'unavailable'
            AND ta.day_of_week = v_dow
            AND ta.starts_at < v_end AND v_start < ta.ends_at
            AND ta.effective_from <= v_date
            AND (ta.effective_to IS NULL OR ta.effective_to >= v_date)
       )
  ),
  scored AS (
    SELECT el.id, el.full_name_bn,
           (SELECT count(*)::int FROM exam_invigilations ei JOIN exam_halls h3 ON h3.id = ei.hall_id
             WHERE ei.teacher_id = el.id AND h3.exam_id = v_exam) AS duties,
           EXISTS (SELECT 1 FROM sections sx JOIN hall_section hn ON hn.section_id = sx.id
                    WHERE sx.class_teacher_id = el.id) AS is_own_class_teacher
      FROM eligible el
  )
  SELECT sc.id, sc.full_name_bn,
         -- Fairness dominates: with the hard filters passed, the only thing
         -- left worth optimising is that duty is spread evenly. Ten points
         -- per duty already taken, and a smaller penalty for standing over
         -- one's own class — discouraged, not forbidden, because a small
         -- school may have nobody else.
         (100 - 10 * sc.duties - CASE WHEN sc.is_own_class_teacher THEN 15 ELSE 0 END)::numeric,
         sc.duties,
         CASE
           WHEN sc.duties = 0 AND NOT sc.is_own_class_teacher THEN 'কোনো ডিউটি নেই'
           WHEN sc.is_own_class_teacher THEN 'নিজের শ্রেণির শিক্ষক'
           ELSE 'ইতিমধ্যে ' || sc.duties || 'টি ডিউটি'
         END
    FROM scored sc
   ORDER BY 3 DESC, 2;
END $function$;

COMMIT;
