/**
 * GET   /api/v1/ops/guardians?studentId=…  — a student's guardians
 * GET   /api/v1/ops/guardians?q=…          — find an existing guardian to link
 * POST  /api/v1/ops/guardians              — link one (creating the person if new)
 * PATCH /api/v1/ops/guardians              — change relation, primary, SMS, fees
 *
 * R-3 completion pass. R-3 showed guardians on the student drawer and could
 * not change them: linking a guardian, or correcting who may pay a child's
 * fees, meant SQL.
 *
 * ── Finding beats creating ──────────────────────────────────────────────
 * The endpoint searches before it offers to create, and the UI puts the
 * search first, because the default failure here is a school accumulating
 * three rows for one father — one per child. Each of those is a separate SMS
 * for the same notice, on the channel that is 80% of the bill, and a separate
 * login that sees one child instead of three.
 *
 * So POST takes EITHER `guardianId` (link this existing person) or a name and
 * phone (create, then link). The phone is the key: a create whose number
 * already exists in the school returns the holder rather than a second row.
 *
 * ── Exactly one primary, atomically ────────────────────────────────────
 * `uq_guardianship_primary` is a partial unique index over (tenant, student)
 * WHERE is_primary, so promoting a new primary must demote the old one first.
 * Two statements from here means a failure between them leaves a child with
 * no primary guardian — the person the school rings when something happens.
 * `app.set_guardian_permissions()` (migration 042) does both, SECURITY
 * INVOKER, so RLS still decides.
 *
 * ── can_pay_fees is a live wire into R-2 ───────────────────────────────
 * The `guardians_payers` audience R-2 added resolves through exactly this
 * column: an invoice notice reaches the guardians of that student who have
 * `can_pay_fees`. Changing it here changes who gets told about money on the
 * next invoice run. That is the intended behaviour and it is asserted in
 * db/tests/guardian_links.sql, because the alternative — a permission screen
 * whose setting quietly does not reach the notice system — is the shape of
 * bug nobody finds until a parent complains they were never told.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sharedDb } from '../../../packages/server-core/src/db.ts';
import { corsHeaders, readJson, json, query, HttpError } from '../../../packages/server-core/src/http.ts';
import { authenticate, requireRole, requireStaff } from '../../../packages/server-core/src/auth.ts';
import { writeAudit } from '../../../packages/server-core/src/audit.ts';

/** Mirrors guardianship_insert_scope / _update_scope in migration 042. */
const GUARDIAN_ADMIN = ['principal', 'school_owner', 'it_admin'];

