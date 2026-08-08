-- ============================================================================
-- 017 — Course content model.
--
-- The missing entity everything in the V2 roadmap depends on. Before this
-- migration the schema had assessment (exams, marks), scheduling (routines)
-- and billing (invoices) but NOTHING representing the material a student
-- actually learns from — which is why no student-facing screen could exist.
--
-- Shape follows the NCTB reality rather than a generic LMS course model:
--
--   subjects (existing, per tenant)
--     └── chapters      — an NCTB textbook chapter ("অধ্যায় ৫: গতি")
--           └── lessons — a teachable unit inside it, one sitting
--                 └── lesson_blocks — the ordered content pieces
--
-- Deliberately NOT built here:
--   * No "course" entity. In an NCTB school a student doesn't enrol in
--     courses — they're in a class, and the class determines the subjects.
--     `enrolments` (003) already models that. Adding courses on top would
--     duplicate the real relationship and create two sources of truth.
--   * No content authoring workflow/versioning yet. Chapters and lessons
--     are seeded per tenant from the NCTB structure; teacher authoring is
--     a later increment.
--
-- lesson_progress is per (student, lesson) and is what makes a student's
-- "what should I study next" answerable at all. It's written through the
-- offline outbox like attendance, so a student reading a lesson on a bus
-- with no signal still records progress.
-- ============================================================================
BEGIN;

-- ---------------------------------------------------------------------
-- Chapters — mirrors the NCTB textbook table of contents.
-- ---------------------------------------------------------------------
CREATE TABLE chapters (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  subject_id     uuid NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  class_id       uuid NOT NULL REFERENCES classes(id) ON DELETE CASCADE,

  chapter_no     smallint NOT NULL,
  name_bn        text NOT NULL,                    -- 'অধ্যায় ৫: গতি'
  name_en        text,
  summary_bn     text,

  -- Prerequisite is a FLAT self-reference, not a graph. docs strategy §13:
  -- a full knowledge graph is V3 work that needs real assessment data to
  -- infer edges from. One honest "you should read this first" pointer is
  -- what's actually useful today, and it upgrades cleanly later.
  prerequisite_chapter_id uuid REFERENCES chapters(id) ON DELETE SET NULL,

  -- Rough teaching time, used to pace "what should I study next".
  est_minutes    smallint NOT NULL DEFAULT 40 CHECK (est_minutes > 0),
  display_order  smallint NOT NULL DEFAULT 0,
  is_published   boolean NOT NULL DEFAULT false,

  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, subject_id, class_id, chapter_no)
);
CREATE INDEX ix_chapters_browse ON chapters (tenant_id, class_id, subject_id, display_order)
  WHERE is_published;
CREATE TRIGGER trg_chapter_tenant BEFORE INSERT OR UPDATE ON chapters
  FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant();
CREATE TRIGGER trg_chapter_touch BEFORE UPDATE ON chapters
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

COMMENT ON COLUMN chapters.prerequisite_chapter_id IS
  'Flat single-parent prerequisite. Intentionally not a graph — see the '
  'file header. Upgrading to a real DAG is a later migration once there '
  'is assessment data to infer edges from.';

-- ---------------------------------------------------------------------
-- Lessons — one sitting's worth of a chapter.
-- ---------------------------------------------------------------------
CREATE TABLE lessons (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  chapter_id     uuid NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,

  lesson_no      smallint NOT NULL,
  title_bn       text NOT NULL,
  title_en       text,
  est_minutes    smallint NOT NULL DEFAULT 15 CHECK (est_minutes > 0),
  display_order  smallint NOT NULL DEFAULT 0,
  is_published   boolean NOT NULL DEFAULT false,

  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, chapter_id, lesson_no)
);
CREATE INDEX ix_lessons_chapter ON lessons (tenant_id, chapter_id, display_order)
  WHERE is_published;
CREATE TRIGGER trg_lesson_tenant BEFORE INSERT OR UPDATE ON lessons
  FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant();
CREATE TRIGGER trg_lesson_touch BEFORE UPDATE ON lessons
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- ---------------------------------------------------------------------
-- Lesson blocks — the ordered content of a lesson.
--
-- Typed blocks rather than one HTML blob: the PWA renders each kind with
-- its own component, and a 2G client can skip fetching `image`/`video`
-- bodies under the existing data-saver policy while still showing the
-- text. An HTML blob would make that impossible.
-- ---------------------------------------------------------------------
CREATE TYPE lesson_block_kind AS ENUM
  ('text', 'image', 'video', 'formula', 'example', 'key_point', 'practice_prompt');

CREATE TABLE lesson_blocks (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lesson_id      uuid NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,

  block_no       smallint NOT NULL,
  kind           lesson_block_kind NOT NULL DEFAULT 'text',
  -- Plain text/markdown for text-ish kinds; object key for media kinds.
  body_bn        text,
  media_key      text,
  alt_text_bn    text,                             -- required for image a11y
  caption_bn     text,

  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, lesson_id, block_no),
  -- An image/video block is meaningless without its object key, and a
  -- text block without a body is an empty paragraph. Enforce both.
  CHECK (
    (kind IN ('image','video') AND media_key IS NOT NULL)
    OR (kind NOT IN ('image','video') AND body_bn IS NOT NULL)
  ),
  -- WCAG: an image without alt text is a defect, not a style choice.
  CHECK (kind <> 'image' OR alt_text_bn IS NOT NULL)
);
CREATE INDEX ix_blocks_lesson ON lesson_blocks (tenant_id, lesson_id, block_no);
CREATE TRIGGER trg_block_tenant BEFORE INSERT OR UPDATE ON lesson_blocks
  FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant();

