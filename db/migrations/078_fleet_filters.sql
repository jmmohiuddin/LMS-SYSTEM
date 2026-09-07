-- ---------------------------------------------------------------------
-- 078 — the filters the console's tabs actually are.  (P10-3)
--
-- The operations console offers four tabs over the fleet: all, "needs
-- attention", overdue, and suspended-or-limited. Before P10 each was a
-- client-side `.filter()` over every school the browser had downloaded, and
-- the count on the tab was `.length` of that array.
--
-- 076 gave the database a single `p_attention` band. Three of those four tabs
-- are not a band:
--
--   attention  critical OR warning — everything a person should act on,
--              which is deliberately NOT the same as `critical` alone
--   overdue    billing has already stopped service
--   blocked    access is anything other than full, whatever caused it
--
-- Expressing them as bands would have meant the tab and its own count coming
-- from different expressions, which is how a filter comes to disagree with
-- the badge that offered it. So the vocabulary is widened instead: one
-- parameter, six words, and the count and the rows are the same query.
-- ---------------------------------------------------------------------
BEGIN;

CREATE OR REPLACE FUNCTION app.platform_fleet_ranked(
  p_search    text DEFAULT NULL,
  p_status    text DEFAULT NULL,
  p_plan      text DEFAULT NULL,
  p_attention text DEFAULT NULL
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
     -- The console's own vocabulary. `action` is critical OR warning, which
     -- is what "needs attention" has always meant to an operator and is not
     -- expressible as a single band.
     AND (p_attention IS NULL OR p_attention IN ('', 'any')
          OR (p_attention = 'action'  AND r.severity IN ('critical', 'warning'))
          OR (p_attention = 'overdue' AND r.billing_state = 'limited')
          OR (p_attention = 'blocked' AND r.access <> 'full')
          OR (p_attention IN ('critical', 'warning', 'info')
              AND r.severity = p_attention));
$$;

COMMENT ON FUNCTION app.platform_fleet_ranked(text, text, text, text) IS
  'Every school matching a filter, graded. `p_attention` takes a severity '
  'band (critical/warning/info) or one of the console''s own words: `action` '
  '(critical or warning), `overdue` (service already stopped for money), '
  '`blocked` (access is not full). One parameter, so a tab and the count on '
  'it are always the same query.';

COMMIT;
