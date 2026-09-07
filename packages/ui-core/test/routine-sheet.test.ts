/**
 * P9-9 — the printed routine, as paper.
 *
 * The builder is pure, so everything about the SHEET can be asserted without a
 * browser or a database. What matters:
 *
 *   1. THE PAPER FOLLOWS THE CONTENT. A section's week fits portrait; a whole
 *      class's does not, because its cells stack every section running at that
 *      hour. §3 asks for exactly this and forbids forcing one orientation on
 *      every routine.
 *
 *   2. EACH AUDIENCE'S SHEET DROPS WHAT IT IS ALREADY ABOUT. A teacher's sheet
 *      that repeats the teacher in all thirty cells has spent the column width
 *      a school needs for the section and the room (§9, §10).
 *
 *   3. THE ORDINALS ARE BANGLA ORDINALS. `format.ts` warns in its own comment
 *      that appending "ম" is wrong and that P4 shipped "২ম পিরিয়ড" once —
 *      ২য়, ৩য়, ৪র্থ and ৬ষ্ঠ each differ, and a school notices immediately.
 *
 *   4. EVERYTHING IS ESCAPED. A subject, a teacher's name and a room name all
 *      come from text a school typed.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRoutineSheet, routineOrientation, routineSheetCss,
  ROUTINE_SCOPE_BN, type RoutineSheetData, type RoutineScope,
} from '../src/documents.ts';
import { ordinalBn } from '../src/format.ts';
import { brandedDocument } from '../src/branded-doc.ts';
import { parseBranding } from '../src/branding.ts';

const lesson = (over: Partial<RoutineSheetData['lessons'][number]> = {}) => ({
  dayOfWeek: 0, periodNo: 1, startsAt: '10:00', endsAt: '10:45',
  subjectBn: 'গণিত', teacherBn: 'রফিক স্যার', roomBn: '১০১ নম্বর কক্ষ',
  sectionLabel: 'ক', classBn: 'নবম শ্রেণি', classLevel: 9, isParallel: false,
  ...over,
});

const data = (over: Partial<RoutineSheetData> = {}): RoutineSheetData => ({
  scopeTitle: 'নবম শ্রেণি — ক',
  scopeKind: 'section',
  yearLabel: '২০২৬',
  shiftBn: 'একক',
  version: 2,
  publishedAt: '2026-03-02T05:30:00.000Z',
  days: [{ dow: 0, bn: 'রবি' }, { dow: 1, bn: 'সোম' }],
  periods: [
    { periodNo: 1, labelBn: '১ নম্বর', startsAt: '10:00', endsAt: '10:45' },
    { periodNo: 2, labelBn: '২ নম্বর', startsAt: '11:00', endsAt: '11:45' },
  ],
  lessons: [lesson()],
  ...over,
});

describe('P9-9 — the printed routine sheet', () => {
  /* ─────────────────────────── §3 orientation ─────────────────────────── */

  test('THE ONE THAT MATTERS — paper follows the density, not the document type', () => {
    // One lesson per cell fits a portrait column; a stack of them does not.
    for (const s of ['section', 'teacher', 'room', 'student'] as RoutineScope[]) {
      assert.equal(routineOrientation(s), 'portrait', s);
    }
    for (const s of ['institution', 'class', 'group', 'stream'] as RoutineScope[]) {
      assert.equal(routineOrientation(s), 'landscape', s);
    }
  });

  test('the page box is A4 in the orientation chosen, and landscape resizes it', () => {
    const p = routineSheetCss('portrait');
    const l = routineSheetCss('landscape');
    assert.match(p, /@page\{size:A4 portrait/);
    assert.match(l, /@page\{size:A4 landscape/);
    // Without this the letterhead keeps a 210mm column in the middle of a
    // 297mm sheet — the page turns, the document does not.
    assert.match(l, /\.doc\{max-width:297mm;min-height:210mm/);
    assert.doesNotMatch(p, /max-width:297mm/);
  });

  test('§6 — the rules that keep a grid readable across pages are present', () => {
    const css = routineSheetCss('landscape');
    assert.match(css, /\.rt-grid tr\{page-break-inside:avoid;break-inside:avoid\}/);
    assert.match(css, /\.rt-grid thead\{display:table-header-group\}/);
    assert.match(css, /\.rt-lesson\{page-break-inside:avoid/);
    // The BODY must flow — a table that refuses to break at all simply
    // overflows the last page.
    assert.match(css, /\.rt-grid tbody\{break-inside:auto\}/);
  });

  /* ────────────────────────── §5 what is in a cell ────────────────────── */

  test('§5 — the period column is a Bangla ordinal and a clock range', () => {
    const b = buildRoutineSheet(data());
    assert.match(b.bodyHtml, /<span class="rt-no">১ম<\/span>/);
    assert.match(b.bodyHtml, /<span class="rt-no">২য়<\/span>/);
    assert.match(b.bodyHtml, /১০:০০–১০:৪৫/);
    assert.match(b.bodyHtml, /১১:০০–১১:৪৫/);
    // The two spans whose whole content is a figure carry the numeric face;
    // the lesson cells beside them keep Hind Siliguri for their names.
    const css = routineSheetCss('portrait');
    assert.match(css, /\.rt-no\{[^}]*Noto Sans Bengali/);
    assert.match(css, /\.rt-time\{[^}]*Noto Sans Bengali/);
    assert.doesNotMatch(css, /\.rt-lesson\{[^}]*font-family/);
  });

  test('the ordinals are per-number, not a suffix', () => {
    // format.ts warns about this in its own comment: P4 shipped "২ম" once.
    assert.deepEqual([1, 2, 3, 4, 5, 6].map(ordinalBn),
      ['১ম', '২য়', '৩য়', '৪র্থ', '৫ম', '৬ষ্ঠ']);
    // Past the table it falls back to the plain numeral rather than guessing.
    assert.equal(ordinalBn(19), '১৯');
  });

  test('§9/§10 — a sheet does not repeat what the page is already about', () => {
    const l = lesson();
    const teacher = buildRoutineSheet(data({ scopeKind: 'teacher', lessons: [l] }));
    assert.doesNotMatch(teacher.bodyHtml, /রফিক স্যার/, 'his own sheet');
    assert.match(teacher.bodyHtml, /নবম শ্রেণি-ক/, 'but the section he is with');
    assert.match(teacher.bodyHtml, /১০১ নম্বর কক্ষ/, 'and the room he is in');

    const room = buildRoutineSheet(data({ scopeKind: 'room', lessons: [l] }));
    assert.doesNotMatch(room.bodyHtml, /১০১ নম্বর কক্ষ/, 'the room’s own sheet');
    assert.match(room.bodyHtml, /রফিক স্যার/, 'but who is in it');
    assert.match(room.bodyHtml, /নবম শ্রেণি-ক/);

    const section = buildRoutineSheet(data({ scopeKind: 'section', lessons: [l] }));
    assert.doesNotMatch(section.bodyHtml, /নবম শ্রেণি-ক/, 'the section’s own sheet');
    assert.match(section.bodyHtml, /রফিক স্যার/);
  });

  test('a split hour is marked, so a reader knows the class divides', () => {
    const b = buildRoutineSheet(data({ lessons: [lesson({ isParallel: true })] }));
    assert.match(b.bodyHtml, /<i>বিভাজিত<\/i>/);
  });

  test('an hour with no class is a dash, not a hole', () => {
    const b = buildRoutineSheet(data());
    // Two periods x two days = four cells, one filled.
    assert.equal((b.bodyHtml.match(/rt-empty/g) ?? []).length, 3);
  });

  /* ──────────────────────── §4 the header block ───────────────────────── */

  test('§4 — the sheet states the year, the shift, the version and the date', () => {
    const b = buildRoutineSheet(data());
    const meta = Object.fromEntries(b.meta.map((m) => [m.label, m.value]));
    assert.equal(meta['শিক্ষাবর্ষ'], '২০২৬');
    assert.equal(meta['শিফট'], 'একক');
    assert.equal(meta['সংস্করণ'], '২', 'a Bangla numeral, not 2');
    assert.match(meta['প্রকাশ'], /২০২৬/, 'a date with its year');
    assert.equal(b.title, 'শাখার রুটিন — নবম শ্রেণি — ক');
    assert.equal(b.signatureCaption, 'প্রধান শিক্ষক');
  });

  test('the institution’s own sheet does not repeat the name the letterhead carries', () => {
    const b = buildRoutineSheet(data({ scopeKind: 'institution', scopeTitle: 'ছোট স্কুল' }));
    assert.equal(b.title, ROUTINE_SCOPE_BN.institution);
    assert.doesNotMatch(b.title, /ছোট স্কুল/);
  });

  test('an unpublished date is simply absent, not an em-dash in the meta', () => {
    const b = buildRoutineSheet(data({ publishedAt: null }));
    assert.equal(b.meta.some((m) => m.label === 'প্রকাশ'), false);
  });

  /* ────────────────────────── empty and hostile ───────────────────────── */

  test('a selection with no classes says so rather than printing a blank grid', () => {
    const b = buildRoutineSheet(data({ lessons: [] }));
    assert.doesNotMatch(b.bodyHtml, /<table/);
    assert.match(b.bodyHtml, /কোনো ক্লাস নেই/,
      'a blank grid on a noticeboard is a claim that the school teaches nothing');
  });

  test('every school-typed value is escaped', () => {
    const b = buildRoutineSheet(data({
      scopeTitle: '<script>x</script>',
      lessons: [lesson({
        subjectBn: '<img src=x onerror=1>', teacherBn: 'A & B',
        roomBn: '"quoted"', sectionLabel: "<'>", classBn: '<b>',
      })],
    }));
    // The assertion is about TAGS, not about the word. Escaped output
    // legitimately still contains "onerror" — inside `&lt;img src=x
    // onerror=1&gt;`, where it is inert text. A first version of this test
    // failed on that and would have pushed someone toward stripping content
    // rather than escaping it.
    assert.doesNotMatch(b.bodyHtml, /<script|<img/);
    assert.match(b.bodyHtml, /&lt;img src=x onerror=1&gt;/, 'escaped, not stripped');
    assert.match(b.bodyHtml, /A &amp; B/);

    // `title` is DATA, like every other builder's — `docSection()` escapes it
    // when it renders the letterhead, so the assertion belongs on the document
    // rather than on the field. Checking the field instead would push someone
    // toward double-escaping, which prints &lt;b&gt; on a school's paper.
    const html = brandedDocument({
      branding: parseBranding({ nameBn: 'ছোট স্কুল' }),
      title: b.title, bodyHtml: b.bodyHtml, meta: b.meta,
    });
    assert.doesNotMatch(html, /<script/);
    assert.match(html, /&lt;script&gt;/);
  });

  test('English keeps Latin numerals and English labels', () => {
    const b = buildRoutineSheet(data(), 'en');
    assert.match(b.bodyHtml, /<span class="rt-no">1<\/span>/);
    assert.match(b.bodyHtml, /Period/);
    assert.equal(b.signatureCaption, 'Head of Institution');
  });

  test('nothing undefined reaches the paper when fields are missing', () => {
    const b = buildRoutineSheet(data({
      lessons: [lesson({ subjectBn: null, teacherBn: null, roomBn: null,
                         sectionLabel: null, classBn: null })],
    }));
    assert.doesNotMatch(b.bodyHtml, /undefined|null|NaN/);
    assert.match(b.bodyHtml, /ক্লাস/, 'a nameless lesson is still an hour of school');
  });
});
