-- Rollback for 030 — exam seat plan and invigilation duty (F-511, F-512).
--
-- Drops the seat plan and the duty roster along with the two publication
-- gates that depend on them. After this an exam routine can be published
-- with halls nobody is standing in, and no student has a seat.
--
-- Destructive: every generated seat plan and every duty assignment is lost.
-- Nothing else reads these tables, so nothing else breaks.
BEGIN;

-- The one trigger that lives on a table this migration did not create, so
-- it has to be named. The rest go with their tables below.
DROP TRIGGER IF EXISTS trg_exams_halls_staffed ON exams;

-- Tables before functions: dropping a table takes its triggers with it,
-- and a trigger still attached is what makes DROP FUNCTION refuse.
-- exam_seats and exam_invigilations both reference exam_halls.
DROP TABLE IF EXISTS exam_invigilations;
DROP TABLE IF EXISTS exam_seats;
DROP TABLE IF EXISTS exam_halls;

DROP FUNCTION IF EXISTS app.assert_exam_halls_staffed();
DROP FUNCTION IF EXISTS app.assert_invigilator_eligible();
DROP FUNCTION IF EXISTS app.rank_invigilators(uuid);
DROP FUNCTION IF EXISTS app.seat_plan(uuid, date, time);
DROP FUNCTION IF EXISTS app.generate_seat_plan(uuid, date, time);
DROP FUNCTION IF EXISTS app.seat_plan_adjacency_violations(uuid, date, time);
DROP FUNCTION IF EXISTS app.sync_seat_session();
DROP FUNCTION IF EXISTS app.assert_hall_within_capacity();

DROP TYPE IF EXISTS invigilation_duty;

COMMIT;
