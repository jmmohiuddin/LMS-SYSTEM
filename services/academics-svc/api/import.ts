/**
 * POST /api/v1/academics/import   — F-1601, wireframe §10.2
 *
 *   { kind:'student', academicYearId, fileName, csv }
 *        → step 2/3: validates and returns per-row errors. Writes nothing.
 *   { kind:'student', academicYearId, fileName, csv, commit:true, digest }
 *        → step 4: imports the valid rows, skips the rest, records a batch.
 *
 * §10.2: "Dry-run first, always — nothing is written until step 4."
 *
 * ── Why there is no staging table ────────────────────────────────────────
 * The obvious way to hold a dry-run between step 2 and step 4 is a table of
 * parsed rows. It is also forbidden: a row may carry a birth registration
 * number, and a national identifier is never written in plaintext
 * anywhere. A staging table of raw CSV rows is exactly that, sitting in
 * the database for as long as the operator takes lunch.
 *
 * So validation is stateless and the commit re-sends the file. The cost is
 * parsing 800 rows twice, which is nothing. The guard against sending a
 * DIFFERENT file the second time is the digest: step 2 returns a sha256
 * over the parsed rows, and step 4 must present it back.
 *
 * ── Why the whole import is one transaction ──────────────────────────────
 * A partial write is the one outcome nobody can recover from: 300 students
 * in, 484 not, and no way to tell which without comparing by hand. §10.2
 * permits skipping INVALID rows — that is a decision made before any write
 * — but every row that passes validation lands, or none does.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';

import { sharedDb } from '../../../packages/server-core/src/db.ts';
import { corsHeaders, readJson, json, HttpError } from '../../../packages/server-core/src/http.ts';
import { authenticate, requireRole } from '../../../packages/server-core/src/auth.ts';
import { parseCsv, toCsv } from '../../../packages/server-core/src/csv.ts';
import { sealIdentifier, piiCryptoAvailable } from '../../../packages/server-core/src/pii-crypto.ts';
import {
  validateStudents, type SchoolSnapshot, type RowError, type StudentRow,
} from '../src/student-import.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IMPORT_ROLES = ['principal', 'school_owner', 'academic_coordinator'];

/** 800 rows is ~120 KB. A megabyte is a wrong file, not a big school. */
const MAX_CSV_BYTES = 1_000_000;

/** From Class 9 the 4th subject is part of a student's grading identity. */
const OPTIONAL_SUBJECT_FROM = 9;

interface ImportBody {
  kind?: string;
  academicYearId?: string;
  fileName?: string;
  csv?: string;
  commit?: boolean;
  digest?: string;
}

