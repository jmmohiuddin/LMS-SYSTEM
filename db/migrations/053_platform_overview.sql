-- ---------------------------------------------------------------------------
-- 053 — The operations console's own read path, and its one write to `tenants`.
--
-- ── The bug this exists to fix ───────────────────────────────────────────
-- P7's `/overview` endpoint selected `FROM tenants` as `shikhon_platform` and
-- got back nothing. Thirty-seven schools in the database, zero rows in the
-- console, HTTP 200.
--
-- `tenants` carries the `tenant_self` policy from migration 010: a row is
-- visible when `id = app.current_tenant()`. The platform role has no tenant,
-- so it matches nothing — which is the correct and deliberate design. It is
-- exactly why R-7 built `app.platform_tenants()` as SECURITY DEFINER, and P7
-- simply forgot to follow the pattern.
--
-- Two lessons, both recorded because both cost a debugging cycle:
--   * a GRANT is not a POLICY (052, `tenant_operations`)
--   * a POLICY is not a BYPASS (this file, `tenants`)
-- Silent zero rows, both times. Neither raised an error.
--
-- ── Why not a policy for the platform role on `tenants` ──────────────────
-- Because a policy would make every stray query in platform-svc cross-tenant
-- by default, and 045's whole argument is that the platform service does most
-- of its work INSIDE one school with RLS standing. A definer function is a
-- door with a name on it; a policy is a hole in the wall.
-- ---------------------------------------------------------------------------

BEGIN;

-- ── 1. The console's list ────────────────────────────────────────────────
--
-- One row per school with everything the master list and the attention queue
-- need. Deliberately one function rather than a view: a view would need its
-- own policy, and we are here because of policies.
CREATE OR REPLACE FUNCTION app.platform_overview()
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
         COALESCE(o.portals, '{}'::jsonb), COALESCE(o.services, '{}'::jsonb)
    FROM tenants t
    LEFT JOIN tenant_operations o ON o.tenant_id = t.id
    LEFT JOIN plans p ON p.code = t.plan_code
    CROSS JOIN LATERAL app.tenant_access(t.id) a
   WHERE t.deleted_at IS NULL
   ORDER BY t.name_bn;
$$;

-- ── 2. One school's operations ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION app.platform_operations(p_tenant uuid)
RETURNS TABLE (
  plan_code      text,
  plan_name      text,
  price_bdt      numeric,
  billing_cycle  text,
  grace_days     integer,
  plan_cap       integer,
  plan_services  jsonb,
  student_cap    integer,
  student_count  bigint,
  trial_ends_on  date,
  status         text,
  ops_state      text,
  state_reason   text,
  state_changed_at timestamptz,
  state_until    timestamptz,
  portals        jsonb,
  services       jsonb,
  next_due_on    date,
  grace_until    date,
  grace_reason   text,
  access         text,
  billing_state  text,
  reason_bn      text,
  until          date
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, app
AS $$
  SELECT t.plan_code, p.name_bn, p.price_bdt, p.billing_cycle, p.grace_days,
         p.student_cap, COALESCE(p.services, '{}'::jsonb),
         t.student_cap,
         (SELECT count(*) FROM enrolments e
           WHERE e.tenant_id = t.id AND e.status = 'active'),
         t.trial_ends_on, t.status::text,
         a.ops_state, o.state_reason, o.state_changed_at, o.state_until,
         COALESCE(o.portals, '{}'::jsonb), COALESCE(o.services, '{}'::jsonb),
         o.next_due_on, o.grace_until, o.grace_reason,
         a.access, a.billing_state, a.reason_bn, a.until
    FROM tenants t
    LEFT JOIN tenant_operations o ON o.tenant_id = t.id
    LEFT JOIN plans p ON p.code = t.plan_code
    CROSS JOIN LATERAL app.tenant_access(t.id) a
   WHERE t.id = p_tenant AND t.deleted_at IS NULL;
$$;

-- ── 3. The student cap ───────────────────────────────────────────────────
--
-- The console's ONE write to `tenants`, and it had the same silent-zero-rows
-- problem: `UPDATE tenants SET student_cap` as the platform role matched no
-- row, reported success, and changed nothing.
--
-- Refuses to go below the children already enrolled. §19: "do not corrupt
-- existing records" — a cap under the roll would make `enforce_student_cap`
-- reject every future enrolment with no way back except another cap change.
CREATE OR REPLACE FUNCTION app.set_student_cap(
  p_actor uuid, p_tenant uuid, p_cap integer, p_reason text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, audit
AS $$
DECLARE
  v_enrolled integer;
BEGIN
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'set_student_cap needs an actor: platform actions are audited'
      USING ERRCODE = '22023';
  END IF;
  IF p_cap IS NULL OR p_cap < 1 THEN
    RAISE EXCEPTION 'student cap must be a positive integer' USING ERRCODE = '22023';
  END IF;

  SELECT count(*) INTO v_enrolled FROM enrolments
   WHERE tenant_id = p_tenant AND status = 'active';

  IF p_cap < v_enrolled THEN
    RAISE EXCEPTION 'cap % is below the % students already enrolled', p_cap, v_enrolled
      USING ERRCODE = '23514';
  END IF;

  UPDATE tenants SET student_cap = p_cap, updated_at = now()
   WHERE id = p_tenant AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such tenant' USING ERRCODE = '02000';
  END IF;

  INSERT INTO audit.platform_access (admin_id, tenant_id, reason, statement)
  VALUES (p_actor, p_tenant, p_reason,
          format('student_cap=%s (enrolled=%s)', p_cap, v_enrolled));

  RETURN v_enrolled;
END;
$$;

-- ── 4. Grants ────────────────────────────────────────────────────────────
--
-- The console only. These three see across schools, which is the one thing
-- the runtime role must never be able to do.
GRANT EXECUTE ON FUNCTION
  app.platform_overview(),
  app.platform_operations(uuid),
  app.set_student_cap(uuid, uuid, integer, text)
TO shikhon_platform;

REVOKE EXECUTE ON FUNCTION
  app.platform_overview(),
  app.platform_operations(uuid),
  app.set_student_cap(uuid, uuid, integer, text)
FROM PUBLIC;

COMMIT;
