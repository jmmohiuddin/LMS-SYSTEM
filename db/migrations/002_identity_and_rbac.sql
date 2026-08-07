-- =====================================================================
-- 002_identity_and_rbac.sql
-- Users, roles, permissions, encrypted PII, guardianship, sessions.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- Role catalogue (platform-global, not tenant-scoped)
-- ---------------------------------------------------------------------
CREATE TABLE roles (
  code          text PRIMARY KEY,
  name_bn       text NOT NULL,
  name_en       text NOT NULL,
  scope_level   text NOT NULL CHECK (scope_level IN ('platform','tenant','class','self')),
  rank          smallint NOT NULL,            -- higher = more authority; used for "can manage"
  is_staff      boolean NOT NULL DEFAULT true
);

INSERT INTO roles (code, name_bn, name_en, scope_level, rank, is_staff) VALUES
  ('super_admin',          'সুপার অ্যাডমিন',        'Super Admin',          'platform', 100, true),
  ('school_owner',         'প্রতিষ্ঠান মালিক',      'School Owner',         'tenant',    90, true),
  ('principal',            'অধ্যক্ষ / প্রধান শিক্ষক','Principal',            'tenant',    80, true),
  ('academic_coordinator', 'একাডেমিক সমন্বয়কারী',  'Academic Coordinator', 'tenant',    70, true),
  ('dept_head',            'বিভাগীয় প্রধান',       'Department Head',      'tenant',    60, true),
  ('accountant',           'হিসাবরক্ষক',           'Accountant',           'tenant',    55, true),
  ('class_teacher',        'শ্রেণি শিক্ষক',         'Class Teacher',        'class',     50, true),
  ('subject_teacher',      'বিষয় শিক্ষক',          'Subject Teacher',      'class',     45, true),
  ('librarian',            'গ্রন্থাগারিক',          'Librarian',            'tenant',    30, true),
  ('student',              'শিক্ষার্থী',            'Student',              'self',      10, false),
  ('guardian',             'অভিভাবক',              'Guardian',             'self',       5, false);

-- ---------------------------------------------------------------------
-- Permission catalogue + role→permission mapping
-- Permissions are strings 'domain.resource.action'.
-- ---------------------------------------------------------------------
CREATE TABLE permissions (
  code        text PRIMARY KEY,
  description text NOT NULL
);

CREATE TABLE role_permissions (
  role_code       text NOT NULL REFERENCES roles(code) ON DELETE CASCADE,
  permission_code text NOT NULL REFERENCES permissions(code) ON DELETE CASCADE,
  PRIMARY KEY (role_code, permission_code)
);

INSERT INTO permissions (code, description) VALUES
  ('attendance.mark',            'Mark attendance for an assigned section'),
  ('attendance.view.section',    'View attendance of own sections'),
  ('attendance.view.all',        'View attendance across the institution'),
  ('attendance.correct',         'Correct a submitted attendance record'),
  ('marks.enter',                'Enter marks for assigned exam subjects'),
  ('marks.publish',              'Publish results (irreversible)'),
  ('marks.correct',              'Approve a correction to published marks'),
  ('routine.view.own',           'View own routine'),
  ('routine.view.all',           'View all routines'),
  ('routine.generate',           'Run the routine solver'),
  ('routine.publish',            'Publish a routine version'),
  ('substitution.assign',        'Assign substitute teachers'),
  ('fee.invoice.create',         'Create fee invoices'),
  ('fee.payment.record',         'Record an offline payment'),
  ('fee.refund',                 'Issue a refund'),
  ('fee.ledger.view',            'View the financial ledger'),
  ('pii.decrypt',                'Decrypt NID/BRC fields'),
  ('ai.sikhok.use',              'Use the SikhokAI teacher co-pilot'),
  ('ai.shikho.use',              'Use the ShikhoAI student tutor'),
  ('alumni.export',              'Export graduation records to the ANS'),
  ('tenant.settings.manage',     'Change institution settings'),
  ('user.manage',                'Create and manage users');

-- super_admin and school_owner are wildcard-evaluated in identity-svc and are
-- intentionally absent from this table; principal gets every tenant-scoped permission.
INSERT INTO role_permissions (role_code, permission_code)
SELECT 'principal', code FROM permissions;