/** An id from a URL or a body is a string until it is checked. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RELATIONS = new Set([
  'father', 'mother', 'brother', 'sister', 'uncle', 'aunt',
  'grandparent', 'legal_guardian', 'other',
]);

interface LinkBody {
  studentId?: string;
  guardianId?: string;
  nameBn?: string;
  nameEn?: string;
  phone?: string;
  relation?: string;
  isPrimary?: boolean;
  receivesSms?: boolean;
  canPayFees?: boolean;
}

/** E.164 for Bangladesh — the same shape users.ts and the importer accept. */
function normalisePhone(raw: string): string {
  const digits = raw.replace(/[^\d+]/g, '');
  if (/^\+8801[3-9]\d{8}$/.test(digits)) return digits;
  if (/^8801[3-9]\d{8}$/.test(digits)) return `+${digits}`;
  if (/^01[3-9]\d{8}$/.test(digits)) return `+88${digits}`;
  throw new HttpError(400, 'মোবাইল নম্বরটি ঠিক নয়', 'bad_phone', { field: 'phone' });
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cors = corsHeaders([], 'GET, POST, PATCH, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }

  try {
    const claims = await authenticate(req);
    const db = await sharedDb();
    const ctx = { tenantId: claims.tid, userId: claims.sub, role: claims.role };

    if (req.method === 'GET') {
      // Reading WHO a student's guardians are is staff-wide: a class teacher
      // needs the names and the relationship, and RLS already limits which
      // students they can see.
      requireStaff(claims);

      // Their PHONE NUMBERS are not. R-3 established that a number on a
      // screen every teacher can open is a number on every teacher's device,
      // and its test asserts it — this endpoint feeds the same student drawer.
      // So the number is withheld here, server-side, for anyone who is not
      // one of the three roles that may actually edit it. Returning it and
      // hiding it in the UI would be the pattern D13 forbids: still in the
      // body, one devtools tab away.
      const mayEdit = GUARDIAN_ADMIN.includes(claims.role);

      const q = query(req);
      const studentId = q.get('studentId');
      const term = (q.get('q') ?? '').trim();
      if (studentId) { json(res, 200, await forStudent(db, ctx, studentId, mayEdit), cors); return; }
      if (term) {
        // Searching the school's people BY name or number is an
        // administrative act in itself — it is how you enumerate a contact
        // list — so it is restricted even though the per-student read is not.
        requireRole(claims, GUARDIAN_ADMIN);
        json(res, 200, await search(db, ctx, term), cors);
        return;
      }
      throw new HttpError(400, 'studentId or q is required', 'bad_request');
    }

    if (req.method === 'POST')  { requireRole(claims, GUARDIAN_ADMIN); json(res, 200, await link(db, ctx, req), cors); return; }
    if (req.method === 'PATCH') { requireRole(claims, GUARDIAN_ADMIN); json(res, 200, await permissions(db, ctx, req), cors); return; }
    // B-7. DELETE is the verb the office means; the database does an UPDATE.
    if (req.method === 'DELETE') { requireRole(claims, GUARDIAN_ADMIN); json(res, 200, await revoke(db, ctx, req), cors); return; }

    json(res, 405, { error: 'method_not_allowed' }, cors);
  } catch (err) {
    if (err instanceof HttpError) {
      json(res, err.status, { error: err.code, message: err.message, ...(err.detail ?? {}) }, cors);
      return;
    }
    json(res, 500, { error: 'internal_error' }, cors);
  }
}

type Db = Awaited<ReturnType<typeof sharedDb>>;
type Ctx = { tenantId: string; userId: string; role: string };

/**
 * End a guardianship.  (B-7)
 *
 * ── What this is NOT ───────────────────────────────────────────────────────
 * Not a delete. Migration 042 refuses DELETE on `guardianships` for every
 * role and gives the reason — a family relationship is a record, and the
 * receipts, attendance rows and audit entries that reference this period must
 * stay readable. Migration 050 added the end date this endpoint stamps.
 *
 * ── Why the work is in the database ────────────────────────────────────────
 * `app.revoke_guardianship()` is SECURITY INVOKER, so RLS decides whether this
 * caller may write; the refusal to strand a child with no contactable adult is
 * enforced there too, in the same statement, rather than as a check this
 * handler could forget. What is left here is the HTTP shape: validate, call,
 * translate the two named errors into sentences, and write the audit entry.
 */
async function revoke(db: Db, ctx: Ctx, req: IncomingMessage) {
  const body = await readJson<{
    studentId?: string; guardianId?: string; reason?: string;
  }>(req);
  const studentId = (body.studentId ?? '').trim();
  const guardianId = (body.guardianId ?? '').trim();
  const reason = (body.reason ?? '').trim();

  if (!UUID_RE.test(studentId)) {
    throw new HttpError(400, 'studentId দরকার', 'bad_student', { field: 'studentId' });
  }
  if (!UUID_RE.test(guardianId)) {
    throw new HttpError(400, 'guardianId দরকার', 'bad_guardian', { field: 'guardianId' });
  }
  // A reason is required by the database too. Asked for here as well so the
  // person gets a field-level message instead of a constraint violation.
  if (!reason) {
    throw new HttpError(400, 'কেন সম্পর্ক শেষ হচ্ছে তা লিখুন', 'reason_required',
      { field: 'reason' });
  }
  if (reason.length > 200) {
    throw new HttpError(400, 'কারণ ২০০ অক্ষরের মধ্যে লিখুন', 'reason_too_long',
      { field: 'reason' });
  }

  return db.withTenant(ctx, async (c) => {
    // Read the names first: after the revocation the row is still visible to
    // this role, but the audit entry reads better written from the state that
    // was, and a 404 here is the honest answer for an id that is not ours.
    const { rows: before } = await c.query<{
      link_id: string;
      relation: string; is_primary: boolean; guardian_name: string; student_name: string;
    }>(
      `SELECT gs.id AS link_id, gs.relation, gs.is_primary,
              g.full_name_bn AS guardian_name, s.full_name_bn AS student_name
         FROM guardianships gs
         JOIN users g ON g.id = gs.guardian_id
         JOIN users s ON s.id = gs.student_id
        WHERE gs.student_id = $1 AND gs.guardian_id = $2 AND gs.revoked_at IS NULL`,
      [studentId, guardianId],
    );
    if (before.length === 0) {
      throw new HttpError(404, 'এই সম্পর্কটি পাওয়া যায়নি', 'guardianship_not_found');
    }

    let revokedAt: string;
    try {
      const { rows } = await c.query<{ revoked_at: string }>(
        `SELECT revoked_at FROM app.revoke_guardianship($1::uuid, $2::uuid, $3)`,
        [studentId, guardianId, reason],
      );
      revokedAt = rows[0].revoked_at;
    } catch (err) {
      const message = (err as { message?: string }).message ?? '';
      // The one refusal a person can act on, so it says what to do about it.
      if (message.includes('last_contactable_guardian')) {
        throw new HttpError(409,
          'এই শিক্ষার্থীর নিজের ফোন বা ইমেইল নেই, আর ইনিই একমাত্র যোগাযোগযোগ্য অভিভাবক। '
          + 'আগে অন্য একজন অভিভাবক যুক্ত করুন, তারপর এই সম্পর্কটি শেষ করুন।',
          'last_contactable_guardian');
      }
      if (message.includes('guardianship_not_found')) {
        throw new HttpError(404, 'এই সম্পর্কটি পাওয়া যায়নি', 'guardianship_not_found');
      }
      throw err;
    }

    await writeAudit(c, ctx, {
      action: 'ops.guardian.revoke',
      entityType: 'guardianship',
      // The link's own id. `entity_id` is a uuid column, and the first draft
      // passed `${studentId}:${guardianId}` — which the audit insert rejected,
      // poisoning the transaction and silently discarding the revocation.
      entityId: before[0].link_id,
      // Names, not ids: this is the entry somebody reads six months later
      // asking why a parent stopped receiving messages.
      before: {
        student: before[0].student_name,
        guardian: before[0].guardian_name,
        relation: before[0].relation,
        isPrimary: before[0].is_primary,
      },
      after: { revokedAt, reason },
    });

    return {
      studentId,
      guardianId,
      revokedAt,
      wasPrimary: before[0].is_primary,
      // Said back so the screen can warn without a second request: a student
      // whose primary guardian has just ended needs another one named.
      needsNewPrimary: before[0].is_primary,
    };
  });
}

async function forStudent(db: Db, ctx: Ctx, studentId: string, mayEdit: boolean) {
  return db.withTenant(ctx, async (c) => {
    const { rows: stu } = await c.query<{ name_bn: string }>(
      `SELECT full_name_bn AS name_bn FROM users WHERE id = $1`, [studentId],
    );
    if (stu.length === 0) throw new HttpError(404, 'শিক্ষার্থী পাওয়া যায়নি', 'not_found');

    const { rows } = await c.query<{
      id: string; guardian_id: string; name_bn: string; phone: string | null;
      relation: string; is_primary: boolean; receives_sms: boolean; can_pay_fees: boolean;
      other_wards: number;
    }>(
      `SELECT gs.id, gs.guardian_id, g.full_name_bn AS name_bn, g.phone_e164 AS phone,
              gs.relation, gs.is_primary, gs.receives_sms, gs.can_pay_fees,
              -- How many other children this person is guardian to. The
              -- office needs it before they "create" a guardian who is
              -- already in the school under another child.
              (SELECT count(*)::int FROM guardianships x
                WHERE x.guardian_id = gs.guardian_id AND x.student_id <> gs.student_id)
                AS other_wards
         FROM guardianships gs
         JOIN users g ON g.id = gs.guardian_id
        WHERE gs.student_id = $1
        ORDER BY gs.is_primary DESC, g.full_name_bn`,
      [studentId],
    );

    return {
      student: { id: studentId, nameBn: stu[0].name_bn },
      guardians: rows.map((r) => ({
        linkId: r.id,
        guardianId: r.guardian_id,
        nameBn: r.name_bn,
        // Withheld unless the caller may edit it. See the header of the GET
        // branch: the office corrects the number, a subject teacher does not
        // need it, and the same drawer serves both.
        phone: mayEdit ? r.phone : null,
        relation: r.relation,
        isPrimary: r.is_primary,
        receivesSms: r.receives_sms,
        canPayFees: r.can_pay_fees,
        otherWards: r.other_wards,
      })),
    };
  });
}

/**
 * Find a person already in this school to link, rather than creating a
 * duplicate. Name is a substring; phone is exact, for the same reason as in
 * users.ts — a prefix search over a phone column enumerates the school's
 * contact list one digit at a time.
 */
async function search(db: Db, ctx: Ctx, term: string) {
  return db.withTenant(ctx, async (c) => {
    const { rows } = await c.query<{
      id: string; name_bn: string; phone: string | null; wards: number;
    }>(
      `SELECT u.id, u.full_name_bn AS name_bn, u.phone_e164 AS phone,
              (SELECT count(*)::int FROM guardianships g WHERE g.guardian_id = u.id) AS wards
         FROM users u
        WHERE u.deleted_at IS NULL
          AND u.status <> 'deleted'
          AND (u.full_name_bn ILIKE '%' || $1 || '%' OR u.phone_e164 = $1)
          -- Anyone in the school may be linked as a guardian: an older
          -- sibling who is also a student, a teacher whose child attends.
          -- Excluding non-guardians here would force a duplicate person.
        ORDER BY (SELECT count(*) FROM guardianships g WHERE g.guardian_id = u.id) DESC,
                 u.full_name_bn
        LIMIT 20`,
      [term],
    );
    return {
      candidates: rows.map((r) => ({
        id: r.id, nameBn: r.name_bn, phone: r.phone, wardCount: r.wards,
      })),
    };
  });
}

async function link(db: Db, ctx: Ctx, req: IncomingMessage) {
  const b = await readJson<LinkBody>(req);
  const studentId = (b.studentId ?? '').trim();
  if (!studentId) throw new HttpError(400, 'শিক্ষার্থী নির্বাচন করুন', 'bad_request', { field: 'studentId' });
  const relation = (b.relation ?? '').trim();
  if (!RELATIONS.has(relation)) {
    throw new HttpError(400, 'সম্পর্ক বেছে নিন', 'bad_relation', { field: 'relation' });
  }

  return db.withTenant(ctx, async (c) => {
    const { rows: stu } = await c.query<{ id: string }>(
      `SELECT id FROM users WHERE id = $1`, [studentId],
    );
    if (stu.length === 0) throw new HttpError(404, 'শিক্ষার্থী পাওয়া যায়নি', 'not_found');

    let guardianId = (b.guardianId ?? '').trim();
    let created = false;
    let reusedExisting = false;

    if (!guardianId) {
      const nameBn = (b.nameBn ?? '').trim();
      if (!nameBn) throw new HttpError(400, 'অভিভাবকের নাম লিখুন', 'bad_name', { field: 'nameBn' });
      const phone = normalisePhone(b.phone ?? '');

      // The duplicate-guardian guard. A number already in the school belongs
      // to somebody; link THAT person rather than making a second copy of a
      // father who already has two children here.
      const { rows: existing } = await c.query<{ id: string }>(
        `SELECT id FROM users WHERE phone_e164 = $1 AND deleted_at IS NULL`, [phone],
      );
      if (existing.length > 0) {
        guardianId = existing[0].id;
        reusedExisting = true;
      } else {
        // full_name_en is NOT NULL; fall back rather than demand a
        // transliteration (same as users.ts and structure.ts).
        const { rows } = await c.query<{ id: string }>(
          `INSERT INTO users (tenant_id, full_name_bn, full_name_en, phone_e164, status)
           VALUES ($1, $2, $3, $4, 'invited') RETURNING id`,
          [ctx.tenantId, nameBn, (b.nameEn ?? '').trim() || nameBn, phone],
        );
        guardianId = rows[0].id;
        created = true;
        await c.query(
          `INSERT INTO user_roles (tenant_id, user_id, role_code) VALUES ($1, $2, 'guardian')
           ON CONFLICT DO NOTHING`,
          [ctx.tenantId, guardianId],
        );
      }
    }

    if (guardianId === studentId) {
      throw new HttpError(400, 'একজন নিজের অভিভাবক হতে পারে না', 'self_link', { field: 'guardianId' });
    }

    const { rows } = await c.query<{ id: string }>(
      `SELECT app.set_guardian_permissions($1, $2, $3, $4, $5, $6) AS id`,
      [studentId, guardianId, relation,
       b.isPrimary === true, b.receivesSms !== false, b.canPayFees !== false],
    );

    await writeAudit(c, ctx, {
      action: 'ops.guardian.link',
      entityType: 'guardianship',
      entityId: rows[0].id,
      after: {
        studentId, guardianId, relation,
        isPrimary: b.isPrimary === true,
        receivesSms: b.receivesSms !== false,
        canPayFees: b.canPayFees !== false,
        createdGuardian: created,
      },
    });

    return {
      linkId: rows[0].id, guardianId, created,
      // The office needs to be told when their "new" guardian was matched to
      // somebody already here — otherwise they will not understand why the
      // name on screen is not the one they typed.
      reusedExisting,
    };
  });
}

async function permissions(db: Db, ctx: Ctx, req: IncomingMessage) {
  const b = await readJson<LinkBody>(req);
  const studentId = (b.studentId ?? '').trim();
  const guardianId = (b.guardianId ?? '').trim();
  if (!studentId || !guardianId) {
    throw new HttpError(400, 'studentId and guardianId are required', 'bad_request');
  }

  return db.withTenant(ctx, async (c) => {
    const { rows: before } = await c.query<{
      relation: string; is_primary: boolean; receives_sms: boolean; can_pay_fees: boolean;
      name_bn: string;
    }>(
      `SELECT gs.relation, gs.is_primary, gs.receives_sms, gs.can_pay_fees,
              g.full_name_bn AS name_bn
         FROM guardianships gs JOIN users g ON g.id = gs.guardian_id
        WHERE gs.student_id = $1 AND gs.guardian_id = $2`,
      [studentId, guardianId],
    );
    if (before.length === 0) throw new HttpError(404, 'সংযোগ পাওয়া যায়নি', 'not_found');
    const prev = before[0];

    const relation = (b.relation ?? prev.relation).trim();
    if (!RELATIONS.has(relation)) {
      throw new HttpError(400, 'সম্পর্ক বেছে নিন', 'bad_relation', { field: 'relation' });
    }
    // Absent means unchanged, not false. A PATCH that sent only canPayFees
    // must not silently clear receivesSms.
    const isPrimary   = b.isPrimary   ?? prev.is_primary;
    const receivesSms = b.receivesSms ?? prev.receives_sms;
    const canPayFees  = b.canPayFees  ?? prev.can_pay_fees;

    // Demoting the last primary leaves a child with nobody the school rings.
    if (prev.is_primary && !isPrimary) {
      const { rows: others } = await c.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM guardianships
          WHERE student_id = $1 AND guardian_id <> $2`,
        [studentId, guardianId],
      );
      if ((others[0]?.n ?? 0) === 0) {
        throw new HttpError(400,
          'একমাত্র অভিভাবককে প্রধান থেকে সরানো যাবে না — আগে আরেকজন যোগ করুন',
          'last_primary', { field: 'isPrimary' });
      }
    }

    const { rows } = await c.query<{ id: string }>(
      `SELECT app.set_guardian_permissions($1, $2, $3, $4, $5, $6) AS id`,
      [studentId, guardianId, relation, isPrimary, receivesSms, canPayFees],
    );

    await writeAudit(c, ctx, {
      action: 'ops.guardian.permissions',
      entityType: 'guardianship',
      entityId: rows[0].id,
      before: {
        relation: prev.relation, isPrimary: prev.is_primary,
        receivesSms: prev.receives_sms, canPayFees: prev.can_pay_fees,
      },
      after: { relation, isPrimary, receivesSms, canPayFees },
    });

    return {
      linkId: rows[0].id, guardianId, nameBn: prev.name_bn,
      relation, isPrimary, receivesSms, canPayFees,
      // Say out loud that this reaches the notice system, so the office knows
      // the setting did something.
      feeNoticesChanged: prev.can_pay_fees !== canPayFees,
    };
  });
}
