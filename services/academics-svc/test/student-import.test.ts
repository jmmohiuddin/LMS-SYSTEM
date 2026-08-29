/**
 * Student import validation — F-1601, wireframe §10.2.
 *
 * The three errors §10.2 draws on the screen are the three this suite
 * cares most about, because they are the ones a head teacher will actually
 * see on their first attempt:
 *
 *     সারি ৪২  জন্ম নিবন্ধন নম্বর ভুল
 *     সারি ৫৭  শাখা "ঘ" নেই — নবম শ্রেণিতে ক,খ,গ
 *     সারি ৯১  চতুর্থ বিষয় খালি (নবম শ্রেণিতে আবশ্যক)
 *
 * Pure module, so no database: the point of separating it was to be able
 * to run the exact spreadsheet a school would send through the rules
 * without standing Postgres up to do it.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  readStudents, normalizePhone, normalizeDate, type SchoolSnapshot,
} from '../src/student-import.ts';

/** Class 9 has sections ক, খ, গ — and deliberately no ঘ. */
function snapshot(over: Partial<SchoolSnapshot> = {}): SchoolSnapshot {
  return {
    sections: new Map([
      [9, new Map([['ক', 'sec-9-ka'], ['খ', 'sec-9-kha'], ['গ', 'sec-9-ga']])],
      [3, new Map([['ক', 'sec-3-ka']])],
    ]),
    subjects: new Map([
      ['উচ্চতর গণিত', 'sub-hmath'],
      ['কৃষিশিক্ষা', 'sub-agri'],
      ['126', 'sub-hmath'],
    ]),
    takenRolls: new Set<string>(),
    templatedClasses: new Set([3, 9]),
    optionalSubjectFrom: 9,
    ...over,
  };
}

const HEAD = 'roll_no,name_bn,class,section,guardian_phone,optional_subject';
const ok = (roll: number, section = 'ক') =>
  `${roll},শিক্ষার্থী ${roll},9,${section},01712345${String(roll).padStart(3, '0')},উচ্চতর গণিত`;

describe('the three errors §10.2 draws', () => {
  test('a birth registration number that is not 17 digits', () => {
    const csv = `${HEAD},brn\n${ok(1)},1234567890\n`;
    const r = readStudents(csv, snapshot());
    assert.equal(r.valid.length, 0);
    assert.equal(r.errors[0].field, 'birth_reg_no');
    assert.match(r.errors[0].messageBn, /জন্ম নিবন্ধন নম্বর ভুল/);
  });

  test('the rejection never echoes the identifier back', () => {
    // An error message is a log line, and a log line holding a birth
    // registration number is a plaintext national identifier at rest.
    // 16 digits, so it is rejected — and the number must not travel with
    // the rejection.
    const csv = `${HEAD},brn\n${ok(1)},1999887766554433\n`;
    const r = readStudents(csv, snapshot());
    assert.equal(r.errors[0].field, 'birth_reg_no');
    assert.ok(!JSON.stringify(r.errors).includes('1999887766554433'));
    assert.ok(!JSON.stringify(r.errors).includes('9988776655'));
  });

  test('a section that does not exist names the ones that do', () => {
    const r = readStudents(`${HEAD}\n${ok(1, 'ঘ')}\n`, snapshot());
    assert.equal(r.errors[0].field, 'section');
    // Naming ক,খ,গ turns a dead end into a correction. §10.2 shows exactly
    // this, and it is the difference between one round trip and three.
    assert.match(r.errors[0].messageBn, /শাখা "ঘ" নেই/);
    assert.match(r.errors[0].messageBn, /ক,খ,গ/);
  });

  test('a missing 4th subject is an error from Class 9 and fine below it', () => {
    const nine = readStudents(`${HEAD}\n1,আনিকা,9,ক,01712345678,\n`, snapshot());
    assert.equal(nine.errors[0].field, 'optional_subject');
    assert.match(nine.errors[0].messageBn, /চতুর্থ বিষয় খালি \(9 শ্রেণিতে আবশ্যক\)/);

    const three = readStudents(`${HEAD}\n1,রাহাত,3,ক,01712345678,\n`, snapshot());
    assert.equal(three.errors.length, 0);
    assert.equal(three.valid[0].optionalSubjectId, null);
  });

  test('R-7 — the Bangla headers the onboarding console tells operators to write', () => {
    // The console's student-import hint reads "কলাম: রোল, নাম, শ্রেণি, শাখা,
    // অভিভাবকের মোবাইল". A CSV written by following that instruction was
    // rejected with "ফাইলে আবশ্যক কলাম নেই: guardian_phone" — naming a column
    // the instruction never mentioned. Found by walking the wizard in a
    // browser; no test covered the Bangla header spellings.
    const r = readStudents(
      ['রোল,নাম,শ্রেণি,শাখা,অভিভাবকের মোবাইল,চতুর্থ_বিষয়',
       '1,রাফিয়া ইসলাম,9,ক,01712345678,উচ্চতর গণিত', ''].join('\n'),
      snapshot());
    assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
    assert.equal(r.valid.length, 1);
    assert.equal(r.valid[0].guardianPhone, '+8801712345678');
  });
});

