/**
 * Writing to audit.activity_log.  (R-3, docs/11-MASTER-PLAN.md)
 *
 * The table has existed since migration 001 and nothing has ever written to
 * it. R-3 is the phase that adds the mutations a school would later need to
 * account for — who assigned this teacher, who moved forty children into
 * another section, who promoted the school, who published these results, who
 * raised the SMS budget — so it is the phase that starts filling it.
 *
 * ── Audit failure must not fail the operation ───────────────────────────
 * Every call here is deliberately swallowed. If the audit insert fails, the
 * teacher is still assigned and the results are still published. The opposite
 * choice — letting a logging error roll back a real mutation — trades a
 * missing log line for a school that cannot promote its students, which is a
 * much worse day for everybody. What the log loses, the domain tables still
 * hold: the assignment history in `class_teacher_assignments`, the rollover in
 * `year_rollovers`, the publication in `exams.published_at`. The audit log is
 * the narration, not the record.
 *
 * That is a genuine trade and it is worth naming rather than discovering: a
 * silently missing audit row is invisible, so this is not a safe default for
 * a system where the log IS the record (a payment ledger, say). Here it is
 * not; `ledger_entries` is.
 *
 * ── It runs inside the caller's transaction and its tenant context ───────
 * `writeAudit` takes the same client the mutation used, so the row lands under
 * the same `SET LOCAL app.tenant_id` and the same RLS. There is no way to
 * write an audit row into another school's history, and none to write one
 * without a tenant.
 *
 * ── before/after are for the small diffs ────────────────────────────────
 * They exist so "replaced Rahim Sir with Karim Sir" can be reconstructed
 * without joining four tables. They are not a change-data-capture stream:
 * never put a roster, a mark sheet, or anything with a student's PII in them.
 * The log is readable by the school's management (041's activity_read_scope),
 * which is a wider audience than most individual records deserve.
 */
import type { PoolClient } from 'pg';

/**
 * Actions are `domain.entity.verb`, matching the permission codes in
 * migration 002 so the two vocabularies stay one vocabulary.
 */
export type AuditAction =
  | 'academic.class_teacher.assign'
  | 'academic.subject_teacher.assign'
  | 'academic.enrolment.move'
  | 'academic.rollover.commit'
  | 'exam.results.publish'
  | 'finance.invoices.generate'
  | 'ops.settings.update'
  | 'ops.user.create'
  | 'ops.user.deactivate'
  | 'ops.user.reactivate'
  // R-3 completion pass.
  | 'academic.year.create'
  | 'academic.class.create'
  | 'academic.section.create'
  | 'ops.guardian.link'
  | 'ops.guardian.permissions'
  // R-4.
  | 'academic.calendar.create'
  | 'academic.calendar.update'
  | 'academic.calendar.delete'
  // Pre-P5 closure pass (B-6). Correcting a class or section NAME. Not its
  // level, stream, group, parent class or year — none of those are editable,
  // because changing them silently re-bases every enrolment beneath them.
  | 'academic.class.update'
  | 'academic.section.update'
  // B-7. A guardianship ENDED. Never a delete — the row and every record that
  // references the period it covered stay exactly where they are.
  | 'ops.guardian.revoke';

export interface AuditEntry {
  action: AuditAction;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
}

/** Just enough of a pg client to run one INSERT — keeps this testable. */
export interface AuditClient {
  query(text: string, values?: unknown[]): Promise<unknown>;
}

/**
 * Record one significant mutation. Never throws.
 *
 * Pass the client the mutation itself ran on, so the row shares its
 * transaction and its tenant context.
 *
 * ── Why the SAVEPOINT, which looks like ceremony and is not ────────────────
 * "Never throws" was implemented as a bare `catch`, and inside a transaction
 * that is a trap rather than a safety net: PostgreSQL aborts the whole
 * transaction on ANY statement error, so swallowing the exception leaves the
 * caller running in a poisoned transaction whose COMMIT silently becomes a
 * ROLLBACK. The caller loses its own write and reports success.
 *
 * That is not hypothetical. B-7's revocation endpoint passed a composite
 * string as `entityId`, `entity_id` is a `uuid` column, and the result was a
 * 200 response carrying a real timestamp for a revocation that had not
 * happened — no error anywhere, and the row untouched. Every other call site
 * in this repo has always had the same exposure.
 *
 * A SAVEPOINT scopes the damage to the audit INSERT: if it fails, only it is
 * rolled back and the caller's transaction is still good. The audit row is
 * lost, which is the documented trade-off; the operation is not, which was
 * always the intent.
 */
export async function writeAudit(
  client: AuditClient | PoolClient,
  actor: { tenantId: string; userId: string; role: string },
  entry: AuditEntry,
): Promise<void> {
  // A name, not a literal: nested audit writes inside one transaction must
  // not release each other's savepoints.
  const sp = `audit_${Math.random().toString(36).slice(2, 10)}`;
  try {
    await client.query(`SAVEPOINT ${sp}`);
  } catch {
    // No transaction to save-point inside (a bare pool client). The INSERT
    // below then stands alone and can only fail on its own.
  }

  try {
    await client.query(
      `INSERT INTO audit.activity_log
         (tenant_id, actor_id, actor_role, action, entity_type, entity_id,
          before_state, after_state)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb)`,
      [
        actor.tenantId,
        actor.userId,
        actor.role,
        entry.action,
        entry.entityType,
        entry.entityId ?? null,
        entry.before === undefined ? null : JSON.stringify(entry.before),
        entry.after === undefined ? null : JSON.stringify(entry.after),
      ],
    );
    try { await client.query(`RELEASE SAVEPOINT ${sp}`); } catch { /* see above */ }
  } catch {
    // See the header: the operation is what matters, the narration is not.
    // The rollback is what keeps that true — without it the caller's own
    // work is discarded at COMMIT and nobody is told.
    try { await client.query(`ROLLBACK TO SAVEPOINT ${sp}`); } catch { /* nothing to undo */ }
  }
}
