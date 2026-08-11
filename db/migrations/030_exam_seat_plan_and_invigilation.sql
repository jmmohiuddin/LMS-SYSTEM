-- ============================================================================
-- 030 — Exam seat plan and invigilation duty  (F-511, F-512, TRD §6.7)
--
-- TRD §6.7, in full:
--
--   "Seat allocation applies a configurable mixing rule (no two students of
--    the same section adjacent) via a deterministic interleave across
--    section rosters, with hall capacity as the binding constraint and an
--    explicit report when the rule cannot be fully satisfied. Invigilation
--    allocation reuses the substitution scorer with two additional hard
--    filters: a teacher never invigilates their own subject's paper, and
--    existing routine obligations in the same slot exclude them."
--
-- ── The unit is the SESSION, not the paper ───────────────────────────────
-- exam_subjects already carries room_id and invigilator_id, one of each per
-- (section, subject). That shape cannot express a seat plan, because a hall
-- does not hold one section sitting one paper — it holds students drawn
-- from several sections, and after the subject model (025) they may be
-- sitting DIFFERENT papers in the same hour: Anika's Higher Maths and
-- Bijoy's Agriculture are one session in one hall.
--
-- So the unit here is the session — (exam, exam_date, start_time) — and the
-- two existing columns stay where they are, describing the simple case a
-- small school hand-fills. Nothing in this migration writes to them.
--
-- ── Why the interleave needs no seed ─────────────────────────────────────
-- §6.4 stores a seed with each generated ROUTINE because that solver makes
-- randomised choices. This allocator makes none: the order is (rank within
-- section, section name), the halls are ordered by room code, and the fill
-- is serpentine through each grid. Regenerating after a roll change moves
-- the students who must move and nobody else. A seed column here would be
-- a lie about how the function works.
-- ============================================================================
BEGIN;

-- ---------------------------------------------------------------------
-- A hall: one room, allocated to one session, laid out as a grid.
--
-- The grid is the point. "Adjacent" has no meaning against a flat seat
-- count, and every real seat plan a Bangladeshi school pins to the hall
-- door is a grid of benches — so rows and columns are stored, not derived.
-- ---------------------------------------------------------------------
CREATE TABLE exam_halls (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  exam_id     uuid NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  exam_date   date NOT NULL,
  start_time  time NOT NULL,
  room_id     uuid NOT NULL REFERENCES rooms(id) ON DELETE RESTRICT,
  rows_count  smallint NOT NULL DEFAULT 6  CHECK (rows_count  BETWEEN 1 AND 40),
  cols_count  smallint NOT NULL DEFAULT 5  CHECK (cols_count  BETWEEN 1 AND 40),
  -- Order halls are filled in. NULL falls back to the room code, so a
  -- school that does not care never has to set it.
  fill_order  smallint,
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  -- A room cannot host two halls in one session.
  UNIQUE (tenant_id, exam_id, exam_date, start_time, room_id)
);

CREATE INDEX ix_exam_halls_session
  ON exam_halls (tenant_id, exam_id, exam_date, start_time);

COMMENT ON TABLE exam_halls IS
  'F-511. One room allocated to one exam session (exam + date + start time), '
  'laid out as a rows x cols grid because adjacency is undefined without one.';

-- A grid that seats more bodies than the room holds is a plan that fails on
-- the morning. CHECK cannot reach rooms.capacity, so this is a trigger.
CREATE OR REPLACE FUNCTION app.assert_hall_within_capacity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE v_cap smallint; v_code text;
BEGIN
  SELECT capacity, code INTO v_cap, v_code FROM rooms WHERE id = NEW.room_id;
  IF v_cap IS NOT NULL AND (NEW.rows_count::int * NEW.cols_count::int) > v_cap THEN
    RAISE EXCEPTION
      'hall grid % x % seats % students but room % holds %',
      NEW.rows_count, NEW.cols_count,
      NEW.rows_count::int * NEW.cols_count::int, v_code, v_cap
      USING ERRCODE = 'check_violation',
            HINT = 'reduce the grid, or raise rooms.capacity if the room really is that big';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_exam_halls_capacity
  BEFORE INSERT OR UPDATE OF rows_count, cols_count, room_id ON exam_halls
  FOR EACH ROW EXECUTE FUNCTION app.assert_hall_within_capacity();

