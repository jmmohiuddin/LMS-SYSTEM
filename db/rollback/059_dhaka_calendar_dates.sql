-- Rollback for 059 — restores UTC calendar dates.
--
-- WARNING: this REINTRODUCES the bug 059 fixed. After running it, for six
-- hours of every day — 00:00 to 06:00 in Bangladesh — the product records
-- yesterday's date on enrolments, invoices, ledger lines and SMS, and the
-- billing lifecycle evaluates grace and due dates a day late.
--
-- Run migration 060 AFTER this if you keep it: 060 replaces
-- `tenant_billing_state` and its version here is the pre-059 one.
--
-- The only reason to run this is to bisect a regression. It is not a
-- configuration choice.
BEGIN;

CREATE OR REPLACE FUNCTION app.tenant_billing_state(p_tenant uuid)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'app'
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION app.commit_rollover(p_rollover uuid)
 RETURNS TABLE(promoted integer, repeated integer, graduated integer)
 LANGUAGE plpgsql
 SET search_path TO 'public', 'app'
AS $function$
DECLARE
  v_from uuid; v_to uuid; v_status text;
  v_blocked integer; v_sample text;
  v_promoted integer := 0; v_repeated integer := 0; v_graduated integer := 0;
  r record; v_new uuid;
BEGIN
  SELECT from_year_id, to_year_id, status INTO v_from, v_to, v_status
    FROM year_rollovers WHERE id = p_rollover FOR UPDATE;
  IF v_from IS NULL THEN
    RAISE EXCEPTION 'rollover % not found', p_rollover USING ERRCODE = 'no_data_found';
  END IF;
  IF v_status <> 'planned' THEN
    -- Not idempotent by design: running it twice would enrol every child
    -- into the new year a second time.
    RAISE EXCEPTION 'rollover is already %', v_status USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT count(*), min(blocker_bn) INTO v_blocked, v_sample
    FROM app.rollover_preview(v_from, v_to) WHERE action = 'blocked';
  IF v_blocked > 0 THEN
    -- Refusing beats skipping. A rollover that quietly left 30 children
    -- behind is found in March, by a teacher whose register is short.
    RAISE EXCEPTION 'rollover has % blocked student(s); e.g. %', v_blocked, v_sample
      USING ERRCODE = 'check_violation',
            HINT = 'call app.rollover_preview(from, to) for the full list';
  END IF;

  FOR r IN SELECT * FROM app.rollover_preview(v_from, v_to) LOOP
    IF r.action = 'graduate' THEN
      UPDATE enrolments SET status = 'promoted', ended_on = CURRENT_DATE WHERE id = r.enrolment_id;
      -- Fires app.emit_graduation_event (migration 009), which is what
      -- puts the student into the alumni network's outbox.
      UPDATE student_profiles
         SET lifecycle_status = 'graduated', graduated_on = CURRENT_DATE
       WHERE user_id = r.student_id;
      v_graduated := v_graduated + 1;
      CONTINUE;
    END IF;

    INSERT INTO enrolments
      (tenant_id, student_id, section_id, academic_year_id, roll_no, status, enrolled_on)
    VALUES (app.current_tenant(), r.student_id, r.to_section_id, v_to,
            r.to_roll, 'active', CURRENT_DATE)
    RETURNING id INTO v_new;

    -- F-304. The new class has its own template, and a Class 10 subject
    -- set is not a Class 9 one carried forward.
    PERFORM app.derive_student_subjects(v_new, NULL, NULL);

    UPDATE enrolments SET status = 'promoted', ended_on = CURRENT_DATE
     WHERE id = r.enrolment_id;

    IF r.action = 'repeat' THEN v_repeated := v_repeated + 1;
    ELSE v_promoted := v_promoted + 1;
    END IF;
  END LOOP;

  UPDATE year_rollovers
     SET status = 'committed', committed_at = now(), committed_by = app.current_user_id(),
         promoted = v_promoted, repeated = v_repeated, graduated = v_graduated
   WHERE id = p_rollover;

  RETURN QUERY SELECT v_promoted, v_repeated, v_graduated;
