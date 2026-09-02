-- Rollback for 060 — restores the fallback that overruled an operator.
--
-- WARNING: after this, an explicit `grace_until` can only ever EXTEND the
-- plan's grace window. An operator who sets a shorter date is told the change
-- succeeded and the school keeps full service until the plan's own window
-- expires.
--
-- Depends on 059 (`app.today_dhaka`). If 059 has been rolled back too, run
-- db/rollback/059 instead — it restores this function's pre-059 body.
BEGIN;

CREATE OR REPLACE FUNCTION app.tenant_billing_state(p_tenant uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, app
AS $function$
  SELECT CASE
    WHEN t.trial_ends_on IS NOT NULL AND t.trial_ends_on >= app.today_dhaka()
      THEN 'trial'
    WHEN o.next_due_on IS NULL
      THEN 'active'
    WHEN o.next_due_on >= app.today_dhaka()
      THEN 'active'
    WHEN o.grace_until IS NOT NULL AND o.grace_until >= app.today_dhaka()
      THEN 'grace_period'
    WHEN COALESCE(p.grace_days, 0) > 0
     AND o.next_due_on + COALESCE(p.grace_days, 0) >= app.today_dhaka()
      THEN 'grace_period'
    WHEN o.next_due_on < app.today_dhaka()
      THEN 'limited'
    ELSE 'active'
  END
  FROM tenants t
  LEFT JOIN tenant_operations o ON o.tenant_id = t.id
  LEFT JOIN plans p ON p.code = t.plan_code
  WHERE t.id = p_tenant;
$function$;

COMMIT;
