/**
 * Teacher CSV import — validation.  (R-7 §13)
 *
 * The student importer (F-1601) has existed since the academics work; the
 * staff one was declared "not built yet" in `api/import.ts` and refused with
 * `unsupported_kind`. R-7 needs it, because an onboarding wizard that imports
 * 800 students and then asks the operator to type 40 teachers one at a time
 * has not saved anybody an afternoon.
 *
 * This is deliberately the SAME SHAPE as `student-import.ts`: the same alias
 * table, the same `RowError`, the same first-error-per-row rule, the same
 * phone normaliser. Two importers that disagree about what a phone number
 * looks like is how a school ends up with staff it cannot text.
 *
 * ── What this file does NOT do ──────────────────────────────────────────
 * Assign anybody to a section or a subject. R-7.6 is explicit: a teacher
 * exists first and is assigned second, and the assignment is a dated record
 * that R-3's screen can end and replace without deleting history. An import
 * that also assigned would create undated assignments that the replacement
 * flow cannot reason about.
 */
import type { CsvTable } from '../../../packages/server-core/src/csv.ts';
import { normalizePhone, type RowError } from './student-import.ts';

/**
 * Accepted headers, aliases included, Bangla included.
 *
 * A school's own spreadsheet is the input — not a template we hand them —
 * so the aliases are the ones an office actually types.
 */
const COLUMNS = {
  nameBn:        ['name_bn', 'name', 'নাম'],
  nameEn:        ['name_en', 'english_name'],
  employeeCode:  ['employee_code', 'employee_id', 'staff_id', 'code', 'আইডি'],
  phone:         ['phone', 'mobile', 'phone_e164', 'মোবাইল'],
  email:         ['email', 'ইমেইল'],
  designationBn: ['designation', 'post', 'পদবি'],
  roleCode:      ['role', 'role_code', 'ভূমিকা'],
  joiningDate:   ['joining_date', 'joined', 'যোগদান'],
} as const;

type Field = keyof typeof COLUMNS;

export interface TeacherRow {
  lineNo: number;
  nameBn: string;
  nameEn: string;
  employeeCode: string;
  phone: string | null;
  email: string | null;
  designationBn: string | null;
  roleCode: string;
  joiningDate: string | null;
}

export interface StaffSnapshot {
  /** employee codes already used in this tenant, lowercased */
  takenCodes: Set<string>;
  /** phone numbers already used in this tenant, E.164 */
  takenPhones: Set<string>;
}

export interface TeacherValidation {
  headers: string[];
  rowsRead: number;
  valid: TeacherRow[];
  errors: RowError[];
}

/**
 * The roles a teacher import may grant.
 *
 * Deliberately narrow. `principal`, `school_owner` and `it_admin` are created
 * by the wizard's own screen with an activation code handed over in person —
 * granting school-wide authority from a spreadsheet row is not a thing a CSV
 * should be able to do, and `super_admin` is a platform role that no tenant
 * import may ever mention.
 */
const IMPORTABLE_ROLES = new Set(['subject_teacher', 'class_teacher', 'dept_head']);

const ROLE_ALIASES: Record<string, string> = {
  'subject_teacher': 'subject_teacher',
  'class_teacher': 'class_teacher',
  'dept_head': 'dept_head',
  'বিষয় শিক্ষক': 'subject_teacher',
  'শ্রেণি শিক্ষক': 'class_teacher',
  'বিভাগীয় প্রধান': 'dept_head',
  'teacher': 'subject_teacher',
  'শিক্ষক': 'subject_teacher',
};

function mapHeaders(headers: string[]): Partial<Record<Field, string>> {
  const norm = (h: string): string => h.trim().toLowerCase().replace(/[\s-]+/g, '_');
  const byNorm = new Map(headers.map((h) => [norm(h), h]));
  const found: Partial<Record<Field, string>> = {};
  for (const [field, aliases] of Object.entries(COLUMNS) as Array<[Field, readonly string[]]>) {
    for (const a of aliases) {
      const hit = byNorm.get(norm(a));
      if (hit !== undefined) { found[field] = hit; break; }
    }
  }
  return found;
}

/**
 * Validate a parsed staff file.
 *
 * One error per row, the first one found — a list where one teacher appears
 * five times is a list an operator gives up on.
 */
