-- ---------------------------------------------------------------------
-- 076 — the fleet, paginated and computed once.  (P10-1, P10-2, P10-3)
--
-- `app.platform_overview()` answers the console's main screen and is
-- QUADRATIC in tenants. Measured on 258 tenants in the development database:
-- 2.56s cold, 500–700ms warm. Its shape is why:
--
--   • five correlated subqueries per tenant — enrolments, users,
--     tenant_payments, user_sessions, product_events
--   • CROSS JOIN LATERAL app.tenant_access(t.id), which is itself two joins
--     plus a call to app.tenant_billing_state(t.id), which is two more
--
-- so a fleet of N schools runs on the order of 7N queries and re-reads the
-- same tables N times. It also returns EVERY school, so the console loads
-- the whole fleet into a browser — 142 kB today — and does its own paging,
-- sorting and attention triage on the client.
--
-- Three functions replace that shape, and they are layered so the rule is
-- written ONCE:
--
--   app.platform_fleet_ranked(...)   every school that matches a filter,
--                                    graded, unpaginated. The rule lives here
--   app.platform_fleet(...)          one page of it, sorted, with the total
--                                    the page was drawn from
--   app.platform_fleet_summary()     the counts a filter bar needs, over the
--                                    WHOLE fleet
--
-- The summary and the list therefore cannot disagree: they are the same
-- rows. The first draft of this migration had the summary call the PAGINATED
-- function, which caps at 200 — it would have quietly under-reported a fleet
-- of 258 and told an operator there were fewer schools in trouble than there
-- were.
--
-- Every per-tenant count becomes a grouped aggregate: one pass per table
-- instead of one query per tenant per table.
--
-- ── The rule that must not fork ──────────────────────────────────────────
-- `app.tenant_access(uuid)` stays exactly as it is. It runs on EVERY tenant
-- request and must stay a single-row lookup; making it read the whole fleet
-- to satisfy the console would be a poor trade. So the access CASE below is
-- a second copy of the same rule, which is precisely the kind of duplication
-- this project keeps finding drifted.
--
-- It is pinned rather than trusted: `db/tests/platform_fleet.sql` asserts
-- that for EVERY tenant, the fleet functions and `tenant_access` return the
-- same access, ops_state and billing_state. If somebody edits one, the suite
-- fails rather than a school discovering it.
-- ---------------------------------------------------------------------
BEGIN;

