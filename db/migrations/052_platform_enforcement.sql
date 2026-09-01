-- ---------------------------------------------------------------------------
-- 052 — The gate. Where operational state stops being a column and starts
--       being a rule.
--
-- 051 created the model. This is the half that bites: one function every
-- tenant request already passes through, returning what this school may do
-- right now, and the derived billing lifecycle that decides it.
--
-- ── Why one function and not a policy per table ──────────────────────────
-- B-7 put a revocation behind a RESTRICTIVE policy because the question was
-- "may this ROW be seen", and a policy answers that for every query at once.
-- This question is different: "may this REQUEST happen at all". It is asked
-- once per request, before any row is touched, and the answer has to reach
-- the HTTP layer so it can be a 403 with a sentence rather than an empty
-- result set. A school that is suspended must be TOLD, not shown a blank.
--
-- ── The lifecycle is derived, never stored ───────────────────────────────
-- §13 asks for ACTIVE → PAYMENT_DUE → GRACE_PERIOD → LIMITED → SUSPENDED and
-- says it must come from authoritative subscription and payment data. So
-- there is no `billing_state` column to drift: `app.tenant_billing_state`
-- computes it from `next_due_on`, `grace_until` and the plan every time.
-- The only stored state is the one an OPERATOR sets by hand, and that is a
-- different column with a different name (`ops_state`) so the two can never
-- be confused.
-- ---------------------------------------------------------------------------

BEGIN;

