-- =====================================================================
-- db/tests/platform_fleet.sql   (P10-1/P10-2/P10-3)
--
-- Migration 076 replaced the console's quadratic fleet read with set-based
-- functions, and in doing so wrote the tenant-access rule down a SECOND
-- time. `app.tenant_access(uuid)` still runs on every tenant request and has
-- to stay a single-row lookup; `app.platform_fleet_ranked()` computes the
-- same answer for the whole fleet at once. Two implementations of one rule
-- is exactly the shape this project keeps finding drifted months later.
--
-- So this suite's first and most important job is to make drift impossible
-- to ship: for EVERY tenant, the two must agree on access, ops_state and
-- billing_state. If somebody edits one CASE and not the other, this fails.
--
-- It also pins the things a paginated list gets wrong quietly — a total that
-- counts the page instead of the result, a sort that orders numbers as text,
-- a second page that repeats a row from the first, and a summary that counts
-- only as far as the page cap.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/platform_fleet.sql
-- =====================================================================

\set ON_ERROR_STOP on

-- These are SECURITY DEFINER and granted to shikhon_platform, which is the
-- point: the fleet is not readable by the tenant role. Test 7 proves it.
GRANT shikhon_platform TO CURRENT_USER;
SET ROLE shikhon_platform;

DO $$
DECLARE
  v_bad     bigint;
  v_total   bigint;
  v_n       bigint;
  v_first   text;
  v_prev    bigint;
  v_row     record;
