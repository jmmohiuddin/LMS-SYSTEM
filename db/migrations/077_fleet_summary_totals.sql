-- ---------------------------------------------------------------------
-- 077 — the dashboard's totals, without downloading the fleet.  (P10-2)
--
-- 076 paginated the LIST, which was half the problem. The operations
-- dashboard above that list shows fleet-wide numbers — total students, active
-- users, money collected, how many schools are read-only, how many are past
-- due — and it computed every one of them in the browser by summing the 258
-- rows it had just downloaded.
--
-- So paginating the list alone would have BROKEN the dashboard rather than
-- sped it up: page one of twenty-five would have reported twenty-five
-- schools' students as the country's total. Either the console keeps loading
-- the whole fleet, or the totals come from the database. They come from the
-- database.
--
-- Everything here is one aggregate over `app.platform_fleet_ranked()`, which
-- is the same graded rows the list and the filter bar use — so the headline
-- number and the list under it cannot disagree.
-- ---------------------------------------------------------------------
BEGIN;

DROP FUNCTION IF EXISTS app.platform_fleet_summary();

CREATE FUNCTION app.platform_fleet_summary()
RETURNS TABLE (
  total          bigint,
  critical       bigint,
  warning        bigint,
  info           bigint,
  -- access, as the request gate would answer it
  access_full    bigint,
  access_read    bigint,
  access_none    bigint,
  -- commercial state
  trial          bigint,
  billing_active bigint,
  grace          bigint,
  overdue        bigint,
  -- usage
  student_total  bigint,
  user_total     bigint,
  class_total    bigint,
  section_total  bigint,
  paid_total     numeric,
  -- a school nobody has signed into for a fortnight
  quiet          bigint,
  never_active   bigint,
  -- {plan_code: schools} — the plans tab shows how many schools are on each
  -- plan before an operator edits or retires one, and that count cannot come
  -- from a page of twenty-five.
  plan_usage     jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, app
AS $$
  -- MATERIALIZED, deliberately. Without it Postgres is free to inline the
  -- CTE and evaluate `platform_fleet_ranked()` twice — once for the totals
  -- and once for the per-plan counts — which would double the cost of the
  -- very query this migration exists to make cheap.
  WITH f AS MATERIALIZED (
    SELECT * FROM app.platform_fleet_ranked(NULL, NULL, NULL, NULL)
  ),
  plans AS (
    SELECT COALESCE(jsonb_object_agg(p.code, p.n), '{}'::jsonb) AS usage
      FROM (SELECT COALESCE(plan_code, '—') AS code, count(*) AS n
              FROM f GROUP BY 1) p
  )
  SELECT
    count(*),
    count(*) FILTER (WHERE f.severity = 'critical'),
    count(*) FILTER (WHERE f.severity = 'warning'),
    count(*) FILTER (WHERE f.severity = 'info'),
    count(*) FILTER (WHERE f.access = 'full'),
    count(*) FILTER (WHERE f.access = 'read_only'),
    count(*) FILTER (WHERE f.access = 'none'),
    count(*) FILTER (WHERE f.billing_state = 'trial'),
    count(*) FILTER (WHERE f.billing_state = 'active'),
    count(*) FILTER (WHERE f.billing_state = 'grace_period'),
    count(*) FILTER (WHERE f.billing_state = 'limited'),
    COALESCE(sum(f.student_count), 0),
    COALESCE(sum(f.user_count), 0),
    COALESCE(sum(f.class_count), 0),
    COALESCE(sum(f.section_count), 0),
    COALESCE(sum(f.paid_total), 0),
    -- "Quiet" is fourteen days, matching the console's own QUIET_DAYS. A
    -- school that has NEVER been signed into is counted separately: it is
    -- being set up, not going dark, and folding the two together is what
    -- made the old attention queue flag almost the whole fleet.
    count(*) FILTER (WHERE f.last_active_at IS NOT NULL
                       AND f.last_active_at < now() - interval '14 days'),
    count(*) FILTER (WHERE f.last_active_at IS NULL),
    (SELECT usage FROM plans)
  FROM f;
$$;

COMMENT ON FUNCTION app.platform_fleet_summary() IS
  'Every number the operations dashboard shows, as one aggregate over the '
  'same graded rows the list pages through. The console used to sum these in '
  'the browser from a full download of the fleet, which is why the list '
  'could not be paginated without making the totals wrong.';

REVOKE EXECUTE ON FUNCTION app.platform_fleet_summary() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION app.platform_fleet_summary() TO shikhon_platform;

COMMIT;
