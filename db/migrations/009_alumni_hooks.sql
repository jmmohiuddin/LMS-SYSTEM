-- =====================================================================
-- 009_alumni_hooks.sql
-- Alumni Networking System (ANS) integration surface.
--
-- Future-proofing contract: the LMS and the ANS must be able to MERGE into
-- one platform later without a fuzzy identity-matching project. Three rules
-- make that possible:
--
--   1. users.global_person_id (002) is the single unified identifier. It is
--      minted once, never reused, never regenerated, and is what the ANS
--      stores as its own primary person key.
--   2. tenants.id doubles as the ANS institution key — no separate mapping.
--   3. Every outbound record carries a schema_version and a monotonically
--      increasing record_version so the ANS can replay and de-duplicate.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- The graduation / lifecycle record — the canonical payload streamed to
-- the ANS. Materialised (rather than computed on demand) so a re-send
-- years later reproduces the record exactly as it was at graduation.
-- ---------------------------------------------------------------------
CREATE TABLE alumni_records (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  -- ── Unified identity (the merge contract) ──────────────────────────
  global_person_id     uuid NOT NULL,             -- = users.global_person_id
  student_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  institution_id       uuid NOT NULL,             -- = tenants.id
  institution_eiin     varchar(8),

  -- ── Academic lifecycle ─────────────────────────────────────────────
  lifecycle_event      text NOT NULL CHECK (lifecycle_event IN
                         ('graduated','transferred_out','dropped_out','alumni_updated')),
  graduation_year      smallint,
  final_class_level    smallint,
  stream               institution_stream,
  academic_group       academic_group,
  board_code           varchar(16),
  board_roll_no        varchar(20),
  board_registration_no varchar(20),
  final_exam_name      text,                      -- 'SSC 2026' / 'HSC 2026' / 'Dakhil 2026'
  final_gpa            numeric(3,2),
  final_letter_grade   varchar(2),

  -- ── Achievements: a denormalised, stable snapshot ──────────────────
  achievements         jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- [{type:'olympiad', title_en, title_bn, year, level:'national', position:2}]
  co_curricular        jsonb NOT NULL DEFAULT '[]'::jsonb,
  subjects_studied     jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- ── Contact: shared ONLY with explicit consent (PDPA 2026) ─────────
  contact_shared       boolean NOT NULL DEFAULT false,
  contact_consent_at   timestamptz,
  contact_consent_version text,
  -- Contact fields are populated at export time from users, never stored
  -- here in the clear, so a revoked consent cannot leak from this table.

  -- ── Versioning for idempotent replay ───────────────────────────────
  schema_version       text NOT NULL DEFAULT '1.0',
  record_version       integer NOT NULL DEFAULT 1,
  content_hash         bytea NOT NULL,            -- sha256 of the canonical payload
  effective_at         timestamptz NOT NULL DEFAULT now(),

  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, global_person_id, lifecycle_event, record_version)
);
CREATE INDEX ix_alumni_person ON alumni_records (global_person_id);
CREATE INDEX ix_alumni_year   ON alumni_records (tenant_id, graduation_year);
CREATE TRIGGER trg_alumni_tenant BEFORE INSERT OR UPDATE ON alumni_records
  FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant();
CREATE TRIGGER trg_alumni_touch BEFORE UPDATE ON alumni_records
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

COMMENT ON COLUMN alumni_records.global_person_id IS
  'THE merge key. When the LMS and ANS consolidate, records join on this column '
  'alone — no name/DOB fuzzy matching, no reconciliation project.';

-- ---------------------------------------------------------------------
-- ANS endpoint registration — per tenant, or platform-wide (tenant_id NULL).
-- ---------------------------------------------------------------------
CREATE TABLE ans_endpoints (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid REFERENCES tenants(id) ON DELETE CASCADE,
  name              text NOT NULL,
  base_url          text NOT NULL CHECK (base_url ~ '^https://'),
  auth_type         text NOT NULL DEFAULT 'oauth2_cc'
                      CHECK (auth_type IN ('oauth2_cc','hmac','mtls')),
  client_id         text,
  client_secret_ciphertext bytea,
  -- Outbound webhook signing key (we sign; the ANS verifies)
  signing_secret_ciphertext bytea NOT NULL,
  signing_key_id    text NOT NULL,
  subscribed_events text[] NOT NULL DEFAULT
                      '{student.graduated.v1,student.achievement_added.v1,student.profile_updated.v1}',
  is_active         boolean NOT NULL DEFAULT true,
  -- Inbound: the ANS may push profile updates back to us
  inbound_allowed_ips inet[],
  inbound_shared_secret_ciphertext bytea,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);