INSERT INTO role_permissions (role_code, permission_code) VALUES
  ('academic_coordinator','attendance.view.all'),
  ('academic_coordinator','attendance.correct'),
  ('academic_coordinator','marks.correct'),
  ('academic_coordinator','routine.view.all'),
  ('academic_coordinator','routine.generate'),
  ('academic_coordinator','routine.publish'),
  ('academic_coordinator','substitution.assign'),
  ('academic_coordinator','ai.sikhok.use'),
  ('class_teacher','attendance.mark'),
  ('class_teacher','attendance.view.section'),
  ('class_teacher','marks.enter'),
  ('class_teacher','routine.view.own'),
  ('class_teacher','ai.sikhok.use'),
  ('subject_teacher','attendance.mark'),
  ('subject_teacher','attendance.view.section'),
  ('subject_teacher','marks.enter'),
  ('subject_teacher','routine.view.own'),
  ('subject_teacher','ai.sikhok.use'),
  ('accountant','fee.invoice.create'),
  ('accountant','fee.payment.record'),
  ('accountant','fee.ledger.view'),
  ('student','ai.shikho.use'),
  ('student','routine.view.own')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------
-- users — one row per human, in one tenant.
--
-- PII columns are stored as application-encrypted ciphertext
-- (AES-256-GCM: nonce||ct||tag) plus an HMAC blind index for exact lookup.
-- The plaintext column does not exist, by design.
-- ---------------------------------------------------------------------
CREATE TYPE user_status AS ENUM ('invited','active','suspended','left','deleted');
CREATE TYPE gender_code AS ENUM ('male','female','other','undisclosed');

CREATE TABLE users (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  -- Cross-system unified identity. Stable for life, shared with the ANS.
  -- Never reused, never regenerated. See 009_alumni_hooks.sql.
  global_person_id   uuid NOT NULL DEFAULT gen_random_uuid(),

  -- Credentials / contact
  phone_e164         varchar(16)  CHECK (phone_e164 ~ '^\+8801[3-9][0-9]{8}$'),
  email              citext,
  password_hash      text,                       -- argon2id
  mfa_totp_secret    bytea,                      -- encrypted
  mfa_required       boolean NOT NULL DEFAULT false,

  -- Names: Bangla is primary, English required for board/MPO filings
  full_name_bn       text NOT NULL,
  full_name_en       text NOT NULL,
  father_name_bn     text,
  mother_name_bn     text,
  date_of_birth      date,
  gender             gender_code,
  photo_key          text,                       -- object-store key, never a URL

  -- Encrypted national identifiers (PDPA 2026 / CA 2023)
  nid_ciphertext     bytea,
  nid_blind_index    bytea,                      -- HMAC-SHA256(tenant_pepper, digits(nid))
  brc_ciphertext     bytea,                      -- Birth Registration Certificate
  brc_blind_index    bytea,
  pii_key_version    smallint NOT NULL DEFAULT 1,

  status             user_status NOT NULL DEFAULT 'invited',
  preferred_locale   text NOT NULL DEFAULT 'bn' CHECK (preferred_locale IN ('bn','en','bn-latn')),

  -- PDPA
  consent_sms        boolean NOT NULL DEFAULT false,
  consent_ai         boolean NOT NULL DEFAULT false,
  consent_version    text,
  consent_at         timestamptz,
  legal_hold         boolean NOT NULL DEFAULT false,   -- blocks erasure of board-mandated records

  row_version        integer NOT NULL DEFAULT 1,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz,

  CONSTRAINT users_contactable CHECK (phone_e164 IS NOT NULL OR email IS NOT NULL)
);

-- Phone is the primary login identity in Bangladesh; unique per tenant.
CREATE UNIQUE INDEX uq_users_tenant_phone ON users (tenant_id, phone_e164)
  WHERE phone_e164 IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX uq_users_tenant_email ON users (tenant_id, email)
  WHERE email IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX uq_users_global_person ON users (global_person_id);
-- Duplicate-NID detection without ever storing plaintext:
CREATE UNIQUE INDEX uq_users_nid_blind ON users (tenant_id, nid_blind_index)
  WHERE nid_blind_index IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX ix_users_name_trgm ON users USING gin (full_name_bn gin_trgm_ops);

CREATE TRIGGER trg_users_tenant BEFORE INSERT OR UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant();
CREATE TRIGGER trg_users_touch BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

COMMENT ON COLUMN users.global_person_id IS
  'Unified identifier shared verbatim with the Alumni Networking System so LMS and ANS records '
  'merge without a fuzzy-matching step. Immutable for the life of the person.';

-- ---------------------------------------------------------------------
-- user_roles — a user may hold several roles (a Dept Head who also teaches)
-- ---------------------------------------------------------------------
CREATE TABLE user_roles (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_code    text NOT NULL REFERENCES roles(code),
  scope_type   text CHECK (scope_type IN ('tenant','department','class','section')),
  scope_id     uuid,
  granted_by   uuid REFERENCES users(id),
  valid_from   date NOT NULL DEFAULT CURRENT_DATE,
  valid_until  date,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id, role_code, scope_type, scope_id)
);
CREATE INDEX ix_user_roles_lookup ON user_roles (tenant_id, user_id) INCLUDE (role_code, scope_id);
CREATE TRIGGER trg_user_roles_tenant BEFORE INSERT OR UPDATE ON user_roles
  FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant();

