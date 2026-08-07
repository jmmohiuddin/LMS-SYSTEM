-- =====================================================================
-- db/tests/schema_lint.sql
--
-- Structural gate. Enforces the invariants that must hold for EVERY table,
-- present and future — the "every new table has RLS enabled, forced, and a
-- policy" line in the Definition of Done (docs/05-DELIVERY-ROADMAP.md §7).
--
-- Hard failures raise. Advisory findings are reported as NOTICEs.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/schema_lint.sql
-- =====================================================================

\set ON_ERROR_STOP on

-- One transaction so the ON COMMIT DROP temp tables survive to the end.
BEGIN;

-- ---------------------------------------------------------------------
-- Tables intentionally exempt from tenant scoping (platform-global
-- reference data). Anything NOT listed here that lacks tenant_id is a
-- lint failure — that is how an accidentally un-scoped table gets caught.
-- ---------------------------------------------------------------------
CREATE TEMP TABLE lint_global_exempt(relname text) ON COMMIT DROP;
INSERT INTO lint_global_exempt VALUES
  ('tenants'),                     -- the tenant registry itself (own policy)
  ('roles'), ('permissions'), ('role_permissions'),
  ('nctb_documents'), ('nctb_chunks'), ('offline_explanation_packs'),
  ('subject_catalogue'), ('period_template_defaults'),
  ('partition_config'),
  ('alumni_profile_enrichment');   -- keyed by global_person_id, may outlive the tenant link

-- ---------------------------------------------------------------------
-- Tables whose tenant_id is nullable BY DESIGN (written before a tenant
-- context exists). Each must carry the pre_tenant_ingest policy.
-- ---------------------------------------------------------------------
CREATE TEMP TABLE lint_pre_tenant(relname text) ON COMMIT DROP;
INSERT INTO lint_pre_tenant VALUES
  ('mfs_webhook_events'), ('ans_inbound_events'), ('otp_challenges'),
  ('ans_endpoints'), ('alumni_profile_enrichment');

DO $$
DECLARE
  r        RECORD;
  failures text[] := '{}';
  advisory integer := 0;
