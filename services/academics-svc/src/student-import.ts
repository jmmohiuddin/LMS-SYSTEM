/**
 * Student import: parsing and validation  (F-1601, wireframe §10.2)
 *
 * Pure. No database, no network, no clock. Everything here takes the
 * parsed file plus a snapshot of what the school already has, and returns
 * either a row ready to write or a reason it cannot be. That separation is
 * what lets the rules be tested against the exact spreadsheet a school
 * would send, without standing up Postgres to do it.
 *
 * §10.2's rules, and where each lives:
 *
 *   "Dry-run first, always — nothing is written until step 4."
 *      → this module never writes. The endpoint calls it twice, once for
 *        the dry run and once for the commit, and only the second one
 *        opens a transaction.
 *
 *   "Errors are reported per row with the reason."
 *      → every rejection carries lineNo, the field, and a Bangla sentence
 *        naming what to change. Never "invalid row".
 *
 *   "Partial import is permitted but the skipped count is stated
 *    explicitly and logged (no silent truncation)."
 *      → validate() returns both lists. Nothing is dropped on the floor
 *        between here and the batch record.
 *
 *   "Subject sets are derived automatically from the subject template
 *    after import (F-304) — the file never contains a subject column."
 *      → there is no subject column below. The optional (4th) subject is
 *        NOT the subject set; it is one input to deriving it, along with
 *        the religion variant.
 */
import { parseCsv, type CsvTable } from '../../../packages/server-core/src/csv.ts';
import { toLatinDigits } from '../../../packages/ui-core/src/format.ts';

/** Canonical column names, and the aliases a real file uses instead. */
const COLUMNS = {
  rollNo:          ['roll_no', 'roll', 'রোল'],
  nameBn:          ['name_bn', 'name', 'নাম'],
  nameEn:          ['name_en', 'english_name'],
  classLevel:      ['class', 'class_level', 'শ্রেণি'],
  sectionName:     ['section', 'শাখা'],
  gender:          ['gender', 'লিঙ্গ'],
  dateOfBirth:     ['dob', 'date_of_birth', 'জন্ম_তারিখ'],
  birthRegNo:      ['brn', 'birth_reg_no', 'জন্ম_নিবন্ধন'],
  religion:        ['religion', 'ধর্ম'],
  optionalSubject: ['optional_subject', 'fourth_subject', 'চতুর্থ_বিষয়'],
  guardianNameBn:  ['guardian_name', 'guardian', 'অভিভাবক', 'অভিভাবকের নাম'],
  // 'অভিভাবকের মোবাইল' is what the onboarding console's own hint tells an
  // operator to write, and it is the phrase a school office would write
  // unprompted. It was not accepted, so a CSV prepared by following the
  // instructions on screen was rejected with "required column missing:
  // guardian_phone" — naming a column the instructions never mentioned.
  // `mapHeaders` folds whitespace to underscores, so the spaced and
  // underscored spellings are the same header.
  guardianPhone:   ['guardian_phone', 'phone', 'মোবাইল', 'অভিভাবকের মোবাইল',
                    'অভিভাবকের ফোন', 'guardian_mobile'],
  guardianRelation:['relation', 'সম্পর্ক'],
} as const;

type Field = keyof typeof COLUMNS;

export interface StudentRow {
  lineNo: number;
  rollNo: number;
  nameBn: string;
  nameEn: string;
  classLevel: number;
  sectionId: string;
  gender: string | null;
  dateOfBirth: string | null;
  /** Plaintext, in memory only. Sealed by the caller; never logged, never stored raw. */
  birthRegNo: string | null;
  religion: string | null;
  optionalSubjectId: string | null;
  guardianNameBn: string;
  guardianPhone: string;
  guardianRelation: string;
}

export interface RowError {
  lineNo: number;
  /** Roll number as written, for the operator to find the row. May be ''. */
  rollNo: string;
  field: string;
  messageBn: string;
}

