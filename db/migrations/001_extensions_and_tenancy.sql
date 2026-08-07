-- =====================================================================
-- 001_extensions_and_tenancy.sql
-- Extensions, roles, tenant registry, tenant-context helpers, audit spine.
-- PostgreSQL 16+
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pgcrypto;      -- gen_random_uuid, digest, hmac
CREATE EXTENSION IF NOT EXISTS citext;        -- case-insensitive email
CREATE EXTENSION IF NOT EXISTS btree_gist;    -- =-ops inside GiST exclusion constraints
CREATE EXTENSION IF NOT EXISTS pg_trgm;       -- fuzzy name search (Bangla + Latin)
CREATE EXTENSION IF NOT EXISTS vector;        -- pgvector, NCTB RAG corpus

-- ---------------------------------------------------------------------
-- Schemas
-- ---------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS app;        -- helper functions
CREATE SCHEMA IF NOT EXISTS audit;      -- append-only audit trails
CREATE SCHEMA IF NOT EXISTS archive;    -- detached cold partitions
CREATE SCHEMA IF NOT EXISTS extensions; -- extensions that expose TABLES/VIEWS

-- pg_stat_statements exposes views. Keeping it out of `public` stops the
-- blanket `GRANT ... ON ALL TABLES IN SCHEMA public` in 010 from trying to
-- grant on objects the application does not own (on managed Postgres such as
-- Neon or RDS those views belong to the platform, and the GRANT warns).
CREATE EXTENSION IF NOT EXISTS pg_stat_statements SCHEMA extensions;

-- ---------------------------------------------------------------------
-- Roles
--   shikhon_owner    : owns DDL, runs migrations.        BYPASSRLS = NO
--   shikhon_app      : runtime role used by all services. NOINHERIT, never BYPASSRLS
--   shikhon_platform : super-admin escape hatch.          BYPASSRLS = YES, fully audited
--   shikhon_readonly : BI / reporting replica consumer
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'shikhon_app') THEN
    CREATE ROLE shikhon_app      NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'shikhon_platform') THEN
    CREATE ROLE shikhon_platform NOLOGIN BYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'shikhon_readonly') THEN
    CREATE ROLE shikhon_readonly NOLOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public, app TO shikhon_app, shikhon_platform, shikhon_readonly;

-- ---------------------------------------------------------------------
-- Tenant-context helpers
--
-- Services MUST issue, inside every transaction:
--     SET LOCAL app.tenant_id = '<uuid>';
--     SET LOCAL app.user_id   = '<uuid>';
--     SET LOCAL app.role      = '<role_code>';
--
-- SET LOCAL (not SET) is mandatory: PgBouncer runs in transaction-pooling
-- mode, so session-scoped GUCs would leak across requests.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.current_tenant() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid;
$$;

CREATE OR REPLACE FUNCTION app.current_user_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid;
$$;

CREATE OR REPLACE FUNCTION app.current_role_code() RETURNS text
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT COALESCE(NULLIF(current_setting('app.role', true), ''), 'anonymous');
$$;

-- Fail-closed guard: any tenant table policy calls this, so a missing
-- context yields zero rows rather than the whole table.
CREATE OR REPLACE FUNCTION app.tenant_guard(row_tenant uuid) RETURNS boolean
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT app.current_tenant() IS NOT NULL AND row_tenant = app.current_tenant();
$$;

CREATE OR REPLACE FUNCTION app.has_role(VARIADIC codes text[]) RETURNS boolean
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT app.current_role_code() = ANY(codes);
$$;

-- ---------------------------------------------------------------------
-- Enumerations
-- ---------------------------------------------------------------------
CREATE TYPE institution_stream AS ENUM (
  'bangla_medium', 'english_version', 'english_medium', 'madrasah', 'technical'
);

CREATE TYPE institution_level AS ENUM (
  'primary',          -- Class 1-5
  'junior_secondary', -- Class 6-8
  'secondary',        -- Class 9-10 (SSC / Dakhil)
  'higher_secondary', -- Class 11-12 (HSC / Alim)
  'combined'
);

CREATE TYPE tenant_status AS ENUM ('trial', 'active', 'suspended', 'archived');

CREATE TYPE shift_code AS ENUM ('morning', 'day', 'evening', 'single');