-- ---------------------------------------------------------------------
-- Lesson progress — per student, per lesson.
--
-- `id` is the client-generated UUIDv7 outbox opId, same contract as
-- attendance_sessions and answer_scripts: a student reading offline
-- queues progress locally and it syncs later, idempotently.
-- ---------------------------------------------------------------------
CREATE TABLE lesson_progress (
  id             uuid PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lesson_id      uuid NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  student_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  state          text NOT NULL DEFAULT 'started'
                   CHECK (state IN ('started','completed')),
  -- Seconds of genuine reading time, accumulated client-side. Capped on
  -- write so a tab left open overnight can't claim 8 hours of study.
  seconds_spent  integer NOT NULL DEFAULT 0
                   CHECK (seconds_spent >= 0 AND seconds_spent <= 14400),
  last_block_no  smallint,                         -- resume point
  started_at     timestamptz NOT NULL DEFAULT now(),
  completed_at   timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, lesson_id, student_id),
  CHECK (state <> 'completed' OR completed_at IS NOT NULL)
);
CREATE INDEX ix_progress_student ON lesson_progress (tenant_id, student_id, updated_at DESC);
CREATE INDEX ix_progress_lesson ON lesson_progress (tenant_id, lesson_id, state);
CREATE TRIGGER trg_progress_tenant BEFORE INSERT OR UPDATE ON lesson_progress
  FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant();
CREATE TRIGGER trg_progress_touch BEFORE UPDATE ON lesson_progress
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- ---------------------------------------------------------------------
-- RLS.
--
-- The generic tenant_isolation policy is applied by the loop below (same
-- one 010 uses for every tenant-scoped table). On top of that:
--
--   * content (chapters/lessons/blocks) — every role in the tenant may
--     READ published content; only academic staff may write. Unpublished
--     content is staff-only, so a half-written lesson never leaks.
--   * lesson_progress — a student sees only their own; guardians see
--     their wards'; teachers see their sections'. That's exactly
--     app.can_see_student(), already defined in 010.
-- ---------------------------------------------------------------------
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT c.oid::regclass AS tbl
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
      AND c.relname IN ('chapters','lessons','lesson_blocks','lesson_progress')
      AND NOT EXISTS (SELECT 1 FROM pg_policy p
                      WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation')
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', r.tbl);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', r.tbl);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %s
        AS PERMISSIVE FOR ALL TO shikhon_app
        USING (app.tenant_guard(tenant_id))
        WITH CHECK (app.tenant_guard(tenant_id))
    $f$, r.tbl);
  END LOOP;
END $$;

-- Unpublished content is invisible to non-staff.
CREATE POLICY chapter_read_scope ON chapters
  AS RESTRICTIVE FOR SELECT TO shikhon_app
  USING (is_published OR app.has_role('principal','school_owner','academic_coordinator','dept_head','class_teacher','subject_teacher'));

CREATE POLICY chapter_write_scope ON chapters
  AS RESTRICTIVE FOR ALL TO shikhon_app
  USING (app.has_role('principal','school_owner','academic_coordinator','dept_head','subject_teacher'))
  WITH CHECK (app.has_role('principal','school_owner','academic_coordinator','dept_head','subject_teacher'));

CREATE POLICY lesson_read_scope ON lessons
  AS RESTRICTIVE FOR SELECT TO shikhon_app
  USING (is_published OR app.has_role('principal','school_owner','academic_coordinator','dept_head','class_teacher','subject_teacher'));

CREATE POLICY lesson_write_scope ON lessons
  AS RESTRICTIVE FOR ALL TO shikhon_app
  USING (app.has_role('principal','school_owner','academic_coordinator','dept_head','subject_teacher'))
  WITH CHECK (app.has_role('principal','school_owner','academic_coordinator','dept_head','subject_teacher'));

CREATE POLICY block_read_scope ON lesson_blocks
  AS RESTRICTIVE FOR SELECT TO shikhon_app
  USING (
    EXISTS (SELECT 1 FROM lessons l WHERE l.id = lesson_blocks.lesson_id AND l.is_published)
    OR app.has_role('principal','school_owner','academic_coordinator','dept_head','class_teacher','subject_teacher')
  );

CREATE POLICY block_write_scope ON lesson_blocks
  AS RESTRICTIVE FOR ALL TO shikhon_app
  USING (app.has_role('principal','school_owner','academic_coordinator','dept_head','subject_teacher'))
  WITH CHECK (app.has_role('principal','school_owner','academic_coordinator','dept_head','subject_teacher'));

-- A student's reading history is personal data. Same visibility rule as
-- attendance and marks: yourself, your wards, or your sections.
CREATE POLICY progress_read_scope ON lesson_progress
  AS RESTRICTIVE FOR SELECT TO shikhon_app
  USING (app.can_see_student(student_id));

-- Only the student themselves may write their own progress. A teacher
-- cannot mark a lesson read on a student's behalf — that would make the
-- "what should I study next" signal a fiction.
CREATE POLICY progress_write_scope ON lesson_progress
  AS RESTRICTIVE FOR ALL TO shikhon_app
  USING (student_id = app.current_user_id())
  WITH CHECK (student_id = app.current_user_id());

COMMIT;
