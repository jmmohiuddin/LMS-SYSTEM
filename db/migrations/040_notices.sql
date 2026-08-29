-- ============================================================================
-- 040 — Notices and in-app notifications  (R-2, docs/11-MASTER-PLAN.md)
--
-- The head teacher publishes one notice; the right people — and only the right
-- people — see it in their bell, and the guardians among them can also get an
-- SMS. Until now the product had no way to tell anybody anything:
-- academics-svc's ward.ts says so outright, refusing to stub the notices card
-- §9.1 draws because "this schema has no notices table".
--
-- ── Two tables, and why the second one exists ───────────────────────────
-- `notices` is what an author writes. `notice_receipts` is one row per person
-- per notice — the thing a bell counts, a reader marks read, and an audit
-- answers "was this delivered?" with.
--
-- Materialising receipts rather than resolving the audience on every read is
-- deliberate. A notice's audience is a QUESTION ABOUT THE PAST — who was in
-- Class 9 Science F on the day the exam notice went out — and a live query
-- answers it about the present. A student who transfers in next week must not
-- retroactively acquire last week's notices, and one who leaves must not lose
-- the record that they were told. Resolving once, at publish, is what makes the
-- receipt a fact instead of a re-derivation.
--
-- It also makes the read path trivial: one indexed lookup by user, no audience
-- interpretation at read time, and the RLS policy is `user_id = current_user`
-- rather than a re-implementation of the targeting rules in SQL.
--
-- ── The audience is stored as it was WRITTEN, and resolved separately ───
-- `notices.audience` keeps the author's intent ({"type":"section","ids":[…]});
-- `notice_receipts` keeps the consequence. Both are needed: the intent is what
-- an author edits and re-publishes, the consequence is what was delivered.
--
-- ── SMS reuses the existing pipeline, entirely ─────────────────────────
-- Publishing emits `notice.published.v1` into `event_outbox`, exactly as
-- attendance emits `attendance.marked.v1`. sms-svc's stage 1 grows a second
-- consumer sharing one daily cap, one weekend/holiday suppression, one dedupe
-- index. There is NO second SMS path — SMS is ~80% of the infrastructure bill
-- (docs/05 §5) and a second path would be a second place for it to double.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- Enumerations
-- ---------------------------------------------------------------------

-- Category drives grouping, icon and default channel in the UI. It is NOT the
-- audience: "who is this for" is `audience`, and conflating the two is how a
-- fee notice becomes undeliverable to a teacher who also has a child here.
CREATE TYPE notice_category AS ENUM (
  'general',    -- everyone, school-wide
  'teacher',    -- staff-only announcements
  'student',
  'guardian',
  'class',
  'section',
  'exam',
  'fee',
  'attendance',
  'emergency'   -- bypasses quiet hours if those are ever added; SMS by default
);

CREATE TYPE notice_status AS ENUM ('draft', 'published', 'archived');