-- ---------------------------------------------------------------------
-- tenants — the root of the isolation model.
-- Deliberately NOT itself RLS-scoped by tenant_id; access is by id and is
-- controlled at the service layer + a self-referential policy (010).
-- ---------------------------------------------------------------------
CREATE TABLE tenants (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                citext NOT NULL UNIQUE
                        CHECK (slug ~ '^[a-z0-9][a-z0-9-]{2,62}$'),
  name_bn             text NOT NULL,
  name_en             text NOT NULL,

  -- Regulatory identifiers
  eiin                varchar(8) UNIQUE,          -- Educational Institution Identification Number
  mpo_code            varchar(20),
  board_code          varchar(16),                -- dhaka, rajshahi, madrasah, technical...
  stream              institution_stream NOT NULL,
  level               institution_level  NOT NULL,

  -- Locale / operations
  district            text,
  upazila             text,
  address_bn          text,
  timezone            text NOT NULL DEFAULT 'Asia/Dhaka',
  default_locale      text NOT NULL DEFAULT 'bn'  CHECK (default_locale IN ('bn','en')),
  weekend_days        smallint[] NOT NULL DEFAULT '{5,6}'   -- 0=Sun … 6=Sat; BD default Fri+Sat
                        CHECK (weekend_days <@ ARRAY[0,1,2,3,4,5,6]::smallint[]),
  shifts              shift_code[] NOT NULL DEFAULT '{single}',

  -- Commercial
  status              tenant_status NOT NULL DEFAULT 'trial',
  plan_code           text NOT NULL DEFAULT 'starter',
  student_cap         integer NOT NULL DEFAULT 500 CHECK (student_cap > 0),
  trial_ends_on       date,

  -- Crypto: per-tenant wrapped DEK + blind-index pepper (both KMS-wrapped)
  dek_wrapped         bytea,
  dek_key_version     smallint NOT NULL DEFAULT 1,
  blind_index_pepper  bytea,

  -- Feature + policy configuration
  settings            jsonb NOT NULL DEFAULT '{}'::jsonb,
  features            jsonb NOT NULL DEFAULT '{}'::jsonb,
  ai_monthly_token_budget bigint NOT NULL DEFAULT 2000000,
  sms_daily_cap       integer NOT NULL DEFAULT 2000,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz
);

COMMENT ON COLUMN tenants.weekend_days IS
  'Per-tenant weekend. Most BD institutions {5,6} (Fri,Sat); many Madrasah {5} (Fri only).';
COMMENT ON COLUMN tenants.blind_index_pepper IS
  'KMS-wrapped pepper for HMAC-SHA256 blind indexes over NID/BRC. Never leaves identity-svc.';

-- ---------------------------------------------------------------------
-- Reusable trigger: maintain updated_at
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE TRIGGER trg_tenants_touch BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- ---------------------------------------------------------------------
-- Reusable trigger: stamp tenant_id from session context and forbid
-- cross-tenant writes even before RLS gets involved (belt + braces).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.enforce_tenant() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE ctx uuid := app.current_tenant();
BEGIN
  IF ctx IS NULL THEN
    -- platform role may act without a tenant context; everyone else may not
    IF pg_has_role(current_user, 'shikhon_platform', 'MEMBER') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'tenant context not set (app.tenant_id)' USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.tenant_id IS NULL THEN NEW.tenant_id := ctx; END IF;
    IF NEW.tenant_id <> ctx THEN
      RAISE EXCEPTION 'cross-tenant insert blocked' USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.tenant_id <> OLD.tenant_id THEN
    RAISE EXCEPTION 'tenant_id is immutable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------
-- Transactional outbox — domain events written in the same transaction as
-- the state change, relayed to Redis Streams by a tailer process.
-- ---------------------------------------------------------------------
CREATE TABLE event_outbox (
  id              bigserial PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_type      text NOT NULL,               -- e.g. 'attendance.marked.v1'
  aggregate_type  text NOT NULL,
  aggregate_id    uuid NOT NULL,
  payload         jsonb NOT NULL,
  trace_id        text,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  published_at    timestamptz,
  attempts        smallint NOT NULL DEFAULT 0
);

CREATE INDEX ix_event_outbox_unpublished
  ON event_outbox (id) WHERE published_at IS NULL;

