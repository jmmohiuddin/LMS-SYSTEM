-- ---------------------------------------------------------------------------
-- 057 — When did anybody last actually USE this school?
--
-- §25/§26 ask the console for usage and for "recently inactive". P7's first
-- answer was "no students have been added", which is a real signal and a
-- narrow one: it says nothing about a school that was set up properly in
-- March and has not been opened since.
--
-- ── Measured, not invented ──────────────────────────────────────────────
-- The brief says do not fake telemetry, so this counts only things the
-- product already records for its own reasons:
--
--   `user_sessions.issued_at`  — somebody signed in. Sessions are REVOKED,
--                                never deleted (logout sets `revoked_at`),
--                                so the maximum survives a logout and is a
--                                real last-sign-in rather than a
--                                last-still-logged-in.
--   `product_events.occurred_at` — the app reported something happening.
--
-- Whichever is later. NULL means nobody has ever signed in, which the console
-- must say as "কখনো ব্যবহার হয়নি" and not as a date.
--
-- Return type changes, so DROP first — `CREATE OR REPLACE` cannot widen a
-- RETURNS TABLE.
-- ---------------------------------------------------------------------------

BEGIN;

DROP FUNCTION IF EXISTS app.platform_overview();

CREATE FUNCTION app.platform_overview()
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
  paid_total     numeric,
  next_due_on    date,
  grace_until    date,
  trial_ends_on  date,
  created_at     timestamptz,
  last_active_at timestamptz,
  portals        jsonb,
  services       jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, app
AS $$
  SELECT t.id, t.slug, t.name_bn, t.name_en,
         t.stream::text, t.level::text, t.district, t.status::text,
         a.access, a.ops_state, a.billing_state, o.state_reason,
         t.plan_code, p.name_bn, p.price_bdt, p.billing_cycle,
         t.student_cap,
         (SELECT count(*) FROM enrolments e
           WHERE e.tenant_id = t.id AND e.status = 'active'),
         (SELECT count(*) FROM users u
           WHERE u.tenant_id = t.id AND u.status = 'active' AND u.deleted_at IS NULL),
         (SELECT COALESCE(sum(pay.amount_bdt), 0) FROM tenant_payments pay
           WHERE pay.tenant_id = t.id),
         o.next_due_on, o.grace_until, t.trial_ends_on, t.created_at,
         GREATEST(
           (SELECT max(s.issued_at) FROM user_sessions s WHERE s.tenant_id = t.id),
           (SELECT max(e.occurred_at) FROM product_events e WHERE e.tenant_id = t.id)
         ),
         COALESCE(o.portals, '{}'::jsonb), COALESCE(o.services, '{}'::jsonb)
    FROM tenants t
    LEFT JOIN tenant_operations o ON o.tenant_id = t.id
    LEFT JOIN plans p ON p.code = t.plan_code
    CROSS JOIN LATERAL app.tenant_access(t.id) a
   WHERE t.deleted_at IS NULL
   ORDER BY t.name_bn;
$$;

GRANT EXECUTE ON FUNCTION app.platform_overview() TO shikhon_platform;
REVOKE EXECUTE ON FUNCTION app.platform_overview() FROM PUBLIC;

COMMIT;