/** Over the PARSED rows, so a re-save that only changes line endings still matches. */
function digestOf(rows: string[][]): string {
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cors = corsHeaders();
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  if (req.method !== 'POST') { json(res, 405, { error: 'method_not_allowed' }, cors); return; }

  try {
    const claims = await authenticate(req);
    requireRole(claims, IMPORT_ROLES);

    const body = await readJson<ImportBody>(req);
    if (body.kind !== 'student') {
      // Staff import is the same shape with a different column set and is
      // not built yet. Saying so beats accepting the call and doing
      // something surprising.
      throw new HttpError(400, "kind must be 'student'", 'unsupported_kind');
    }
    const academicYearId = body.academicYearId ?? '';
    if (!UUID_RE.test(academicYearId)) {
      throw new HttpError(400, 'academicYearId must be a valid uuid', 'invalid_year');
    }
    const csv = body.csv ?? '';
    if (!csv.trim()) throw new HttpError(400, 'csv is empty', 'empty_file');
    if (Buffer.byteLength(csv, 'utf8') > MAX_CSV_BYTES) {
      throw new HttpError(413, 'file is larger than 1 MB', 'file_too_large');
    }

    const table = parseCsv(csv);
    const digest = digestOf(table.rows.map((r) => r.raw));

    if (body.commit && body.digest !== digest) {
      // The operator validated one file and is committing another. Refusing
      // is the only safe answer: the error list they are looking at
      // describes rows this file may not contain.
      throw new HttpError(409,
        'this file is not the one that was validated — run the check again',
        'digest_mismatch');
    }

    const db = await sharedDb();
    const ctx = { tenantId: claims.tid, userId: claims.sub, role: claims.role };

    const result = await db.withTenant(ctx, async (client) => {
      // ── the snapshot the rules are checked against ────────────────────
      const sectionRows = await client.query<{ level_no: number; name: string; id: string }>(
        `SELECT c.level_no, s.name, s.id
           FROM sections s JOIN classes c ON c.id = s.class_id
          WHERE s.academic_year_id = $1`,
        [academicYearId],
      );
      const sections = new Map<number, Map<string, string>>();
      for (const r of sectionRows.rows) {
        if (!sections.has(r.level_no)) sections.set(r.level_no, new Map());
        (sections.get(r.level_no) as Map<string, string>).set(r.name, r.id);
      }

      const subjectRows = await client.query<{ id: string; name_bn: string; nctb_code: string | null }>(
        `SELECT id, name_bn, nctb_code FROM subjects`,
      );
      const subjects = new Map<string, string>();
      for (const s of subjectRows.rows) {
        subjects.set(s.name_bn.trim().toLowerCase(), s.id);
        if (s.nctb_code) subjects.set(s.nctb_code.trim().toLowerCase(), s.id);
      }

      const rollRows = await client.query<{ level_no: number; name: string; roll_no: number }>(
        `SELECT c.level_no, s.name, e.roll_no
           FROM enrolments e
           JOIN sections s ON s.id = e.section_id
           JOIN classes  c ON c.id = s.class_id
          WHERE e.academic_year_id = $1 AND e.status = 'active'`,
        [academicYearId],
      );
      const takenRolls = new Set(
        rollRows.rows.map((r) => `${r.level_no}|${r.name}|${r.roll_no}`));

      // Which classes F-304 can actually derive a subject set for. Without
      // this the commit dies inside app.derive_student_subjects after the
      // operator has already pressed the button.
      const templateRows = await client.query<{ level_no: number }>(
        `SELECT DISTINCT c.level_no
           FROM subject_templates st
           JOIN classes c ON c.id = st.class_id
           JOIN curriculum_schemes cs ON cs.id = st.curriculum_scheme_id
          WHERE cs.academic_year_id = $1`,
        [academicYearId],
      );

      const snap: SchoolSnapshot = {
        sections, subjects, takenRolls,
        templatedClasses: new Set(templateRows.rows.map((r) => r.level_no)),
        optionalSubjectFrom: OPTIONAL_SUBJECT_FROM,
      };

      const checked = validateStudents(table, snap);
      let valid = checked.valid;
      const errors: RowError[] = [...checked.errors];

      // A birth registration number can only be accepted if it can be
      // sealed. With the key absent the honest outcome is to reject those
      // rows, not to quietly drop the number and import the student as
      // though the file never had one.
      if (!piiCryptoAvailable()) {
        const withBrn = valid.filter((r) => r.birthRegNo !== null);
        if (withBrn.length > 0) {
          for (const r of withBrn) {
            errors.push({
              lineNo: r.lineNo, rollNo: String(r.rollNo), field: 'birth_reg_no',
              messageBn: 'জন্ম নিবন্ধন নম্বর এখন সংরক্ষণ করা যাচ্ছে না — কলামটি বাদ দিয়ে আবার চেষ্টা করুন',
            });
          }
          valid = valid.filter((r) => r.birthRegNo === null);
        }
      }

      errors.sort((a, b) => a.lineNo - b.lineNo);

      const counts = {
        rowsRead: checked.rowsRead,
        rowsValid: valid.length,
        rowsRejected: errors.length,
      };

      if (!body.commit) {
        return {
          ...counts, digest, rowsImported: 0, batchId: null,
          errors,
          // §10.2: "the error list is downloadable so it can be fixed in
          // the source spreadsheet". Built here rather than in the browser
          // so the file the operator opens is byte-identical to the one
          // the server judged.
          errorCsv: errors.length > 0
            ? toCsv(['line', 'roll', 'field', 'reason'],
                    errors.map((e) => ({
                      line: String(e.lineNo), roll: e.rollNo,
                      field: e.field, reason: e.messageBn,
                    })))
            : null,
        };
      }

      const imported = await importStudents(client, valid, academicYearId, claims.tid);

      const batch = await client.query<{ id: string }>(
        `INSERT INTO import_batches
           (tenant_id, kind, academic_year_id, file_name, file_digest,
            rows_read, rows_valid, rows_rejected, rows_imported,
            status, started_by, completed_at)
         VALUES (app.current_tenant(), 'student', $1, $2, $3, $4, $5, $6, $7,
                 'imported', $8, now())
         RETURNING id`,
        [academicYearId, body.fileName ?? null, digest,
         counts.rowsRead, counts.rowsValid, counts.rowsRejected, imported, claims.sub],
      );

      return { ...counts, digest, rowsImported: imported, batchId: batch.rows[0].id, errors, errorCsv: null };
    });

    json(res, 200, result, cors);
  } catch (err) {
    if (err instanceof HttpError) {
      json(res, err.status, { error: err.code ?? 'error', message: err.message }, cors);
      return;
    }
    // Never echo a driver message: it can quote the row that failed, and a
    // row can hold a birth registration number.
    json(res, 500, { error: 'import_failed' }, cors);
  }
}

