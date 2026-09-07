-- 074 — routine editor undo  (P9-5 §11)
--
-- A coordinator adjusting a generated timetable will move a class to the
-- wrong hour. Today that is unrecoverable in the only sense that matters:
-- they must remember what it was and put it back by hand, in a screen where
-- "what it was" is exactly the thing they can no longer see.
--
-- ── Why a dedicated table and not `audit.activity_log` ───────────────────
-- The audit trail already records every editor mutation, and reusing it was
-- the first idea. Two reasons it is the wrong source:
--
--   Its `before` payloads are written for a READER, not for a replay.
--   `remove` records `{subjectBn}` — enough for a person to understand what
--   happened, nowhere near enough to restore the row.
--
--   It is evidence. An audit log that some other feature writes against, and
--   whose rows change meaning when a later action marks them consumed, is no
--   longer the record it exists to be. `audit.activity_log` stays immutable
--   and this table carries the undo, and the two say different things on
--   purpose: the audit says what a person did, this says how to put it back.
--
-- ── Bounded, and the bound is on DEPTH, not on storage ───────────────────
-- Nothing is ever deleted from this table; the bound is how far back the
-- editor will offer to go. Only the newest UNDO_DEPTH un-undone entries for a
-- routine are undoable, and the reason is correctness rather than space: the
-- inverse was computed against the state of that moment, and reversing an
-- edit from three weeks and forty edits ago would apply it to a routine that
-- no longer resembles the one it was written for.
--
-- A stack with no redo. Undoing marks the entry consumed and appends nothing,
-- so a coordinator walks backwards through their recent edits and cannot walk
-- forwards again. That is deliberate: a redo stack is a second mechanism to
-- get wrong, for a case ("I undid one too many") that is solved by making the
-- edit again.
--
-- ── The inverse is computed at WRITE time, not at undo time ──────────────
-- `inverse` holds what to do to put the slot back, decided while the old row
-- is still in front of us. Computing it at undo time would mean reading a
-- row that later edits may have moved, and applying an inverse derived from
-- the wrong state — which is how an undo feature becomes the thing that
-- loses the work.

CREATE TABLE routine_edit_log (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  routine_id   uuid NOT NULL REFERENCES routines(id) ON DELETE CASCADE,

  -- Monotonic per routine, assigned inside the editing transaction. The
  -- UNIQUE below is what makes two simultaneous edits serialise rather than
  -- both claim the same position in the stack.
  seq          bigint NOT NULL,

  -- What the person did. Named for the editor action, so a row reads as the
  -- sentence a coordinator would say.
  action       text NOT NULL
                 CHECK (action IN ('place','assign','move','remove','lock','unlock')),

  -- The slot this touched. Not a foreign key: `place` logs the id of a row
  -- that its own undo will remove, and a later hard delete elsewhere must not
  -- take the log entry's meaning with it.
  slot_id      uuid,

  -- How to put it back: `{op, slotId, dayOfWeek, periodNo, teacherId, …}`.
  -- Read by `api/editor.ts:undo` and by nothing else.
  inverse      jsonb NOT NULL,

  -- What the person would recognise: "নবম-ক · গণিত · সোম ৩য় পিরিয়ড".
  -- Stored rather than re-derived so the undo button can say what it will
  -- undo even after the subject or the teacher has since been renamed.
  label_bn     text NOT NULL,

  actor_id     uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at   timestamptz NOT NULL DEFAULT now(),

  -- Set when this entry has been undone. The entry stays: two operators must
  -- not both undo the same edit, and the row is how the second one is told.
  undone_at    timestamptz,
  undone_by    uuid REFERENCES users(id) ON DELETE SET NULL,

  UNIQUE (routine_id, seq)
);

-- The one query this table serves: the newest un-undone entry for a routine.
CREATE INDEX ix_edit_log_undo
  ON routine_edit_log (tenant_id, routine_id, seq DESC)
  WHERE undone_at IS NULL;

ALTER TABLE routine_edit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE routine_edit_log FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON routine_edit_log
  USING (tenant_id = app.current_tenant())
  WITH CHECK (tenant_id = app.current_tenant());

-- B-91. Per-command scopes from the first day this table exists, not from the
-- day some later phase finally writes to it. Four instances of that pattern
-- are already recorded (B-53, B-77, B-89, B-92) and every one was found by a
-- phase tripping over it rather than by looking.
--
-- The undo log is the routine's history. Whoever may edit the routine may add
-- to it and may mark an entry undone; nobody may rewrite or delete it, which
-- is what makes "two operators cannot both undo the same edit" enforceable
-- rather than merely intended.
CREATE POLICY edit_log_insert_scope ON routine_edit_log
  AS RESTRICTIVE FOR INSERT
  WITH CHECK (app.has_role('principal', 'school_owner', 'academic_coordinator'));

CREATE POLICY edit_log_update_scope ON routine_edit_log
  AS RESTRICTIVE FOR UPDATE
  USING (app.has_role('principal', 'school_owner', 'academic_coordinator'))
  WITH CHECK (app.has_role('principal', 'school_owner', 'academic_coordinator'));

-- Nothing deletes. A person who could remove their own entries could hide an
-- edit from the stack that exists to reverse it, and the depth bound above
-- makes trimming unnecessary — an old entry is simply never offered.
CREATE POLICY edit_log_delete_scope ON routine_edit_log
  AS RESTRICTIVE FOR DELETE
  USING (false);

COMMENT ON TABLE routine_edit_log IS
  'P9-5 undo stack for the routine editor. Bounded per routine; no redo. '
  'The inverse is computed when the edit is made, while the old row is still '
  'visible — deriving it at undo time would apply an inverse built from state '
  'that later edits had already changed.';