-- ---------------------------------------------------------------------
-- Staff / student profile extensions
-- ---------------------------------------------------------------------
CREATE TABLE staff_profiles (
  user_id             uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  employee_code       text NOT NULL,
  designation_bn      text,
  department_id       uuid,
  joining_date        date,
  employment_type     text CHECK (employment_type IN ('mpo','non_mpo','part_time','contract','guest')),
  highest_degree      text,
  -- RMS inputs
  max_periods_per_week smallint NOT NULL DEFAULT 30 CHECK (max_periods_per_week BETWEEN 1 AND 60),
  max_periods_per_day  smallint NOT NULL DEFAULT 6  CHECK (max_periods_per_day BETWEEN 1 AND 12),
  max_substitutions_per_week smallint NOT NULL DEFAULT 4,
  serves_shifts       shift_code[] NOT NULL DEFAULT '{single}',
  bank_account_ciphertext bytea,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, employee_code)
);
CREATE TRIGGER trg_staff_tenant BEFORE INSERT OR UPDATE ON staff_profiles
  FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant();

CREATE TABLE student_profiles (
  user_id            uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  student_code       text NOT NULL,              -- institution-issued
  admission_date     date NOT NULL,
  admission_class    smallint,
  -- Board identifiers, populated from Class 9 onward
  board_registration_no varchar(20),
  board_roll_no         varchar(20),
  blood_group        varchar(3),
  religion           text,
  quota_category     text,                       -- freedom-fighter, tribal, disabled...
  is_boarding        boolean NOT NULL DEFAULT false,
  -- Lifecycle: drives the ANS graduation hook (009)
  lifecycle_status   text NOT NULL DEFAULT 'enrolled'
                       CHECK (lifecycle_status IN
                         ('enrolled','promoted','transferred_out','dropped_out','graduated','alumni')),
  graduated_on       date,
  graduation_exam_id uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, student_code)
);
CREATE INDEX ix_student_lifecycle ON student_profiles (tenant_id, lifecycle_status)
  WHERE lifecycle_status IN ('graduated','alumni');
CREATE TRIGGER trg_student_tenant BEFORE INSERT OR UPDATE ON student_profiles
  FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant();

-- ---------------------------------------------------------------------
-- guardianship — many-to-many; SMS routing depends on it
-- ---------------------------------------------------------------------
CREATE TABLE guardianships (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  student_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  guardian_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  relation       text NOT NULL CHECK (relation IN ('father','mother','brother','sister',
                                                   'uncle','aunt','grandparent','legal_guardian','other')),
  is_primary     boolean NOT NULL DEFAULT false,
  receives_sms   boolean NOT NULL DEFAULT true,
  can_pay_fees   boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, student_id, guardian_id)
);
-- Exactly one primary guardian per student.
CREATE UNIQUE INDEX uq_guardianship_primary ON guardianships (tenant_id, student_id)
  WHERE is_primary;
CREATE INDEX ix_guardianship_by_guardian ON guardianships (tenant_id, guardian_id);
CREATE TRIGGER trg_guardianships_tenant BEFORE INSERT OR UPDATE ON guardianships
  FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant();

-- ---------------------------------------------------------------------
-- Sessions, devices, OTP
-- ---------------------------------------------------------------------
CREATE TABLE user_sessions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_hash bytea NOT NULL,             -- sha256; rotated on every use
  device_id          text NOT NULL,
  device_label       text,
  device_fingerprint text,
  ip_address         inet,
  user_agent         text,
  issued_at          timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL,
  last_seen_at       timestamptz NOT NULL DEFAULT now(),
  revoked_at         timestamptz,
  revoked_reason     text,
  -- refresh-token reuse detection
  superseded_by      uuid REFERENCES user_sessions(id)
);
CREATE UNIQUE INDEX uq_session_refresh ON user_sessions (refresh_token_hash);
CREATE INDEX ix_session_active ON user_sessions (tenant_id, user_id)
  WHERE revoked_at IS NULL;
CREATE TRIGGER trg_sessions_tenant BEFORE INSERT OR UPDATE ON user_sessions
  FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant();

CREATE TABLE otp_challenges (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid REFERENCES tenants(id) ON DELETE CASCADE,
  phone_e164   varchar(16) NOT NULL,
  code_hash    bytea NOT NULL,
  purpose      text NOT NULL CHECK (purpose IN ('login','enrol_device','reset_password','verify_phone')),
  attempts     smallint NOT NULL DEFAULT 0,
  max_attempts smallint NOT NULL DEFAULT 5,
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_otp_lookup ON otp_challenges (phone_e164, purpose, created_at DESC)
  WHERE consumed_at IS NULL;

COMMIT;
