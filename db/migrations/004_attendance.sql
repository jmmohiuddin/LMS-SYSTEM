-- =====================================================================
-- 004_attendance.sql
-- Attendance sessions + partitioned records + guardian SMS outbox.
--
-- Design notes
--  * attendance_records is RANGE-partitioned by taken_on (monthly). At the
--    target scale (~150M rows/year) an unpartitioned table makes the daily
--    "absent students" scan and the 5-year retention purge both painful.
--  * The (tenant_id, session_id, student_id) natural key is enforced through
--    the primary key, which must include the partition key.
--  * Absence SMS is NOT sent inline. A record lands in sms_outbox; a worker
--    debounces per student per day, respects holidays and the tenant cap.
-- =====================================================================

BEGIN;

CREATE TYPE attendance_status AS ENUM ('present','absent','late','excused','half_day');
CREATE TYPE attendance_mode   AS ENUM ('section_daily','period_wise');

-- ---------------------------------------------------------------------
-- A session = one act of taking attendance. Created by the teacher's
-- device (id is a client UUIDv7) so the offline flow needs no round trip.
-- ---------------------------------------------------------------------
CREATE TABLE attendance_sessions (
  id                uuid PRIMARY KEY,                      -- client-generated UUIDv7
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  section_id        uuid NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  academic_year_id  uuid NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
  routine_slot_id   uuid,                                  -- FK added in 006
  subject_id        uuid REFERENCES subjects(id),
  taken_on          date NOT NULL,
  period_no         smallint,                              -- NULL for section_daily
  mode              attendance_mode NOT NULL DEFAULT 'section_daily',
  taken_by          uuid NOT NULL REFERENCES users(id),
  taken_at          timestamptz NOT NULL,                  -- client clock, skew-corrected
  device_id         text,
  synced_at         timestamptz NOT NULL DEFAULT now(),
  is_locked         boolean NOT NULL DEFAULT false,        -- set once the SMS batch has fired
  present_count     smallint NOT NULL DEFAULT 0,
  absent_count      smallint NOT NULL DEFAULT 0,
  late_count        smallint NOT NULL DEFAULT 0,
  row_version       integer NOT NULL DEFAULT 1,
  -- NULLS NOT DISTINCT is essential, not decorative: period_no is NULL for
  -- the 'section_daily' mode, which is the common case. Under the default
  -- NULLS DISTINCT, two daily sessions for the same section on the same day
  -- would BOTH be accepted, and every guardian would get a second absence SMS.
  -- Requires PostgreSQL 15+.
  CONSTRAINT uq_attendance_session
    UNIQUE NULLS NOT DISTINCT (tenant_id, section_id, taken_on, period_no, mode)
);
CREATE INDEX ix_att_session_day    ON attendance_sessions (tenant_id, taken_on DESC, section_id);
CREATE INDEX ix_att_session_taker  ON attendance_sessions (tenant_id, taken_by, taken_on DESC);
CREATE TRIGGER trg_att_session_tenant BEFORE INSERT OR UPDATE ON attendance_sessions
  FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant();

COMMENT ON CONSTRAINT uq_attendance_session ON attendance_sessions IS
  'Prevents two teachers double-taking attendance for the same section/period/day. '
  'On the offline path the server upserts against this key, so a duplicate submission '
  'from a re-installed device merges instead of duplicating.';

-- ---------------------------------------------------------------------
-- Records — partitioned monthly
-- ---------------------------------------------------------------------
CREATE TABLE attendance_records (
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  session_id    uuid NOT NULL,
  student_id    uuid NOT NULL,
  section_id    uuid NOT NULL,
  taken_on      date NOT NULL,
  status        attendance_status NOT NULL,
  minutes_late  smallint,
  remark        text,
  marked_by     uuid NOT NULL,
  marked_at     timestamptz NOT NULL,
  -- Offline provenance
  op_id         uuid,                                   -- links to sync_operations
  device_id     text,
  -- SMS lifecycle for this specific absence
  sms_state     text NOT NULL DEFAULT 'not_applicable'
                  CHECK (sms_state IN ('not_applicable','queued','sent','failed','suppressed')),
  row_version   integer NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, taken_on, session_id, student_id)
) PARTITION BY RANGE (taken_on);

-- Seed partitions. pg_partman (or the maintenance job in 011) rolls these forward.
CREATE TABLE attendance_records_2026_08 PARTITION OF attendance_records
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE attendance_records_2026_09 PARTITION OF attendance_records
  FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE attendance_records_2026_10 PARTITION OF attendance_records
  FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE attendance_records_default PARTITION OF attendance_records DEFAULT;

-- Guardian dashboard: "my child's attendance this month" — index-only.
CREATE INDEX ix_att_rec_student
  ON attendance_records (tenant_id, student_id, taken_on DESC) INCLUDE (status);

-- Absence sweep for the SMS worker: partial, so it stays tiny.
CREATE INDEX ix_att_rec_absent_pending
  ON attendance_records (tenant_id, taken_on, student_id)
  WHERE status IN ('absent','late') AND sms_state = 'queued';

