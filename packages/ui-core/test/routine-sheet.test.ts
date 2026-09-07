/**
 * P9-9 — the printed routine, as paper.
 *
 * The builder is pure, so everything about the SHEET can be asserted without a
 * browser or a database. What matters:
 *
 *   1. THE HOUR'S ORDINAL COUNTS TAUGHT HOURS. `period_no` is a position in
 *      the day, not a count of teaching hours, and the seeded day shift puts
 *      tiffin at position 5 — so `ordinalBn(period_no)` printed "৬ষ্ঠ" over
 *      the hour every teacher calls "৫ম", off by one all afternoon.
 *
 *   2. THE CLOCK IS THE ONE BANGLADESH READS. "১৪:০০" beside a period column
 *      is read as a period number before it is read as a time. `দুপুর ২:০০`
 *      cannot be.
 *
 *   3. A SECTION IS TOLD BY A CHIP, A BORDER AND A TINT — in that order, so
 *      the page survives a photocopier. And a long section name is KEYED, not
 *      cut: the legend carries it in full.
 *
 *   4. A LESSON IS ONE LINE, NOT FOUR. A class of four sections used to put
 *      sixteen lines in one cell and compress the grid into a grey band.
 *
 *   5. THE PAPER FOLLOWS THE CONTENT. A section's week fits portrait; a whole
 *      class's does not.
 *
 *   6. EACH AUDIENCE'S SHEET DROPS WHAT IT IS ALREADY ABOUT (§9, §10).
 *
 *   7. EVERYTHING IS ESCAPED. Subject, teacher, room, section label and the
 *      break's label all come from text a school typed.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRoutineSheet, routineOrientation, routineIsDense, routineSheetCss,
  ROUTINE_SCOPE_BN, type RoutineSheetData, type RoutineScope,
} from '../src/documents.ts';
import { ordinalBn, formatClockRange, dayPartBn } from '../src/format.ts';
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

const ords = (h: string) =>
  [...h.matchAll(/<span class="rt-no">([^<]*)</g)].map((m) => m[1]);
const chips = (h: string) =>
  [...h.matchAll(/<span class="rt-sec">([^<]*)<\/span>/g)].map((m) => m[1]);

describe('P9-9 — the printed routine sheet', () => {
  /* ───────────────── §2 the hour, and what it is called ──────────────── */

  test('THE ONE THAT MATTERS — the ordinal counts TAUGHT hours, not rows', () => {
    // Position 6 in the seeded day shift is the hour the school labels ৫ম,
    // because tiffin holds position 5. `ordinalBn(period_no)` printed ৬ষ্ঠ
    // over it — off by one for the whole afternoon, in the one column a
    // reader uses to find their row.
    const b = buildRoutineSheet(data({
      periods: realDay(),
      lessons: [lesson({ periodNo: 6, startsAt: '11:30', endsAt: '12:10' })],
    }));
    assert.deepEqual(ords(b.bodyHtml),
      ['১ম', '২য়', '৩য়', '৪র্থ', '৫ম', '৬ষ্ঠ', '৭ম'],
      'seven taught hours, numbered as the school numbers them');

    // The proof it is the SEQUENCE and not the position: the fifth taught
    // hour is `period_no` 6, and ordinalBn(6) — the old output — is ৬ষ্ঠ.
    assert.equal(ordinalBn(6), '৬ষ্ঠ');
    assert.ok(b.bodyHtml.indexOf('৫ম') < b.bodyHtml.indexOf('গণিত'),
      '৫ম heads the row its lesson is in');
    // Bands are not hours and must not consume an ordinal.
    assert.equal(ords(b.bodyHtml).length, 7);
  });

  test('§2 — the ordinals are per-number, and the word rides beside them', () => {
    // format.ts warns about this in its own comment: P4 shipped "২ম" once.
    assert.deepEqual([1, 2, 3, 4, 5, 6].map(ordinalBn),
      ['১ম', '২য়', '৩য়', '৪র্থ', '৫ম', '৬ষ্ঠ']);
    assert.equal(ordinalBn(19), '১৯', 'past the table, no guessed suffix');
    const b = buildRoutineSheet(data());
    assert.match(b.bodyHtml, /<span class="rt-no">১ম<span class="rt-pd">পিরিয়ড</);
  });

  test('a hostile period label cannot reach the page at all', () => {
    // Teaching rows are numbered, not labelled, so the school's own text for
    // a taught hour is never rendered — the narrowest possible surface.
    const b = buildRoutineSheet(data({
      periods: [{ periodNo: 1, labelBn: '<script>x</script>', startsAt: '10:00',
                  endsAt: '10:45', kind: 'teaching' }],
    }));
    assert.doesNotMatch(b.bodyHtml, /script/);
    assert.match(b.bodyHtml, /<span class="rt-no">১ম</);
  });

  /* ──────────────────── §3 the Bangladeshi clock ─────────────────────── */

  test('§3 — the clock is 12-hour with the part of the day, never 24-hour', () => {
    assert.equal(formatClockRange('10:00', '10:45', 'bn'), 'সকাল ১০:০০–১০:৪৫');
    assert.equal(formatClockRange('13:00', '13:45', 'bn'), 'দুপুর ১:০০–১:৪৫');
    assert.equal(formatClockRange('13:45', '14:30', 'bn'), 'দুপুর ১:৪৫–২:৩০');
    assert.equal(formatClockRange('11:30', '12:15', 'bn'), 'সকাল ১১:৩০–১২:১৫',
      'the part of the day is named once, from the start');
    assert.equal(formatClockRange('15:20', '16:00', 'bn'), 'বিকাল ৩:২০–৪:০০');
    assert.equal(formatClockRange('10:00', '10:45', 'en'), '10:00–10:45 AM');

    for (const [h, part] of [['05:00', 'ভোর'], ['09:00', 'সকাল'],
      ['12:30', 'দুপুর'], ['16:00', 'বিকাল'], ['18:30', 'সন্ধ্যা'],
      ['21:00', 'রাত']] as const) {
      assert.equal(dayPartBn(h), part, h);
    }
  });

  test('§3 — no sheet prints a 13 or a 14 where a period number could be read', () => {
    const b = buildRoutineSheet(data({
      periods: realDay(),
      lessons: [lesson({ periodNo: 9, startsAt: '13:20', endsAt: '14:00' })],
    }));
    // The afternoon hours are the ones that used to read as ১৩:২০–১৪:০০.
    assert.match(b.bodyHtml, /দুপুর ১:২০–২:০০/);
    assert.doesNotMatch(b.bodyHtml, /১৩:|১৪:/,
      'a 24-hour clock beside a period column is read as a period');
  });

  /* ───────────────── §4 the break, unmistakable ──────────────────────── */

  test('§4 — tiffin is a band across the whole grid, named and timed', () => {
    const b = buildRoutineSheet(data({ periods: realDay() }));
    assert.match(b.bodyHtml,
      /<tr class="rt-band"><td colspan="3"><span class="rt-band-name">টিফিন<\/span>/);
    assert.match(b.bodyHtml, /<span class="rt-band-time">সকাল ১১:০০–১১:৩০<\/span>/);
    for (const n of ['সমাবেশ', 'টিফিন', 'জোহর']) {
      assert.ok(b.bodyHtml.includes(`<span class="rt-band-name">${n}</span>`), n);
    }
    assert.equal((b.bodyHtml.match(/rt-band"/g) ?? []).length, 3);
    // A band is not a row of empty hours: it must not draw day cells.
    assert.doesNotMatch(b.bodyHtml.match(/<tr class="rt-band">.*?<\/tr>/)![0], /rt-empty/);
    // §10. It is a band because of its RULES, not its tint — the rules are
    // what a photocopy keeps.
    assert.match(routineSheetCss('landscape'),
      /\.rt-band td\{[^}]*border-top:2px solid #374151;border-bottom:2px solid #374151/);
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

  /* ─────────────── §1/§5/§6 sections: chip, tint, legend ─────────────── */

  test('THE OTHER ONE — a section is ONE line, chipped and tinted', () => {
    // The defect that failed the first review: subject, class-section,
    // teacher and room each took a line, so four sections was sixteen lines
    // in a single cell and the grid collapsed into a grey band.
    const four = 'কখগঘ'.split('').map((sec) =>
      lesson({ sectionLabel: sec, dayOfWeek: 0, periodNo: 1 }));
    const b = buildRoutineSheet(data({
      scopeKind: 'class', scopeTitle: 'নবম শ্রেণি', lessons: four }));

    assert.equal((b.bodyHtml.match(/class="rt-line/g) ?? []).length, 4);
    assert.doesNotMatch(b.bodyHtml, /<br>/, 'the stacked cell is gone');
    // Each section gets its OWN tint class, so a reader follows one down.
    assert.deepEqual(
      [...b.bodyHtml.matchAll(/rt-line rt-s(\d)/g)].map((m) => m[1]),
      ['0', '1', '2', '3']);
    assert.match(b.bodyHtml, /<span class="rt-sec">ক<\/span>/);
    assert.match(b.bodyHtml, /<b>গণিত<\/b>/);
    assert.match(b.bodyHtml, /<span class="rt-who">রফিক স্যার<\/span>/);
    // The room is NOT here, and that is the measurement talking: with it
    // every line wraps to two and one section fits a page instead of two.
    assert.doesNotMatch(b.bodyHtml, /১০১ নম্বর কক্ষ/);
  });

  test('§1/§10 — the tint is the SECOND signal, and every one is near-neutral', () => {
    const css = routineSheetCss('landscape');
    // Eight tints, all defined.
    for (let i = 0; i < 8; i++) assert.match(css, new RegExp(`\\.rt-s${i}\\{background:#`));
    // The first section takes no tint — a page with no white has nowhere to rest.
    assert.match(css, /\.rt-s0\{background:#ffffff\}/);
    // The chip carries a border and a weight, so a photocopy that loses every
    // tint still tells one section from the next.
    assert.match(css, /\.rt-sec\{[^}]*font-weight:700/);
    assert.match(css, /\.rt-sec\{[^}]*border:1px solid #9ca3af/);
    // Grayscale safety, asserted rather than hoped: no hue anywhere.
    for (const c of [routineSheetCss('portrait'), routineSheetCss('landscape', true), css]) {
      for (const hex of c.match(/#[0-9a-f]{6}/g) ?? []) {
        const [r, g, bl] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
        assert.ok(Math.max(r, g, bl) - Math.min(r, g, bl) < 40,
          `${hex} carries a hue and will not survive a mono printer`);
      }
    }
  });

  test('§5/§6 — a long section name is KEYED, never cut', () => {
    const long = ['বিজ্ঞান ও প্রযুক্তি শাখা', 'ব্যবসায় শিক্ষা',
                  'মানবিক ও সামাজিক বিজ্ঞান', 'HSC Science Group'];
    const b = buildRoutineSheet(data({
      scopeKind: 'class', scopeTitle: 'একাদশ শ্রেণি',
      lessons: long.map((s) => lesson({ sectionLabel: s })),
    }));
    // Cells carry a numeral, not the name — §6's whole point.
    assert.deepEqual([...new Set(chips(b.bodyHtml))].sort(), ['১', '২', '৩', '৪']);
    const grid = b.bodyHtml.slice(b.bodyHtml.indexOf('<table'));
    for (const n of long) {
      // …and every name is on the page IN FULL, in the legend.
      assert.ok(b.bodyHtml.includes(`<span>${n}</span>`), n);
      // The grid itself never repeats it.
      assert.ok(!grid.includes(n), `${n} repeated in the grid`);
    }
    assert.match(b.bodyHtml, /<p class="rt-legend">/);
  });

  test('§5 — short labels stay themselves, and the legend does not echo them', () => {
    const b = buildRoutineSheet(data({
      scopeKind: 'class', scopeTitle: 'নবম শ্রেণি',
      lessons: ['ক', 'খ'].map((s) => lesson({ sectionLabel: s })),
    }));
    assert.deepEqual([...new Set(chips(b.bodyHtml))].sort(), ['ক', 'খ']);
    // "ক ক" in the legend reads as a mistake; the swatch alone carries it.
    assert.doesNotMatch(b.bodyHtml, /<span class="rt-sec">ক<\/span><span>ক<\/span>/);
  });

  test('§5 — one long name keys the whole page, not just itself', () => {
    // A grid where some cells say 'ক' and others say '২' is one where the
    // reader has to work out which scheme they are looking at.
    const b = buildRoutineSheet(data({
      scopeKind: 'class',
      lessons: [lesson({ sectionLabel: 'ক' }),
                lesson({ sectionLabel: 'বিজ্ঞান ও প্রযুক্তি শাখা' })],
    }));
    assert.deepEqual([...new Set(chips(b.bodyHtml))].sort(), ['১', '২']);
  });

  test('§5 — long subjects and long teacher names wrap, and never overflow', () => {
    const css = routineSheetCss('landscape');
    // The text wraps; the chip does not shrink; nothing is clipped, because a
    // silently cut subject on a routine is worse than a taller row.
    assert.match(css, /\.rt-what\{min-width:0;overflow-wrap:anywhere;word-break:break-word\}/);
    assert.match(css, /\.rt-sec\{flex:none/);
    assert.doesNotMatch(css, /text-overflow:ellipsis|line-clamp/);
    const b = buildRoutineSheet(data({
      scopeKind: 'class',
      lessons: [lesson({
        subjectBn: 'তথ্য ও যোগাযোগ প্রযুক্তি এবং কারিগরি শিক্ষা',
        teacherBn: 'অধ্যাপক মোহাম্মদ আব্দুর রহমান চৌধুরী',
      })],
    }));
    assert.match(b.bodyHtml, /তথ্য ও যোগাযোগ প্রযুক্তি এবং কারিগরি শিক্ষা/);
    assert.match(b.bodyHtml, /অধ্যাপক মোহাম্মদ আব্দুর রহমান চৌধুরী/);
  });

  /* ────────────────────── §12/§13 paper and pages ────────────────────── */

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

  test('§12 — the page box is A4 in the orientation chosen', () => {
    const p = routineSheetCss('portrait');
    const l = routineSheetCss('landscape');
    assert.match(p, /@page\{size:A4 portrait/);
    assert.match(l, /@page\{size:A4 landscape/);
    // Without this the letterhead keeps a 210mm column in a 297mm sheet.
    assert.match(l, /\.doc\{max-width:297mm;min-height:210mm/);
    assert.doesNotMatch(p, /max-width:297mm/);
  });

  test('§6 — the rules that keep a grid readable across pages are present', () => {
    const css = routineSheetCss('landscape');
    assert.match(css, /\.rt-grid tr\{page-break-inside:avoid;break-inside:avoid\}/);
    assert.match(css, /\.rt-grid thead\{display:table-header-group\}/);
    assert.match(css, /\.rt-lesson,\.rt-line\{page-break-inside:avoid/);
    assert.match(css, /\.rt-grid tbody\{break-inside:auto\}/);
  });

  test('§9 — the weights step down, so a reader lands on the level they want', () => {
    const css = routineSheetCss('landscape');
    const size = (sel: string) =>
      Number(css.match(new RegExp(`\\${sel}\\{[^}]*font-size:([\\d.]+)px`))![1]);
    // Class title > period ordinal > grid body > clock.
    assert.ok(size('.doc-title') > size('.rt-no'), 'class over period');
    assert.ok(size('.rt-no') > size('.rt-grid'), 'period over body');
    assert.ok(size('.rt-grid') > size('.rt-time'), 'body over clock');
    assert.ok(size('.rt-time') >= 9, `the clock is still legible: ${size('.rt-time')}px`);
    // Bangla numerals take the numeric face; the words beside them do not.
    assert.match(css, /\.rt-no\{[^}]*Noto Sans Bengali/);
    assert.match(css, /\.rt-time\{[^}]*Noto Sans Bengali/);
    assert.match(css, /\.rt-pd\{[^}]*Hind Siliguri/);
  });

  test('§11 — notice-board mode scales the type and changes nothing else', () => {
    const normal = routineSheetCss('landscape');
    const board = routineSheetCss('landscape', true);
    const size = (css: string, sel: string) =>
      Number(css.match(new RegExp(`\\${sel}\\{[^}]*font-size:([\\d.]+)px`))![1]);
    for (const sel of ['.rt-no', '.rt-time', '.rt-grid']) {
      assert.ok(size(board, sel) > size(normal, sel), sel);
    }
    const shape = (css: string) => (css.match(/\.[a-z-]+\d*(?=\{)/g) ?? []).join(',');
    assert.equal(shape(board), shape(normal), 'same rules, different scale');
  });

  test('§12 — every page foots with its version, its date and its number', () => {
    const b = buildRoutineSheet(data({ pageNo: 3, pageCount: 7 }));
    assert.match(b.bodyHtml, /<div class="rt-foot">/);
    assert.match(b.bodyHtml, /সংস্করণ ২ · প্রকাশ ২ মার্চ ২০২৬/);
    assert.match(b.bodyHtml, /পৃষ্ঠা ৩ \/ ৭/);
    assert.match(b.bodyHtml, /<span class="rt-sign">প্রধান শিক্ষক<\/span>/);
    assert.equal(b.showSignature, false, 'the block signature is ~30mm of page');
    assert.doesNotMatch(buildRoutineSheet(data()).bodyHtml, /পৃষ্ঠা/,
      '"page 1 of 1" is noise');
  });

  /* ────────────────────────── the header block ───────────────────────── */

  test('the sheet states the year, the shift, the version and the date', () => {
    const b = buildRoutineSheet(data());
    const meta = Object.fromEntries(b.meta.map((m) => [m.label, m.value]));
    assert.equal(meta['শিক্ষাবর্ষ'], '২০২৬');
    assert.equal(meta['শিফট'], 'একক');
    assert.equal(meta['সংস্করণ'], '২', 'a Bangla numeral, not 2');
    assert.match(meta['প্রকাশ'], /২০২৬/);
    assert.equal(b.title, 'শাখার রুটিন — নবম শ্রেণি — ক');
  });

  test('the institution’s own sheet does not repeat the letterhead’s name', () => {
    const b = buildRoutineSheet(data({ scopeKind: 'institution', scopeTitle: 'ছোট স্কুল' }));
    assert.equal(b.title, ROUTINE_SCOPE_BN.institution);
    assert.doesNotMatch(b.title, /ছোট স্কুল/);
  });

  test('an unpublished date is simply absent, not an em-dash in the meta', () => {
    assert.equal(
      buildRoutineSheet(data({ publishedAt: null })).meta.some((m) => m.label === 'প্রকাশ'),
      false);
  });

  /* ───────────────────── §15 what each sheet omits ───────────────────── */

  test('a sheet does not repeat what the page is already about', () => {
    const l = lesson();
    const teacher = buildRoutineSheet(data({ scopeKind: 'teacher', lessons: [l] }));
    assert.doesNotMatch(teacher.bodyHtml, /রফিক স্যার/, 'his own sheet');
    assert.match(teacher.bodyHtml, /নবম শ্রেণি-ক/, 'but the section he is with');
    assert.match(teacher.bodyHtml, /১০১ নম্বর কক্ষ/, 'and the room he is in');

    const room = buildRoutineSheet(data({ scopeKind: 'room', lessons: [l] }));
    assert.doesNotMatch(room.bodyHtml, /১০১ নম্বর কক্ষ/, 'the room’s own sheet');
    assert.match(room.bodyHtml, /রফিক স্যার/);

    const section = buildRoutineSheet(data({ scopeKind: 'section', lessons: [l] }));
    assert.doesNotMatch(section.bodyHtml, /নবম শ্রেণি-ক/, 'the section’s own sheet');
    assert.match(section.bodyHtml, /রফিক স্যার/);
    // A single-lesson sheet is not chipped or tinted — there is nothing to
    // tell apart, and §15 forbids forcing the institution design onto it.
    assert.doesNotMatch(section.bodyHtml, /rt-line|rt-legend/);
  });

  test('a split hour is marked, so a reader knows the class divides', () => {
    assert.match(
      buildRoutineSheet(data({ lessons: [lesson({ isParallel: true })] })).bodyHtml,
      /<i>বিভাজিত<\/i>/);
  });

  test('an hour with no class is a dash, not a hole', () => {
    // Two periods x two days = four cells, one filled.
    assert.equal((buildRoutineSheet(data()).bodyHtml.match(/rt-empty/g) ?? []).length, 3);
  });

  /* ────────────────────────── empty and hostile ───────────────────────── */

  test('a selection with no classes says so rather than printing a blank grid', () => {
    const b = buildRoutineSheet(data({ lessons: [] }));
    assert.doesNotMatch(b.bodyHtml, /<table/);
    assert.match(b.bodyHtml, /কোনো ক্লাস নেই/,
      'a blank grid on a noticeboard is a claim that the school teaches nothing');
  });

  test('every school-typed value is escaped — the break label and the chip too', () => {
    const b = buildRoutineSheet(data({
      scopeTitle: '<script>x</script>',
      scopeKind: 'class',
      periods: [
        { periodNo: 1, labelBn: 'ok', startsAt: '10:00', endsAt: '10:45', kind: 'teaching' },
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
    // The band's digit is localised before it is escaped, so '2' arrives as ২.
    assert.match(b.bodyHtml, /&lt;img src=x onerror=২&gt;/, 'the band label too');
    assert.match(b.bodyHtml, /A &amp; B/);
    assert.match(b.bodyHtml, /&lt;&#39;&gt;/, 'the section chip and legend');

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

  test('English keeps Latin numerals and an AM/PM clock', () => {
    const b = buildRoutineSheet(data(), 'en');
    assert.match(b.bodyHtml, /<span class="rt-no">1<span class="rt-pd">period</);
    assert.match(b.bodyHtml, /Period/);
    assert.match(b.bodyHtml, /10:00–10:45 AM/);
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