CREATE TRIGGER trg_ansep_tenant BEFORE INSERT OR UPDATE ON ans_endpoints
  FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant();

-- ---------------------------------------------------------------------
-- alumni_export_logs — one row per delivery ATTEMPT.
-- This is the audit trail for "did the ANS get Rahim's graduation record,
-- and if not, why not?"
-- ---------------------------------------------------------------------
CREATE TYPE ans_delivery_status AS ENUM
  ('pending','sending','delivered','failed','dead_lettered','skipped_no_consent','superseded');

CREATE TABLE alumni_export_logs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  endpoint_id        uuid NOT NULL REFERENCES ans_endpoints(id) ON DELETE CASCADE,
  alumni_record_id   uuid REFERENCES alumni_records(id) ON DELETE SET NULL,

  -- Denormalised so the log survives record deletion (erasure requests)
  global_person_id   uuid NOT NULL,
  student_id         uuid,
  event_type         text NOT NULL,               -- 'student.graduated.v1'
  -- Idempotency key the ANS dedupes on. Stable across our retries.
  delivery_id        uuid NOT NULL DEFAULT gen_random_uuid(),

  export_mode        text NOT NULL DEFAULT 'webhook'
                       CHECK (export_mode IN ('webhook','batch_pull','manual_csv','backfill')),
  batch_id           uuid,
  payload            jsonb,                       -- exact bytes sent (contact fields included only if consented)
  payload_hash       bytea NOT NULL,
  payload_bytes      integer,
  schema_version     text NOT NULL DEFAULT '1.0',

  status             ans_delivery_status NOT NULL DEFAULT 'pending',
  attempts           smallint NOT NULL DEFAULT 0,
  max_attempts       smallint NOT NULL DEFAULT 8,
  next_attempt_at    timestamptz,
  http_status        smallint,
  response_body      text,
  error_code         text,
  error_detail       text,

  -- ANS's acknowledgement, so we can prove receipt
  ans_record_id      text,
  ans_acknowledged_at timestamptz,

  requested_by       uuid REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  first_attempt_at   timestamptz,
  completed_at       timestamptz
);

CREATE UNIQUE INDEX uq_ans_delivery ON alumni_export_logs (delivery_id);
-- The retry worker's only query.
CREATE INDEX ix_ans_retry ON alumni_export_logs (next_attempt_at)
  WHERE status IN ('pending','failed');
CREATE INDEX ix_ans_person ON alumni_export_logs (tenant_id, global_person_id, created_at DESC);
CREATE INDEX ix_ans_dead   ON alumni_export_logs (tenant_id, created_at DESC)
  WHERE status = 'dead_lettered';
CREATE INDEX ix_ans_batch  ON alumni_export_logs (tenant_id, batch_id) WHERE batch_id IS NOT NULL;
CREATE TRIGGER trg_anslog_tenant BEFORE INSERT OR UPDATE ON alumni_export_logs
  FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant();

COMMENT ON TABLE alumni_export_logs IS
  'One row per delivery attempt, not per record. delivery_id is the idempotency key '
  'the ANS dedupes on and is stable across our retries, so an 8-attempt backoff can '
  'never create eight alumni in the ANS.';