END $function$;

CREATE OR REPLACE FUNCTION app.consume_ai_budget(p_estimated_tokens bigint DEFAULT 1000)
 RETURNS TABLE(allowed boolean, used bigint, budget bigint, remaining bigint)
 LANGUAGE plpgsql
 SET search_path TO 'public', 'app'
AS $function$
DECLARE
  v_tenant uuid := app.current_tenant();
  v_month  date := date_trunc('month', CURRENT_DATE)::date;
  v_budget bigint;
  v_used   bigint;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'tenant context not set (app.tenant_id)' USING ERRCODE = '42501';
  END IF;

  SELECT ai_monthly_token_budget INTO v_budget FROM tenants WHERE id = v_tenant;

  -- A NULL budget is "not configured", which means unmetered rather than
  -- zero. Defaulting an unset budget to zero would take the AI away from
  -- every school the day this migration landed.
  IF v_budget IS NULL THEN
    RETURN QUERY SELECT true, 0::bigint, NULL::bigint, NULL::bigint;
    RETURN;
  END IF;

  INSERT INTO ai_budget_periods (tenant_id, period_month, token_budget, tokens_used)
  VALUES (v_tenant, v_month, v_budget, 0)
  ON CONFLICT (tenant_id, period_month) DO NOTHING;

  SELECT tokens_used, token_budget INTO v_used, v_budget
    FROM ai_budget_periods
   WHERE tenant_id = v_tenant AND period_month = v_month
     FOR UPDATE;

  IF v_used + p_estimated_tokens > v_budget THEN
    UPDATE ai_budget_periods
       SET hard_limit_hit_at = COALESCE(hard_limit_hit_at, now())
     WHERE tenant_id = v_tenant AND period_month = v_month;
    RETURN QUERY SELECT false, v_used, v_budget, GREATEST(v_budget - v_used, 0)::bigint;
    RETURN;
  END IF;

  -- Reserve the estimate now. `settle_ai_budget` corrects it to the real
  -- figure once the provider answers; between the two calls the school is
  -- charged the estimate, which is what stops concurrent requests from each
  -- seeing the same headroom.
  UPDATE ai_budget_periods
     SET tokens_used = tokens_used + p_estimated_tokens,
         soft_limit_notified_at = CASE
           WHEN soft_limit_notified_at IS NULL
            AND tokens_used + p_estimated_tokens > (token_budget * 0.8)::bigint
           THEN now() ELSE soft_limit_notified_at END
   WHERE tenant_id = v_tenant AND period_month = v_month;

  RETURN QUERY SELECT true, v_used + p_estimated_tokens, v_budget,
                      GREATEST(v_budget - v_used - p_estimated_tokens, 0)::bigint;
END;
$function$;

CREATE OR REPLACE FUNCTION app.settle_ai_budget(p_estimated_tokens bigint, p_actual_tokens bigint, p_cost_usd numeric DEFAULT NULL::numeric)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'app'
AS $function$
DECLARE
  v_tenant uuid := app.current_tenant();
  v_month  date := date_trunc('month', CURRENT_DATE)::date;
BEGIN
  IF v_tenant IS NULL THEN RETURN; END IF;

  -- The delta, which may be negative when the estimate was generous. GREATEST
  -- keeps the counter from going below zero if a call is settled twice.
  UPDATE ai_budget_periods
     SET tokens_used = GREATEST(tokens_used - p_estimated_tokens + p_actual_tokens, 0),
         cost_usd    = COALESCE(cost_usd, 0) + COALESCE(p_cost_usd, 0)
   WHERE tenant_id = v_tenant AND period_month = v_month;
END;
$function$;

CREATE OR REPLACE FUNCTION app.resolve_notice_audience(p_tenant uuid, p_audience jsonb)
 RETURNS TABLE(user_id uuid, about_student_id uuid)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'app'
