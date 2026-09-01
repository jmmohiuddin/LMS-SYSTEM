-- ---------------------------------------------------------------------------
-- 055 — The service switches, made real.
--
-- ── The bug this exists to fix ───────────────────────────────────────────
-- 051 built a catalogue of thirteen services. 052 built
-- `app.tenant_service_state(tenant, service)` to answer whether one of them
-- is on. P7's console renders all thirteen with their consequences, refuses
-- to disable one another depends on, and audits every change.
--
-- And the only two callers of that function were in the console itself: one
-- to draw the list, one to check dependencies. No tenant-facing code asked.
-- Turning off "এসএমএস" changed a row and nothing else; the messages kept
-- going out.
--
-- 054 fixed the same shape for portals. This is the third and last of the
-- inert controls P7-1's audit turned up.
--
-- ── The composition rule ─────────────────────────────────────────────────
-- A service answer may only ever RESTRICT the school's answer, never widen
-- it. A suspended school does not become reachable because one of its
-- services is enabled, and that is enforced by construction here: the
-- three-argument form starts from the two-argument answer and can only take
-- away.
-- ---------------------------------------------------------------------------

BEGIN;

CREATE OR REPLACE FUNCTION app.tenant_access(p_tenant uuid, p_role text, p_service text)
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
  WITH base AS (SELECT * FROM app.tenant_access(p_tenant, p_role)),
       s AS (
         SELECT app.tenant_service_state(p_tenant, p_service) AS state,
                (SELECT c.name_bn FROM service_catalogue c WHERE c.code = p_service) AS name_bn
       )
  SELECT
    CASE
      -- Already refused for the school or the portal. Nothing here can undo
      -- that, and the reason already on the row is the more useful one.
      WHEN b.access = 'none' THEN 'none'
      -- Off, never bought, or an answer we could not get. All three mean the
      -- same thing to the person in front of the screen, and the safe answer
      -- to a question we cannot answer is no.
      WHEN s.state IN ('disabled', 'not_in_plan', 'unknown') THEN 'none'
      -- Readable, not writable: the school can still look at what is already
      -- there, which is the difference between a paused service and a
      -- deleted one.
      WHEN s.state IN ('limited', 'maintenance') THEN 'read_only'
      ELSE b.access
    END,
    b.ops_state,
    b.billing_state,
    CASE
      WHEN b.access = 'none' THEN b.reason_bn
      -- The SCHOOL is already restricted — in maintenance, or limited by its
      -- bill. `tenant_service_state` reports every service as 'limited' in
      -- that case, so a service-shaped sentence here would tell a headmaster
      -- their notices are limited when what is actually true is that their
      -- school is. The school-level reason is the one that explains what to
      -- do about it.
      WHEN b.access = 'read_only' AND s.state IN ('limited', 'maintenance')
        THEN b.reason_bn
      WHEN s.state = 'not_in_plan' THEN
        COALESCE(s.name_bn, p_service) || ' এই প্রতিষ্ঠানের প্ল্যানে নেই। '
        || 'প্ল্যান পরিবর্তনের জন্য shikhonBD-এর সঙ্গে যোগাযোগ করুন।'
      WHEN s.state = 'disabled' THEN
        COALESCE(s.name_bn, p_service) || ' এই প্রতিষ্ঠানের জন্য আপাতত বন্ধ রাখা হয়েছে।'
      WHEN s.state = 'unknown' THEN
        'এই সেবাটির অবস্থা যাচাই করা যায়নি। একটু পরে আবার চেষ্টা করুন।'
      WHEN s.state = 'maintenance' THEN
        COALESCE(s.name_bn, p_service) || ' এখন রক্ষণাবেক্ষণে আছে — দেখা যাবে, '
        || 'কিন্তু নতুন কিছু যোগ করা যাবে না।'
      WHEN s.state = 'limited' THEN
        COALESCE(s.name_bn, p_service) || ' এখন সীমিত অবস্থায় আছে — দেখা যাবে, '
        || 'কিন্তু নতুন কিছু যোগ করা যাবে না।'
      ELSE b.reason_bn
    END,
    b.until
  FROM base b CROSS JOIN s;
$$;

GRANT EXECUTE ON FUNCTION app.tenant_access(uuid, text, text)
  TO shikhon_app, shikhon_platform;

COMMIT;