-- Section report: BRIN on the time column is ~200x smaller than a B-tree here.
CREATE INDEX ix_att_rec_brin ON attendance_records USING brin (taken_on)
  WITH (pages_per_range = 32);

CREATE TRIGGER trg_att_rec_tenant BEFORE INSERT OR UPDATE ON attendance_records
  FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant();

-- ---------------------------------------------------------------------
-- Corrections — a present→absent flip AFTER the SMS has gone out must not
-- silently mutate history. The original record stands; a correction row
-- records what changed, who approved it, and why.
-- ---------------------------------------------------------------------
CREATE TABLE attendance_corrections (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id    uuid NOT NULL,
  student_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  taken_on      date NOT NULL,
  old_status    attendance_status NOT NULL,
  new_status    attendance_status NOT NULL,
  reason        text NOT NULL,
  requested_by  uuid NOT NULL REFERENCES users(id),
  approved_by   uuid REFERENCES users(id),
  approved_at   timestamptz,
  sms_already_sent boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_att_corr_pending ON attendance_corrections (tenant_id, created_at DESC)
  WHERE approved_at IS NULL;
CREATE TRIGGER trg_att_corr_tenant BEFORE INSERT OR UPDATE ON attendance_corrections
  FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant();

-- ---------------------------------------------------------------------
-- SMS outbox — every outbound message, partitioned monthly, 90-day retention.
-- ---------------------------------------------------------------------
CREATE TABLE sms_outbox (
  id             uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  created_on     date NOT NULL DEFAULT CURRENT_DATE,
  recipient_id   uuid,                          -- guardian/user; NULL for bulk
  msisdn         varchar(16) NOT NULL,
  template_code  text NOT NULL,                 -- 'attendance.absent.v2'
  locale         text NOT NULL DEFAULT 'bn',
  body           text NOT NULL,
  -- Bangla SMS = UCS-2 = 70 chars/segment. Cost control depends on this.
  encoding       text NOT NULL DEFAULT 'unicode' CHECK (encoding IN ('gsm7','unicode')),
  segments       smallint NOT NULL DEFAULT 1,
  priority       smallint NOT NULL DEFAULT 5,
  -- Idempotency: one absence SMS per student per day per template.
  dedupe_key     text NOT NULL,
  status         text NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued','sending','sent','delivered','failed','suppressed')),
  provider       text,                          -- 'ssl_wireless' | 'robi' | 'banglalink'
  provider_msg_id text,
  attempts       smallint NOT NULL DEFAULT 0,
  error_code     text,
  cost_bdt       numeric(8,4),
  queued_at      timestamptz NOT NULL DEFAULT now(),
  sent_at        timestamptz,
  delivered_at   timestamptz,
  context        jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (tenant_id, created_on, id)
) PARTITION BY RANGE (created_on);

CREATE TABLE sms_outbox_2026_08 PARTITION OF sms_outbox
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE sms_outbox_2026_09 PARTITION OF sms_outbox
  FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE sms_outbox_default PARTITION OF sms_outbox DEFAULT;

-- The dispatcher's only query. Partial index keeps it in cache permanently.
CREATE INDEX ix_sms_dispatch ON sms_outbox (tenant_id, priority, queued_at)
  WHERE status = 'queued';
CREATE UNIQUE INDEX uq_sms_dedupe ON sms_outbox (tenant_id, created_on, dedupe_key);
CREATE INDEX ix_sms_recipient ON sms_outbox (tenant_id, recipient_id, queued_at DESC);

CREATE TRIGGER trg_sms_tenant BEFORE INSERT OR UPDATE ON sms_outbox
  FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant();

COMMENT ON COLUMN sms_outbox.dedupe_key IS
  'e.g. absent:2026-08-06:student_018f... — the UNIQUE index is what makes the '
  'offline retry path safe: a re-delivered outbox op cannot double-SMS a parent.';

-- ---------------------------------------------------------------------
-- Enqueue absence SMS at commit time, in the same transaction as the
-- attendance write. Guarantees "attendance saved ⇒ SMS eventually queued".
-- Suppression (holiday, cap exceeded, consent withdrawn) is the worker's job.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.queue_absence_sms() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status NOT IN ('absent','late') THEN
    RETURN NULL;
  END IF;

  INSERT INTO event_outbox (tenant_id, event_type, aggregate_type, aggregate_id, payload)
  VALUES (NEW.tenant_id, 'attendance.marked.v1', 'attendance_record', NEW.session_id,
          jsonb_build_object(
            'studentId', NEW.student_id,
            'sectionId', NEW.section_id,
            'takenOn',   NEW.taken_on,
            'status',    NEW.status,
            'sessionId', NEW.session_id));
  RETURN NULL;
END $$;

CREATE TRIGGER trg_attendance_absence_event
  AFTER INSERT OR UPDATE OF status ON attendance_records
  FOR EACH ROW EXECUTE FUNCTION app.queue_absence_sms();

COMMIT;
