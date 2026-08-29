/**
 * The import, as a function rather than an endpoint.  (R-7 §13, §14)
 *
 * This orchestration used to live inside the closure in `api/import.ts`, and
 * that was fine while exactly one caller needed it. R-7's onboarding wizard is
 * a second caller: the platform operator imports a new school's teachers and
 * students before that school has a single account of its own, so there is
 * nobody to hold the tenant JWT that `api/import.ts` requires.
 *
 * The wrong fix is to give the operator a tenant token — impersonation, with a
 * blast radius the size of a school. The other wrong fix is a second copy of
 * the import in platform-svc, which is how two importers end up disagreeing
 * about what a phone number looks like.
 *
 * So the orchestration moved here, takes a client, and both callers pass their
 * own: `api/import.ts` passes one from `withTenant()` under the school's own
 * session, and platform-svc passes one from the platform connection with the
 * tenant context set. Same parse, same validation, same digest, same writes.
 *
 * ── The contract, unchanged ─────────────────────────────────────────────
 * validate → the server returns a sha256 over the parsed rows → commit
 * re-sends the same file with that digest. Validation is stateless; there is
 * no staging table holding student PII between the two calls, because a row
 * may carry a birth registration number and a national identifier is never
 * written in plaintext anywhere.
 */
import { createHash } from 'node:crypto';

import { parseCsv, toCsv } from '../../../packages/server-core/src/csv.ts';
import { sealIdentifier, piiCryptoAvailable } from '../../../packages/server-core/src/pii-crypto.ts';
import {
  validateStudents, type SchoolSnapshot, type RowError, type StudentRow,
} from './student-import.ts';
import {
  validateTeachers, type StaffSnapshot, type TeacherRow,
} from './teacher-import.ts';

export type Client = { query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }> };

/** 800 rows is ~120 KB. A megabyte is a wrong file, not a big school. */
export const MAX_CSV_BYTES = 1_000_000;

/** F-304: the class level from which a fourth subject is compulsory. */
const OPTIONAL_SUBJECT_FROM = 9;

export interface ImportOutcome {
  rowsRead: number;
  rowsValid: number;
  rowsRejected: number;
  rowsImported: number;
  digest: string;
  batchId: string | null;
  errors: RowError[];
  errorCsv: string | null;
}

/**
 * Plain fields, not constructor parameter properties: this repo runs `.ts`
 * through Node's strip-only loader, which parses types away rather than
 * compiling them, and a parameter property is syntax that needs compiling.
 */
