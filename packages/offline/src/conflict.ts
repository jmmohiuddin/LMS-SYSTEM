/**
 * Per-entity conflict policy.
 *
 * Implements the table in docs/01-ARCHITECTURE.md §2.6. The policies are not
 * uniform on purpose — "last writer wins everywhere" is wrong here, because
 * some of these writes have already had irreversible real-world side effects.
 */
import type { ConflictResolution, Entity, OutboxOp, PushResult } from './types.ts';

export interface ConflictContext {
  /** Did an absence SMS already go out for this attendance record? */
  smsAlreadySent?: boolean;
  /** Have the results been published? Published marks are legally significant. */
  resultsPublished?: boolean;
  /** Server's occurredAt for the competing write, if known. */
  serverOccurredAt?: string;
}

export function resolveConflict(
  op: OutboxOp,
  result: PushResult,
  ctx: ConflictContext = {},
): ConflictResolution {
  const entity: Entity = op.entity;

  switch (entity) {
    /**
     * Attendance: last-writer-wins on (occurredAt, deviceId) — EXCEPT that a
     * present→absent flip after the SMS has fired must not mutate history.
     * The parent has already been told; the audit trail has to show both the
     * original record and the correction.
     */
    case 'attendance_record':
    case 'attendance_session': {
      if (ctx.smsAlreadySent) return 'append_correction';
      if (!ctx.serverOccurredAt) return 'client_wins';
      const mine = Date.parse(op.occurredAt);
      const theirs = Date.parse(ctx.serverOccurredAt);
      if (mine > theirs) return 'client_wins';
      if (mine < theirs) return 'server_wins';
      // Identical timestamps: break the tie deterministically on deviceId so
      // every device converges on the same winner without another round trip.
      return op.deviceId > String((result.conflict?.serverValue as { deviceId?: string })?.deviceId ?? '')
        ? 'client_wins'
        : 'server_wins';
    }

    /**
     * Marks: once published, the server always wins — a published result is a
     * legal document. Before publication it is a genuine editorial clash, so
     * the teacher is shown a diff rather than having a value silently chosen.
     */
    case 'exam_mark':
      return ctx.resultsPublished || result.conflict?.reason === 'published_marks_immutable'
        ? 'server_wins'
        : 'ask_user';

    /** Answer scripts are content-addressed; a clash means we already have it. */
    case 'answer_script':
      return 'server_wins';

    /** Delivery log is per (slot, date); latest observation is the truth. */
    case 'class_delivery_log':
      return 'client_wins';

    /** Chat history is a grow-only set keyed by opId — merges trivially. */
    case 'ai_chat_turn':
      return 'merge';

    default:
      return 'server_wins';
  }
}

/**
 * Entities the client may never author. Routines must stay globally
 * clash-free, and payments are only ever created by an MFS callback — letting
 * a device author either would put an unverifiable write on the critical path.
 */
const CLIENT_AUTHORABLE: ReadonlySet<string> = new Set<Entity>([
  'attendance_session',
  'attendance_record',
  'exam_mark',
  'answer_script',
  'class_delivery_log',
  // A student reading a lesson offline must still record progress —
  // otherwise "what should I study next" is wrong for anyone without
  // constant connectivity, which is most of the target audience.
  'lesson_progress',
  // Homework written on a phone with no signal must survive to the outbox;
  // losing a student's answer text is the worst failure this app can have.
  'assignment_submission',
  // Practice must work on the bus with no signal — that's most of when a
  // student actually revises.
  'practice_attempt',
  'ai_chat_turn',
]);

export function assertClientAuthorable(entity: string): void {
  if (!CLIENT_AUTHORABLE.has(entity)) {
    throw new Error(
      `entity "${entity}" cannot be authored offline: routines and payments are server-authoritative`,
    );
  }
}