-- ── 1. The derived billing lifecycle ─────────────────────────────────────
--
-- Returns exactly one of:
--   trial          — inside the trial window, nothing owed yet
--   active         — paid, and the next due date is in the future
--   payment_due    — the due date has passed, grace has not started or is not
--                    configured
--   grace_period   — past due, inside `grace_until`
--   limited        — past due and past grace
--
-- `suspended` is deliberately NOT here: suspension is an operator decision,
-- not a consequence of a date, and conflating them would mean a bank holiday
-- could suspend a school.
CREATE OR REPLACE FUNCTION app.tenant_billing_state(p_tenant uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, app
AS $$
  SELECT CASE
    -- Trial wins while it lasts, even if a due date was set optimistically.
    WHEN t.trial_ends_on IS NOT NULL AND t.trial_ends_on >= CURRENT_DATE
      THEN 'trial'
    -- No due date means nobody has started billing this school. That is not
    -- a debt; a pilot runs like this for a year.
    WHEN o.next_due_on IS NULL
      THEN 'active'
    WHEN o.next_due_on >= CURRENT_DATE
      THEN 'active'
    WHEN o.grace_until IS NOT NULL AND o.grace_until >= CURRENT_DATE
      THEN 'grace_period'
    -- Past due, and grace either never granted or already spent. If the plan
    -- carries grace days and none was recorded, the plan's own window still
    -- applies — a school does not lose service because an operator forgot to
    -- press a button.
    WHEN COALESCE(p.grace_days, 0) > 0
     AND o.next_due_on + COALESCE(p.grace_days, 0) >= CURRENT_DATE
      THEN 'grace_period'
    WHEN o.next_due_on < CURRENT_DATE
      THEN 'limited'
    ELSE 'active'
  END
  FROM tenants t
  -- LEFT, with the defaults below. A missing operations row must degrade to
  -- "nothing owed", not to "no answer" — see the header of step 0.
  LEFT JOIN tenant_operations o ON o.tenant_id = t.id
  LEFT JOIN plans p ON p.code = t.plan_code
  WHERE t.id = p_tenant;
$$;

COMMENT ON FUNCTION app.tenant_billing_state(uuid) IS
  'DERIVED from dates and payments. There is no billing_state column, so '
  'there is nothing for a manual edit to disagree with.';

-- ── 2. The gate ──────────────────────────────────────────────────────────
--
-- One row: may this school act, may it read, and why not.
--
--   access  'full'      everything the plan allows
--           'read_only' signed in, nothing may be written
--           'none'      no tenant access at all
--
-- The operator's `ops_state` and the derived billing state are combined by
-- taking the STRICTER of the two. A paid-up school in maintenance is
-- read-only; a suspended school that has just paid is still suspended,
-- because an operator suspended it for a reason a payment does not answer.
CREATE OR REPLACE FUNCTION app.tenant_access(p_tenant uuid)
RETURNS TABLE (
  access        text,
  ops_state     text,
  billing_state text,
  reason_bn     text,
  until         date
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, app
AS $$
  WITH s AS (
    SELECT COALESCE(o.ops_state::text, 'active') AS ops,
           app.tenant_billing_state(p_tenant) AS bill,
           o.state_reason,
           o.state_until,
           o.grace_until,
           o.next_due_on,
           t.deleted_at,
           t.status::text AS legacy_status
    FROM tenants t
    -- LEFT: a school with no operations row is a school nobody has set an
    -- operational state for, which is `active`. INNER would have returned no
    -- row at all, and the gate fails closed on no row — so a brand-new school
    -- would have been born suspended.
    LEFT JOIN tenant_operations o ON o.tenant_id = t.id
    WHERE t.id = p_tenant
  )
  SELECT
    CASE
      -- A deleted or archived school is gone. Checked first: it outranks
      -- every commercial consideration.
      WHEN s.deleted_at IS NOT NULL OR s.legacy_status = 'archived' THEN 'none'
      -- `tenants.status` kept its old meaning, and R-7 shipped a console
      -- button that writes 'suspended' into it. Before 052 nothing read that
      -- column; honouring it here is what makes the existing button real,
      -- rather than leaving two suspension mechanisms that disagree.
      WHEN s.legacy_status = 'suspended' THEN 'none'
      WHEN s.ops = 'suspended' THEN 'none'
      WHEN s.ops IN ('maintenance', 'limited') THEN 'read_only'
      WHEN s.bill = 'limited' THEN 'read_only'
      ELSE 'full'
    END,
    s.ops,
    s.bill,
    CASE
      WHEN s.deleted_at IS NOT NULL OR s.legacy_status = 'archived'
        THEN 'এই প্রতিষ্ঠানের অ্যাকাউন্ট বন্ধ করা হয়েছে।'
      WHEN s.legacy_status = 'suspended' OR s.ops = 'suspended'
        THEN COALESCE(s.state_reason,
             'প্রতিষ্ঠানের অ্যাকাউন্ট সাময়িকভাবে স্থগিত আছে। '
             || 'কোনো তথ্য মুছে যায়নি — শিখনবিডির সাথে যোগাযোগ করুন।')
      WHEN s.ops = 'maintenance'
        THEN COALESCE(s.state_reason,
             'রক্ষণাবেক্ষণ চলছে — এখন শুধু দেখা যাবে, কোনো পরিবর্তন সংরক্ষণ হবে না।')
      WHEN s.ops = 'limited' OR s.bill = 'limited'
        THEN 'বকেয়া পরিশোধ না হওয়া পর্যন্ত শুধু দেখা যাবে। '
             || 'সব তথ্য অক্ষত আছে — পরিশোধের পর সব আগের মতো চালু হবে।'
      ELSE NULL
    END,
    CASE
      WHEN s.ops = 'maintenance' THEN s.state_until::date
      WHEN s.bill = 'grace_period' THEN
        GREATEST(s.grace_until, s.next_due_on)
      ELSE NULL
    END
  FROM s;
$$;

COMMENT ON FUNCTION app.tenant_access(uuid) IS
  'The one question every tenant request asks before touching a row: may this '
  'school act, may it read, and what do we tell them. Combines the operator''s '
  'state with the derived billing state by taking the stricter of the two.';

-- ── 3. Is one service on, for this school, right now? ────────────────────
--
-- Three inputs, in order of authority:
--   1. the tenant override  — what an operator switched off for this school
--   2. the plan             — what this school is entitled to at all
--   3. the access level     — `limited`/`maintenance` allows only the
--                             services the catalogue marks `in_limited`
CREATE OR REPLACE FUNCTION app.tenant_service_state(p_tenant uuid, p_service text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, app
AS $$
  WITH a AS (SELECT * FROM app.tenant_access(p_tenant)),
       c AS (SELECT * FROM service_catalogue WHERE code = p_service),
       o AS (SELECT services FROM tenant_operations WHERE tenant_id = p_tenant),
       pl AS (SELECT p.services FROM tenants t
              LEFT JOIN plans p ON p.code = t.plan_code WHERE t.id = p_tenant)
  SELECT CASE
    WHEN (SELECT code FROM c) IS NULL THEN 'unknown'
    -- FAIL CLOSED. A tenant id that matches no row is not a school with no
    -- entitlements — it is a question we cannot answer, and the safe answer
    -- to "may this happen" is no. Without this the CASE fell through to the
    -- plan check, which is also NULL for a ghost, and returned `not_in_plan`
    -- — a value a caller testing for 'disabled' would not catch.
    WHEN (SELECT access FROM a) IS NULL THEN 'disabled'
    -- No tenant access at all: nothing is on, whatever the plan says.
    WHEN (SELECT access FROM a) = 'none' THEN 'disabled'
    -- The operator's switch beats everything below it.
    WHEN (SELECT services ->> p_service FROM o) = 'disabled' THEN 'disabled'
    WHEN (SELECT services ->> p_service FROM o) = 'maintenance' THEN 'maintenance'
    -- Not in the plan is not "switched off" — it is not bought. The console
    -- says so differently, because the remedy is different.
    WHEN COALESCE((SELECT (services -> p_service)::text FROM pl), 'null') = 'null'
      THEN 'not_in_plan'
    WHEN (SELECT (services ->> p_service)::boolean FROM pl) IS NOT TRUE
      THEN 'not_in_plan'
    -- Read-only school: only the services the catalogue says survive it.
    WHEN (SELECT access FROM a) = 'read_only'
      THEN CASE WHEN (SELECT in_limited FROM c) THEN 'limited' ELSE 'disabled' END
    WHEN (SELECT services ->> p_service FROM o) = 'limited' THEN 'limited'
    ELSE 'enabled'
  END;
$$;

-- The five portals §8 names, from the ten roles the product has. A role with
-- no portal of its own rides with the one it works alongside.
CREATE OR REPLACE FUNCTION app.portal_of(p_role text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_role
    WHEN 'student'   THEN 'student'
    WHEN 'guardian'  THEN 'guardian'
    WHEN 'it_admin'  THEN 'it_admin'
    WHEN 'principal' THEN 'principal'
    WHEN 'school_owner' THEN 'principal'
    ELSE 'teacher'   -- class/subject teacher, dept head, coordinator, accountant
  END;
$$;

-- ── 4. May this portal sign in? ──────────────────────────────────────────
--
-- Never implemented by deleting users or roles (§8). An absent key means
-- allowed, so every tenant that existed before 051 behaves unchanged.
CREATE OR REPLACE FUNCTION app.tenant_portal_open(p_tenant uuid, p_role text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, app
AS $$
  SELECT CASE
    WHEN (SELECT access FROM app.tenant_access(p_tenant)) = 'none' THEN false
    ELSE COALESCE(
      (SELECT (portals ->> app.portal_of(p_role))::boolean
       FROM tenant_operations WHERE tenant_id = p_tenant),
      true)
  END;
$$;

-- ── 4b. Every tenant gets its operations row, always ─────────────────────
--
-- `app.create_tenant` was written in 045 and does not know these tables exist.
-- Rather than edit a shipped function — and rather than trust every future
-- creation path to remember — the row is created by a trigger on `tenants`.
-- A school cannot exist without one.
CREATE OR REPLACE FUNCTION app.ensure_tenant_operations()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app
AS $$
BEGIN
  INSERT INTO tenant_operations (tenant_id) VALUES (NEW.id)
  ON CONFLICT (tenant_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tenants_ensure_operations ON tenants;
CREATE TRIGGER tenants_ensure_operations
  AFTER INSERT ON tenants
  FOR EACH ROW EXECUTE FUNCTION app.ensure_tenant_operations();

-- ── 5. Grants ────────────────────────────────────────────────────────────
--
-- SECURITY DEFINER and readable by the runtime role: the gate must answer for
-- the caller's OWN tenant before RLS has been set up for the request, which
-- is exactly why it is definer. It takes a tenant id and returns one row of
-- state — there is nothing here to leak across schools.
GRANT EXECUTE ON FUNCTION
  app.tenant_billing_state(uuid),
  app.tenant_access(uuid),
  app.tenant_service_state(uuid, text),
  app.tenant_portal_open(uuid, text),
  app.portal_of(text)
TO shikhon_app;

GRANT EXECUTE ON FUNCTION
  app.tenant_billing_state(uuid),
  app.tenant_access(uuid),
  app.tenant_service_state(uuid, text),
  app.tenant_portal_open(uuid, text),
  app.portal_of(text)
TO shikhon_platform;

GRANT SELECT ON plans, service_catalogue TO shikhon_app;
GRANT SELECT, INSERT, UPDATE ON plans TO shikhon_platform;
GRANT SELECT, UPDATE ON service_catalogue TO shikhon_platform;
GRANT SELECT, INSERT, UPDATE ON tenant_operations TO shikhon_platform;
GRANT SELECT ON tenant_operations TO shikhon_app;
GRANT SELECT, INSERT ON tenant_payments TO shikhon_platform;

-- ── 6. RLS on the new tenant-scoped tables ───────────────────────────────
--
-- `tenant_operations` is readable by a school for its OWN row — the tenant UI
-- needs to render "you are in read-only mode" — and writable by nobody but
-- the platform role.
ALTER TABLE tenant_operations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_ops_self ON tenant_operations;
CREATE POLICY tenant_ops_self ON tenant_operations
  FOR SELECT TO shikhon_app
  USING (tenant_id = app.current_tenant());

-- The console. A GRANT alone is not enough once RLS is on: without a policy
-- the platform role saw zero rows and its UPDATEs reported `rowCount: 0` —
-- no error, no row, and a console that would have reported success for every
-- toggle while changing nothing. Exactly the failure this migration exists to
-- end, reintroduced one table lower down.
DROP POLICY IF EXISTS tenant_ops_platform ON tenant_operations;
CREATE POLICY tenant_ops_platform ON tenant_operations
  FOR ALL TO shikhon_platform
  USING (true) WITH CHECK (true);

-- Payments are commercial data between shikhonBD and a school's owner. A
-- teacher has no business reading them, and the tenant app has no screen for
-- them, so the runtime role gets nothing at all.
ALTER TABLE tenant_payments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_payments_platform ON tenant_payments;
CREATE POLICY tenant_payments_platform ON tenant_payments
  FOR ALL TO shikhon_platform
  USING (true) WITH CHECK (true);

-- ── 7. plan_code becomes a real reference ────────────────────────────────
--
-- Added NOT VALID: an existing row with an unknown plan must not stop this
-- migration, and step 6 of 051 has already created a row for every code in
-- use. Validated separately so the failure, if any, is legible.
DO $$ BEGIN
  ALTER TABLE tenants
    ADD CONSTRAINT tenants_plan_fk FOREIGN KEY (plan_code) REFERENCES plans(code)
    NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE tenants VALIDATE CONSTRAINT tenants_plan_fk;

COMMIT;
