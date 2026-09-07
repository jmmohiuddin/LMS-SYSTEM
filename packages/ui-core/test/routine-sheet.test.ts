/**
 * P9-9 — the printed routine, as paper.
 *
 * The builder is pure, so everything about the SHEET can be asserted without a
 * browser or a database. What matters:
 *
 *   1. THE HOUR IS CALLED WHAT THE SCHOOL CALLS IT. `period_no` is a position
 *      in the day, not a count of teaching hours, and the seeded day shift
 *      puts tiffin at position 5 — so the hour every teacher calls "৫ম" is
 *      `period_no` 6. The first version numbered the rows with
 *      `ordinalBn(period_no)` and printed "৬ষ্ঠ" over it.
 *
 *   2. THE BREAK IS ON THE PAGE. `period_definitions.kind` has seven values
 *      and migration 012 seeds সমাবেশ, টিফিন and জোহর into every school. The
 *      read filtered them out, so the break the whole day is built around
 *      never reached the paper.
 *
 *   3. A LESSON IS ONE LINE, NOT FOUR. A class of four sections used to put
 *      sixteen lines in one cell and compress the grid into a grey band. A
 *      notice board is read standing up, from a metre away.
 *
 *   4. THE PAPER FOLLOWS THE CONTENT. A section's week fits portrait; a whole
 *      class's does not. §3 forbids forcing one orientation on every routine.
 *
 *   5. EACH AUDIENCE'S SHEET DROPS WHAT IT IS ALREADY ABOUT. A teacher's sheet
 *      that repeats the teacher in all thirty cells has spent the column width
 *      a school needs for the section and the room (§9, §10).
 *
 *   6. EVERYTHING IS ESCAPED. A subject, a teacher's name, a room name and now
 *      a PERIOD LABEL all come from text a school typed.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRoutineSheet, routineOrientation, routineIsDense, routineSheetCss,
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
    { periodNo: 1, labelBn: '১ম', startsAt: '10:00', endsAt: '10:45', kind: 'teaching' },
    { periodNo: 2, labelBn: '২য়', startsAt: '11:00', endsAt: '11:45', kind: 'teaching' },
  ],
  lessons: [lesson()],
  ...over,
});

/** The seeded day shift, which is where the off-by-one actually lives. */
const realDay = (): RoutineSheetData['periods'] => [
  { periodNo: 0, labelBn: 'সমাবেশ', startsAt: '08:00', endsAt: '08:20', kind: 'assembly' },
  { periodNo: 1, labelBn: '১ম', startsAt: '08:20', endsAt: '09:00', kind: 'teaching' },
  { periodNo: 2, labelBn: '২য়', startsAt: '09:00', endsAt: '09:40', kind: 'teaching' },
  { periodNo: 3, labelBn: '৩য়', startsAt: '09:40', endsAt: '10:20', kind: 'teaching' },
  { periodNo: 4, labelBn: '৪র্থ', startsAt: '10:20', endsAt: '11:00', kind: 'teaching' },
  { periodNo: 5, labelBn: 'টিফিন', startsAt: '11:00', endsAt: '11:30', kind: 'tiffin' },
  { periodNo: 6, labelBn: '৫ম', startsAt: '11:30', endsAt: '12:10', kind: 'teaching' },
  { periodNo: 7, labelBn: '৬ষ্ঠ', startsAt: '12:10', endsAt: '12:50', kind: 'teaching' },
  { periodNo: 8, labelBn: 'জোহর', startsAt: '12:50', endsAt: '13:20', kind: 'prayer' },
  { periodNo: 9, labelBn: '৭ম', startsAt: '13:20', endsAt: '14:00', kind: 'teaching' },
];