AS $function$
DECLARE
  v_type text := p_audience->>'type';
  v_ids  uuid[];
BEGIN
  IF app.current_tenant() IS DISTINCT FROM p_tenant THEN
    RAISE EXCEPTION 'resolve_notice_audience must run inside the tenant''s own context'
      USING ERRCODE = '42501';
  END IF;

  IF p_audience ? 'ids' THEN
    SELECT array_agg(value::text::uuid) INTO v_ids
      FROM jsonb_array_elements_text(p_audience->'ids') AS value;
  END IF;

  IF v_type IN ('class','section','users') AND (v_ids IS NULL OR cardinality(v_ids) = 0) THEN
    RAISE EXCEPTION 'audience type % requires a non-empty ids array', v_type
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  -- ── Named individuals ──────────────────────────────────────────────
  SELECT u.id, NULL::uuid
    FROM users u
   WHERE v_type = 'users'
     AND u.tenant_id = p_tenant AND u.id = ANY(v_ids) AND u.status = 'active'

  UNION
  -- ── Everyone, and the staff-only case ──────────────────────────────
  -- app.is_staff() reads the SESSION's role, so it cannot be used here to
  -- classify OTHER users. Staff is defined by holding a staff role.
  SELECT u.id, NULL::uuid
    FROM users u
   WHERE v_type IN ('all','staff')
     AND u.tenant_id = p_tenant AND u.status = 'active'
     AND EXISTS (
       SELECT 1 FROM user_roles ur JOIN roles r ON r.code = ur.role_code
        WHERE ur.tenant_id = p_tenant AND ur.user_id = u.id AND r.is_staff
          AND (ur.valid_until IS NULL OR ur.valid_until > CURRENT_DATE))

  UNION
  -- ── Students: enrolled this year, optionally narrowed ───────────────
  SELECT e.student_id, NULL::uuid
    FROM enrolments e
    JOIN academic_years ay ON ay.id = e.academic_year_id AND ay.is_current
    LEFT JOIN sections s ON s.id = e.section_id
   WHERE v_type IN ('all','students','class','section')
     AND e.tenant_id = p_tenant AND e.status = 'active'
     AND (v_type NOT IN ('class','section') OR (
           (v_type = 'section' AND e.section_id = ANY(v_ids))
        OR (v_type = 'class'   AND s.class_id = ANY(v_ids))))

  UNION
  -- ── Guardians authorised to pay ────────────────────────────────────
  -- A separate audience from 'guardians', because a fee notice addressed to
  -- everyone who is merely RELATED to a student reaches people who cannot
  -- act on it — and a payment reminder to someone with no authority to pay
  -- is noise that costs an SMS.
  SELECT g.guardian_id, g.student_id
    FROM guardianships g
    JOIN enrolments e ON e.student_id = g.student_id AND e.tenant_id = g.tenant_id
                     AND e.status = 'active'
    JOIN academic_years ay ON ay.id = e.academic_year_id AND ay.is_current
   WHERE v_type = 'guardians_payers'
     AND g.tenant_id = p_tenant AND g.can_pay_fees = true
     -- B-7. Definer rights bypass guardianship_hide_revoked, so both guardian
     -- branches carry the test explicitly. Missing it here would send a fee
     -- reminder about a child to somebody who is no longer their guardian.
     AND g.revoked_at IS NULL

  UNION
  -- ── Guardians: once per child in scope ─────────────────────────────
  SELECT g.guardian_id, g.student_id
    FROM guardianships g
    JOIN enrolments e ON e.student_id = g.student_id AND e.tenant_id = g.tenant_id
                     AND e.status = 'active'
    JOIN academic_years ay ON ay.id = e.academic_year_id AND ay.is_current
    LEFT JOIN sections s ON s.id = e.section_id
   WHERE v_type IN ('all','guardians','class','section')
     AND g.tenant_id = p_tenant
     AND g.revoked_at IS NULL                                        -- B-7
     AND (v_type NOT IN ('class','section') OR (
           (v_type = 'section' AND e.section_id = ANY(v_ids))
        OR (v_type = 'class'   AND s.class_id = ANY(v_ids))));