/**
 * Write the valid rows. All of them, or none — the caller's transaction.
 *
 * Guardians are shared: two siblings name the same mobile, and that must
 * produce one guardian with two children rather than a unique-violation on
 * the second row.
 */
async function importStudents(
  client: { query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }> },
  rows: StudentRow[],
  academicYearId: string,
  tenantId: string,
): Promise<number> {
  const guardianByPhone = new Map<string, string>();
  let imported = 0;

  for (const r of rows) {
    let guardianId = guardianByPhone.get(r.guardianPhone);
    if (!guardianId) {
      const existing = await client.query<{ id: string }>(
        `SELECT id FROM users WHERE phone_e164 = $1 AND deleted_at IS NULL`,
        [r.guardianPhone],
      );
      if (existing.rows[0]) {
        guardianId = existing.rows[0].id;
      } else {
        const g = await client.query<{ id: string }>(
          `INSERT INTO users (tenant_id, full_name_bn, full_name_en, phone_e164, status)
           VALUES (app.current_tenant(), $1, $1, $2, 'invited') RETURNING id`,
          [r.guardianNameBn, r.guardianPhone],
        );
        guardianId = g.rows[0].id;
        await client.query(
          // scope_type is CHECK IN (tenant, department, class, section) and
          // NULL-permissive. A guardian's role is scoped to their own
          // children, which is none of those, so it stays unset rather
          // than being mislabelled as tenant-wide.
          `INSERT INTO user_roles (tenant_id, user_id, role_code)
           VALUES (app.current_tenant(), $1, 'guardian')
           ON CONFLICT DO NOTHING`,
          [guardianId],
        );
      }
      guardianByPhone.set(r.guardianPhone, guardianId);
    }

    // The student carries no phone. Migration 031's deferred trigger checks
    // at COMMIT that the guardianship below makes them reachable.
    const student = await client.query<{ id: string }>(
      `INSERT INTO users (tenant_id, full_name_bn, full_name_en, gender, date_of_birth, status)
       VALUES (app.current_tenant(), $1, $2, $3, $4, 'invited') RETURNING id`,
      [r.nameBn, r.nameEn, r.gender, r.dateOfBirth],
    );
    const studentId = student.rows[0].id;

    if (r.birthRegNo) {
      // Sealed against this row's id, so a ciphertext cannot be moved to
      // another student's record and still decrypt.
      const sealed = sealIdentifier('brc', r.birthRegNo, tenantId, studentId);
      await client.query(
        `UPDATE users SET brc_ciphertext = $2, brc_blind_index = $3, pii_key_version = $4
          WHERE id = $1`,
        [studentId, sealed.ciphertext, sealed.blindIndex, sealed.keyVersion],
      );
    }

    await client.query(
      `INSERT INTO user_roles (tenant_id, user_id, role_code)
       VALUES (app.current_tenant(), $1, 'student') ON CONFLICT DO NOTHING`,
      [studentId],
    );

    await client.query(
      `INSERT INTO guardianships
         (tenant_id, student_id, guardian_id, relation, is_primary, receives_sms)
       VALUES (app.current_tenant(), $1, $2, $3, true, true)`,
      [studentId, guardianId, r.guardianRelation],
    );

    const enrolment = await client.query<{ id: string }>(
      `INSERT INTO enrolments
         (tenant_id, student_id, section_id, academic_year_id, roll_no,
          optional_subject_id, status)
       VALUES (app.current_tenant(), $1, $2, $3, $4, $5, 'active') RETURNING id`,
      [studentId, r.sectionId, academicYearId, r.rollNo, r.optionalSubjectId],
    );

    // F-304. §10.2: "Subject sets are derived automatically from the
    // subject template after import — the file never contains a subject
    // column." The optional subject and the religion are inputs to that
    // derivation, not the set itself.
    await client.query(
      `SELECT app.derive_student_subjects($1, $2, $3)`,
      [enrolment.rows[0].id, r.optionalSubjectId, r.religion],
    );

    imported++;
  }

  return imported;
}
