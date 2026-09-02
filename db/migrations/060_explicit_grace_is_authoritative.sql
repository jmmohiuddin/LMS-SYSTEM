-- ---------------------------------------------------------------------------
-- 060 — an operator's grace decision must be able to END.
--
-- ── Found by walking P8 §8's four boundary dates ─────────────────────────
--
--   due TODAY (Dhaka)              → active        ✓
--   due YESTERDAY (Dhaka)          → grace_period  ✓
--   grace ends TODAY (Dhaka)       → grace_period  ✓
--   grace ended YESTERDAY (Dhaka)  → grace_period  ✗   expected: limited
--
-- The school's explicit grace ran to 2026-09-01 and it is 2026-09-02, so the
-- grant has expired. But the school is on `standard`, whose plan grace is 14
-- days, and the bill was due 2026-08-24 — so the FALLBACK clause
--
--     WHEN COALESCE(p.grace_days, 0) > 0
--      AND o.next_due_on + COALESCE(p.grace_days, 0) >= today
--
-- still matches, and quietly extends the school to 2026-09-07.
--
-- ── Why that is a bug and not a policy ───────────────────────────────────
-- The clause's own comment says what it is for:
--
--     "If the plan carries grace days and none was recorded, the plan's own
--      window still applies — a school does not lose service because an
--      operator forgot to press a button."
--
-- *and none was recorded*. The code never checks that. It falls through
-- whenever the explicit grant has EXPIRED, which is a different thing
-- entirely from never having been made.
--
-- The consequence is a half-inert control, which is the defect this product
-- keeps finding: the console's "ছাড়ের মেয়াদ বাড়ান" can only ever push grace
-- LATER than the plan default. An operator who decides "until the first, and
-- no longer" is overruled by a default, is told the change succeeded, and the
-- school keeps full service for six more days.
--
-- ── The rule, stated once ────────────────────────────────────────────────
-- An explicit `grace_until` is the answer while it is set: it may extend the
-- plan's window or cut it short, because a person looked at this school and
-- decided. The plan's window applies only when nobody decided — which is what
-- the comment always said.
--
-- Suspension is untouched: this moves a school from `grace_period` to
-- `limited`, which is read-only access, never data loss (D16).
-- ---------------------------------------------------------------------------

BEGIN;

CREATE OR REPLACE FUNCTION app.tenant_billing_state(p_tenant uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, app
AS $function$
  SELECT CASE
    -- Trial wins while it lasts, even if a due date was set optimistically.
    WHEN t.trial_ends_on IS NOT NULL AND t.trial_ends_on >= app.today_dhaka()
      THEN 'trial'
    -- No due date means nobody has started billing this school. That is not
    -- a debt; a pilot runs like this for a year.
    WHEN o.next_due_on IS NULL
      THEN 'active'
    WHEN o.next_due_on >= app.today_dhaka()
      THEN 'active'
    -- An operator looked at this school and named a date. While it is set it
    -- IS the answer, whether it is longer or shorter than the plan's window.
    WHEN o.grace_until IS NOT NULL
      THEN CASE WHEN o.grace_until >= app.today_dhaka()
                THEN 'grace_period'
                ELSE 'limited'
           END
    -- Nobody decided. The plan's own window applies, so a school does not
    -- lose service because an operator forgot to press a button.
    WHEN COALESCE(p.grace_days, 0) > 0
     AND o.next_due_on + COALESCE(p.grace_days, 0) >= app.today_dhaka()
      THEN 'grace_period'
    WHEN o.next_due_on < app.today_dhaka()
      THEN 'limited'
    ELSE 'active'
  END
  FROM tenants t
  -- LEFT, with the defaults below. A missing operations row must degrade to
  -- "nothing owed", not to "no answer".
  LEFT JOIN tenant_operations o ON o.tenant_id = t.id
  LEFT JOIN plans p ON p.code = t.plan_code
  WHERE t.id = p_tenant;
$function$;

COMMIT;