-- ---------------------------------------------------------------------
-- Change log — powers the /sync/pull cursor. Written by AFTER triggers on
-- syncable tables. 30-day retention.
-- ---------------------------------------------------------------------
CREATE TABLE sync_change_log (
  id           bigserial PRIMARY KEY,
  tenant_id    uuid NOT NULL,
  scope        text NOT NULL,                 -- 'routineSlots', 'students', ...
  entity_id    uuid NOT NULL,
  op           char(1) NOT NULL CHECK (op IN ('U','D')),  -- upsert | delete
  row_version  integer NOT NULL DEFAULT 1,
  changed_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ix_sync_change_log_cursor
  ON sync_change_log (tenant_id, scope, id);

CREATE OR REPLACE FUNCTION app.log_sync_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE scope_name text := TG_ARGV[0];
BEGIN
  IF TG_OP = 'DELETE' THEN
    INSERT INTO sync_change_log (tenant_id, scope, entity_id, op)
    VALUES (OLD.tenant_id, scope_name, OLD.id, 'D');
    RETURN OLD;
  END IF;
  INSERT INTO sync_change_log (tenant_id, scope, entity_id, op)
  VALUES (NEW.tenant_id, scope_name, NEW.id, 'U');
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------
-- Idempotency ledger — every offline outbox op is recorded exactly once.
-- The (tenant_id, op_id) unique constraint is what makes retry-on-2G safe.
-- ---------------------------------------------------------------------
CREATE TABLE sync_operations (
  op_id         uuid PRIMARY KEY,             -- UUIDv7 generated on the device
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  device_id     text NOT NULL,
  actor_id      uuid NOT NULL,
  device_seq    bigint NOT NULL,
  entity        text NOT NULL,
  operation     text NOT NULL,
  occurred_at   timestamptz NOT NULL,          -- client clock, skew-corrected
  received_at   timestamptz NOT NULL DEFAULT now(),
  result        text NOT NULL CHECK (result IN ('applied','conflict','rejected','duplicate')),
  conflict_detail jsonb
);

-- device_seq is deliberately NOT unique: it lives in the device's own
-- IndexedDB and restarts at 1 after a reinstall or storage eviction. Making it
-- unique permanently poisons sync for that phone. Idempotency is op_id (the PK)
-- alone. See migration 015 for the full rationale.
CREATE INDEX ix_sync_operations_device_seq ON sync_operations (tenant_id, device_id, device_seq);
CREATE INDEX ix_sync_operations_actor ON sync_operations (tenant_id, actor_id, received_at DESC);

-- ---------------------------------------------------------------------
-- Audit spine
-- ---------------------------------------------------------------------
CREATE TABLE audit.activity_log (
  id           bigserial PRIMARY KEY,
  tenant_id    uuid,
  actor_id     uuid,
  actor_role   text,
  action       text NOT NULL,                 -- 'exam.marks.publish'
  entity_type  text,
  entity_id    uuid,
  before_state jsonb,
  after_state  jsonb,
  ip_address   inet,
  user_agent   text,
  trace_id     text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_activity_tenant_time ON audit.activity_log (tenant_id, created_at DESC);
CREATE INDEX ix_activity_entity      ON audit.activity_log (entity_type, entity_id);

-- Every decryption of an NID/BRC lands here. Volumetric alerting reads it.
CREATE TABLE audit.pii_access (
  id           bigserial PRIMARY KEY,
  tenant_id    uuid NOT NULL,
  actor_id     uuid NOT NULL,
  subject_type text NOT NULL,                 -- 'student' | 'guardian' | 'staff'
  subject_id   uuid NOT NULL,
  field        text NOT NULL,                 -- 'nid' | 'brc' | 'bank_account'
  purpose_code text NOT NULL,                 -- 'board_registration' | 'mpo_filing' | 'dsar'
  legal_basis  text NOT NULL,                 -- PDPA 2026 basis
  ip_address   inet,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_pii_access_actor ON audit.pii_access (tenant_id, actor_id, created_at DESC);

-- Break-glass: any statement executed under the BYPASSRLS platform role.
CREATE TABLE audit.platform_access (
  id          bigserial PRIMARY KEY,
  admin_id    uuid NOT NULL,
  tenant_id   uuid,
  reason      text NOT NULL,
  ticket_ref  text,
  statement   text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

COMMIT;