-- ---------------------------------------------------------------------
-- notices — what the author wrote
-- ---------------------------------------------------------------------
CREATE TABLE notices (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  title          text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  body           text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 4000),
  category       notice_category NOT NULL DEFAULT 'general',

  -- The author's intent, validated in code (packages/ui-core/src/notice.ts) so
  -- the composer and the API agree — the same one-definition rule R-1 used for
  -- branding. SQL enforces only the shape, which is what SQL is good at.
  --   {"type":"all"}
  --   {"type":"staff"} | {"type":"students"} | {"type":"guardians"}
  --   {"type":"class",   "ids":["<class_offering uuid>", …]}
  --   {"type":"section", "ids":["<section uuid>", …]}
  --   {"type":"users",   "ids":["<user uuid>", …]}
  audience       jsonb NOT NULL DEFAULT '{"type":"all"}'::jsonb
                   CHECK (jsonb_typeof(audience) = 'object'
                          AND audience ? 'type'
                          AND audience->>'type' IN
                              ('all','staff','students','guardians','class','section','users')),

  -- Channels the author chose. In-app is always on: a notice nobody can read
  -- in the product is not a notice. SMS costs money and is opt-in per notice.
  send_inapp     boolean NOT NULL DEFAULT true CHECK (send_inapp),
  send_sms       boolean NOT NULL DEFAULT false,

  status         notice_status NOT NULL DEFAULT 'draft',
  -- Scheduling: a notice may be written now and published later. The publish
  -- endpoint refuses to fan out before this time; nothing polls it in R-2, so
  -- a future publish_at is a draft with a date, not a scheduled job yet.
  publish_at     timestamptz,
  published_at   timestamptz,
  published_by   uuid REFERENCES users(id),

  -- Denormalised so the inbox can show "12 people" without counting receipts,
  -- and so the number survives a later enrolment change.
  recipient_count integer NOT NULL DEFAULT 0 CHECK (recipient_count >= 0),

  created_by     uuid NOT NULL REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  -- A published notice must know when and by whom, or "was this sent?" has no
  -- answer. Enforced rather than trusted to the endpoint.
  CONSTRAINT notices_published_is_stamped CHECK (
    status <> 'published' OR (published_at IS NOT NULL AND published_by IS NOT NULL)
  )
);

CREATE INDEX ix_notices_tenant_status ON notices (tenant_id, status, published_at DESC);
CREATE INDEX ix_notices_category ON notices (tenant_id, category, published_at DESC)
  WHERE status = 'published';

CREATE TRIGGER trg_notices_tenant BEFORE INSERT OR UPDATE ON notices
  FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant();

-- ---------------------------------------------------------------------
-- notice_receipts — one row per person per notice
-- ---------------------------------------------------------------------
CREATE TABLE notice_receipts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  notice_id      uuid NOT NULL REFERENCES notices(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- For a guardian receipt, WHICH child it concerns. §9.1's ward view shows a
  -- notice under the child it is about, and a guardian with two children in
  -- two sections gets two receipts for a section notice — which is correct,
  -- because they are two different pieces of news.
  about_student_id uuid REFERENCES users(id) ON DELETE CASCADE,

  delivered_at   timestamptz NOT NULL DEFAULT now(),
  read_at        timestamptz,

  -- One receipt per person per notice per child. NULLS NOT DISTINCT so the
  -- staff/student case (about_student_id IS NULL) also collapses on re-publish
  -- — the default NULL-distinct behaviour would let a re-publish duplicate
  -- every staff receipt, which is exactly the idempotency bug this prevents.
  CONSTRAINT uq_notice_receipt UNIQUE NULLS NOT DISTINCT (notice_id, user_id, about_student_id)
);

-- The bell's query: unread count for one person. Partial index so it stays
-- small and hot no matter how many read notices accumulate.
CREATE INDEX ix_notice_receipts_unread ON notice_receipts (tenant_id, user_id, delivered_at DESC)
  WHERE read_at IS NULL;
-- The inbox's query: everything for one person, newest first.
CREATE INDEX ix_notice_receipts_user ON notice_receipts (tenant_id, user_id, delivered_at DESC);
CREATE INDEX ix_notice_receipts_notice ON notice_receipts (tenant_id, notice_id);

CREATE TRIGGER trg_notice_receipts_tenant BEFORE INSERT OR UPDATE ON notice_receipts
  FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant();

