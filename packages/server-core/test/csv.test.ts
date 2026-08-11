/**
 * The CSV reader — the half of F-1601 that decides whether a real school's
 * spreadsheet imports at all.
 *
 * Every case here is one I expect to meet in a Bangladeshi school office,
 * not a conformance exercise. The BOM, the semicolon and the quoted comma
 * are the three that turn "the importer is broken" into a support call.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parseCsv, sniffDelimiter, toCsv } from '../src/csv.ts';

describe('parseCsv', () => {
  test('reads a plain file into headers and trimmed cells', () => {
    const t = parseCsv('roll,name\n7, আনিকা \n8,বিজয়\n');
    assert.deepEqual(t.headers, ['roll', 'name']);
    assert.equal(t.rows.length, 2);
    assert.deepEqual(t.rows[0].cells, { roll: '7', name: 'আনিকা' });
    assert.deepEqual(t.rows[1].cells, { roll: '8', name: 'বিজয়' });
  });

  test('strips the UTF-8 BOM Excel writes', () => {
    // Without this the first header is "﻿roll", which matches no
    // column, so every row reports a missing roll number — and the header
    // looks correct in every editor the operator will check it in.
    const t = parseCsv('﻿roll,name\n7,আনিকা\n');
    assert.deepEqual(t.headers, ['roll', 'name']);
    assert.equal(t.rows[0].cells.roll, '7');
  });

  test('detects the semicolon Excel uses on a non-English locale', () => {
    const t = parseCsv('roll;name;section\n7;আনিকা;ক\n');
    assert.equal(t.delimiter, ';');
    assert.deepEqual(t.headers, ['roll', 'name', 'section']);
    assert.equal(t.rows[0].cells.section, 'ক');
  });

  test('a quoted field in row 1 does not outvote the real delimiter', () => {
    // The header line is what is sniffed, and quotes are respected while
    // sniffing — otherwise one comma-laden guardian name picks the
    // delimiter for the whole file.
    const t = parseCsv('roll;"name, full";section\n7;"ফয়সাল, মাহির";ক\n');
    assert.equal(t.delimiter, ';');
    assert.equal(t.rows[0].cells['name, full'], 'ফয়সাল, মাহির');
  });

  test('handles a quoted comma, a quoted newline and a doubled quote', () => {
    const t = parseCsv('roll,guardian,note\n'
      + '7,"ফয়সাল, মাহির","লাইন ১\nলাইন ২"\n'
      + '8,"তিনি ""স্যার"" বলেন",ok\n');
    assert.equal(t.rows.length, 2);
    assert.equal(t.rows[0].cells.guardian, 'ফয়সাল, মাহির');
    assert.equal(t.rows[0].cells.note, 'লাইন ১\nলাইন ২');
    assert.equal(t.rows[1].cells.guardian, 'তিনি "স্যার" বলেন');
  });

  test('a newline inside quotes does not advance the reported line number', () => {
    // Reported line numbers are what the operator types into Excel's
    // "go to row" box. If an embedded newline shifted them, every error
    // after the first multi-line cell would point at the wrong student.
    const t = parseCsv('roll,note\n7,"a\nb"\n8,c\n');
    assert.equal(t.rows[0].lineNo, 2);
    assert.equal(t.rows[1].lineNo, 4);   // row 8 really is on file line 4
  });

  test('CRLF, LF and a lone CR are all one line break', () => {
    assert.equal(parseCsv('a,b\r\n1,2\r\n').rows.length, 1);
    assert.equal(parseCsv('a,b\n1,2\n').rows.length, 1);
    assert.equal(parseCsv('a,b\r1,2\r').rows.length, 1);
  });

  test('a trailing newline does not produce a phantom row', () => {
    // Every file ends with one, and a phantom row would report "name
    // required" for a student who does not exist.
    assert.equal(parseCsv('a,b\n1,2\n').rows.length, 1);
    assert.equal(parseCsv('a,b\n1,2').rows.length, 1);
    assert.equal(parseCsv('a,b\n1,2\n\n\n').rows.length, 1);
  });

  test('an all-empty row is skipped — Excel emits them for cleared rows', () => {
    const t = parseCsv('roll,name\n7,আনিকা\n,\n8,বিজয়\n');
    assert.equal(t.rows.length, 2);
    assert.deepEqual(t.rows.map((r) => r.cells.roll), ['7', '8']);
  });

  test('a ragged row is reported, never padded silently or dropped', () => {
    // Usually an unescaped quote earlier in the file. Padding it would
    // import the wrong values into the right-hand columns, which is worse
    // than refusing the row.
    const t = parseCsv('roll,name,section\n7,আনিকা\n8,বিজয়,ক,extra\n');
    assert.equal(t.ragged.length, 2);
    assert.deepEqual(t.ragged[0], { lineNo: 2, expected: 3, got: 2 });
    assert.deepEqual(t.ragged[1], { lineNo: 3, expected: 3, got: 4 });
    // Still returned, so the importer can report a per-row reason.
    assert.equal(t.rows.length, 2);
    assert.equal(t.rows[0].cells.section, '');
  });

  test('a header-only file yields no rows and no errors', () => {
    const t = parseCsv('roll,name\n');
    assert.deepEqual(t.headers, ['roll', 'name']);
    assert.equal(t.rows.length, 0);
  });

  test('an empty file is empty, not a crash', () => {
    const t = parseCsv('');
    assert.deepEqual(t.headers, []);
    assert.equal(t.rows.length, 0);
  });

  test('a file with no final newline still yields its last row', () => {
    const t = parseCsv('roll,name\n7,আনিকা');
    assert.equal(t.rows.length, 1);
    assert.equal(t.rows[0].cells.name, 'আনিকা');
  });
});

describe('sniffDelimiter', () => {
  test('falls back to comma for a single-column file', () => {
    assert.equal(sniffDelimiter('roll'), ',');
  });

  test('picks tab over comma when tabs dominate', () => {
    assert.equal(sniffDelimiter('roll\tname\tsection'), '\t');
  });
});

describe('toCsv', () => {
  test('round-trips through parseCsv', () => {
    const out = toCsv(['roll', 'reason'], [
      { roll: '42', reason: 'জন্ম নিবন্ধন নম্বর ভুল' },
      { roll: '57', reason: 'শাখা "ঘ" নেই, নবম শ্রেণিতে ক,খ,গ' },
    ]);
    const back = parseCsv(out);
    assert.deepEqual(back.headers, ['roll', 'reason']);
    assert.equal(back.rows[1].cells.reason, 'শাখা "ঘ" নেই, নবম শ্রেণিতে ক,খ,গ');
  });

  test('writes a BOM so Excel renders Bangla rather than mojibake', () => {
    // The error list goes back into the spreadsheet it came from. The same
    // BOM that must be stripped on the way in is mandatory on the way out.
    assert.equal(toCsv(['a'], [{ a: 'ক' }]).charCodeAt(0), 0xfeff);
  });
});