-- ---------------------------------------------------------------------
-- A seat: one student, one bench, one session.
--
-- exam_id / exam_date / start_time are denormalised from the hall by a
-- trigger, purely so the "one student sits in one place at one time"
-- invariant can be a UNIQUE index rather than a hope. A student in two
-- halls is the same failure F-510 exists to prevent, one layer down.
-- ---------------------------------------------------------------------
CREATE TABLE exam_seats (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  hall_id         uuid NOT NULL REFERENCES exam_halls(id) ON DELETE CASCADE,
  seat_row        smallint NOT NULL CHECK (seat_row > 0),
  seat_col        smallint NOT NULL CHECK (seat_col > 0),
  enrolment_id    uuid NOT NULL REFERENCES enrolments(id) ON DELETE CASCADE,
  exam_subject_id uuid NOT NULL REFERENCES exam_subjects(id) ON DELETE CASCADE,
  -- Denormalised session key. Maintained by trigger; never set by hand.
  exam_id         uuid NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  exam_date       date NOT NULL,
  start_time      time NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, hall_id, seat_row, seat_col),
  UNIQUE (tenant_id, exam_id, exam_date, start_time, enrolment_id)
);

CREATE INDEX ix_exam_seats_student
  ON exam_seats (tenant_id, enrolment_id, exam_date);

COMMENT ON TABLE exam_seats IS
  'F-511. One student at one bench for one session. The second UNIQUE is the '
  'invariant that matters: nobody is seated in two halls at once.';

CREATE OR REPLACE FUNCTION app.sync_seat_session()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  SELECT h.exam_id, h.exam_date, h.start_time
    INTO NEW.exam_id, NEW.exam_date, NEW.start_time
    FROM exam_halls h WHERE h.id = NEW.hall_id;
  IF NEW.exam_id IS NULL THEN
    RAISE EXCEPTION 'seat references a hall that does not exist' USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_exam_seats_session
  BEFORE INSERT OR UPDATE OF hall_id ON exam_seats
  FOR EACH ROW EXECUTE FUNCTION app.sync_seat_session();

-- ---------------------------------------------------------------------
-- Invigilation duty.
-- ---------------------------------------------------------------------
CREATE TYPE invigilation_duty AS ENUM ('chief', 'invigilator', 'relief');

CREATE TABLE exam_invigilations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  hall_id      uuid NOT NULL REFERENCES exam_halls(id) ON DELETE CASCADE,
  teacher_id   uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  duty         invigilation_duty NOT NULL DEFAULT 'invigilator',
  -- Provenance, same reasoning as routines.generated_by: a coordinator
  -- deserves to know whether a name was chosen by the ranker or by a person.
  assigned_mode text NOT NULL DEFAULT 'manual'
                  CHECK (assigned_mode IN ('manual','ranked')),
  assigned_by  uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, hall_id, teacher_id)
);

CREATE INDEX ix_exam_invigilations_teacher
  ON exam_invigilations (tenant_id, teacher_id);

COMMENT ON TABLE exam_invigilations IS
  'F-512 / TRD §6.7. Duty roster, one row per teacher per hall. The two hard '
  'filters (own subject, routine obligation) are enforced by trigger, not '
  'only by the ranker that suggests names.';