-- ---------------------------------------------------------------------
-- Audience resolution
--
-- SECURITY DEFINER because it reads users, enrolments and guardianships to
-- decide who a notice reaches, and it must not be re-filtered by the caller's
-- own row-level view — a principal publishing to "all guardians" is not
-- themselves a guardian. The tenant is passed explicitly and asserted against
-- the session, so definer rights cannot be used to reach another tenant.
--
-- Returns (user_id, about_student_id). A guardian appears once per child in
-- scope; everyone else appears once with NULL.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.resolve_notice_audience(
  p_tenant   uuid,
  p_audience jsonb
)
RETURNS TABLE (user_id uuid, about_student_id uuid)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, app
AS $$
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
       SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
        WHERE ur.tenant_id = p_tenant AND ur.user_id = u.id AND r.is_staff
          AND (ur.valid_until IS NULL OR ur.valid_until > now()))

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
        OR (v_type = 'class'   AND s.class_offering_id = ANY(v_ids))))

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
     AND (v_type NOT IN ('class','section') OR (
           (v_type = 'section' AND e.section_id = ANY(v_ids))
        OR (v_type = 'class'   AND s.class_offering_id = ANY(v_ids))));
END $$;

COMMENT ON FUNCTION app.resolve_notice_audience(uuid, jsonb) IS
  'R-2: who a notice reaches, resolved ONCE at publish time. Returns '
  '(user_id, about_student_id); guardians appear once per child in scope. '
  'Asserts the session tenant, so definer rights cannot cross tenants.';

GRANT EXECUTE ON FUNCTION app.resolve_notice_audience(uuid, jsonb) TO shikhon_app;

-- ---------------------------------------------------------------------
-- Publish — resolve, materialise receipts, emit the SMS event, in ONE
-- transaction. Idempotent: re-publishing inserts no duplicate receipt
-- (uq_notice_receipt) and emits no second event.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.publish_notice(p_notice uuid)
RETURNS TABLE (recipients integer, sms_event boolean)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, app
AS $$
DECLARE
  v_notice notices%ROWTYPE;
  v_count  integer;
  v_emit   boolean := false;
BEGIN
  -- SECURITY INVOKER: the caller's RLS decides whether they may see and
  -- therefore publish this notice. The endpoint's requireRole is the courtesy
  -- 403 in front of that, not the boundary.
  SELECT * INTO v_notice FROM notices WHERE id = p_notice FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'notice % not found in this tenant', p_notice USING ERRCODE = 'P0002';
  END IF;

  IF v_notice.status = 'archived' THEN
    RAISE EXCEPTION 'an archived notice cannot be published' USING ERRCODE = '22023';
  END IF;

  INSERT INTO notice_receipts (tenant_id, notice_id, user_id, about_student_id)
  SELECT v_notice.tenant_id, v_notice.id, a.user_id, a.about_student_id
    FROM app.resolve_notice_audience(v_notice.tenant_id, v_notice.audience) AS a
    -- The author does not need to be told what they just wrote.
   WHERE a.user_id <> COALESCE(v_notice.published_by, app.current_user_id(), a.user_id)
      OR a.about_student_id IS NOT NULL
  ON CONFLICT ON CONSTRAINT uq_notice_receipt DO NOTHING;
  GET DIAGNOSTICS v_count = ROW_COUNT;

  -- Emit the SMS event only on the FIRST publish. A re-publish that inserted
  -- no new receipt must not re-notify; one that reached new people (an
  -- audience widened after the fact) legitimately does.
  IF v_notice.send_sms AND (v_notice.status <> 'published' OR v_count > 0) THEN
    INSERT INTO event_outbox (tenant_id, event_type, aggregate_type, aggregate_id, payload)
    VALUES (v_notice.tenant_id, 'notice.published.v1', 'notice', v_notice.id,
            jsonb_build_object('noticeId', v_notice.id,
                               'category', v_notice.category,
                               'title',    v_notice.title));
    v_emit := true;
  END IF;

  UPDATE notices
     SET status          = 'published',
         published_at    = COALESCE(published_at, now()),
         published_by    = COALESCE(published_by, app.current_user_id()),
         recipient_count = (SELECT count(*) FROM notice_receipts WHERE notice_id = v_notice.id),
         updated_at      = now()
   WHERE id = v_notice.id;

  recipients := v_count;
  sms_event  := v_emit;
  RETURN NEXT;