export class ImportError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function digestOf(rows: string[][]): string {
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

function errorCsvFor(errors: RowError[]): string | null {
  // Built on the server rather than in the browser so the file the operator
  // opens is byte-identical to the one the server judged.
  return errors.length > 0
    ? toCsv(['line', 'roll', 'field', 'reason'],
            errors.map((e) => ({
              line: String(e.lineNo), roll: e.rollNo,
              field: e.field, reason: e.messageBn,
            })))
    : null;
}

function guardFile(csv: string): void {
  if (!csv.trim()) throw new ImportError(400, 'empty_file', 'csv is empty');
  if (Buffer.byteLength(csv, 'utf8') > MAX_CSV_BYTES) {
    throw new ImportError(413, 'file_too_large', 'file is larger than 1 MB');
  }
}

// ── Students ────────────────────────────────────────────────────────────

export interface StudentImportOptions {
  csv: string;
  academicYearId: string;
  tenantId: string;
  /** Null when the PLATFORM ran the import and the school has no admin yet. */
  userId: string | null;
  commit?: boolean;
  digest?: string;
  fileName?: string | null;
}

export async function runStudentImport(
  client: Client, o: StudentImportOptions,
): Promise<ImportOutcome> {
  guardFile(o.csv);
  const table = parseCsv(o.csv);
  const digest = digestOf(table.rows.map((r) => r.raw));

  if (o.commit && o.digest !== digest) {
    // The operator validated one file and is committing another. Refusing is
    // the only safe answer: the error list they are looking at describes rows
    // this file may not contain.
    throw new ImportError(409, 'digest_mismatch',
      'this file is not the one that was validated — run the check again');
  }

  const sectionRows = await client.query<{ level_no: number; name: string; id: string }>(
    `SELECT c.level_no, s.name, s.id
       FROM sections s JOIN classes c ON c.id = s.class_id
      WHERE s.academic_year_id = $1`,
    [o.academicYearId],
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
    [o.academicYearId],
  );
  const takenRolls = new Set(
    rollRows.rows.map((r) => `${r.level_no}|${r.name}|${r.roll_no}`));

  const templateRows = await client.query<{ level_no: number }>(
    `SELECT DISTINCT c.level_no
       FROM subject_templates st
       JOIN classes c ON c.id = st.class_id
       JOIN curriculum_schemes cs ON cs.id = st.curriculum_scheme_id
      WHERE cs.academic_year_id = $1`,
    [o.academicYearId],
  );

  const snap: SchoolSnapshot = {
    sections, subjects, takenRolls,
    templatedClasses: new Set(templateRows.rows.map((r) => r.level_no)),
    optionalSubjectFrom: OPTIONAL_SUBJECT_FROM,
  };

  const checked = validateStudents(table, snap);
  let valid = checked.valid;
  const errors: RowError[] = [...checked.errors];

  // A birth registration number can only be accepted if it can be sealed.
  // With the key absent the honest outcome is to reject those rows, not to
  // quietly drop the number and import the student as though the file never
  // had one.
  if (!piiCryptoAvailable()) {
    const withBrn = valid.filter((r) => r.birthRegNo !== null);
    for (const r of withBrn) {
      errors.push({
        lineNo: r.lineNo, rollNo: String(r.rollNo), field: 'birth_reg_no',
        messageBn: 'জন্ম নিবন্ধন নম্বর এখন সংরক্ষণ করা যাচ্ছে না — কলামটি বাদ দিয়ে আবার চেষ্টা করুন',
      });
    }
    valid = valid.filter((r) => r.birthRegNo === null);
  }
  errors.sort((a, b) => a.lineNo - b.lineNo);

  const counts = {
    rowsRead: checked.rowsRead,
    rowsValid: valid.length,
    rowsRejected: errors.length,
  };

  if (!o.commit) {
    return { ...counts, digest, rowsImported: 0, batchId: null, errors, errorCsv: errorCsvFor(errors) };
  }

  const imported = await writeStudents(client, valid, o.academicYearId, o.tenantId);
  const batch = await client.query<{ id: string }>(
    `INSERT INTO import_batches
       (tenant_id, kind, academic_year_id, file_name, file_digest,
        rows_read, rows_valid, rows_rejected, rows_imported,
        status, started_by, completed_at)
     VALUES (app.current_tenant(), 'student', $1, $2, $3, $4, $5, $6, $7,
             'imported', $8, now())
     RETURNING id`,
    [o.academicYearId, o.fileName ?? null, digest,
     counts.rowsRead, counts.rowsValid, counts.rowsRejected, imported, o.userId],
  );
  return { ...counts, digest, rowsImported: imported, batchId: batch.rows[0].id, errors, errorCsv: null };
}

/**
 * A permanent student code, in the shape the product already searches by.
 *
 * R-6 built search-by-permanent-ID against `student_profiles.student_code`,
 * and it turned out NOTHING in the product had ever written a
 * `student_profiles` row — the table has held the permanent identifier since
 * migration 001 and only test fixtures had ever put anything in it. So the
 * search worked and had nothing to find.
 *
 * The import is where a student first exists, so it is where the code is
 * assigned. `STU-` + eight hex from the user's own uuid: derived, so it is
 * stable and needs no counter, and unique per tenant by the same construction
 * that makes the uuid unique. `student_profiles_tenant_id_student_code_key`
 * catches the astronomically unlikely collision as a constraint violation
 * rather than silently reusing a code.
 */
function studentCodeFor(userId: string): string {
  return `STU-${userId.replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}

async function writeStudents(
  client: Client, rows: StudentRow[], academicYearId: string, tenantId: string,
): Promise<number> {
  const guardianByPhone = new Map<string, string>();
  let imported = 0;

  for (const r of rows) {
    // Guardians are shared: two siblings name the same mobile, and that must
    // produce one guardian with two children rather than a unique-violation
    // on the second row.
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
          // children, which is none of those, so it stays unset rather than
          // being mislabelled as tenant-wide.
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

    // The permanent record. New in R-7 — see studentCodeFor.
    await client.query(
      `INSERT INTO student_profiles
         (user_id, tenant_id, student_code, admission_date, admission_class,
          religion, lifecycle_status)
       VALUES ($1, app.current_tenant(), $2, CURRENT_DATE, $3, $4, 'enrolled')
       ON CONFLICT (user_id) DO NOTHING`,
      [studentId, studentCodeFor(studentId), r.classLevel, r.religion],
    );

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

    // F-304. §10.2: "Subject sets are derived automatically from the subject
    // template after import — the file never contains a subject column."
    await client.query(
      `SELECT app.derive_student_subjects($1, $2, $3)`,
      [enrolment.rows[0].id, r.optionalSubjectId, r.religion],
    );

    imported++;
  }

  return imported;
}

// ── Teachers ────────────────────────────────────────────────────────────

export interface TeacherImportOptions {
  csv: string;
  tenantId: string;
  userId: string | null;
  commit?: boolean;
  digest?: string;
  fileName?: string | null;
}

export async function runTeacherImport(
  client: Client, o: TeacherImportOptions,
): Promise<ImportOutcome> {
  guardFile(o.csv);
  const table = parseCsv(o.csv);
  const digest = digestOf(table.rows.map((r) => r.raw));

  if (o.commit && o.digest !== digest) {
    throw new ImportError(409, 'digest_mismatch',
      'this file is not the one that was validated — run the check again');
  }

  const codeRows = await client.query<{ employee_code: string }>(
    `SELECT employee_code FROM staff_profiles`);
  const phoneRows = await client.query<{ phone_e164: string }>(
    `SELECT phone_e164 FROM users WHERE phone_e164 IS NOT NULL AND deleted_at IS NULL`);

  const snap: StaffSnapshot = {
    takenCodes: new Set(codeRows.rows.map((r) => r.employee_code.toLowerCase())),
    takenPhones: new Set(phoneRows.rows.map((r) => r.phone_e164)),
  };

  const checked = validateTeachers(table, snap);
  const counts = {
    rowsRead: checked.rowsRead,
    rowsValid: checked.valid.length,
    rowsRejected: checked.errors.length,
  };

  if (!o.commit) {
    return {
      ...counts, digest, rowsImported: 0, batchId: null,
      errors: checked.errors, errorCsv: errorCsvFor(checked.errors),
    };
  }

  const imported = await writeTeachers(client, checked.valid);
  const batch = await client.query<{ id: string }>(
    `INSERT INTO import_batches
       (tenant_id, kind, file_name, file_digest,
        rows_read, rows_valid, rows_rejected, rows_imported,
        status, started_by, completed_at)
     VALUES (app.current_tenant(), 'staff', $1, $2, $3, $4, $5, $6,
             'imported', $7, now())
     RETURNING id`,
    [o.fileName ?? null, digest,
     counts.rowsRead, counts.rowsValid, counts.rowsRejected, imported, o.userId],
  );
  return {
    ...counts, digest, rowsImported: imported,
    batchId: batch.rows[0].id, errors: checked.errors, errorCsv: null,
  };
}

async function writeTeachers(client: Client, rows: TeacherRow[]): Promise<number> {
  let imported = 0;
  for (const r of rows) {
    const u = await client.query<{ id: string }>(
      `INSERT INTO users (tenant_id, full_name_bn, full_name_en, phone_e164, email, status)
       VALUES (app.current_tenant(), $1, $2, $3, $4, 'invited') RETURNING id`,
      [r.nameBn, r.nameEn, r.phone, r.email],
    );
    const userId = u.rows[0].id;

    await client.query(
      `INSERT INTO staff_profiles (user_id, tenant_id, employee_code, designation_bn, joining_date)
       VALUES ($1, app.current_tenant(), $2, $3, $4)`,
      [userId, r.employeeCode, r.designationBn, r.joiningDate],
    );

    await client.query(
      `INSERT INTO user_roles (tenant_id, user_id, role_code, scope_type)
       VALUES (app.current_tenant(), $1, $2, 'tenant') ON CONFLICT DO NOTHING`,
      [userId, r.roleCode],
    );
    imported++;
  }
  return imported;
}