describe('P9-9 — the printed routine sheet', () => {
  /* ─────────────── §5 the hour, its name and its break ─────────────── */

  test('THE ONE THAT MATTERS — the hour is called what the school calls it', () => {
    // Position 6 in the seeded day shift is the hour the school labels ৫ম,
    // because tiffin holds position 5. Numbering the rows instead of reading
    // the label printed ৬ষ্ঠ over it — off by one for the whole afternoon,
    // and wrong in the one column a reader uses to find their row.
    const b = buildRoutineSheet(data({
      periods: realDay(),
      lessons: [lesson({ periodNo: 6, startsAt: '11:30', endsAt: '12:10' })],
    }));
    const labels = [...b.bodyHtml.matchAll(/<span class="rt-no">([^<]*)<\/span>/g)]
      .map((m) => m[1]);
    assert.deepEqual(labels, ['১ম', '২য়', '৩য়', '৪র্থ', '৫ম', '৬ষ্ঠ', '৭ম'],
      'the school’s own labels, in day order, breaks excluded');

    // The proof that it is the LABEL and not the number: position 6 renders
    // ৫ম, and ordinalBn(6) — what the first version printed — is ৬ষ্ঠ.
    assert.equal(ordinalBn(6), '৬ষ্ঠ');
    const fifth = b.bodyHtml.indexOf('৫ম');
    const lessonAt = b.bodyHtml.indexOf('গণিত');
    assert.ok(fifth > 0 && fifth < lessonAt, '৫ম heads the row its lesson is in');
  });

  test('§5 — tiffin is a band across the whole grid, named and timed', () => {
    const b = buildRoutineSheet(data({ periods: realDay() }));
    // Full width: the period column plus every day column.
    assert.match(b.bodyHtml,
      /<tr class="rt-band"><td colspan="3"><span class="rt-band-name">টিফিন<\/span>/);
    assert.match(b.bodyHtml, /<span class="rt-band-time">১১:০০–১১:৩০<\/span>/);
    // Every non-teaching kind the school observes, not just tiffin.
    for (const n of ['সমাবেশ', 'টিফিন', 'জোহর']) {
      assert.ok(b.bodyHtml.includes(`<span class="rt-band-name">${n}</span>`), n);
    }
    assert.equal((b.bodyHtml.match(/rt-band"/g) ?? []).length, 3);
    // A band is not a row of empty hours: it must not draw day cells.
    const band = b.bodyHtml.match(/<tr class="rt-band">.*?<\/tr>/)![0];
    assert.doesNotMatch(band, /rt-empty/);
  });

  test('a period with no kind is a taught hour, not a band', () => {
    // A caller that predates period kinds — a cached payload, an older
    // service — must get a grid, not a page of bands with no lessons on it.
    const b = buildRoutineSheet(data({
      periods: [{ periodNo: 1, labelBn: '১ম', startsAt: '10:00', endsAt: '10:45' }],
    }));
    assert.doesNotMatch(b.bodyHtml, /rt-band/);
    assert.match(b.bodyHtml, /গণিত/);
  });

  test('a period whose label the school left blank falls back to the ordinal', () => {
    const b = buildRoutineSheet(data({
      periods: [{ periodNo: 4, labelBn: '  ', startsAt: '10:00', endsAt: '10:45',
                  kind: 'teaching' }],
    }));
    assert.match(b.bodyHtml, /<span class="rt-no">৪র্থ<\/span>/);
  });

  test('the ordinals are per-number, not a suffix', () => {
    // format.ts warns about this in its own comment: P4 shipped "২ম" once.
    assert.deepEqual([1, 2, 3, 4, 5, 6].map(ordinalBn),
      ['১ম', '২য়', '৩য়', '৪র্থ', '৫ম', '৬ষ্ঠ']);
    // Past the table it falls back to the plain numeral rather than guessing.
    assert.equal(ordinalBn(19), '১৯');
  });

  test('§5 — the period column carries the time as well, in the numeric face', () => {
    const b = buildRoutineSheet(data());
    assert.match(b.bodyHtml, /<span class="rt-time">১০:০০–১০:৪৫<\/span>/);
    const css = routineSheetCss('portrait');
    assert.match(css, /\.rt-no\{[^}]*Noto Sans Bengali/);
    assert.match(css, /\.rt-time\{[^}]*Noto Sans Bengali/);
    // Neither is small print — the label leads the column and the time is
    // still readable under it. §5 forbids shrinking either into metadata.
    const size = (sel: string) =>
      Number(css.match(new RegExp(`\\${sel}\\{[^}]*font-size:([\\d.]+)px`))![1]);
    assert.ok(size('.rt-no') >= 14, `period label ${size('.rt-no')}px`);
    assert.ok(size('.rt-time') >= 10, `period time ${size('.rt-time')}px`);
  });

  /* ──────────────────── §2/§3 the density fix ─────────────────────── */

  test('THE OTHER ONE — a section is ONE line on a class sheet, not four', () => {
    // The defect that failed the first review: subject, class-section,
    // teacher and room each took a line, so six sections was twenty-four
    // lines in a single cell and the grid collapsed into a grey band.
    const six = 'কখগঘঙচ'.split('').map((sec) =>
      lesson({ sectionLabel: sec, dayOfWeek: 0, periodNo: 1 }));
    const b = buildRoutineSheet(data({
      scopeKind: 'class', scopeTitle: 'নবম শ্রেণি', lessons: six }));

    assert.equal((b.bodyHtml.match(/class="rt-line"/g) ?? []).length, 6,
      'six sections, six lines');
    // The old shape is gone entirely — `<br>` was how four lines were made.
    assert.doesNotMatch(b.bodyHtml, /<br>/,
      'a stacked cell is what made the sheet unreadable');
    // The section label sits in a column of its own so the eye runs down it.
    assert.match(b.bodyHtml, /<span class="rt-sec">ক<\/span>/);
    assert.match(routineSheetCss('landscape'), /\.rt-sec\{flex:none;min-width:[\d.]+mm/);
    // …and the lesson still says what a class board is asked: which
    // subject, and who is taking it.
    assert.match(b.bodyHtml, /<b>গণিত<\/b>/);
    assert.match(b.bodyHtml, /<span class="rt-who">রফিক স্যার<\/span>/);
    // The room is NOT here, and that is the measurement talking: with it,
    // every line wraps to two and ONE section fits a page instead of two.
    // It is on the section's own sheet, the teacher's and the room's.
    assert.doesNotMatch(b.bodyHtml, /১০১ নম্বর কক্ষ/);
  });

  test('a single-lesson sheet keeps its second line — it has the room for it', () => {
    const b = buildRoutineSheet(data());
    assert.match(b.bodyHtml, /<div class="rt-lesson"><b>গণিত<\/b>/);
    assert.match(b.bodyHtml, /<span class="rt-who">রফিক স্যার · ১০১ নম্বর কক্ষ<\/span>/);
    assert.doesNotMatch(b.bodyHtml, /rt-line/);
  });

  test('§3 — a class page says which of its sections are on it', () => {
    // A class too wide for one page splits into several, and this caption is
    // the only thing that tells a reader which sheet is theirs.
    const b = buildRoutineSheet(data({
      scopeKind: 'class', scopeTitle: 'নবম শ্রেণি',
      lessons: ['ক', 'খ', 'গ'].map((s) => lesson({ sectionLabel: s })),
    }));
    assert.match(b.bodyHtml, /<p class="rt-sections">শাখা: ক, খ, গ<\/p>/);
    // A section's own sheet is already named by its title; no caption.
    assert.doesNotMatch(buildRoutineSheet(data()).bodyHtml, /rt-sections/);
  });

  test('density and orientation are the SAME decision, not two lists', () => {
    for (const s of ['institution', 'class', 'group', 'stream'] as RoutineScope[]) {
      assert.equal(routineIsDense(s), true, s);
      assert.equal(routineOrientation(s), 'landscape', s);
    }
    for (const s of ['section', 'teacher', 'room', 'student'] as RoutineScope[]) {
      assert.equal(routineIsDense(s), false, s);
      assert.equal(routineOrientation(s), 'portrait', s);
    }
  });

  test('§14 — the page box is A4 in the orientation chosen', () => {
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
    assert.match(css, /\.rt-lesson,\.rt-line\{page-break-inside:avoid/);
    // The BODY must flow — a table that refuses to break at all simply
    // overflows the last page.
    assert.match(css, /\.rt-grid tbody\{break-inside:auto\}/);
  });

  /* ──────────────────── §9 board · §10 grayscale · §12 foot ────────── */

  test('§9 — notice-board mode scales the type and changes nothing else', () => {
    const normal = routineSheetCss('landscape');
    const board = routineSheetCss('landscape', true);
    const size = (css: string, sel: string) =>
      Number(css.match(new RegExp(`\\${sel}\\{[^}]*font-size:([\\d.]+)px`))![1]);
    for (const sel of ['.rt-no', '.rt-time', '.rt-grid']) {
      assert.ok(size(board, sel) > size(normal, sel),
        `${sel}: ${size(board, sel)} vs ${size(normal, sel)}`);
    }
    // A mode that also dropped or reordered content would give a school two
    // documents to reconcile. Same selectors, same rules, different scale.
    const shape = (css: string) => (css.match(/\.[a-z-]+(?=\{)/g) ?? []).join(',');
    assert.equal(shape(board), shape(normal));
  });

  test('§10 — nothing on the sheet is printed in a hue', () => {
    // Grayscale safety is not "it happens to look fine": every colour the
    // sheet sets is near-neutral, so a mono laser renders the same tones a
    // colour one does. Meaning is carried by rules, weight and words —
    // a break by its band, an empty hour by "—".
    for (const css of [routineSheetCss('portrait'), routineSheetCss('landscape', true)]) {
      for (const hex of css.match(/#[0-9a-f]{6}/g) ?? []) {
        const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
        assert.ok(Math.max(r, g, b) - Math.min(r, g, b) < 40,
          `${hex} carries a hue and will not survive a mono printer`);
      }
    }
  });

  test('§12 — every page foots with its version, its date and its number', () => {
    const b = buildRoutineSheet(data({ pageNo: 3, pageCount: 7 }));
    assert.match(b.bodyHtml, /<div class="rt-foot">/);
    assert.match(b.bodyHtml, /সংস্করণ ২ · প্রকাশ ২ মার্চ ২০২৬/);
    assert.match(b.bodyHtml, /পৃষ্ঠা ৩ \/ ৭/);
    // A single-page sheet has no "page 1 of 1" to add.
    assert.doesNotMatch(buildRoutineSheet(data()).bodyHtml, /পৃষ্ঠা/);
  });

  /* ────────────────────────── §4 the header block ───────────────────── */

  test('§4 — the sheet states the year, the shift, the version and the date', () => {
    const b = buildRoutineSheet(data());
    const meta = Object.fromEntries(b.meta.map((m) => [m.label, m.value]));
    assert.equal(meta['শিক্ষাবর্ষ'], '২০২৬');
    assert.equal(meta['শিফট'], 'একক');
    assert.equal(meta['সংস্করণ'], '২', 'a Bangla numeral, not 2');
    assert.match(meta['প্রকাশ'], /২০২৬/, 'a date with its year');
    assert.equal(b.title, 'শাখার রুটিন — নবম শ্রেণি — ক');
    // R-5's signature BLOCK is off and the line lives in the footer: the
    // block's 56px blank gap is ~30mm at the foot of every page, and a class
    // page was over a sheet of A4 by about that much.
    assert.equal(b.showSignature, false);
    assert.match(b.bodyHtml, /<span class="rt-sign">প্রধান শিক্ষক<\/span>/);
  });

  test('§11 — the institution’s own sheet does not repeat the letterhead’s name', () => {
    const b = buildRoutineSheet(data({ scopeKind: 'institution', scopeTitle: 'ছোট স্কুল' }));
    assert.equal(b.title, ROUTINE_SCOPE_BN.institution);
    assert.doesNotMatch(b.title, /ছোট স্কুল/);
  });

  test('an unpublished date is simply absent, not an em-dash in the meta', () => {
    const b = buildRoutineSheet(data({ publishedAt: null }));
    assert.equal(b.meta.some((m) => m.label === 'প্রকাশ'), false);
  });

  /* ───────────────────── §9/§10 what a cell omits ────────────────────── */

  test('a sheet does not repeat what the page is already about', () => {
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

  /* ────────────────────────── empty and hostile ───────────────────────── */

  test('a selection with no classes says so rather than printing a blank grid', () => {
    const b = buildRoutineSheet(data({ lessons: [] }));
    assert.doesNotMatch(b.bodyHtml, /<table/);
    assert.match(b.bodyHtml, /কোনো ক্লাস নেই/,
      'a blank grid on a noticeboard is a claim that the school teaches nothing');
  });

  test('every school-typed value is escaped — the period label included', () => {
    const b = buildRoutineSheet(data({
      scopeTitle: '<script>x</script>',
      // The label and the band label are both new attack surface: they are
      // free text a school types into the period template.
      periods: [
        { periodNo: 1, labelBn: '<script>a</script>', startsAt: '10:00',
          endsAt: '10:45', kind: 'teaching' },
        { periodNo: 2, labelBn: '<img src=x onerror=2>', startsAt: '11:00',
          endsAt: '11:30', kind: 'tiffin' },
      ],
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
    // The band label's digit is localised before it is escaped, so the '2'
    // arrives as '২'. Escaping is what makes it inert, and it ran.
    assert.match(b.bodyHtml, /&lt;img src=x onerror=২&gt;/, 'the band label too');
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

  test('the school’s digits are printed in the reader’s numerals', () => {
    // A school that typed "1 নম্বর" into its period template must not put the
    // only Latin digit on an otherwise Bangla sheet. The WORDS stay the
    // school's; only the figures are localised.
    const b = buildRoutineSheet(data({
      periods: [{ periodNo: 1, labelBn: '1 নম্বর', startsAt: '10:00',
                  endsAt: '10:45', kind: 'teaching' }],
    }));
    assert.match(b.bodyHtml, /<span class="rt-no">১ নম্বর<\/span>/);
  });

  test('English keeps Latin numerals and the school’s own period names', () => {
    const b = buildRoutineSheet(data(), 'en');
    // There is ONE label, not one per locale, so an English sheet names the
    // hour the same way — the alternative is a computed number, and a
    // computed number is the off-by-one this replaced.
    assert.match(b.bodyHtml, /<span class="rt-no">১ম<\/span>/);
    assert.match(b.bodyHtml, /Period/);
    assert.match(b.bodyHtml, /10:00 AM–10:45 AM/, 'but the clock is Latin');
    assert.match(b.bodyHtml, /<span class="rt-sign">Head of Institution<\/span>/);
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
