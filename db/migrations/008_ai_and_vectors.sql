-- =====================================================================
-- 008_ai_and_vectors.sql
-- NCTB RAG corpus (pgvector), SikhokAI / ShikhoAI session logs,
-- guardrail audit, per-tenant token budgeting.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- NCTB curriculum corpus — platform-global, NOT tenant-scoped.
-- The textbooks are the same for every school; duplicating 40M embeddings
-- per tenant would be absurd. Tenant-authored content lives in
-- question_items.embedding instead (005).
-- ---------------------------------------------------------------------
CREATE TABLE nctb_documents (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title_bn       text NOT NULL,
  title_en       text NOT NULL,
  stream         institution_stream NOT NULL,
  class_level    smallint NOT NULL CHECK (class_level BETWEEN 1 AND 12),
  subject_code   varchar(8),
  subject_name_en text NOT NULL,
  language       text NOT NULL CHECK (language IN ('bn','en')),
  curriculum_year smallint NOT NULL,              -- NCTB revises; old cohorts keep old books
  edition        text,
  source_uri     text,
  page_count     integer,
  ingested_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (stream, class_level, subject_code, language, curriculum_year)
);

CREATE TABLE nctb_chunks (
  id             bigserial PRIMARY KEY,
  document_id    uuid NOT NULL REFERENCES nctb_documents(id) ON DELETE CASCADE,
  chapter_no     smallint,
  chapter_title  text,
  section_path   text,                            -- 'ch5 > 5.2 > নিউটনের দ্বিতীয় সূত্র'
  page_from      integer,
  page_to        integer,
  ordinal        integer NOT NULL,
  content        text NOT NULL,
  token_count    smallint NOT NULL,
  -- Denormalised filter columns: the hard metadata filter runs BEFORE the
  -- vector search, so a Class 9 query can never retrieve a Class 11 chunk.
  class_level    smallint NOT NULL,
  subject_code   varchar(8),
  stream         institution_stream NOT NULL,
  language       text NOT NULL,
  embedding      vector(1024) NOT NULL,
  content_tsv    tsvector,
  UNIQUE (document_id, ordinal)
);

-- Hybrid retrieval needs both an ANN index and a lexical index.
CREATE INDEX ix_nctb_chunks_hnsw ON nctb_chunks
  USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
CREATE INDEX ix_nctb_chunks_filter ON nctb_chunks
  (class_level, subject_code, stream, language, chapter_no);
CREATE INDEX ix_nctb_chunks_fts ON nctb_chunks USING gin (content_tsv);

-- Bangla full-text: 'simple' config avoids English stemming mangling Bangla.
CREATE OR REPLACE FUNCTION app.nctb_chunk_tsv() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.content_tsv := to_tsvector(
    CASE WHEN NEW.language = 'en' THEN 'english' ELSE 'simple' END::regconfig,
    NEW.content);
  RETURN NEW;
END $$;

CREATE TRIGGER trg_nctb_tsv BEFORE INSERT OR UPDATE OF content, language
  ON nctb_chunks FOR EACH ROW EXECUTE FUNCTION app.nctb_chunk_tsv();

COMMENT ON INDEX ix_nctb_chunks_filter IS
  'The metadata filter is applied BEFORE the HNSW search, not after. Retrieving an '
  'out-of-syllabus chunk destroys teacher trust in one shot, so scope is a hard bound.';

-- ---------------------------------------------------------------------
-- AI sessions and turns. Partitioned monthly, 12-month retention under
-- PDPA data-minimisation.
-- ---------------------------------------------------------------------
CREATE TYPE ai_engine AS ENUM ('sikhok','shikho');

CREATE TABLE ai_sessions (
  id             uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  started_on     date NOT NULL DEFAULT CURRENT_DATE,
  engine         ai_engine NOT NULL,
  user_id        uuid NOT NULL,
  user_role      text NOT NULL,
  -- Scope bounds enforced on every retrieval in this session
  class_id       uuid,
  subject_id     uuid,
  chapter_no     smallint,
  locale         text NOT NULL DEFAULT 'bn' CHECK (locale IN ('bn','en','bn-latn')),
  task_type      text,                            -- 'generate_cq' | 'lesson_plan' | 'tutor_chat'
  model          text NOT NULL,
  input_tokens   integer NOT NULL DEFAULT 0,
  output_tokens  integer NOT NULL DEFAULT 0,
  cost_usd       numeric(10,6) NOT NULL DEFAULT 0,
  turn_count     smallint NOT NULL DEFAULT 0,
  ended_at       timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, started_on, id)
) PARTITION BY RANGE (started_on);

CREATE TABLE ai_sessions_2026_08 PARTITION OF ai_sessions
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE ai_sessions_default PARTITION OF ai_sessions DEFAULT;

CREATE INDEX ix_ai_sessions_user ON ai_sessions (tenant_id, user_id, created_at DESC);
CREATE INDEX ix_ai_sessions_cost ON ai_sessions (tenant_id, started_on) INCLUDE (cost_usd);
CREATE TRIGGER trg_ai_sess_tenant BEFORE INSERT OR UPDATE ON ai_sessions
  FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant();