BEGIN
  -- ── L1: every non-exempt public table must carry tenant_id ─────────
  FOR r IN
    SELECT c.relname
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
      AND NOT c.relispartition
      AND c.relname NOT IN (SELECT relname FROM lint_global_exempt)
      AND NOT EXISTS (SELECT 1 FROM pg_attribute a
                      WHERE a.attrelid = c.oid AND a.attname = 'tenant_id'
                        AND a.attnum > 0 AND NOT a.attisdropped)
    ORDER BY 1
  LOOP
    failures := failures || format('L1 %s: no tenant_id column and not in the exempt list', r.relname);
  END LOOP;

  -- ── L2: every tenant table must have RLS ENABLED and FORCED ────────
  FOR r IN
    SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
      AND EXISTS (SELECT 1 FROM pg_attribute a
                  WHERE a.attrelid = c.oid AND a.attname = 'tenant_id'
                    AND a.attnum > 0 AND NOT a.attisdropped)
      AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity)
    ORDER BY 1
  LOOP
    failures := failures || format('L2 %s: RLS enabled=%s forced=%s (both must be true)',
                                   r.relname, r.relrowsecurity, r.relforcerowsecurity);
  END LOOP;

  -- ── L3: every tenant table must have at least one policy ───────────
  FOR r IN
    SELECT c.relname
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
      AND EXISTS (SELECT 1 FROM pg_attribute a
                  WHERE a.attrelid = c.oid AND a.attname = 'tenant_id'
                    AND a.attnum > 0 AND NOT a.attisdropped)
      AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid)
    ORDER BY 1
  LOOP
    failures := failures || format('L3 %s: has tenant_id but no RLS policy', r.relname);
  END LOOP;

  -- ── L4: tenant_id must be NOT NULL unless explicitly pre-tenant ────
  FOR r IN
    SELECT c.relname
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
    WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND NOT c.relispartition
      AND NOT a.attnotnull
      AND c.relname NOT IN (SELECT relname FROM lint_pre_tenant)
    ORDER BY 1
  LOOP
    failures := failures || format('L4 %s: tenant_id is nullable but not declared pre-tenant', r.relname);
  END LOOP;

  -- ── L5: pre-tenant tables must carry the ingest policy ─────────────
  FOR r IN
    SELECT pt.relname FROM lint_pre_tenant pt
    JOIN pg_class c ON c.relname = pt.relname
    JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
    WHERE NOT EXISTS (SELECT 1 FROM pg_policy p
                      WHERE p.polrelid = c.oid AND p.polname = 'pre_tenant_ingest')
    ORDER BY 1
  LOOP
    failures := failures || format('L5 %s: declared pre-tenant but missing pre_tenant_ingest policy', r.relname);
  END LOOP;

  -- ── L6: every partitioned table needs a DEFAULT partition ──────────
  FOR r IN
    SELECT c.relname
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'p'
      AND NOT EXISTS (
        SELECT 1 FROM pg_inherits i JOIN pg_class ch ON ch.oid = i.inhrelid
        WHERE i.inhparent = c.oid
          AND pg_get_expr(ch.relpartbound, ch.oid) = 'DEFAULT')
    ORDER BY 1
  LOOP
    failures := failures || format('L6 %s: partitioned table has no DEFAULT partition', r.relname);
  END LOOP;

  -- ── L8: every tenant table must have an FK to tenants ──────────────
  --     Without it, deleting a tenant silently orphans rows: RLS hides them
  --     forever but they stay on disk, which breaks PDPA 2026 erasure.
  --     This was a live defect — 196 orphaned attendance_records and 613
  --     sync_change_log rows survived a tenant DELETE before migration 013.
  FOR r IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
    WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND NOT c.relispartition
      AND c.relname <> 'tenants'
      AND NOT EXISTS (
        SELECT 1 FROM pg_constraint k
        WHERE k.conrelid = c.oid AND k.contype = 'f'
          AND k.confrelid = 'tenants'::regclass
          AND a.attnum = ANY(k.conkey))
    ORDER BY 1
  LOOP
    failures := failures || format(
      'L8 %s: tenant_id has no FK to tenants — deletion would orphan its rows', r.relname);
  END LOOP;

  -- ── L7 (advisory): multi-column btree LOOKUP indexes on tenant tables
  --     should lead with tenant_id, because RLS injects `tenant_id = …`
  --     into every plan and a leading match turns a filter into a seek.
  --
  --     Deliberately NOT flagged:
  --       * primary keys — surrogate uuid PKs are point lookups by id
  --       * single-column indexes — nothing to reorder
  --       * BRIN / GIN / GiST / HNSW — not b-tree seeks; column order is
  --         irrelevant to how they are scanned
  --       * globally-unique keys that must be unique ACROSS tenants
  --         (gateway transaction ids, ANS delivery ids, refresh tokens)
  FOR r IN
    SELECT c.relname AS tbl, i.relname AS idx
    FROM pg_index x
    JOIN pg_class i ON i.oid = x.indexrelid
    JOIN pg_class c ON c.oid = x.indrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_am am ON am.oid = i.relam
    WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND NOT c.relispartition
      AND EXISTS (SELECT 1 FROM pg_attribute a
                  WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
      AND am.amname = 'btree'
      AND NOT x.indisprimary
      AND x.indnkeyatts > 1
      AND (SELECT a.attname FROM pg_attribute a
           WHERE a.attrelid = c.oid AND a.attnum = x.indkey[0]) IS DISTINCT FROM 'tenant_id'
      AND i.relname NOT IN (
        'uq_users_global_person','uq_mfs_gateway_trx','uq_ans_delivery',
        'uq_sms_dedupe','uq_session_refresh','ix_ans_retry','uq_ans_inbound',
        'uq_webhook_event','ix_webhook_unprocessed','ix_webhook_rejected',
        'ix_event_outbox_unpublished','ix_otp_lookup','ix_alumni_person')
    ORDER BY 1,2
  LOOP
    RAISE NOTICE 'ADVISORY L7 %.%: index does not lead with tenant_id', r.tbl, r.idx;
    advisory := advisory + 1;
  END LOOP;

  -- ── Report ─────────────────────────────────────────────────────────
  IF array_length(failures, 1) > 0 THEN
    RAISE EXCEPTION E'schema lint failed with % problem(s):\n  %',
      array_length(failures, 1), array_to_string(failures, E'\n  ');
  END IF;

  RAISE NOTICE 'PASS schema lint — L1..L6, L8 clean (% advisory L7 note(s))', advisory;
END $$;

COMMIT;
