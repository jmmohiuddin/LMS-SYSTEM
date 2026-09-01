-- ---------------------------------------------------------------------------
-- 054 — The portal switch, made real.
--
-- ── The bug this exists to fix ───────────────────────────────────────────
-- 052 built `app.tenant_portal_open(tenant, role)`. P7's console wrote
-- `tenant_operations.portals` through it, showed the switch, recorded the
-- audit row — and nothing in the application ever called the function. An
-- operator could close the teacher portal, be told it worked, and every
-- teacher in that school would keep signing in.
--
-- That is the SAME defect P7-1 found in `tenants.status`, reproduced in the
-- feature built to replace it. A control whose only effect is on the screen
-- that operates it is worse than no control: it is a lie an operator will
-- repeat to a headmaster.
--
-- ── Why it lands here and not in the application ─────────────────────────
-- `withTenant` already reads `app.tenant_access(tenant)` once per request, on
-- the connection the transaction already holds. Folding the portal answer
-- into that same row costs nothing and — more importantly — cannot be
-- forgotten by an endpoint, because no endpoint is involved.
--
-- The two-argument form is an OVERLOAD, not a replacement: the one-argument
-- form still answers "may this school act at all", which the platform console
-- and every report over tenants asks without reference to a role.
-- ---------------------------------------------------------------------------

BEGIN;

-- ── The gate, now aware of who is knocking ───────────────────────────────
--
-- `access` is the school's answer reduced by the portal's. A closed portal
-- means 'none' for that role and nothing at all for any other role in the
-- same school — which is the whole point of a portal switch: send the
-- teachers home without locking out the principal who has to fix it.
CREATE OR REPLACE FUNCTION app.tenant_access(p_tenant uuid, p_role text)
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
  WITH base AS (SELECT * FROM app.tenant_access(p_tenant)),
       p AS (
         SELECT COALESCE(
           (SELECT (o.portals ->> app.portal_of(p_role))::boolean
              FROM tenant_operations o WHERE o.tenant_id = p_tenant),
           true) AS open
       )
  SELECT
    CASE WHEN NOT p.open THEN 'none' ELSE b.access END,
    b.ops_state,
    b.billing_state,
    -- The person is told which door is shut, in the language they read it
    -- in. "প্রবেশ বন্ধ" with no subject would send a teacher to the school
    -- office to ask whether the whole system is down.
    CASE WHEN NOT p.open THEN
      CASE app.portal_of(p_role)
        WHEN 'student'   THEN 'শিক্ষার্থীদের প্রবেশ আপাতত বন্ধ রাখা হয়েছে।'
        WHEN 'guardian'  THEN 'অভিভাবকদের প্রবেশ আপাতত বন্ধ রাখা হয়েছে।'
        WHEN 'teacher'   THEN 'শিক্ষক ও কর্মীদের প্রবেশ আপাতত বন্ধ রাখা হয়েছে।'
        WHEN 'it_admin'  THEN 'আইটি অ্যাডমিনের প্রবেশ আপাতত বন্ধ রাখা হয়েছে।'
        WHEN 'principal' THEN 'প্রধান শিক্ষকের প্রবেশ আপাতত বন্ধ রাখা হয়েছে।'
        ELSE 'এই প্রবেশপথ আপাতত বন্ধ রাখা হয়েছে।'
      END
      || ' প্রতিষ্ঠানের প্রশাসনের সঙ্গে যোগাযোগ করুন।'
    ELSE b.reason_bn END,
    b.until
  FROM base b CROSS JOIN p;
$$;

GRANT EXECUTE ON FUNCTION app.tenant_access(uuid, text) TO shikhon_app, shikhon_platform;

COMMIT;
