-- ---------------------------------------------------------------------------
-- 051 — Platform operations: the commercial model, and controls that BITE.
--
-- P7-1's inventory found the thing this migration exists for:
--
--   `app.set_tenant_status` writes `tenants.status`, the console shows a
--   button for it, the audit log records it — and NOT ONE LINE of application
--   code reads that column. The only read anywhere in the repository is
--   `ops-svc/api/maintenance.ts` choosing tenants for a nightly cron.
--
-- So today an operator can suspend a school, see a success message and an
-- audit entry, and the school keeps working normally. A control that reports
-- success and changes nothing is worse than no control: it is a lie the
-- operator will act on.
--
-- This migration makes the operational state real, and adds the four things
-- D16 and P7 need that the schema has never had: plans, subscriptions,
-- payments, and per-service / per-portal entitlements.
--
-- ── Why a new table rather than more columns on `tenants` ────────────────
-- `tenants` is read on every request through RLS. Widening it with billing
-- fields puts commercial data in the hot path of every student's timetable
-- query. `tenant_operations` is one row per tenant, read only by the gate.
--
-- ── Why the enum is not extended ─────────────────────────────────────────
-- `tenant_status` is trial/active/suspended/archived and is referenced by
-- `app.create_tenant`, `app.set_tenant_status`, `platform_tenants` and a
-- migration-001 CHECK. Adding LIMITED and MAINTENANCE to it would change the
-- meaning of a column four other objects already interpret. The OPERATIONAL
-- state is a separate concept — a paid-up school can be in maintenance, and a
-- suspended school is not "archived" — so it gets its own type and its own
-- column, and `tenants.status` keeps meaning exactly what it meant.
-- ---------------------------------------------------------------------------

BEGIN;