export function validateTeachers(table: CsvTable, snap: StaffSnapshot): TeacherValidation {
  const map = mapHeaders(table.headers);
  const errors: RowError[] = [];
  const valid: TeacherRow[] = [];

  // A missing REQUIRED column is a file-level problem, not a row-level one:
  // reporting it once beats reporting it 40 times.
  const missing: string[] = [];
  if (!map.nameBn) missing.push('নাম (name_bn)');
  if (!map.employeeCode) missing.push('আইডি (employee_code)');
  if (missing.length > 0) {
    return {
      headers: table.headers, rowsRead: table.rows.length, valid: [],
      errors: [{
        lineNo: 1, rollNo: '', field: 'header',
        messageBn: `ফাইলে আবশ্যক কলাম নেই: ${missing.join(', ')}`,
      }],
    };
  }

  for (const r of table.ragged) {
    errors.push({
      lineNo: r.lineNo, rollNo: '', field: 'row',
      messageBn: `সারিতে ${r.got}টি ঘর, ${r.expected}টি হওয়ার কথা`,
    });
  }

  // Duplicates WITHIN the file, not only against the database. Two rows with
  // one employee code is the commonest spreadsheet mistake and the database
  // would report it as a constraint violation halfway through the commit.
  const seenCodes = new Set<string>();
  const seenPhones = new Set<string>();

  for (const row of table.rows) {
    const cell = (f: Field): string => {
      const h = map[f];
      return h ? (row.cells[h] ?? '').trim() : '';
    };
    const fail = (field: string, messageBn: string): void => {
      errors.push({ lineNo: row.lineNo, rollNo: cell('employeeCode'), field, messageBn });
    };

    const nameBn = cell('nameBn');
    if (!nameBn) { fail('name_bn', 'নাম নেই'); continue; }
    if (nameBn.length > 120) { fail('name_bn', 'নাম অনেক বড়'); continue; }

    const employeeCode = cell('employeeCode');
    if (!employeeCode) { fail('employee_code', 'কর্মচারী আইডি নেই'); continue; }
    const codeKey = employeeCode.toLowerCase();
    if (seenCodes.has(codeKey)) { fail('employee_code', 'এই আইডি ফাইলেই দুইবার আছে'); continue; }
    if (snap.takenCodes.has(codeKey)) {
      fail('employee_code', 'এই আইডি আগে থেকেই ব্যবহৃত');
      continue;
    }

    const rawPhone = cell('phone');
    let phone: string | null = null;
    if (rawPhone) {
      phone = normalizePhone(rawPhone);
      if (!phone) { fail('phone', 'মোবাইল নম্বর সঠিক নয়'); continue; }
      if (seenPhones.has(phone)) { fail('phone', 'এই নম্বর ফাইলেই দুইবার আছে'); continue; }
      if (snap.takenPhones.has(phone)) {
        fail('phone', 'এই নম্বর এই প্রতিষ্ঠানে আগে থেকেই আছে');
        continue;
      }
    }
    // A teacher with no phone is importable — R-7.6 — because they activate
    // by a code handed over in person, not by OTP. `assert_user_reachable`
    // in the schema requires a phone OR an email, so one of the two must be
    // present; saying which is missing beats a constraint violation.
    const email = cell('email') || null;
    if (!phone && !email) {
      fail('phone', 'মোবাইল বা ইমেইল — অন্তত একটি দরকার');
      continue;
    }

    const rawRole = cell('roleCode').trim().toLowerCase();
    const roleCode = rawRole ? (ROLE_ALIASES[rawRole] ?? rawRole) : 'subject_teacher';
    if (!IMPORTABLE_ROLES.has(roleCode)) {
      fail('role', 'ভূমিকা শুধু শিক্ষক হতে পারে — প্রধান শিক্ষক/আইটি অ্যাডমিন আলাদাভাবে তৈরি হয়');
      continue;
    }

    seenCodes.add(codeKey);
    if (phone) seenPhones.add(phone);

    valid.push({
      lineNo: row.lineNo,
      nameBn,
      // `users.full_name_en` is NOT NULL, so a file without an English name
      // still has to produce one. The Bangla name is a truthful fallback;
      // an empty string would fail the insert after validation passed.
      nameEn: cell('nameEn') || nameBn,
      employeeCode,
      phone,
      email,
      designationBn: cell('designationBn') || null,
      roleCode,
      joiningDate: cell('joiningDate') || null,
    });
  }

  errors.sort((a, b) => a.lineNo - b.lineNo);
  return { headers: table.headers, rowsRead: table.rows.length, valid, errors };
}