-- ---------------------------------------------------------------------
-- Inbound: the ANS pushes profile enrichment back (current employer,
-- higher-education destination, mentorship availability). Staged here and
-- applied only after review — the LMS never blindly trusts external writes.
-- ---------------------------------------------------------------------
CREATE TABLE ans_inbound_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid REFERENCES tenants(id) ON DELETE CASCADE,
  endpoint_id       uuid REFERENCES ans_endpoints(id) ON DELETE SET NULL,
  global_person_id  uuid,
  event_type        text NOT NULL,                -- 'alumni.profile_updated.v1'
  ans_event_id      text NOT NULL,
  raw_body          text NOT NULL,
  signature_valid   boolean,
  source_ip         inet,
  processing_state  text NOT NULL DEFAULT 'received'
                      CHECK (processing_state IN ('received','verified','applied','rejected','duplicate')),
  reject_reason     text,
  received_at       timestamptz NOT NULL DEFAULT now(),
  processed_at      timestamptz
);
CREATE UNIQUE INDEX uq_ans_inbound ON ans_inbound_events (endpoint_id, ans_event_id);
CREATE INDEX ix_ans_inbound_pending ON ans_inbound_events (received_at)
  WHERE processing_state IN ('received','verified');

-- Applied enrichment lands here, kept separate from LMS-authoritative data.
CREATE TABLE alumni_profile_enrichment (
  global_person_id  uuid PRIMARY KEY,
  tenant_id         uuid REFERENCES tenants(id) ON DELETE SET NULL,
  current_institution text,
  current_employer  text,
  current_designation text,
  higher_education  jsonb NOT NULL DEFAULT '[]'::jsonb,
  linkedin_url      text,
  is_mentor_available boolean NOT NULL DEFAULT false,
  last_synced_at    timestamptz NOT NULL DEFAULT now(),
  source            text NOT NULL DEFAULT 'ans'
);

-- ---------------------------------------------------------------------
-- Graduation → export, wired as a domain event.
-- Fires when a student's lifecycle_status becomes 'graduated'.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.emit_graduation_event() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_gpid uuid;
BEGIN
  IF NEW.lifecycle_status <> 'graduated'
     OR (TG_OP = 'UPDATE' AND OLD.lifecycle_status = 'graduated') THEN
    RETURN NULL;
  END IF;

  SELECT u.global_person_id INTO v_gpid FROM users u WHERE u.id = NEW.user_id;

  INSERT INTO event_outbox (tenant_id, event_type, aggregate_type, aggregate_id, payload)
  VALUES (NEW.tenant_id, 'student.graduated.v1', 'student', NEW.user_id,
          jsonb_build_object(
            'globalPersonId', v_gpid,
            'studentId',      NEW.user_id,
            'institutionId',  NEW.tenant_id,
            'graduatedOn',    NEW.graduated_on,
            'examId',         NEW.graduation_exam_id));
  RETURN NULL;
END $$;

CREATE TRIGGER trg_student_graduated
  AFTER INSERT OR UPDATE OF lifecycle_status ON student_profiles
  FOR EACH ROW EXECUTE FUNCTION app.emit_graduation_event();

-- ---------------------------------------------------------------------
-- Read model the ANS pulls in batch mode (GET /ans/v1/alumni?since=…).
-- Consent gating is applied here, not in the application, so a bug in the
-- API layer cannot leak an unconsented contact detail.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW v_ans_alumni_export AS
SELECT
  ar.global_person_id,
  ar.institution_id,
  ar.institution_eiin,
  ar.lifecycle_event,
  ar.graduation_year,
  ar.final_class_level,
  ar.stream,
  ar.academic_group,
  ar.board_code,
  ar.final_exam_name,
  ar.final_gpa,
  ar.final_letter_grade,
  ar.achievements,
  ar.co_curricular,
  ar.subjects_studied,
  u.full_name_en,
  u.full_name_bn,
  CASE WHEN ar.contact_shared THEN u.phone_e164 END AS phone_e164,
  CASE WHEN ar.contact_shared THEN u.email::text  END AS email,
  ar.contact_shared,
  ar.schema_version,
  ar.record_version,
  ar.effective_at,
  ar.updated_at
FROM alumni_records ar
JOIN users u ON u.id = ar.student_id
WHERE u.deleted_at IS NULL;

COMMENT ON VIEW v_ans_alumni_export IS
  'Consent gating lives in the CASE expressions here. An API-layer bug cannot '
  'leak an unconsented phone number, because the column arrives NULL.';

COMMIT;