-- ── 1. The operational state ─────────────────────────────────────────────
--
-- Ordered by how much a school can do, most to least. The order matters:
-- `access_level` below compares against it, so a check for "at least LIMITED"
-- is one comparison rather than a list.
DO $$ BEGIN
  CREATE TYPE tenant_ops_state AS ENUM (
    'active',       -- everything the plan allows
    'maintenance',  -- read-only, by OUR choice, for a deploy or a migration
    'limited',      -- read-only, by BILLING, plus the explicit exceptions below
    'suspended'     -- no tenant access at all; data untouched
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 2. Plans ─────────────────────────────────────────────────────────────
--
-- `tenants.plan_code` has been free text since 001, so a typo produced a
-- plan. It becomes a foreign key to a row that says what the plan MEANS.
CREATE TABLE IF NOT EXISTS plans (
  code            text PRIMARY KEY
                  CONSTRAINT plans_code_check CHECK (code ~ '^[a-z][a-z0-9_]{1,30}$'),
  name_bn         text NOT NULL,
  -- Money as an exact decimal, never a float. Same rule as invoices.
  price_bdt       numeric(12,2) NOT NULL DEFAULT 0
                  CONSTRAINT plans_price_check CHECK (price_bdt >= 0),
  billing_cycle   text NOT NULL DEFAULT 'yearly'
                  CONSTRAINT plans_cycle_check CHECK (billing_cycle IN ('monthly','quarterly','yearly')),
  student_cap     integer NOT NULL DEFAULT 500
                  CONSTRAINT plans_cap_check CHECK (student_cap > 0),
  -- Which services this plan entitles a school to. The KEYS are the service
  -- codes in `app.SERVICE_CODES` below; absent means "not entitled".
  services        jsonb NOT NULL DEFAULT '{}'::jsonb,
  trial_days      integer NOT NULL DEFAULT 30
                  CONSTRAINT plans_trial_check CHECK (trial_days >= 0),
  -- How long after a due date a school keeps working before it is limited.
  grace_days      integer NOT NULL DEFAULT 14
                  CONSTRAINT plans_grace_check CHECK (grace_days >= 0),
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE plans IS
  'What a plan_code MEANS. Before 051 it meant nothing — it was free text.';

-- ── 3. Per-tenant operational state, entitlements and billing ────────────
CREATE TABLE IF NOT EXISTS tenant_operations (
  tenant_id       uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,

  ops_state       tenant_ops_state NOT NULL DEFAULT 'active',
  -- Why, who and when. A state change with no reason is indistinguishable
  -- from a bug six months later; the same lesson B-7's revocation learned.
  state_reason    text,
  state_changed_at timestamptz,
  state_changed_by uuid,
  -- For `maintenance`: when it should end. Advisory — nothing auto-clears it,
  -- because a deploy that overruns must not silently re-open a school.
  state_until     timestamptz,

  -- Which of the FIVE portals may sign in. Absent key = allowed, so a tenant
  -- created before this migration behaves exactly as it did.
  --   { "teacher": false, "student": false, … }
  portals         jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Per-service override ON TOP of the plan. A plan says what is included;
  -- this says what the operator has switched off for THIS school.
  --   { "sms": "disabled", "finance": "limited" }
  services        jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Billing. `next_due_on` is the authority; the lifecycle is DERIVED from
  -- it and from payments, never set by hand.
  next_due_on     date,
  grace_until     date,
  grace_reason    text,
  grace_granted_by uuid,

  updated_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN tenant_operations.portals IS
  'Per-portal sign-in control. Absent key means allowed, so pre-051 tenants '
  'are unchanged. Never implemented by deleting users or roles.';

-- Every tenant has a row, so the gate never has to handle a missing one.
INSERT INTO tenant_operations (tenant_id)
SELECT id FROM tenants
ON CONFLICT (tenant_id) DO NOTHING;

-- ── 4. Payments ──────────────────────────────────────────────────────────
--
-- Manual only. R-7.10/D16: shikhonBD invoices a school outside the product
-- and records the payment here. There is deliberately no gateway.
CREATE TABLE IF NOT EXISTS tenant_payments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  amount_bdt      numeric(12,2) NOT NULL
                  CONSTRAINT payments_amount_check CHECK (amount_bdt > 0),
  paid_on         date NOT NULL,
  method          text NOT NULL
                  CONSTRAINT payments_method_check
                  CHECK (method IN ('bank','bkash','nagad','rocket','cash','cheque','other')),
  -- The school's own reference: a bank slip number, an MFS transaction id.
  reference       text,
  note            text,
  -- What this payment bought. Set when it is recorded, so a later plan change
  -- does not rewrite history.
  covers_until    date,
  recorded_by     uuid NOT NULL,
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  -- A duplicate payment is the commonest operator error and the one with a
  -- real cost, so the database refuses it rather than the UI warning about
  -- it. Two genuinely identical payments on one day need a distinct
  -- reference, which a bank slip always has.
  CONSTRAINT payments_no_duplicate
    UNIQUE (tenant_id, paid_on, amount_bdt, method, reference)
);

CREATE INDEX IF NOT EXISTS payments_by_tenant
  ON tenant_payments (tenant_id, paid_on DESC);

-- ── 5. The service catalogue, and what each state permits ────────────────
--
-- §15 asked for an explicit matrix rather than a guess. This is it, in the
-- database, so the API and the console read one source.
CREATE TABLE IF NOT EXISTS service_catalogue (
  code            text PRIMARY KEY
                  CONSTRAINT service_code_check CHECK (code ~ '^[a-z][a-z0-9_]{1,30}$'),
  name_bn         text NOT NULL,
  -- What turning this off actually stops. Shown verbatim in the confirmation.
  effect_bn       text NOT NULL,
  -- Services this one needs. Disabling a dependency is refused while a
  -- dependent is on — §10's "do not allow impossible states".
  depends_on      text[] NOT NULL DEFAULT '{}',
  -- Is this service available at all in `limited` mode? Most are not; the
  -- exceptions are the ones a school still needs while it settles a bill.
  in_limited      boolean NOT NULL DEFAULT false,
  sort_order      integer NOT NULL DEFAULT 100
);

INSERT INTO service_catalogue (code, name_bn, effect_bn, depends_on, in_limited, sort_order) VALUES
  ('attendance',  'হাজিরা',
   'শিক্ষক আর হাজিরা নিতে পারবেন না। আগের হাজিরা দেখা যাবে।', '{}', true, 10),
  ('results',     'ফলাফল',
   'নম্বর দেওয়া ও ফলাফল প্রকাশ বন্ধ হবে। প্রকাশিত ফলাফল দেখা যাবে।', '{}', true, 20),
  ('assignments', 'বাড়ির কাজ',
   'নতুন কাজ দেওয়া ও জমা দেওয়া বন্ধ হবে।', '{}', false, 30),
  ('learning',    'পড়াশোনা ও কনটেন্ট',
   'অধ্যায় ও পাঠ দেখা বন্ধ হবে।', '{}', false, 40),
  ('finance',     'ফি ও হিসাব',
   'ইনভয়েস তৈরি, ফি আদায় ও লেজার বন্ধ হবে। আগের রসিদ দেখা যাবে।', '{}', false, 50),
  ('notices',     'নোটিশ',
   'নতুন নোটিশ পাঠানো বন্ধ হবে। আগের নোটিশ পড়া যাবে।', '{}', true, 60),
  -- SMS and push are the two DELIVERY channels a notice uses. Turning off
  -- notices does not turn them off — an absence SMS is not a notice — but
  -- turning off notices while claiming an SMS went is exactly §10's third
  -- forbidden state, so the dependency is declared the other way round.
  ('sms',         'এসএমএস',
   'কোনো এসএমএস পাঠানো হবে না — হাজিরার বার্তা ও লগইন কোড সহ। '
   || 'অ্যাপের নোটিফিকেশন চালু থাকবে।', '{}', false, 70),
  ('push',        'নোটিফিকেশন',
   'অ্যাপে কোনো নোটিফিকেশন যাবে না। এসএমএস চালু থাকলে সেটি যাবে।', '{}', false, 80),
  ('calendar',    'শিক্ষাপঞ্জি',
   'ছুটি ও পরীক্ষার সূচি যোগ করা বন্ধ হবে। বর্তমান পঞ্জি দেখা যাবে।', '{}', true, 90),
  ('documents',   'নথি ও ছাপা',
   'রসিদ, প্রগতি পত্র ও প্রবেশপত্র ছাপা বন্ধ হবে।', '{documents_source}', false, 100),
  ('imports',     'আমদানি',
   'CSV থেকে শিক্ষার্থী বা শিক্ষক যোগ করা বন্ধ হবে।', '{}', false, 110),
  ('reports',     'রিপোর্ট',
   'বিশ্লেষণ ও রিপোর্ট দেখা বন্ধ হবে।', '{}', false, 120),
  ('ai',          'AI সহায়ক',
   'শিক্ষক সহায়ক ও শিখো টিউটর বন্ধ হবে।', '{}', false, 130)
ON CONFLICT (code) DO UPDATE
  SET name_bn = EXCLUDED.name_bn,
      effect_bn = EXCLUDED.effect_bn,
      in_limited = EXCLUDED.in_limited,
      sort_order = EXCLUDED.sort_order;

-- `documents` was declared as depending on a code that does not exist, which
-- is the sort of thing a catalogue should not be able to say. Clear it here
-- rather than shipping a dangling dependency.
UPDATE service_catalogue SET depends_on = '{}' WHERE code = 'documents';

-- ── 6. Seed plans ────────────────────────────────────────────────────────
--
-- `starter` is the default `tenants.plan_code` has had since 001, and
-- `pilot` is what `app.create_tenant` defaults to. Both must exist or the
-- foreign key below would orphan every existing school.
INSERT INTO plans (code, name_bn, price_bdt, billing_cycle, student_cap, trial_days, grace_days, services) VALUES
  ('pilot',   'পাইলট',        0,     'yearly',  500,  90, 30,
   '{"attendance":true,"results":true,"assignments":true,"learning":true,"notices":true,"push":true,"calendar":true,"documents":true,"imports":true,"reports":true}'),
  ('starter', 'স্টার্টার',     25000, 'yearly',  500,  30, 14,
   '{"attendance":true,"results":true,"assignments":true,"learning":true,"notices":true,"sms":true,"push":true,"calendar":true,"documents":true,"imports":true,"reports":true}'),
  ('standard','স্ট্যান্ডার্ড',  60000, 'yearly', 1500,  30, 14,
   '{"attendance":true,"results":true,"assignments":true,"learning":true,"finance":true,"notices":true,"sms":true,"push":true,"calendar":true,"documents":true,"imports":true,"reports":true}'),
  ('complete','সম্পূর্ণ',      120000,'yearly', 5000,  30, 14,
   '{"attendance":true,"results":true,"assignments":true,"learning":true,"finance":true,"notices":true,"sms":true,"push":true,"calendar":true,"documents":true,"imports":true,"reports":true,"ai":true}')
ON CONFLICT (code) DO NOTHING;

-- Any plan_code in use that is not in the catalogue becomes a real row rather
-- than being rewritten — a school's plan is not ours to change silently.
INSERT INTO plans (code, name_bn, price_bdt, student_cap)
SELECT DISTINCT t.plan_code,
       t.plan_code,
       0,
       COALESCE(t.student_cap, 500)
FROM tenants t
WHERE t.plan_code IS NOT NULL
  AND t.plan_code ~ '^[a-z][a-z0-9_]{1,30}$'
  AND NOT EXISTS (SELECT 1 FROM plans p WHERE p.code = t.plan_code)
ON CONFLICT (code) DO NOTHING;

COMMIT;