/** What the school already has. Supplied by the endpoint from one query each. */
export interface SchoolSnapshot {
  /** classLevel → sectionName → sectionId */
  sections: Map<number, Map<string, string>>;
  /** subject code or Bangla name (lowercased) → subjectId */
  subjects: Map<string, string>;
  /** "classLevel|sectionName|roll" already taken by an active enrolment */
  takenRolls: Set<string>;
  /**
   * Class levels that have a subject template for this year. F-304 derives
   * the subject set from it, and app.derive_student_subjects RAISES when
   * there is none — so a class without one has to be caught at step 2,
   * not discovered when the commit blows up.
   */
  templatedClasses: Set<number>;
  /** Class levels at which a 4th subject is compulsory. */
  optionalSubjectFrom: number;
}

export interface ValidationResult {
  headers: string[];
  rowsRead: number;
  valid: StudentRow[];
  errors: RowError[];
}

const RELATIONS = new Set(['father', 'mother', 'brother', 'sister', 'uncle',
                           'aunt', 'grandparent', 'legal_guardian', 'other']);
const GENDERS = new Set(['male', 'female', 'other', 'undisclosed']);
const RELIGIONS = new Set(['islam', 'hindu', 'buddhist', 'christian']);

const GENDER_BN: Record<string, string> = {
  'পুরুষ': 'male', 'ছেলে': 'male', 'বালক': 'male',
  'মহিলা': 'female', 'মেয়ে': 'female', 'বালিকা': 'female',
};
const RELIGION_BN: Record<string, string> = {
  'ইসলাম': 'islam', 'মুসলিম': 'islam',
  'হিন্দু': 'hindu', 'সনাতন': 'hindu',
  'বৌদ্ধ': 'buddhist', 'খ্রিস্টান': 'christian', 'খ্রিষ্টান': 'christian',
};
const RELATION_BN: Record<string, string> = {
  'পিতা': 'father', 'বাবা': 'father', 'মাতা': 'mother', 'মা': 'mother',
  'ভাই': 'brother', 'বোন': 'sister', 'চাচা': 'uncle', 'মামা': 'uncle',
  'খালা': 'aunt', 'ফুফু': 'aunt', 'দাদা': 'grandparent', 'নানা': 'grandparent',
  'অভিভাবক': 'legal_guardian', 'অন্যান্য': 'other',
};

/** Resolve the header a file actually used for each field we want. */
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
 * Bangladeshi mobile numbers arrive as 01712345678, 8801712345678,
 * +8801712345678, with spaces or dashes, and in Bangla digits. The database
 * accepts exactly one of those shapes, so normalising here is the
 * difference between a file importing and 784 rows of "invalid phone".
 */
export function normalizePhone(raw: string): string | null {
  const digits = toLatinDigits(raw).replace(/[^\d+]/g, '');
  let d = digits.replace(/^\+/, '');
  if (d.startsWith('88')) d = d.slice(2);
  if (d.length === 10 && d.startsWith('1')) d = `0${d}`;
  if (!/^01[3-9]\d{8}$/.test(d)) return null;
  return `+88${d}`;
}