CREATE TABLE ai_turns (
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  created_on      date NOT NULL DEFAULT CURRENT_DATE,
  session_id      uuid NOT NULL,
  turn_no         smallint NOT NULL,
  role            text NOT NULL CHECK (role IN ('user','assistant','system','tool')),
  -- Stored POST-redaction. Direct identifiers are pseudonymised before they
  -- leave the BD VPC and are never written here in the clear.
  content_redacted text NOT NULL,
  retrieved_chunk_ids bigint[],
  grounding_ok    boolean,                        -- did every claim cite a retrieved chunk?
  guardrail_flags text[],                         -- {answer_leak, out_of_scope, safeguarding}
  latency_ms      integer,
  input_tokens    integer,
  output_tokens   integer,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, created_on, id)
) PARTITION BY RANGE (created_on);

CREATE TABLE ai_turns_2026_08 PARTITION OF ai_turns
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE ai_turns_default PARTITION OF ai_turns DEFAULT;

CREATE INDEX ix_ai_turns_session ON ai_turns (tenant_id, session_id, turn_no);
CREATE INDEX ix_ai_turns_flagged ON ai_turns (tenant_id, created_on)
  WHERE guardrail_flags IS NOT NULL AND array_length(guardrail_flags, 1) > 0;
CREATE TRIGGER trg_ai_turns_tenant BEFORE INSERT OR UPDATE ON ai_turns
  FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant();

-- ---------------------------------------------------------------------
-- Safeguarding escalations — self-harm, abuse disclosure, cheating signals.
-- Routed to the Principal only. Never auto-forwarded to guardians: a
-- disclosure about the home is not something to SMS to the home.
-- ---------------------------------------------------------------------
CREATE TABLE ai_safeguarding_flags (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id    uuid NOT NULL,
  student_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category      text NOT NULL CHECK (category IN
                  ('self_harm','abuse_disclosure','bullying','exam_misconduct','other')),
  severity      smallint NOT NULL CHECK (severity BETWEEN 1 AND 5),
  excerpt_redacted text,
  status        text NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open','reviewing','actioned','dismissed')),
  reviewed_by   uuid REFERENCES users(id),
  reviewed_at   timestamptz,
  action_notes  text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_safeguard_open ON ai_safeguarding_flags (tenant_id, severity DESC, created_at DESC)
  WHERE status IN ('open','reviewing');
CREATE TRIGGER trg_safeguard_tenant BEFORE INSERT OR UPDATE ON ai_safeguarding_flags
  FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant();

-- ---------------------------------------------------------------------
-- Token budget ledger — the gateway decrements a Redis bucket in the hot
-- path and reconciles here nightly. At 100% SikhokAI falls back to template
-- generation and ShikhoAI to cached explanations. No surprise invoices.
-- ---------------------------------------------------------------------
CREATE TABLE ai_budget_periods (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  period_month    date NOT NULL,                  -- first of month
  token_budget    bigint NOT NULL,
  tokens_used     bigint NOT NULL DEFAULT 0,
  cost_usd        numeric(10,4) NOT NULL DEFAULT 0,
  soft_limit_notified_at timestamptz,
  hard_limit_hit_at      timestamptz,
  UNIQUE (tenant_id, period_month)
);
CREATE TRIGGER trg_aibudget_tenant BEFORE INSERT OR UPDATE ON ai_budget_periods
  FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant();

-- ---------------------------------------------------------------------
-- Offline explanation pack — pre-written Bangla explanations shipped to
-- IndexedDB so ShikhoAI degrades to something useful without a network.
-- ---------------------------------------------------------------------
CREATE TABLE offline_explanation_packs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  class_level   smallint NOT NULL,
  subject_code  varchar(8) NOT NULL,
  chapter_no    smallint NOT NULL,
  language      text NOT NULL DEFAULT 'bn',
  version       integer NOT NULL DEFAULT 1,
  payload       jsonb NOT NULL,                   -- [{q, a, keywords[]}] — target ≤ 40 KB
  byte_size     integer NOT NULL,
  published_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (class_level, subject_code, chapter_no, language, version)
);

-- ---------------------------------------------------------------------
-- Retrieval helper: hard metadata filter, then ANN. Reciprocal-rank fusion
-- with the lexical arm happens in ai-gateway.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.nctb_retrieve(
  p_embedding    vector(1024),
  p_class_level  smallint,
  p_subject_code varchar(8),
  p_stream       institution_stream,
  p_language     text,
  p_chapter_no   smallint DEFAULT NULL,
  p_limit        integer  DEFAULT 40
) RETURNS TABLE (chunk_id bigint, content text, section_path text, distance real)
LANGUAGE sql STABLE AS $$
  SELECT c.id, c.content, c.section_path,
         (c.embedding <=> p_embedding)::real
  FROM nctb_chunks c
  WHERE c.class_level  = p_class_level
    AND c.stream       = p_stream
    AND c.language     = p_language
    AND (p_subject_code IS NULL OR c.subject_code = p_subject_code)
    AND (p_chapter_no   IS NULL OR c.chapter_no   = p_chapter_no)
  ORDER BY c.embedding <=> p_embedding
  LIMIT p_limit;
$$;

COMMIT;