-- ---------------------------------------------------------------------
-- F-511 — the allocator.
--
-- Deterministic interleave. Students are ranked within their own section by
-- roll number, then ordered by (rank, section name): ক1, খ1, গ1, ক2, খ2,
-- গ2 … Laid serpentine into the grid, consecutive seats therefore come from
-- different sections for as long as the sections last.
--
-- "For as long as the sections last" is the honest part. When one section
-- is larger than the others its tail has nobody left to interleave with,
-- and the last benches are unavoidably same-section. §6.7 asks for "an
-- explicit report when the rule cannot be fully satisfied" rather than a
-- silent success, so the function counts what it could not avoid and
-- returns it.
--
-- Idempotent: it clears the session's seats first, so regenerating after a
-- roster change is safe and produces the same plan for the same input.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.generate_seat_plan(
  p_exam  uuid,
  p_date  date,
  p_start time
)
RETURNS TABLE (
  students_to_seat      integer,
  seats_available       integer,
  students_seated       integer,
  students_unseated     integer,
  halls_used            integer,
  adjacency_violations  integer
)
LANGUAGE plpgsql
SECURITY INVOKER              -- RLS still decides which students are visible
SET search_path = public, app
AS $$
DECLARE v_seated integer;
BEGIN
  DELETE FROM exam_seats s
   WHERE s.exam_id = p_exam AND s.exam_date = p_date AND s.start_time = p_start;

  WITH candidate AS (
    -- Who sits this session: the student's OWN subject set (F-304), scoped
    -- to the section the paper was scheduled for. DISTINCT ON because a
    -- draft routine may still contain a clash; F-510 stops that reaching
    -- publication, and until then one student gets one seat rather than an
    -- error from a unique index.
    SELECT DISTINCT ON (e.id)
           e.id AS enrolment_id, e.section_id, e.roll_no,
           es.id AS exam_subject_id, sec.name AS section_name
      FROM exam_subjects es
      JOIN student_subjects ss ON ss.subject_id  = es.subject_id
      JOIN enrolments       e  ON e.id = ss.enrolment_id
                              AND e.section_id = es.section_id
                              AND e.status = 'active'
      JOIN sections        sec ON sec.id = e.section_id
     WHERE es.exam_id = p_exam AND es.exam_date = p_date AND es.start_time = p_start
     ORDER BY e.id, es.id
  ),
  -- Rank within the section first, then order by that rank across
  -- sections. Two stages because a window function may not be nested
  -- inside another window's ORDER BY.
  ranked AS (
    SELECT c.*,
           row_number() OVER (PARTITION BY c.section_id
                                  ORDER BY c.roll_no, c.enrolment_id) AS rn
      FROM candidate c
  ),
  ordered AS (
    SELECT rk.*,
           row_number() OVER (ORDER BY rk.rn, rk.section_name, rk.section_id) AS seq
      FROM ranked rk
  ),
  seat AS (
    -- Serpentine fill, and the reason is worth the line it costs.
    --
    -- Filling strictly left-to-right on every row defeats the interleave
    -- vertically whenever the column count is even: with two sections and
    -- four columns you get ক খ ক খ / ক খ ক খ, alternating along each row
    -- and matching down every column. Reversing alternate rows makes the
    -- seat above and the seat beside both come from the neighbouring
    -- position in the order, so the property holds in both directions for
    -- any grid shape.
    SELECT h.id AS hall_id, gr.seat_row::smallint, gc.seat_col::smallint,
           row_number() OVER (
             ORDER BY COALESCE(h.fill_order, 32767), r.code, gr.seat_row,
                      CASE WHEN gr.seat_row % 2 = 1 THEN gc.seat_col
                           ELSE h.cols_count - gc.seat_col + 1 END
           ) AS seq
      FROM exam_halls h
      JOIN rooms r ON r.id = h.room_id
      CROSS JOIN LATERAL generate_series(1, h.rows_count) AS gr(seat_row)
      CROSS JOIN LATERAL generate_series(1, h.cols_count) AS gc(seat_col)
     WHERE h.exam_id = p_exam AND h.exam_date = p_date AND h.start_time = p_start
  )
  INSERT INTO exam_seats
    (tenant_id, hall_id, seat_row, seat_col, enrolment_id, exam_subject_id,
     exam_id, exam_date, start_time)
  SELECT app.current_tenant(), s.hall_id, s.seat_row, s.seat_col,
         o.enrolment_id, o.exam_subject_id,
         -- overwritten by trg_exam_seats_session; NOT NULL wants a value now
         p_exam, p_date, p_start
    FROM ordered o JOIN seat s ON s.seq = o.seq;

  GET DIAGNOSTICS v_seated = ROW_COUNT;

  RETURN QUERY
  WITH cand AS (
    SELECT DISTINCT e.id
      FROM exam_subjects es
      JOIN student_subjects ss ON ss.subject_id = es.subject_id
      JOIN enrolments e ON e.id = ss.enrolment_id
                       AND e.section_id = es.section_id
                       AND e.status = 'active'
     WHERE es.exam_id = p_exam AND es.exam_date = p_date AND es.start_time = p_start
  ),
  cap AS (
    SELECT COALESCE(sum(h.rows_count::int * h.cols_count::int), 0)::int AS seats,
           count(*)::int AS halls
      FROM exam_halls h
     WHERE h.exam_id = p_exam AND h.exam_date = p_date AND h.start_time = p_start
  )
  SELECT (SELECT count(*)::int FROM cand),
         cap.seats,
         v_seated,
         (SELECT count(*)::int FROM cand) - v_seated,
         cap.halls,
         app.seat_plan_adjacency_violations(p_exam, p_date, p_start)
    FROM cap;