END $function$;

CREATE OR REPLACE FUNCTION app.rollup_product_events()
 RETURNS TABLE(days_recomputed integer, raw_pruned integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app'
AS $function$
DECLARE v_days integer; v_pruned integer;
BEGIN
  -- A seven-day window, recomputed whole. Offline events arrive days late
  -- (that is the product working, not failing), and recomputing the
  -- window is what puts them in the day they OCCURRED rather than the day
  -- they arrived.
  INSERT INTO product_event_rollups (tenant_id, day, event_type, n, distinct_users)
  SELECT e.tenant_id, e.occurred_at::date, e.event_type,
         count(*), count(DISTINCT e.user_id)
    FROM product_events e
   WHERE e.occurred_at >= CURRENT_DATE - 7
   GROUP BY 1, 2, 3
  ON CONFLICT (tenant_id, day, event_type)
  DO UPDATE SET n = EXCLUDED.n, distinct_users = EXCLUDED.distinct_users;
  GET DIAGNOSTICS v_days = ROW_COUNT;

  -- Retention: raw rows live 90 days, the rollup keeps the history. Stated
  -- here, where it happens, because "no silent truncation" applies to
  -- deletion policies too.
  DELETE FROM product_events WHERE occurred_at < CURRENT_DATE - 90;
  GET DIAGNOSTICS v_pruned = ROW_COUNT;

  RETURN QUERY SELECT v_days, v_pruned;
END $function$;

ALTER TABLE ai_sessions                  ALTER COLUMN started_on       SET DEFAULT CURRENT_DATE;
ALTER TABLE ai_sessions_2026_08          ALTER COLUMN started_on       SET DEFAULT CURRENT_DATE;
ALTER TABLE ai_sessions_default          ALTER COLUMN started_on       SET DEFAULT CURRENT_DATE;
ALTER TABLE ai_turns                     ALTER COLUMN created_on       SET DEFAULT CURRENT_DATE;
ALTER TABLE ai_turns_2026_08             ALTER COLUMN created_on       SET DEFAULT CURRENT_DATE;
ALTER TABLE ai_turns_default             ALTER COLUMN created_on       SET DEFAULT CURRENT_DATE;
ALTER TABLE assignments                  ALTER COLUMN assigned_on      SET DEFAULT CURRENT_DATE;
ALTER TABLE class_teacher_assignments    ALTER COLUMN started_on       SET DEFAULT CURRENT_DATE;
ALTER TABLE enrolments                   ALTER COLUMN enrolled_on      SET DEFAULT CURRENT_DATE;
ALTER TABLE fee_waivers                  ALTER COLUMN valid_from       SET DEFAULT CURRENT_DATE;
ALTER TABLE invoices                     ALTER COLUMN issued_on        SET DEFAULT CURRENT_DATE;
ALTER TABLE ledger_entries               ALTER COLUMN entry_date       SET DEFAULT CURRENT_DATE;
ALTER TABLE section_subject_teachers     ALTER COLUMN started_on       SET DEFAULT CURRENT_DATE;
ALTER TABLE sms_outbox                   ALTER COLUMN created_on       SET DEFAULT CURRENT_DATE;
ALTER TABLE sms_outbox_2026_08           ALTER COLUMN created_on       SET DEFAULT CURRENT_DATE;
ALTER TABLE sms_outbox_2026_09           ALTER COLUMN created_on       SET DEFAULT CURRENT_DATE;
ALTER TABLE sms_outbox_default           ALTER COLUMN created_on       SET DEFAULT CURRENT_DATE;
ALTER TABLE teacher_availability         ALTER COLUMN effective_from   SET DEFAULT CURRENT_DATE;
ALTER TABLE user_roles                   ALTER COLUMN valid_from       SET DEFAULT CURRENT_DATE;

DROP FUNCTION IF EXISTS app.today_dhaka();

COMMIT;