BEGIN
  -- =================================================================
  -- 1. THE ONE THAT MATTERS. The duplicated rule agrees, tenant by tenant.
  -- =================================================================
  SELECT count(*) INTO v_bad
    FROM app.platform_fleet_ranked(NULL, NULL, NULL, NULL) f
    CROSS JOIN LATERAL app.tenant_access(f.id) a
   WHERE f.access        IS DISTINCT FROM a.access
      OR f.ops_state     IS DISTINCT FROM a.ops_state
      OR f.billing_state IS DISTINCT FROM a.billing_state;

  IF v_bad <> 0 THEN
    RAISE EXCEPTION
      'FAIL 1: % tenant(s) where platform_fleet_ranked and tenant_access '
      'disagree. The console and the enforcement gate would show different '
      'answers for the same school.', v_bad;
  END IF;
  RAISE NOTICE 'PASS 1 — the fleet grading and the request gate agree on every tenant';

  -- =================================================================
  -- 2. The total describes the RESULT, not the page.
  --
  -- The failure this prevents: an operator filters to the schools that are
  -- down, sees "1–25 of 25" because that is the page size, and closes the
  -- screen believing they have seen all of them.
  -- =================================================================
  SELECT count(*) INTO v_total FROM app.platform_fleet_ranked(NULL, NULL, NULL, NULL);
  SELECT DISTINCT total_count INTO v_n
    FROM app.platform_fleet(NULL, NULL, NULL, NULL, 'name', 'asc', 5, 0);

  IF v_n IS DISTINCT FROM v_total THEN
    RAISE EXCEPTION 'FAIL 2: a five-row page reports a total of %, the fleet has %',
      v_n, v_total;
  END IF;
  RAISE NOTICE 'PASS 2 — a page of 5 still reports the whole fleet (%)', v_total;

  -- …and the same holds once a filter narrows it.
  SELECT count(*) INTO v_total
    FROM app.platform_fleet_ranked(NULL, NULL, NULL, 'critical');
  SELECT DISTINCT total_count INTO v_n
    FROM app.platform_fleet(NULL, NULL, NULL, 'critical', 'name', 'asc', 2, 0);
  IF v_total > 0 AND v_n IS DISTINCT FROM v_total THEN
    RAISE EXCEPTION 'FAIL 2b: filtered total is % but the page says %', v_total, v_n;
  END IF;
  RAISE NOTICE 'PASS 2b — a filtered page reports the filtered total (%)', v_total;

  -- =================================================================
  -- 3. A filter returns only what it says.
  -- =================================================================
  SELECT count(*) INTO v_bad
    FROM app.platform_fleet(NULL, NULL, NULL, 'critical', 'name', 'asc', 100, 0)
   WHERE severity <> 'critical';
  IF v_bad <> 0 THEN
    RAISE EXCEPTION 'FAIL 3: % non-critical rows in a critical-only page', v_bad;
  END IF;
  RAISE NOTICE 'PASS 3 — the severity filter returns only that band';

  -- =================================================================
  -- 4. Sorting by a NUMBER orders numerically.
  --
  -- The trap: student_count sorted as text puts 9 above 10 and tells an
  -- operator their largest school is their smallest. The function
  -- zero-pads for exactly this reason.
  -- =================================================================
  v_prev := NULL;
  FOR v_row IN
    SELECT student_count FROM app.platform_fleet(
      NULL, NULL, NULL, NULL, 'students', 'desc', 50, 0)
  LOOP
    IF v_prev IS NOT NULL AND v_row.student_count > v_prev THEN
      RAISE EXCEPTION 'FAIL 4: students desc went % then % — sorted as text',
        v_prev, v_row.student_count;
    END IF;
    v_prev := v_row.student_count;
  END LOOP;
  RAISE NOTICE 'PASS 4 — a numeric sort is numeric, not lexicographic';

  -- =================================================================
  -- 5. Page 2 does not repeat page 1.
  --
  -- Without a stable tiebreak, rows with equal sort keys may come back in a
  -- different order per request, so paging silently shows one school twice
  -- and never shows another at all.
  -- =================================================================
  SELECT count(*) INTO v_bad FROM (
    SELECT id FROM app.platform_fleet(NULL, NULL, NULL, NULL, 'status', 'asc', 10, 0)
    INTERSECT
    SELECT id FROM app.platform_fleet(NULL, NULL, NULL, NULL, 'status', 'asc', 10, 10)
  ) x;
  IF v_bad <> 0 THEN
    RAISE EXCEPTION 'FAIL 5: % school(s) appear on both page 1 and page 2', v_bad;
  END IF;
  RAISE NOTICE 'PASS 5 — paging is stable across requests';

  -- =================================================================
  -- 6. The summary counts the FLEET, not one page.
  --
  -- The first draft of migration 076 had the summary call the paginated
  -- function, which caps at 200. On a 258-school fleet it would have told an
  -- operator there was less wrong than there was.
  -- =================================================================
  -- Ground truth is the RANKED function, not a direct read of `tenants`:
  -- `shikhon_platform` is deliberately not granted that table, which is why
  -- these functions are SECURITY DEFINER in the first place. An earlier
  -- version of this assertion read the table, got 0 rows through RLS, and
  -- reported a failure that was actually the isolation working.
  SELECT total INTO v_n FROM app.platform_fleet_summary();
  SELECT count(*) INTO v_total FROM app.platform_fleet_ranked(NULL, NULL, NULL, NULL);
  IF v_n IS DISTINCT FROM v_total THEN
    RAISE EXCEPTION 'FAIL 6: summary totals % against % live tenants', v_n, v_total;
  END IF;

  SELECT count(*) INTO v_total
    FROM app.platform_fleet_ranked(NULL, NULL, NULL, 'critical');
  SELECT critical INTO v_n FROM app.platform_fleet_summary();
  IF v_n IS DISTINCT FROM v_total THEN
    RAISE EXCEPTION 'FAIL 6b: summary says % critical, the list has %', v_n, v_total;
  END IF;
  RAISE NOTICE 'PASS 6 — the summary and the list are the same rows (% total)', v_total;

  -- =================================================================
  -- 7. A hostile sort key cannot become SQL.
  --
  -- `p_sort` is operator input and it lands in an ORDER BY. It is whitelisted
  -- through CASE rather than concatenated; this asserts that an injection
  -- attempt is simply ignored and the default ordering is used.
  -- =================================================================
  SELECT count(*) INTO v_total FROM app.platform_fleet_ranked(NULL, NULL, NULL, NULL);
  SELECT count(*) INTO v_n FROM app.platform_fleet(
    NULL, NULL, NULL, NULL, 'name; DROP TABLE tenants--', 'asc', 5, 0);
  IF v_n <> LEAST(5::bigint, v_total) THEN
    RAISE EXCEPTION 'FAIL 7: a hostile sort key changed the result (% rows)', v_n;
  END IF;
  -- And the fleet is still there to be counted.
  SELECT count(*) INTO v_n FROM app.platform_fleet_ranked(NULL, NULL, NULL, NULL);
  IF v_n <> v_total THEN
    RAISE EXCEPTION 'FAIL 7: the fleet changed size after a hostile sort key';
  END IF;
  RAISE NOTICE 'PASS 7 — a hostile sort key is ignored, not executed';

  -- =================================================================
  -- 8. The page size is clamped in the DATABASE, not only in the handler.
  -- =================================================================
  SELECT count(*) INTO v_n FROM app.platform_fleet(
    NULL, NULL, NULL, NULL, 'name', 'asc', 100000, 0);
  IF v_n > 200 THEN
    RAISE EXCEPTION 'FAIL 8: asked for 100000 rows and got % — the clamp is only in the handler', v_n;
  END IF;
  RAISE NOTICE 'PASS 8 — a caller cannot ask the database for the whole fleet at once';
END $$;

RESET ROLE;

-- =====================================================================
-- 9. The tenant role cannot read the fleet.
--
-- `shikhon_app` serves every school request. If it could execute these, a
-- single SQL-injection anywhere in the tenant surface would hand over every
-- institution in the country.
-- =====================================================================
SET ROLE shikhon_app;
DO $$
BEGIN
  BEGIN
    PERFORM * FROM app.platform_fleet_ranked(NULL, NULL, NULL, NULL) LIMIT 1;
    RAISE EXCEPTION 'FAIL 9: shikhon_app executed platform_fleet_ranked';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS 9a — shikhon_app is refused platform_fleet_ranked';
  END;
  BEGIN
    PERFORM * FROM app.platform_fleet_summary();
    RAISE EXCEPTION 'FAIL 9: shikhon_app executed platform_fleet_summary';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS 9b — shikhon_app is refused platform_fleet_summary';
  END;
  BEGIN
    PERFORM * FROM app.platform_fleet(NULL, NULL, NULL, NULL, 'name', 'asc', 1, 0);
    RAISE EXCEPTION 'FAIL 9: shikhon_app executed platform_fleet';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS 9c — shikhon_app is refused platform_fleet';
  END;
END $$;
RESET ROLE;

\echo 'platform_fleet.sql — all assertions passed'