-- ---------------------------------------------------------------------
-- 1. app.platform_fleet_ranked — every matching school, graded, unpaginated.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.platform_fleet_ranked(
  p_search    text DEFAULT NULL,
  p_status    text DEFAULT NULL,   -- tenant_status, or 'any'
  p_plan      text DEFAULT NULL,   -- plans.code, or 'any'
  p_attention text DEFAULT NULL    -- 'critical' | 'warning' | 'info' | 'any'
)
RETURNS TABLE (
  id             uuid,
  slug           citext,
  name_bn        text,
  name_en        text,
  stream         text,
  level          text,
  district       text,
  status         text,
  access         text,
  ops_state      text,
  billing_state  text,
  state_reason   text,
  plan_code      text,
  plan_name      text,
  plan_price     numeric,
  billing_cycle  text,
  student_cap    integer,
  student_count  bigint,
  user_count     bigint,
  class_count    bigint,
  section_count  bigint,
  paid_total     numeric,
  next_due_on    date,
  grace_until    date,
  trial_ends_on  date,
  created_at     timestamptz,
  last_active_at timestamptz,
  portals        jsonb,
  services       jsonb,
  severity       text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, app
AS $$
  WITH
  -- ── One pass per table, not one query per tenant. ──
  enrol AS (
    SELECT e.tenant_id, count(*) AS n FROM enrolments e
     WHERE e.status = 'active' GROUP BY e.tenant_id
  ),
  usr AS (
    SELECT u.tenant_id, count(*) AS n FROM users u
     WHERE u.status = 'active' AND u.deleted_at IS NULL GROUP BY u.tenant_id
  ),
  cls AS (
    SELECT c.tenant_id, count(*) AS n FROM classes c GROUP BY c.tenant_id
  ),
  sec AS (
    SELECT s.tenant_id, count(*) AS n FROM sections s GROUP BY s.tenant_id
  ),
  pay AS (
    SELECT p.tenant_id, sum(p.amount_bdt) AS total FROM tenant_payments p
     GROUP BY p.tenant_id
  ),
  ses AS (
    SELECT s.tenant_id, max(s.issued_at) AS at FROM user_sessions s
     GROUP BY s.tenant_id
  ),
  evt AS (
    SELECT e.tenant_id, max(e.occurred_at) AS at FROM product_events e
     GROUP BY e.tenant_id
  ),
  base AS (
    SELECT
      t.id, t.slug, t.name_bn, t.name_en,
      t.stream::text AS stream, t.level::text AS level, t.district,
      t.status::text AS status,
      o.state_reason,
      t.plan_code, pl.name_bn AS plan_name, pl.price_bdt AS plan_price,
      pl.billing_cycle::text AS billing_cycle,
      t.student_cap,
      COALESCE(enrol.n, 0)   AS student_count,
      COALESCE(usr.n, 0)     AS user_count,
      COALESCE(cls.n, 0)     AS class_count,
      COALESCE(sec.n, 0)     AS section_count,
      COALESCE(pay.total, 0) AS paid_total,
      o.next_due_on, o.grace_until, t.trial_ends_on, t.created_at,
      GREATEST(ses.at, evt.at) AS last_active_at,
      COALESCE(o.portals,  '{}'::jsonb) AS portals,
      COALESCE(o.services, '{}'::jsonb) AS services,
      COALESCE(o.ops_state::text, 'active') AS ops_state,
      -- app.tenant_billing_state, set-based. Same order, same defaults.
      CASE
        WHEN t.trial_ends_on IS NOT NULL AND t.trial_ends_on >= CURRENT_DATE
          THEN 'trial'
        WHEN o.next_due_on IS NULL           THEN 'active'
        WHEN o.next_due_on >= CURRENT_DATE   THEN 'active'
        WHEN o.grace_until IS NOT NULL AND o.grace_until >= CURRENT_DATE
          THEN 'grace_period'
        WHEN COALESCE(pl.grace_days, 0) > 0
         AND o.next_due_on + COALESCE(pl.grace_days, 0) >= CURRENT_DATE
          THEN 'grace_period'
        WHEN o.next_due_on < CURRENT_DATE    THEN 'limited'
        ELSE 'active'
      END AS billing_state
    FROM tenants t
    LEFT JOIN tenant_operations o ON o.tenant_id = t.id
    LEFT JOIN plans pl            ON pl.code = t.plan_code
    LEFT JOIN enrol ON enrol.tenant_id = t.id
    LEFT JOIN usr   ON usr.tenant_id = t.id
    LEFT JOIN cls   ON cls.tenant_id = t.id
    LEFT JOIN sec   ON sec.tenant_id = t.id
    LEFT JOIN pay   ON pay.tenant_id = t.id
    LEFT JOIN ses   ON ses.tenant_id = t.id
    LEFT JOIN evt   ON evt.tenant_id = t.id
    WHERE t.deleted_at IS NULL
  ),
  graded AS (
    SELECT b.*,
      -- app.tenant_access's access CASE, set-based. The `deleted_at` arm is
      -- unreachable here because `base` already excludes those rows; it is
      -- omitted rather than written as dead code, and the SQL test compares
      -- the two functions only over rows both can see.
      CASE
        WHEN b.status = 'archived'                     THEN 'none'
        WHEN b.status = 'suspended'                    THEN 'none'
        WHEN b.ops_state = 'suspended'                 THEN 'none'
        WHEN b.ops_state IN ('maintenance', 'limited') THEN 'read_only'
        WHEN b.billing_state = 'limited'               THEN 'read_only'
        ELSE 'full'
      END AS access
    FROM base b
  ),
  ranked AS (
    SELECT g.*,
      -- §4. Three bands, so the queue can lead with what stops people.
      --   critical  nobody can work, or money has already stopped service
      --   warning   something will stop working if nobody acts
      --   info      worth seeing, urgent to nobody
      CASE
        WHEN g.access = 'none'                      THEN 'critical'
        WHEN g.billing_state = 'limited'            THEN 'critical'
        WHEN g.access = 'read_only'                 THEN 'warning'
        WHEN g.billing_state = 'grace_period'       THEN 'warning'
        WHEN g.student_cap IS NOT NULL
         AND g.student_cap > 0
         AND g.student_count >= g.student_cap       THEN 'warning'
        WHEN g.trial_ends_on IS NOT NULL
         AND g.trial_ends_on >= CURRENT_DATE
         AND g.trial_ends_on < CURRENT_DATE + 14    THEN 'warning'
        -- Onboarding is the band that swamped the queue: 246 of 276 rows on
        -- the development fleet. It is real and it is urgent to nobody, so
        -- it is `info` and filterable rather than hidden.
        WHEN g.student_count = 0 AND g.user_count <= 1 THEN 'info'
        ELSE 'none'
      END AS severity
    FROM graded g
  )
  SELECT
    r.id, r.slug, r.name_bn, r.name_en, r.stream, r.level, r.district,
    r.status, r.access, r.ops_state, r.billing_state, r.state_reason,
    r.plan_code, r.plan_name, r.plan_price, r.billing_cycle,
    r.student_cap, r.student_count, r.user_count, r.class_count,
    r.section_count, r.paid_total, r.next_due_on, r.grace_until,
    r.trial_ends_on, r.created_at, r.last_active_at, r.portals, r.services,
    r.severity
  FROM ranked r
   WHERE (p_search IS NULL OR p_search = ''
          OR r.name_bn ILIKE '%' || p_search || '%'
          OR r.name_en ILIKE '%' || p_search || '%'
          OR r.district ILIKE '%' || p_search || '%'
          OR r.slug::text ILIKE '%' || p_search || '%')
     AND (p_status IS NULL OR p_status IN ('', 'any') OR r.status = p_status)
     AND (p_plan   IS NULL OR p_plan   IN ('', 'any') OR r.plan_code = p_plan)
     AND (p_attention IS NULL OR p_attention IN ('', 'any')
          OR r.severity = p_attention);
$$;

-- ---------------------------------------------------------------------
-- 2. app.platform_fleet — one page of it.
--
-- `p_sort` and `p_dir` are whitelisted through CASE rather than
-- concatenated. A sort key is operator input, and an ORDER BY built by
-- string concatenation is an injection in the one console that can suspend
-- every school in the country.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.platform_fleet(
  p_search    text    DEFAULT NULL,
  p_status    text    DEFAULT NULL,
  p_plan      text    DEFAULT NULL,
  p_attention text    DEFAULT NULL,
  p_sort      text    DEFAULT 'name',
  p_dir       text    DEFAULT 'asc',
  p_limit     integer DEFAULT 25,
  p_offset    integer DEFAULT 0
)
RETURNS TABLE (
  id             uuid,
  slug           citext,
  name_bn        text,
  name_en        text,
  stream         text,
  level          text,
  district       text,
  status         text,
  access         text,
  ops_state      text,
  billing_state  text,
  state_reason   text,
  plan_code      text,
  plan_name      text,
  plan_price     numeric,
  billing_cycle  text,
  student_cap    integer,
  student_count  bigint,
  user_count     bigint,
  class_count    bigint,
  section_count  bigint,
  paid_total     numeric,
  next_due_on    date,
  grace_until    date,
  trial_ends_on  date,
  created_at     timestamptz,
  last_active_at timestamptz,
  portals        jsonb,
  services       jsonb,
  severity       text,
  total_count    bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, app
AS $$
  WITH counted AS (
    SELECT f.*, count(*) OVER () AS total_count
      FROM app.platform_fleet_ranked(p_search, p_status, p_plan, p_attention) f
  ),
  -- The sort key, computed once as a comparable text so the two ORDER BY
  -- arms below stay in step. Numbers are zero-padded because '9' sorts after
  -- '10' as text and a fleet sorted by students would put the smallest
  -- school on top of the largest.
  keyed AS (
    SELECT c.*,
      CASE lower(COALESCE(p_sort, 'name'))
        WHEN 'students' THEN lpad(c.student_count::text, 12, '0')
        WHEN 'created'  THEN to_char(c.created_at, 'YYYYMMDDHH24MISS')
        WHEN 'active'   THEN to_char(COALESCE(c.last_active_at,
                              '1970-01-01'::timestamptz), 'YYYYMMDDHH24MISS')
        WHEN 'status'   THEN c.status
        WHEN 'plan'     THEN COALESCE(c.plan_code, '')
        WHEN 'severity' THEN CASE c.severity
                               WHEN 'critical' THEN '0' WHEN 'warning' THEN '1'
                               WHEN 'info' THEN '2' ELSE '3' END
        ELSE c.name_bn
      END AS sort_key
    FROM counted c
  )
  SELECT
    k.id, k.slug, k.name_bn, k.name_en, k.stream, k.level, k.district,
    k.status, k.access, k.ops_state, k.billing_state, k.state_reason,
    k.plan_code, k.plan_name, k.plan_price, k.billing_cycle,
    k.student_cap, k.student_count, k.user_count, k.class_count,
    k.section_count, k.paid_total, k.next_due_on, k.grace_until,
    k.trial_ends_on, k.created_at, k.last_active_at, k.portals, k.services,
    k.severity, k.total_count
  FROM keyed k
  ORDER BY
    CASE WHEN lower(COALESCE(p_dir, 'asc')) <> 'desc' THEN k.sort_key END ASC,
    CASE WHEN lower(COALESCE(p_dir, 'asc'))  = 'desc' THEN k.sort_key END DESC,
    -- A stable tiebreak, so page 2 never repeats or skips a row page 1 has
    -- already shown. Without it a paginated list with equal sort keys is
    -- free to reorder between requests.
    k.id
  LIMIT  GREATEST(1, LEAST(COALESCE(p_limit, 25), 200))
  OFFSET GREATEST(0, COALESCE(p_offset, 0));
$$;

COMMENT ON FUNCTION app.platform_fleet(text, text, text, text, text, text, integer, integer) IS
  'One page of the fleet, filtered and sorted in the database. Replaces the '
  'quadratic app.platform_overview() for the console list: every per-tenant '
  'count is a grouped aggregate, so a fleet of N costs a fixed number of '
  'passes rather than 7N queries. The access rule is a second copy of '
  'app.tenant_access and db/tests/platform_fleet.sql pins them equal.';

-- ---------------------------------------------------------------------
-- 3. app.platform_fleet_summary — the whole fleet, in one row.
--
-- A filter bar that counts only the page it can see is a filter bar that
-- lies. These counts are over every school, so "৫টি জরুরি" means five in the
-- fleet and not five on this screen. It reads the RANKED function, not the
-- paginated one, so the 200-row page cap cannot silently truncate it.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.platform_fleet_summary()
RETURNS TABLE (
  total     bigint,
  critical  bigint,
  warning   bigint,
  info      bigint,
  suspended bigint,
  trial     bigint,
  overdue   bigint,
  active    bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, app
AS $$
  SELECT
    count(*),
    count(*) FILTER (WHERE f.severity = 'critical'),
    count(*) FILTER (WHERE f.severity = 'warning'),
    count(*) FILTER (WHERE f.severity = 'info'),
    count(*) FILTER (WHERE f.access = 'none'),
    count(*) FILTER (WHERE f.billing_state = 'trial'),
    count(*) FILTER (WHERE f.billing_state IN ('limited', 'grace_period')),
    count(*) FILTER (WHERE f.access = 'full')
  FROM app.platform_fleet_ranked(NULL, NULL, NULL, NULL) f;
$$;

REVOKE EXECUTE ON FUNCTION app.platform_fleet_ranked(text, text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.platform_fleet(text, text, text, text, text, text, integer, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.platform_fleet_summary() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION app.platform_fleet_ranked(text, text, text, text) TO shikhon_platform;
GRANT  EXECUTE ON FUNCTION app.platform_fleet(text, text, text, text, text, text, integer, integer) TO shikhon_platform;
GRANT  EXECUTE ON FUNCTION app.platform_fleet_summary() TO shikhon_platform;

COMMIT;
