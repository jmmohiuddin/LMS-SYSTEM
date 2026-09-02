-- Rollback for 063 — remove the teacher register and restore the ranker.
--
-- `app.rank_invigilators` is put back to its migration-030 definition by
-- re-running that migration's own CREATE OR REPLACE, which is reproduced
-- here in full for the same reason 063 reproduced it: a function body that
-- is retyped is a function body that quietly changes. The only edit is the
-- removal of the two comment lines and the `AND NOT app.teacher_absent_on`
-- call that 063 added.
--
-- Order matters. The ranker must stop calling `app.teacher_absent_on()`
-- before the function is dropped, and the function must go before the table
-- it reads, or the drops fail on dependency.

BEGIN;

-- 1. The ranker, back to what migration 030 defined.
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

-- 2. The absence test, now unreferenced.
DROP FUNCTION IF EXISTS app.teacher_absent_on(uuid, date);

-- 3. The register. CASCADE takes the two indexes, the trigger and both
--    policies with it. This DELETES the school's staff register, which is
--    why a rollback past 063 is a decision and not a routine step.
DROP TABLE IF EXISTS teacher_attendance CASCADE;

COMMIT;
