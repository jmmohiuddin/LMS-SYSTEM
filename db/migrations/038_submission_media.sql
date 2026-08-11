-- F-902. Multi-format submission: text, photo of handwritten work, or a
-- short spoken answer.
--
-- 018 anticipated this with assignment_submissions.media_key, but one text
-- column cannot say WHAT the object is. A grader opening a submission needs
-- to know whether to expect an image or audio before fetching it — on a 3G
-- connection, fetching to find out is the expensive way to learn.
--
-- Why the metadata lives here and the bytes do not: same contract as
-- answer_scripts (005). The blob rides a presigned PUT to object storage;
-- this row owns the metadata and the idempotency. Nothing in this migration
-- requires object storage to exist — the columns are nullable and the
-- submission path already works with text alone.
--
-- ── A note on what these bytes are ───────────────────────────────────────
-- A voice submission is a recording of a child's voice, and a photo
-- submission may contain their handwriting, their name, and their home. Both
-- are personal data of a minor. Two consequences are enforced structurally
-- rather than left to reviewer discipline:
--
--   • media_key is computed server-side from ids, never from a filename. A
--     client-supplied name would put "রফিকুল-ইসলাম-ক্লাস-৯.jpg" into a
--     bucket listing and into every access log that touches it.
--   • media_sha256 exists so a re-upload after a dropped connection is
--     recognised as the same object rather than stored twice. Duplicate
--     copies of a child's voice are a retention problem, not just a bill.

ALTER TABLE assignment_submissions
  ADD COLUMN media_kind        text,
  ADD COLUMN media_bytes       integer,
  ADD COLUMN media_duration_ms integer,
  ADD COLUMN media_sha256      bytea;

-- Kind and key travel together or not at all. A key with no kind is an
-- object nobody can safely open; a kind with no key is a promise of media
-- that does not exist.
ALTER TABLE assignment_submissions
  ADD CONSTRAINT ck_submission_media_paired
  CHECK ((media_key IS NULL AND media_kind IS NULL)
      OR (media_key IS NOT NULL AND media_kind IS NOT NULL));

ALTER TABLE assignment_submissions
  ADD CONSTRAINT ck_submission_media_kind
  CHECK (media_kind IS NULL OR media_kind IN ('photo', 'voice'));

-- Ceilings, in the database rather than only in the handler, because the
-- handler is one caller and the sync applier is another. 250 KB matches
-- answer_scripts: it is what client-side compression must reach for an
-- upload to complete on 3G. Voice is capped at 90 seconds — long enough for
-- a spoken maths explanation, short enough that a phone left recording in a
-- pocket cannot post a 40 MB file.
ALTER TABLE assignment_submissions
  ADD CONSTRAINT ck_submission_media_bytes
  CHECK (media_bytes IS NULL OR (media_bytes > 0 AND media_bytes <= 262144));

ALTER TABLE assignment_submissions
  ADD CONSTRAINT ck_submission_voice_duration
  CHECK (media_duration_ms IS NULL
      OR (media_duration_ms > 0 AND media_duration_ms <= 90000));

-- Duration is meaningless for a photo, and a photo carrying one is a client
-- that has confused its own payloads.
ALTER TABLE assignment_submissions
  ADD CONSTRAINT ck_submission_photo_has_no_duration
  CHECK (media_kind IS DISTINCT FROM 'photo' OR media_duration_ms IS NULL);

COMMENT ON COLUMN assignment_submissions.media_kind IS
  'photo | voice. Tells a grader what the object is before they pay to fetch it.';
COMMENT ON COLUMN assignment_submissions.media_sha256 IS
  'Content hash. A retried upload after a dropped connection is the same '
  'object, not a second copy of a child''s voice.';