/** Accepts YYYY-MM-DD and the DD/MM/YYYY a Bangladeshi office writes. */
export function normalizeDate(raw: string): string | null {
  const s = toLatinDigits(raw).trim();
  if (!s) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (!m) {
    const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
    if (dmy) m = [dmy[0], dmy[3], dmy[2], dmy[1]] as unknown as RegExpExecArray;
  }
  if (!m) return null;
  const [y, mo, da] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || da < 1 || da > 31) return null;
  // Round-trip through Date to reject 31 February rather than store it.
  const dt = new Date(Date.UTC(y, mo - 1, da));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== da) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(da).padStart(2, '0')}`;
}

/**
 * Validate a parsed file against what the school already has.
 *
 * The order matters: a row with several problems reports the FIRST one
 * only. A list where one student appears five times is a list an operator
 * gives up on, and fixing the first problem usually fixes the rest.
 */
export function validateStudents(table: CsvTable, snap: SchoolSnapshot): ValidationResult {
  const h = mapHeaders(table.headers);
  const valid: StudentRow[] = [];
  const errors: RowError[] = [];
  const ragged = new Map(table.ragged.map((r) => [r.lineNo, r]));
  // Rolls claimed earlier in THIS file, so two rows cannot claim one seat.
  const claimed = new Set<string>();

  const missing = (['rollNo', 'nameBn', 'classLevel', 'sectionName', 'guardianPhone'] as Field[])
    .filter((f) => h[f] === undefined);
  if (missing.length > 0) {
    return {
      headers: table.headers,
      rowsRead: table.rows.length,
      valid: [],
      errors: [{
        lineNo: 1,
        rollNo: '',
        field: missing.join(', '),
        messageBn: `ফাইলে আবশ্যক কলাম নেই: ${missing.map((f) => COLUMNS[f][0]).join(', ')}`,
      }],
    };
  }

  const get = (row: Record<string, string>, f: Field): string =>
    (h[f] !== undefined ? row[h[f] as string] ?? '' : '');

  for (const row of table.rows) {
    const c = row.cells;
    const rollRaw = get(c, 'rollNo');
    const fail = (field: string, messageBn: string): void => {
      errors.push({ lineNo: row.lineNo, rollNo: rollRaw, field, messageBn });
    };

    if (ragged.has(row.lineNo)) {
      const r = ragged.get(row.lineNo) as { expected: number; got: number };
      fail('row', `সারিতে ${r.got}টি ঘর, থাকার কথা ${r.expected}টি — সম্ভবত উদ্ধৃতি চিহ্ন ভুল`);
      continue;
    }

    const nameBn = get(c, 'nameBn');
    if (!nameBn) { fail('name_bn', 'নাম খালি'); continue; }

    const classLevel = Number(toLatinDigits(get(c, 'classLevel')));
    if (!Number.isInteger(classLevel) || classLevel < 1 || classLevel > 12) {
      fail('class', 'শ্রেণি ১–১২ এর মধ্যে হতে হবে'); continue;
    }

    if (!snap.templatedClasses.has(classLevel)) {
      // §11.1 puts template configuration before import for exactly this
      // reason. Reported per row so the operator can still import the
      // classes that ARE configured.
      fail('class', `${classLevel} শ্রেণির বিষয় তালিকা (টেমপ্লেট) তৈরি হয়নি — আগে সেটি তৈরি করুন`);
      continue;
    }

    const sectionName = get(c, 'sectionName');
    const inClass = snap.sections.get(classLevel);
    if (!inClass || inClass.size === 0) {
      fail('section', `${classLevel} শ্রেণিতে কোনো শাখা তৈরি হয়নি`); continue;
    }
    const sectionId = inClass.get(sectionName);
    if (!sectionId) {
      // §10.2's own example: naming the sections that DO exist turns a
      // dead end into a correction the operator can make immediately.
      fail('section',
        `শাখা "${sectionName}" নেই — ${classLevel} শ্রেণিতে ${[...inClass.keys()].join(',')}`);
      continue;
    }

    const rollNo = Number(toLatinDigits(rollRaw));
    if (!Number.isInteger(rollNo) || rollNo <= 0 || rollNo > 32767) {
      fail('roll_no', 'রোল নম্বর একটি ধনাত্মক সংখ্যা হতে হবে'); continue;
    }
    const rollKey = `${classLevel}|${sectionName}|${rollNo}`;
    if (snap.takenRolls.has(rollKey)) {
      fail('roll_no', `রোল ${rollNo} ইতিমধ্যে ${classLevel}-${sectionName} শাখায় আছে`); continue;
    }
    if (claimed.has(rollKey)) {
      fail('roll_no', `রোল ${rollNo} এই ফাইলেই দুইবার আছে`); continue;
    }

    const guardianPhone = normalizePhone(get(c, 'guardianPhone'));
    if (!guardianPhone) {
      fail('guardian_phone', 'মোবাইল নম্বর ভুল — ০১XXXXXXXXX হতে হবে'); continue;
    }

    const dobRaw = get(c, 'dateOfBirth');
    const dateOfBirth = dobRaw ? normalizeDate(dobRaw) : null;
    if (dobRaw && !dateOfBirth) {
      fail('dob', 'জন্ম তারিখ ভুল — YYYY-MM-DD বা DD/MM/YYYY'); continue;
    }

    // §10.2's own example. The BRC is 17 digits; anything else is a typo,
    // and a typo'd national identifier is worse than an absent one because
    // it looks authoritative. Never echoed back in the message.
    const brnRaw = toLatinDigits(get(c, 'birthRegNo')).replace(/\D/g, '');
    if (brnRaw && brnRaw.length !== 17) {
      fail('birth_reg_no', 'জন্ম নিবন্ধন নম্বর ভুল — ১৭ সংখ্যা হতে হবে'); continue;
    }

    const genderRaw = get(c, 'gender').toLowerCase();
    const gender = genderRaw ? (GENDER_BN[get(c, 'gender')] ?? genderRaw) : null;
    if (gender && !GENDERS.has(gender)) {
      fail('gender', 'লিঙ্গ — ছেলে / মেয়ে লিখুন'); continue;
    }

    const religionRaw = get(c, 'religion');
    const religion = religionRaw ? (RELIGION_BN[religionRaw] ?? religionRaw.toLowerCase()) : null;
    if (religion && !RELIGIONS.has(religion)) {
      fail('religion', 'ধর্ম — ইসলাম / হিন্দু / বৌদ্ধ / খ্রিস্টান লিখুন'); continue;
    }

    const optRaw = get(c, 'optionalSubject');
    let optionalSubjectId: string | null = null;
    if (optRaw) {
      optionalSubjectId = snap.subjects.get(optRaw.trim().toLowerCase()) ?? null;
      if (!optionalSubjectId) {
        fail('optional_subject', `"${optRaw}" নামে কোনো বিষয় নেই`); continue;
      }
    } else if (classLevel >= snap.optionalSubjectFrom) {
      // §10.2's third example. From Class 9 the 4th subject is part of the
      // student's identity for grading — importing without it produces a
      // subject set that is quietly wrong.
      fail('optional_subject', `চতুর্থ বিষয় খালি (${classLevel} শ্রেণিতে আবশ্যক)`); continue;
    }

    const relRaw = get(c, 'guardianRelation');
    const guardianRelation = relRaw
      ? (RELATION_BN[relRaw] ?? relRaw.toLowerCase())
      : 'legal_guardian';
    if (!RELATIONS.has(guardianRelation)) {
      fail('relation', 'সম্পর্ক — পিতা / মাতা / অভিভাবক লিখুন'); continue;
    }

    claimed.add(rollKey);
    valid.push({
      lineNo: row.lineNo,
      rollNo,
      nameBn,
      // The board wants an English name. Falling back to the Bangla one is
      // better than refusing the row: a school can correct a name later,
      // and cannot correct a student who was never imported.
      nameEn: get(c, 'nameEn') || nameBn,
      classLevel,
      sectionId,
      gender,
      dateOfBirth,
      birthRegNo: brnRaw || null,
      religion,
      optionalSubjectId,
      guardianNameBn: get(c, 'guardianNameBn') || `${nameBn} এর অভিভাবক`,
      guardianPhone,
      guardianRelation,
    });
  }

  return { headers: table.headers, rowsRead: table.rows.length, valid, errors };
}

/** Convenience for the endpoint: parse then validate. */
export function readStudents(csv: string, snap: SchoolSnapshot): ValidationResult {
  return validateStudents(parseCsv(csv), snap);
}
