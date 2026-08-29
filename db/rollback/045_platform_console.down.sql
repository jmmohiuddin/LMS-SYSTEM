-- Rollback for 045 — the platform console (R-7).
--
-- Loses no school data. Every tenant, student, teacher and enrolment created
-- through the console stays exactly where it is: this drops the ABILITY to
-- create another one, not anything already created.
--
-- What it does take away, and both are worth knowing before running it:
--
--   1. `student_cap` stops being enforced. The column keeps its value and
--      the plan keeps its number, and nothing checks either — which is the
--      state the product was in from migration 001 until R-7.
--
--   2. Onboarding returns to SQL by hand. platform-svc's endpoints all
--      answer 500 once the functions are gone, so a new school is created
--      the way docs/PILOT-ONBOARDING-RUNBOOK.md describes.
--
-- `shikhon_platform` keeps its LOGIN and its membership of `shikhon_app`.
-- Revoking those would break a running platform-svc mid-request, and the
-- role is harmless without the functions — it can do exactly what the
-- runtime role can do, inside one tenant, which is what its connection
-- string already implies. BYPASSRLS is deliberately NOT restored: it was
-- removed because a service that touches every school should not be exempt
-- from row-level security, and that is true whether or not R-7 is deployed.

DROP TRIGGER IF EXISTS trg_student_cap ON enrolments;
DROP FUNCTION IF EXISTS app.enforce_student_cap();

DROP FUNCTION IF EXISTS app.provision_curriculum(uuid, uuid);
DROP FUNCTION IF EXISTS app.tenant_onboarding_state(uuid);
DROP FUNCTION IF EXISTS app.log_platform_action(uuid, uuid, text, text);
DROP FUNCTION IF EXISTS app.set_tenant_status(uuid, uuid, tenant_status, text);
DROP FUNCTION IF EXISTS app.platform_tenants(text);
DROP FUNCTION IF EXISTS app.create_tenant(
  uuid, text, text, text, institution_stream, institution_level,
  text, text, text, text, text, text, smallint[], shift_code[],
  text, text, text, integer, date, tenant_status, text);

REVOKE SELECT ON audit.platform_access FROM shikhon_platform;