describe('partial import — §10.2 permits it, loudly', () => {
  test('good rows survive alongside bad ones and both are counted', () => {
    const csv = `${HEAD}\n${ok(1)}\n${ok(2, 'ঘ')}\n${ok(3)}\n`;
    const r = readStudents(csv, snapshot());
    assert.equal(r.rowsRead, 3);
    assert.equal(r.valid.length, 2);
    assert.equal(r.errors.length, 1);
    // Nothing is dropped between read and reported: 2 + 1 = 3.
    assert.equal(r.valid.length + r.errors.length, r.rowsRead);
  });

  test('a row with several faults reports only the first', () => {
    // A list where one student appears five times is a list an operator
    // gives up on, and fixing the first fault usually fixes the rest.
    const csv = `${HEAD},brn\n,,9,ঘ,not-a-phone,nonsense,123\n`;
    const r = readStudents(csv, snapshot());
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0].field, 'name_bn');
  });

  test('the roll number is carried on the error so the row can be found', () => {
    const r = readStudents(`${HEAD}\n${ok(57, 'ঘ')}\n`, snapshot());
    assert.equal(r.errors[0].rollNo, '57');
    assert.equal(r.errors[0].lineNo, 2);
  });
});

describe('roll numbers', () => {
  test('a roll already held in that section is refused', () => {
    const snap = snapshot({ takenRolls: new Set(['9|ক|7']) });
    const r = readStudents(`${HEAD}\n${ok(7)}\n`, snap);
    assert.match(r.errors[0].messageBn, /রোল 7 ইতিমধ্যে/);
  });

  test('the same roll twice in one file is caught before the database sees it', () => {
    const csv = `${HEAD}\n${ok(7)}\n7,অন্য জন,9,ক,01799999999,উচ্চতর গণিত\n`;
    const r = readStudents(csv, snapshot());
    assert.equal(r.valid.length, 1);
    assert.match(r.errors[0].messageBn, /এই ফাইলেই দুইবার/);
  });

  test('the same roll in a DIFFERENT section is fine', () => {
    const csv = `${HEAD}\n${ok(7, 'ক')}\n7,অন্য জন,9,খ,01799999999,উচ্চতর গণিত\n`;
    const r = readStudents(csv, snapshot());
    assert.equal(r.valid.length, 2);
    assert.equal(r.errors.length, 0);
  });
});

describe('what a real spreadsheet looks like', () => {
  test('Bangla digits in roll, class and phone are read as numbers', () => {
    const csv = `${HEAD}\n৭,আনিকা,৯,ক,০১৭১২৩৪৫৬৭৮,উচ্চতর গণিত\n`;
    const r = readStudents(csv, snapshot());
    assert.equal(r.errors.length, 0);
    assert.equal(r.valid[0].rollNo, 7);
    assert.equal(r.valid[0].classLevel, 9);
    assert.equal(r.valid[0].guardianPhone, '+8801712345678');
  });

  test('Bangla column headers are understood', () => {
    const csv = 'রোল,নাম,শ্রেণি,শাখা,মোবাইল,চতুর্থ_বিষয়\n'
              + '৭,আনিকা,৯,ক,০১৭১২৩৪৫৬৭৮,উচ্চতর গণিত\n';
    const r = readStudents(csv, snapshot());
    assert.equal(r.errors.length, 0);
    assert.equal(r.valid[0].nameBn, 'আনিকা');
  });

  test('a missing required COLUMN fails the file, not every row', () => {
    // 784 identical row errors is not a report, it is a wall. The file is
    // wrong, so the file is what gets reported.
    const r = readStudents('name_bn,class\nআনিকা,9\n', snapshot());
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0].lineNo, 1);
    assert.match(r.errors[0].messageBn, /আবশ্যক কলাম নেই/);
  });

  test('an English name is optional and falls back to the Bangla one', () => {
    // A school can correct a name later; it cannot correct a student who
    // was never imported.
    const r = readStudents(`${HEAD}\n${ok(1)}\n`, snapshot());
    assert.equal(r.valid[0].nameEn, 'শিক্ষার্থী 1');
  });

  test('a ragged row is reported as one, with the likely cause', () => {
    const csv = `${HEAD}\n1,আনিকা,9,ক\n`;
    const r = readStudents(csv, snapshot());
    assert.equal(r.errors[0].field, 'row');
    assert.match(r.errors[0].messageBn, /উদ্ধৃতি চিহ্ন ভুল/);
  });
});

describe('normalizePhone', () => {
  test('accepts every shape a Bangladeshi office writes', () => {
    for (const raw of ['01712345678', '8801712345678', '+8801712345678',
                       '01712-345678', '017 1234 5678', '০১৭১২৩৪৫৬৭৮']) {
      assert.equal(normalizePhone(raw), '+8801712345678', raw);
    }
  });

  test('rejects a landline, a short number and an impossible operator', () => {
    assert.equal(normalizePhone('029123456'), null);
    assert.equal(normalizePhone('0171234567'), null);
    assert.equal(normalizePhone('01212345678'), null);   // no 012 operator
  });
});

describe('normalizeDate', () => {
  test('accepts ISO and the DD/MM/YYYY an office writes', () => {
    assert.equal(normalizeDate('2012-03-09'), '2012-03-09');
    assert.equal(normalizeDate('09/03/2012'), '2012-03-09');
    assert.equal(normalizeDate('9.3.2012'), '2012-03-09');
    assert.equal(normalizeDate('০৯/০৩/২০১২'), '2012-03-09');
  });

  test('rejects a date that does not exist rather than storing it', () => {
    assert.equal(normalizeDate('31/02/2012'), null);
    assert.equal(normalizeDate('2012-13-01'), null);
  });
});
