-- ============================================================================
-- 049 — app.student_day: the routine, read by the person who attends it
--
-- P4 shipped the student home with no "today's classes" card, and said why:
-- `GET /rms/routine` wraps `app.teacher_day(claims.sub, …)`, so a student who
-- calls it gets their own — empty — teaching day. The card was left out rather
-- than filled with invented data.
--
-- The fix is NOT to widen `app.teacher_day`. That function answers "which
-- periods is this PERSON responsible for", in both directions (own classes and
-- covers), and returns three facts a student must never read:
-- `student_count`, `attendance_taken` and `delivery_logged` — how many
-- children are in the room, whether the register has been taken, whether the
-- lesson was logged. Those are operational facts about a teacher's day.
-- Making one function serve both readers would mean either leaking them or
-- adding a role branch inside a function that RLS policies depend on.
--
-- So this is a sibling, keyed on the SECTION instead of the teacher, returning
-- only what the student attending it may see.
--
-- ── Authorization: one gate, and it is the gate everything else already uses
--
-- `app.can_see_student(p_student)` (migration 010) already answers "may this
-- session read this student's data": a student sees only themselves, a
-- guardian only their wards, a teacher only their sections, management all.
-- Reusing it means this function cannot drift from the rest of the product,
-- and it means the guardian's copy of the same screen is free rather than a
-- second implementation with a second set of mistakes.
--
-- The function returns NO ROWS for an unauthorized caller — it does not raise.
-- An exception distinguishes "this student exists but is not yours" from
-- "this student does not exist", which is the enumeration oracle 010 and
-- studenthistory.ts both went out of their way to avoid.
--
-- ── SECURITY DEFINER, and exactly why ─────────────────────────────────────
--
-- `app.teacher_day` is invoker-rights and can afford to be: a teacher may read
-- the `users` rows of the colleagues they cover for. A STUDENT may not. Under
-- a student's session `SELECT count(*) FROM users` returns 1 — migration 010
-- shows them themselves and their household and nothing else, which is right
-- and is not being changed for a timetable.
--
-- The first draft of this function was invoker-rights, and running it produced
-- exactly what that implies: `teacher_name_bn` null on every period, and a
-- covered period reporting `is_substitution: false` because the substitute's
-- user row was invisible too. A student would have been told the subject, the
-- room and the hour, with no teacher and no hint that somebody else is taking
-- it today.
--
-- So this is definer-rights, and the safety moves from "RLS will catch it" to
-- "this function is written so there is nothing to catch":
--
--   * `app.can_see_student(p_student)` gates every row, as before. That is the
--     same helper the RLS policies use, so the answer cannot drift from them.
--   * EVERY table is joined with an explicit `tenant_id = app.current_tenant()`
--     — including the lookup joins, which invoker rights would have covered
--     for free. A definer function that omits one is a cross-tenant read.
--   * Exactly one column is taken from `users`: `full_name_bn`. Not the phone,
--     not the email, not the NID, not the status.
--
-- What that widens, stated plainly: a student learns the display name of the
-- teacher taking a period on their own timetable. That is a person standing at
-- the front of their classroom. It is not a staff directory — no other user is
-- reachable, and no other column of any user is returned.
--
-- REVOKE/GRANT below keeps it to `shikhon_app`, as with the other definer
-- helpers in 010.
--
-- ── Parallel blocks: why a section's routine is not one student's routine
--
-- Migration 034 added `routine_slots.parallel_pool` for F-504: two religion
-- variants, or two optional subjects, placed in the SAME section at the SAME
-- hour. They are not a double booking — they are different children in
-- different rooms. A student attends exactly one of them.
--
-- `student_subjects` (025) records which subjects each enrolment actually
-- takes, so the filter is exact and needs no new table: a slot with no
-- `parallel_pool` is for the whole section; a slot WITH one is included only
-- when the student is enrolled in that subject. Getting this wrong would put
-- a Hindu student in an Islamic-studies period on their own timetable — not a
-- leak of anybody else's data, but fabricated curriculum for them, which §10
-- of the UI brief forbids in the same breath as asking for the card.
--
-- ── Substitutions
--
-- Resolved the way a student experiences them: the period still happens, so
-- the row stays, and `teacher_name_bn` becomes the person actually taking it,
-- with `is_substitution` true. `teacher_day` removes a covered period from the
-- original teacher's day; a section's day never loses the period at all.
-- ============================================================================
BEGIN;