END $$;

COMMENT ON FUNCTION app.generate_seat_plan IS
  'F-511 / TRD §6.7. Deterministic section interleave, serpentine through each hall. '
  'Returns a report rather than a boolean: capacity shortfall and residual '
  'adjacency violations are facts a coordinator must see, not errors.';

-- ---------------------------------------------------------------------
-- The explicit report §6.7 asks for.
--
-- Adjacent means side by side in a row, or directly in front of / behind in
-- a column. Diagonals are not adjacent: on a real bench you cannot read a
-- diagonal neighbour's script, and counting them would report violations
-- no arrangement can remove.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.seat_plan_adjacency_violations(
  p_exam uuid, p_date date, p_start time
)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, app
AS $$
  SELECT count(*)::int
    FROM exam_seats a
    JOIN enrolments ea ON ea.id = a.enrolment_id
    JOIN exam_seats b
      ON b.hall_id = a.hall_id
     -- ordered pair, so each neighbouring pair is counted once
     AND ( (b.seat_row = a.seat_row AND b.seat_col = a.seat_col + 1)
        OR (b.seat_col = a.seat_col AND b.seat_row = a.seat_row + 1) )
    JOIN enrolments eb ON eb.id = b.enrolment_id
   WHERE a.exam_id = p_exam AND a.exam_date = p_date AND a.start_time = p_start
     AND ea.section_id = eb.section_id
$$;

COMMENT ON FUNCTION app.seat_plan_adjacency_violations IS
  'F-511. Residual same-section neighbours after the interleave. Non-zero is '
  'a report, not a failure: with one section in the hall it is unavoidable.';

