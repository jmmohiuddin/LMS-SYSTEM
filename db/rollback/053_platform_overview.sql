-- Rollback for 053 — the console's read path.
--
-- After this the operations console shows zero institutions again: the
-- platform role cannot see `tenants` without one of these definer functions,
-- because `tenant_self` is doing exactly what it was built to do.
--
-- Harmless to data. Run together with reverting the P7 console code.
BEGIN;

DROP FUNCTION IF EXISTS app.set_student_cap(uuid, uuid, integer, text);
DROP FUNCTION IF EXISTS app.platform_operations(uuid);
DROP FUNCTION IF EXISTS app.platform_overview();

COMMIT;