CREATE OR REPLACE FUNCTION app.student_day(p_student uuid, p_date date)
RETURNS TABLE (
  slot_id uuid,
  period_no smallint,
  starts_at time,
  ends_at time,
  slot_kind slot_kind,
  subject_bn text,
  subject_en text,
  section_label text,
  room_code text,
  teacher_name_bn text,
  is_substitution boolean
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app AS $$
  WITH gate AS (
    -- Everything below is inner-joined to this. An unauthorized caller gets
    -- an empty set, indistinguishable from a student with no classes today.
    SELECT 1 WHERE app.can_see_student(p_student)
  ),
  enrolment AS (
    SELECT e.id AS enrolment_id, e.section_id
    FROM enrolments e
    JOIN academic_years y
      ON y.id = e.academic_year_id AND y.tenant_id = app.current_tenant()
    CROSS JOIN gate
    WHERE e.tenant_id = app.current_tenant()
      AND e.student_id = p_student
      AND e.status = 'active'
      -- The year that CONTAINS the date, not the one flagged current: asking
      -- for a date in last year must answer with last year's section, and on
      -- the day a new year is flagged current the old one is still the truth
      -- for yesterday.
      AND p_date BETWEEN y.starts_on AND y.ends_on
    ORDER BY e.enrolled_on DESC
    LIMIT 1
  ),
  active_routine AS (
    SELECT r.id FROM routines r
    WHERE r.tenant_id = app.current_tenant()
      AND r.status = 'active'
      AND r.effective_from <= p_date
      AND (r.effective_to IS NULL OR r.effective_to >= p_date)
  ),
  slots AS (
    SELECT rs.*
    FROM routine_slots rs
    JOIN enrolment en ON en.section_id = rs.primary_section_id
    WHERE rs.tenant_id = app.current_tenant()
      AND rs.routine_id IN (SELECT id FROM active_routine)
      AND rs.day_of_week = EXTRACT(DOW FROM p_date)::smallint
      AND rs.status = 'active'
      -- F-504. Whole-section slot, or one this student actually takes.
      AND (
        rs.parallel_pool IS NULL
        OR EXISTS (
          SELECT 1 FROM student_subjects ss
          WHERE ss.tenant_id = app.current_tenant()
            AND ss.enrolment_id = en.enrolment_id
            AND ss.subject_id = rs.subject_id)
      )
  )
  SELECT
    s.id,
    s.period_no,
    s.starts_at,
    s.ends_at,
    s.slot_kind,
    sub.name_bn,
    sub.name_en,
    c.name_bn || ' — ' || sec.name,
    rm.code,
    -- The substitute if there is one, otherwise the timetabled teacher.
    -- One column, from one person, who is standing in this student's room.
    COALESCE(cover.full_name_bn, t.full_name_bn),
    (cover.slot IS NOT NULL)
  FROM slots s
  -- Every lookup carries its own tenant clause. Definer rights mean RLS is
  -- not going to add one, and a join by id alone would be a cross-tenant read
  -- the moment any id were ever reused or mis-set.
  LEFT JOIN subjects sub ON sub.id = s.subject_id
                        AND sub.tenant_id = app.current_tenant()
  LEFT JOIN sections sec ON sec.id = s.primary_section_id
                        AND sec.tenant_id = app.current_tenant()
  LEFT JOIN classes  c   ON c.id  = sec.class_id
                        AND c.tenant_id = app.current_tenant()
  LEFT JOIN rooms    rm  ON rm.id = s.room_id
                        AND rm.tenant_id = app.current_tenant()
  LEFT JOIN users    t   ON t.id  = s.teacher_id
                        AND t.tenant_id = app.current_tenant()
  LEFT JOIN LATERAL (
    SELECT rsub.slot_id AS slot, u.full_name_bn
    FROM routine_substitutions rsub
    LEFT JOIN users u ON u.id = rsub.substitute_teacher_id
                     AND u.tenant_id = app.current_tenant()
    WHERE rsub.tenant_id = app.current_tenant()
      AND rsub.slot_id = s.id
      AND rsub.substitution_date = p_date
      AND rsub.status IN ('assigned','completed')
      AND rsub.action = 'assign'
    LIMIT 1
  ) cover ON true
  ORDER BY s.starts_at;
$$;

COMMENT ON FUNCTION app.student_day(uuid, date) IS
  'B-15. One student''s timetable for one date: section-scoped, parallel-block '
  'filtered through student_subjects, substitutions resolved to the covering '
  'teacher. Gated by app.can_see_student, so a student sees only their own and '
  'a guardian only their wards. Deliberately omits student_count, '
  'attendance_taken and delivery_logged — those are app.teacher_day''s to '
  'return and are not a student''s to read.';

-- Same grant shape as the rest of the app.* surface: the runtime role and
-- nobody else.
REVOKE ALL ON FUNCTION app.student_day(uuid, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.student_day(uuid, date) TO shikhon_app;

-- The read this adds: slots for a section, on a weekday, in an active routine.
-- Migration 011 already created BOTH halves of that pair —
--   ix_slots_teacher_day (tenant_id, teacher_id, day_of_week, starts_at)
--   ix_slots_section_day (tenant_id, primary_section_id, day_of_week, starts_at)
--     INCLUDE (subject_id, teacher_id, room_id, ...)
-- and the section one is covering for exactly this query. So NO index is
-- created here. A duplicate index would cost write throughput on every routine
-- save and buy nothing; the section-day read has been indexed since 011 and
-- was simply never called by anything until now.

COMMIT;