END $$;

COMMENT ON FUNCTION app.publish_notice(uuid) IS
  'R-2: resolve the audience, materialise receipts, emit notice.published.v1 '
  'for the SMS worker — one transaction, idempotent on re-publish.';

GRANT EXECUTE ON FUNCTION app.publish_notice(uuid) TO shikhon_app;

-- ---------------------------------------------------------------------
-- Row-level security
--
-- Layer 1 (tenant_isolation) is generated for both tables by 010's DO block
-- pattern; new tables added after 010 must declare it themselves.
-- ---------------------------------------------------------------------
ALTER TABLE notices          ENABLE ROW LEVEL SECURITY;
ALTER TABLE notices          FORCE  ROW LEVEL SECURITY;
ALTER TABLE notice_receipts  ENABLE ROW LEVEL SECURITY;
ALTER TABLE notice_receipts  FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON notices
  AS PERMISSIVE FOR ALL TO shikhon_app
  USING (app.tenant_guard(tenant_id)) WITH CHECK (app.tenant_guard(tenant_id));

CREATE POLICY tenant_isolation ON notice_receipts
  AS PERMISSIVE FOR ALL TO shikhon_app
  USING (app.tenant_guard(tenant_id)) WITH CHECK (app.tenant_guard(tenant_id));

-- ── Layer 2: who may READ a notice ───────────────────────────────────
-- A notice is readable if you hold a receipt for it, or you are management.
-- THIS is what stops a student reading a teachers-only notice: not the
-- category, not the UI, but the absence of a receipt.
CREATE POLICY notice_read_scope ON notices
  AS RESTRICTIVE FOR SELECT TO shikhon_app
  USING (
    app.has_role('principal','school_owner','academic_coordinator')
    OR EXISTS (SELECT 1 FROM notice_receipts r
                WHERE r.notice_id = notices.id AND r.user_id = app.current_user_id())
    OR created_by = app.current_user_id()
  );

-- ── Layer 2: who may WRITE ───────────────────────────────────────────
-- Management writes school-wide notices. A class teacher may write too — the
-- endpoint narrows them to their own sections, because expressing "the ids in
-- this jsonb are all sections you teach" as a policy predicate would be a
-- second, divergent implementation of app.my_section_ids().
CREATE POLICY notice_write_scope ON notices
  AS RESTRICTIVE FOR INSERT TO shikhon_app
  WITH CHECK (app.has_role('principal','school_owner','academic_coordinator','class_teacher'));

CREATE POLICY notice_update_scope ON notices
  AS RESTRICTIVE FOR UPDATE TO shikhon_app
  USING (app.has_role('principal','school_owner','academic_coordinator','class_teacher'));

-- ── Layer 2: receipts belong to their owner ──────────────────────────
-- A reader sees only their own receipts; management sees all, because
-- "did the guardians receive it?" is a question the office has to answer.
CREATE POLICY receipt_read_scope ON notice_receipts
  AS RESTRICTIVE FOR SELECT TO shikhon_app
  USING (
    user_id = app.current_user_id()
    OR app.has_role('principal','school_owner','academic_coordinator')
  );

-- Marking read is the only update a reader makes, and only on their own row.
-- The publish path inserts receipts as the publishing user, so INSERT stays
-- with the write roles.
CREATE POLICY receipt_update_scope ON notice_receipts
  AS RESTRICTIVE FOR UPDATE TO shikhon_app
  USING (user_id = app.current_user_id());

CREATE POLICY receipt_insert_scope ON notice_receipts
  AS RESTRICTIVE FOR INSERT TO shikhon_app
  WITH CHECK (app.has_role('principal','school_owner','academic_coordinator','class_teacher'));

GRANT SELECT, INSERT, UPDATE ON notices TO shikhon_app;
GRANT SELECT, INSERT, UPDATE ON notice_receipts TO shikhon_app;

COMMIT;
