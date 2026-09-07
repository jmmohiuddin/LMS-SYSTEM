/**
 * The routine editor's undo stack.  (P9-5 §11)
 *
 * Every mutation records how to reverse itself, computed while the old row is
 * still in front of us. Deriving the inverse at undo time would mean reading
 * a row that later edits may have moved and reversing it into state it never
 * came from — which is how an undo feature becomes the thing that loses the
 * work.
 *
 * ── A stack, not a history ────────────────────────────────────────────────
 * Undo takes the newest un-undone entry, applies its inverse, and marks it
 * consumed. It appends nothing, so there is no redo and no way to undo an
 * undo. That is a deliberate limit: a redo stack is a second mechanism to get
 * wrong for a case ("I went one too far") that a coordinator solves by making
 * the edit again.
 *
 * ── Bounded by DEPTH, and the reason is correctness ───────────────────────
 * Only the newest `UNDO_DEPTH` entries are offered. Not for space — nothing
 * is ever deleted — but because an inverse written forty edits ago describes
 * a routine that no longer exists. Past that depth the honest answer is "make
 * the change yourself", and the screen says so.
 *
 * ── Why it does not reuse `audit.activity_log` ────────────────────────────
 * That table's `before` payloads are written for a person to read, not for a
 * replay: `remove` records `{subjectBn}`, which tells you what happened and
 * nothing about how to restore it. And an audit log that another feature
 * writes against, whose rows change meaning when something marks them
 * consumed, stops being the evidence it exists to be.
 */
/**
 * The same structural client `api/editor.ts` passes around, rather than
 * `pg.PoolClient`: the editor's helpers all take this shape, and a nominally
 * different one here would make every call site cast.
 */
type Client = {
  query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[]; rowCount?: number | null }>;
};

/**
 * How far back the editor will offer to go.
 *
 * Twelve is a session's worth of adjustments — a coordinator fixing a
 * generated routine moves a handful of classes, not fifty — and it is short
 * enough that every entry in reach describes a routine close to the one on
 * screen.
 */
export const UNDO_DEPTH = 12;

export type EditAction = 'place' | 'assign' | 'move' | 'remove' | 'lock' | 'unlock';

/**
 * What to do to put it back.
 *
 * One shape per operation, and each names only what it needs: `restore`
 * un-removes a soft-deleted row, `remove` deletes one that `place` created,
 * `move` returns a slot to the day and period it came from, `assign` returns
 * the three fields it changed, `pin` restores the lock state.
 */
export type Inverse =
  | { op: 'restore'; slotId: string }
  | { op: 'remove'; slotId: string }
  | { op: 'move'; slotId: string; dayOfWeek: number; periodNo: number }
  | { op: 'assign'; slotId: string; subjectId: string | null;
      teacherId: string | null; roomId: string | null }
  | { op: 'pin'; slotId: string; isPinned: boolean };

export interface LogEntry {
  id: string;
  seq: string;
  action: EditAction;
  labelBn: string;
  inverse: Inverse;
  createdAt: string;
}

/**
 * Record how to reverse an edit. Called inside the edit's own transaction, so
 * a mutation that rolls back takes its log entry with it — an undo stack that
 * could offer to reverse something that never happened would be worse than
 * none.
 */
export async function logEdit(
  c: Client,
  o: {
    tenantId: string; routineId: string; actorId: string;
    action: EditAction; slotId: string | null;
    inverse: Inverse; labelBn: string;
  },
): Promise<void> {
  await c.query(
    `INSERT INTO routine_edit_log
       (tenant_id, routine_id, seq, action, slot_id, inverse, label_bn, actor_id)
     SELECT $1, $2,
            COALESCE((SELECT max(seq) FROM routine_edit_log WHERE routine_id = $2), 0) + 1,
            $3, $4, $5::jsonb, $6, $7`,
    [o.tenantId, o.routineId, o.action, o.slotId,
     JSON.stringify(o.inverse), o.labelBn, o.actorId]);
}

/** The entries a coordinator may still reverse, newest first. */
export async function undoable(c: Client, routineId: string): Promise<LogEntry[]> {
  const { rows } = await c.query<{
    id: string; seq: string; action: EditAction; label_bn: string;
    inverse: Inverse; created_at: string;
  }>(
    `SELECT id, seq::text, action, label_bn, inverse, created_at::text
       FROM routine_edit_log
      WHERE routine_id = $1 AND undone_at IS NULL
      ORDER BY seq DESC
      LIMIT $2`,
    [routineId, UNDO_DEPTH]);
  return rows.map((r) => ({
    id: r.id, seq: r.seq, action: r.action, labelBn: r.label_bn,
    inverse: r.inverse, createdAt: r.created_at,
  }));
}

/**
 * Claim the newest un-undone entry, or null when the stack is empty.
 *
 * `FOR UPDATE SKIP LOCKED` is the whole concurrency story: two coordinators
 * pressing undo at the same moment take two DIFFERENT entries rather than
 * both reversing the same edit, which would apply one inverse twice. The
 * second one is a no-op only because the row it wanted was already claimed —
 * so it gets the next entry down, which is what it should have got anyway.
 */
export async function claimNewest(
  c: Client, routineId: string, actorId: string,
): Promise<LogEntry | null> {
  const { rows } = await c.query<{
    id: string; seq: string; action: EditAction; label_bn: string;
    inverse: Inverse; created_at: string;
  }>(
    `UPDATE routine_edit_log
        SET undone_at = now(), undone_by = $2
      WHERE id = (
        SELECT id FROM routine_edit_log
         WHERE routine_id = $1 AND undone_at IS NULL
         ORDER BY seq DESC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING id, seq::text, action, label_bn, inverse, created_at::text`,
    [routineId, actorId]);
  const r = rows[0];
  return r ? {
    id: r.id, seq: r.seq, action: r.action, labelBn: r.label_bn,
    inverse: r.inverse, createdAt: r.created_at,
  } : null;
}