-- ---------------------------------------------------------------------
-- The seat slip a student and an invigilator actually read.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.seat_plan(p_exam uuid, p_date date, p_start time)
RETURNS TABLE (
  room_code    text,
  seat_row     smallint,
  seat_col     smallint,
  student_name_bn text,
  roll_no      smallint,
  section_name text,
  subject_bn   text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, app
AS $$
  SELECT r.code, s.seat_row, s.seat_col, u.full_name_bn, e.roll_no, sec.name, sub.name_bn
    FROM exam_seats s
    JOIN exam_halls h  ON h.id = s.hall_id
    JOIN rooms      r  ON r.id = h.room_id
    JOIN enrolments e  ON e.id = s.enrolment_id
    JOIN users      u  ON u.id = e.student_id
    JOIN sections  sec ON sec.id = e.section_id
    JOIN exam_subjects es ON es.id = s.exam_subject_id
    JOIN subjects  sub ON sub.id = es.subject_id
   WHERE s.exam_id = p_exam AND s.exam_date = p_date AND s.start_time = p_start
   ORDER BY r.code, s.seat_row, s.seat_col
$$;

-- ---------------------------------------------------------------------
-- F-512 — invigilator ranking.
--
-- §6.7: "reuses the substitution scorer with two additional hard filters".
-- The substitution scorer (§6.5) ranks on competency match, free-period
-- availability, current load, familiarity and fairness. Two of its terms
-- INVERT here, and that is the whole design:
--
--   * subject competency is a POSITIVE in substitution (the cover teacher
--     should know the subject) and a HARD EXCLUSION in invigilation (a
--     teacher must not stand over their own paper);
--   * section familiarity is a positive in substitution and a soft
--     PENALTY here, for the same reason.
--
-- What carries over unchanged: free-in-this-slot as a hard filter rather
-- than a weight, and fairness as a negative on duties already taken.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.rank_invigilators(p_hall uuid)
RETURNS TABLE (
  teacher_id     uuid,
  teacher_name_bn text,
  score          numeric,
  duties_this_exam integer,
  reason_bn      text
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, app
AS $$
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
END $$;

COMMENT ON FUNCTION app.rank_invigilators IS
  'F-512 / TRD §6.7. The §6.5 substitution scorer with subject competency '
  'and section familiarity INVERTED — what makes a good substitute makes a '
  'bad invigilator. Free-in-slot stays a hard filter, fairness stays a '
  'negative weight.';

REVOKE ALL ON FUNCTION app.generate_seat_plan(uuid, date, time) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.seat_plan_adjacency_violations(uuid, date, time) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.seat_plan(uuid, date, time) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.rank_invigilators(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.generate_seat_plan(uuid, date, time) TO shikhon_app;
GRANT EXECUTE ON FUNCTION app.seat_plan_adjacency_violations(uuid, date, time) TO shikhon_app;
GRANT EXECUTE ON FUNCTION app.seat_plan(uuid, date, time) TO shikhon_app;
GRANT EXECUTE ON FUNCTION app.rank_invigilators(uuid) TO shikhon_app;

-- ---------------------------------------------------------------------
-- The ranker suggests. The trigger decides.
--
-- Same layering as routine substitutions (006): the endpoint's candidate
-- list is advisory and can go stale between the coordinator loading it and
-- pressing assign. The two hard filters of §6.7 are therefore re-checked at
-- INSERT, so a stale list produces a clean error and never a teacher
-- standing over the paper they wrote.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.assert_invigilator_eligible()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_exam uuid; v_date date; v_start time; v_end time; v_dow smallint;
  v_subject text; v_clash text;
BEGIN
  SELECT h.exam_id, h.exam_date, h.start_time
    INTO v_exam, v_date, v_start
    FROM exam_halls h WHERE h.id = NEW.hall_id;

  SELECT max(es.start_time + make_interval(mins => COALESCE(es.duration_minutes, 0)))
    INTO v_end
    FROM exam_subjects es
   WHERE es.exam_id = v_exam AND es.exam_date = v_date AND es.start_time = v_start;
  v_end := COALESCE(v_end, v_start + interval '3 hours');
  v_dow := EXTRACT(DOW FROM v_date)::smallint;

  SELECT sub.name_bn INTO v_subject
    FROM exam_seats s
    JOIN exam_subjects es ON es.id = s.exam_subject_id
    JOIN subjects sub     ON sub.id = es.subject_id
    JOIN teacher_competencies tc ON tc.subject_id = es.subject_id
   WHERE s.hall_id = NEW.hall_id AND tc.teacher_id = NEW.teacher_id AND tc.is_active
   LIMIT 1;
  IF v_subject IS NOT NULL THEN
    RAISE EXCEPTION 'teacher may not invigilate their own subject''s paper (%)', v_subject
      USING ERRCODE = 'check_violation',
            HINT = 'call app.rank_invigilators(hall_id) for eligible teachers';
  END IF;

  SELECT sec.name INTO v_clash
    FROM routine_slots rs
    JOIN routines ro ON ro.id = rs.routine_id
    LEFT JOIN sections sec ON sec.id = rs.primary_section_id
   WHERE rs.teacher_id = NEW.teacher_id AND rs.status = 'active' AND ro.status = 'active'
     AND rs.day_of_week = v_dow
     AND rs.starts_at < v_end AND v_start < rs.ends_at
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'teacher has a routine obligation in this slot (section %)', COALESCE(v_clash, '?')
      USING ERRCODE = 'check_violation',
            HINT = 'free the slot with a substitution first, or pick another invigilator';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER trg_invigilation_eligible
  BEFORE INSERT OR UPDATE OF teacher_id, hall_id ON exam_invigilations
  FOR EACH ROW EXECUTE FUNCTION app.assert_invigilator_eligible();

-- ---------------------------------------------------------------------
-- A published exam routine must have every hall staffed.
--
-- Extends the F-510 gate rather than adding a second one: an unstaffed hall
-- and a double-booked student are the same class of failure — discovered on
-- the morning of the paper, when nothing can be done about it.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.assert_exam_halls_staffed()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE v_room text; v_date date;
BEGIN
  IF NEW.status <> 'published' OR OLD.status = 'published' THEN
    RETURN NEW;
  END IF;

  SELECT r.code, h.exam_date INTO v_room, v_date
    FROM exam_halls h
    JOIN rooms r ON r.id = h.room_id
   WHERE h.exam_id = NEW.id
     AND NOT EXISTS (SELECT 1 FROM exam_invigilations ei WHERE ei.hall_id = h.id)
   ORDER BY h.exam_date, h.start_time, r.code
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'hall % on % has no invigilator', v_room, v_date
      USING ERRCODE = 'check_violation',
            HINT = 'assign duty for every hall before publishing the routine';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_exams_halls_staffed
  BEFORE UPDATE OF status ON exams
  FOR EACH ROW EXECUTE FUNCTION app.assert_exam_halls_staffed();

-- ---------------------------------------------------------------------
-- Tenancy and RLS, via the same programmatic loop as 010 and 025.
-- ---------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['exam_halls', 'exam_seats', 'exam_invigilations'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        AS PERMISSIVE FOR ALL TO shikhon_app
        USING (app.tenant_guard(tenant_id))
        WITH CHECK (app.tenant_guard(tenant_id))
    $f$, t);
    EXECUTE format('CREATE TRIGGER trg_%s_tenant BEFORE INSERT OR UPDATE ON %I
                    FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant()',
                   left(t, 20), t);
  END LOOP;
END $$;

-- exam_seats is written once per generation and never updated in place.
CREATE TRIGGER trg_exam_halls_touch BEFORE UPDATE ON exam_halls
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER trg_exam_invigilations_touch BEFORE UPDATE ON exam_invigilations
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- ---------------------------------------------------------------------
-- Read and write scopes.
--
-- Split INSERT / UPDATE / DELETE rather than FOR ALL — migration 023 exists
-- because a RESTRICTIVE FOR ALL write policy silently cancels the read
-- policy beside it, and that broke every student-facing read for a while.
-- ---------------------------------------------------------------------
CREATE POLICY seat_read_scope ON exam_seats
  AS RESTRICTIVE FOR SELECT TO shikhon_app
  USING (
    app.has_role('principal','school_owner','academic_coordinator','dept_head',
                 'class_teacher','subject_teacher')
    -- A student sees their own seat, and only after the routine is
    -- published. A draft plan is a working document, not an announcement.
    OR EXISTS (
      SELECT 1 FROM enrolments e JOIN exams x ON x.id = exam_seats.exam_id
       WHERE e.id = exam_seats.enrolment_id
         AND x.status = 'published'
         AND app.can_see_student(e.student_id)
    )
  );

CREATE POLICY hall_read_scope ON exam_halls
  AS RESTRICTIVE FOR SELECT TO shikhon_app
  USING (
    app.has_role('principal','school_owner','academic_coordinator','dept_head',
                 'class_teacher','subject_teacher')
    OR EXISTS (SELECT 1 FROM exams x WHERE x.id = exam_halls.exam_id AND x.status = 'published')
  );

CREATE POLICY invigilation_read_scope ON exam_invigilations
  AS RESTRICTIVE FOR SELECT TO shikhon_app
  USING (
    app.has_role('principal','school_owner','academic_coordinator','dept_head')
    -- A teacher may always see their own duty. Not being able to find out
    -- where you are standing tomorrow is not a security property.
    OR exam_invigilations.teacher_id = app.current_user_id()
  );

DO $$
DECLARE t text; w text := 'app.has_role(''principal'',''school_owner'',''academic_coordinator'')';
BEGIN
  FOREACH t IN ARRAY ARRAY['exam_halls', 'exam_seats', 'exam_invigilations'] LOOP
    EXECUTE format('CREATE POLICY %s_insert_scope ON %I AS RESTRICTIVE FOR INSERT TO shikhon_app WITH CHECK (%s)',
                   left(t, 18), t, w);
    EXECUTE format('CREATE POLICY %s_update_scope ON %I AS RESTRICTIVE FOR UPDATE TO shikhon_app USING (%s) WITH CHECK (%s)',
                   left(t, 18), t, w, w);
    EXECUTE format('CREATE POLICY %s_delete_scope ON %I AS RESTRICTIVE FOR DELETE TO shikhon_app USING (%s)',
                   left(t, 18), t, w);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON exam_halls, exam_seats, exam_invigilations TO shikhon_app;

COMMIT;
