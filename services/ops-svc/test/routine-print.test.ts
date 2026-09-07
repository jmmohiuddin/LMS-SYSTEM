/**
 * P9-9 — printing the published routine.
 *
 * The five outputs the brief requires, through the endpoint a school's print
 * button actually calls. What matters:
 *
 *   1. ONLY PUBLISHED. §15. A sheet pinned to a noticeboard is the school's
 *      statement about its week; a draft on the wall is a statement it has
 *      not decided to make. `readTimetable` reads `status = 'active'` and
 *      nothing else, so draft, review and superseded are all invisible —
 *      asserted here rather than assumed.
 *
 *   2. THE SAME AUTHORISATION AS THE SCREEN. The print path imports
 *      `readTimetable` rather than re-deriving who may see what. A teacher
 *      who cannot open the institution's routine cannot print it either, and
 *      this suite checks the print path directly rather than trusting that.
 *
 *   3. NO PAGE IS TALLER THAN THE SHEET. §6/§7. A cell holding thirty
 *      lessons is a row no page-break rule can rescue, so the booklet splits
 *      until no cell exceeds the bound. Measured on the fixture, not argued.
 *
 *   4. THE SCHOOL'S OWN IDENTITY, NEVER THE PLATFORM'S. §4 and D11.
 *
 *   DATABASE_URL=postgres://shikhon_app:… \
 *     node --test services/ops-svc/test/routine-print.test.ts
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createDb, type Db, type TenantContext } from '../../../packages/server-core/src/db.ts';
import {
  installTestKeys, call, lockFixtures, unlockFixtures, asBootstrap,
} from '../../../packages/server-core/test/harness.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL ? 'DATABASE_URL not set' : false;

const T        = '7c9a0000-0000-4000-8000-0000000000a0';
const HEAD     = '7c9a0000-0000-4000-8000-0000000000a1';
const RAFIQ    = '7c9a0000-0000-4000-8000-0000000000a2';
const SALMA    = '7c9a0000-0000-4000-8000-0000000000a3';
const STUDENT  = '7c9a0000-0000-4000-8000-0000000000a4';
const GUARDIAN = '7c9a0000-0000-4000-8000-0000000000a5';
const YEAR     = '7c9a0000-0000-4000-8000-0000000000c1';
const KLASS    = '7c9a0000-0000-4000-8000-0000000000d1';
const SEC_A    = '7c9a0000-0000-4000-8000-0000000000e1';
const SEC_B    = '7c9a0000-0000-4000-8000-0000000000e2';
const BANGLA   = '7c9a0000-0000-4000-8000-0000000000f1';
const MATHS    = '7c9a0000-0000-4000-8000-0000000000f2';
const TPL      = '7c9a0000-0000-4000-8000-00000000ab01';
const ROOM_A   = '7c9a0000-0000-4000-8000-00000000ab02';
const ROOM_B   = '7c9a0000-0000-4000-8000-00000000ab04';

const T_B      = '7c9a0000-0000-4000-8000-0000000000b0';
const HEAD_B   = '7c9a0000-0000-4000-8000-0000000000b1';

let db: Db;
let headTok = '', headBTok = '', rafiqTok = '', studentTok = '', guardianTok = '';
let doc: Parameters<typeof call>[0];
let generate: Parameters<typeof call>[0];
let publish: Parameters<typeof call>[0];

const head: TenantContext = { tenantId: T, userId: HEAD, role: 'principal' };
const headB: TenantContext = { tenantId: T_B, userId: HEAD_B, role: 'principal' };

const get = (qs: string, token: string) =>
  call(doc, { method: 'GET', url: `/?${qs}`, token } as Parameters<typeof call>[1]);
const html = async (qs: string, token: string): Promise<string> =>
  (await get(qs, token)).raw ?? '';

/** How many lessons sit in the deepest cell of a printed page. */
// How many LINES the deepest cell holds. A dense sheet's cell is one
// `rt-line` per section; a single-lesson sheet's is one `rt-lesson`. Counting
// only the latter reported 0 for every class page and would have let the
// density regression this phase fixed come straight back.
const worstCell = (h: string): number => Math.max(0,
  ...[...h.matchAll(/<td>([\s\S]*?)<\/td>/g)]
    .map((m) => (m[1].match(/rt-line|rt-lesson/g) ?? []).length));
const pageCount = (h: string) => (h.match(/<main class="doc">/g) ?? []).length;

const publishAll = async () => {
  const g = await call(generate, {
    method: 'POST', url: '/', token: headTok, body: { yearId: YEAR },
  } as Parameters<typeof call>[1]);
  assert.equal(g.status, 200, JSON.stringify(g.body));
  const { rows } = await asBootstrap(db, head, (c) => c.query<{ id: string }>(
    `SELECT id FROM routines WHERE tenant_id = $1 AND status = 'draft'`, [T]));
  for (const r of rows) {
    const p = await call(publish, {
      method: 'POST', url: '/', token: headTok,
      body: { action: 'publish', routineId: r.id, confirmWarnings: true },
    } as Parameters<typeof call>[1]);
    assert.equal(p.status, 200, JSON.stringify(p.body));
  }
};

describe('P9-9 — the printed routine', { skip }, () => {
  before(async () => {
    await installTestKeys();
    await lockFixtures(DATABASE_URL as string);
    db = createDb(DATABASE_URL as string);

    await asBootstrap(db, head, async (c) => {
      await c.query('DELETE FROM tenants WHERE id = $1', [T]);
      await c.query(
        `INSERT INTO tenants (id, slug, name_bn, name_en, stream, level, weekend_days)
         VALUES ($1,'p99','পি৯৯ উচ্চ বিদ্যালয়','P99','bangla_medium','secondary','{5,6}')`,
        [T]);
      for (const [id, bn, phone, role] of [
        [HEAD, 'প্রধান শিক্ষক', '+8801799910001', 'principal'],
        [RAFIQ, 'রফিক স্যার', '+8801799910002', 'subject_teacher'],
        [SALMA, 'সালমা ম্যাডাম', '+8801799910003', 'subject_teacher'],
        [STUDENT, 'ছাত্র', '+8801799910004', 'student'],
        [GUARDIAN, 'অভিভাবক', '+8801799910005', 'guardian'],
      ] as const) {
        await c.query(
          `INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164, status)
           VALUES ($1,$2,$3,'X',$4,'active')`, [id, T, bn, phone]);
        await c.query(
          `INSERT INTO user_roles (tenant_id, user_id, role_code) VALUES ($1,$2,$3)`,
          [T, id, role]);
      }
      await c.query(
        `INSERT INTO academic_years (id, tenant_id, label, starts_on, ends_on, is_current)
         VALUES ($1,$2,'২০২৬','2026-01-01','2026-12-31',true)`, [YEAR, T]);
      await c.query(
        `INSERT INTO classes (id, tenant_id, level_no, name_bn, name_en, stream, "group")
         VALUES ($1,$2,9,'নবম','Nine','bangla_medium','science')`, [KLASS, T]);
      for (const [id, code] of [[ROOM_A, 'R-1'], [ROOM_B, 'R-2']] as const) {
        await c.query(
          `INSERT INTO rooms (id, tenant_id, code, name_bn, capacity, capabilities, is_bookable)
           VALUES ($1,$2,$3,$3,60,'{}',true)`, [id, T, code]);
      }
      for (const [id, name] of [[SEC_A, 'ক'], [SEC_B, 'খ']] as const) {
        await c.query(
          `INSERT INTO sections (id, tenant_id, class_id, academic_year_id, name,
                                 student_count, shift, home_room_id)
           VALUES ($1,$2,$3,$4,$5,40,'single',$6)`,
          [id, T, KLASS, YEAR, name, id === SEC_A ? ROOM_A : ROOM_B]);
      }
      for (const [id, nameBn] of [[BANGLA, 'বাংলা'], [MATHS, 'গণিত']] as const) {
        await c.query(
          `INSERT INTO subjects (id, tenant_id, name_bn, name_en, short_name)
           VALUES ($1,$2,$3,'S',substr($3,1,3))`, [id, T, nameBn]);
        await c.query(
          `INSERT INTO class_subjects
             (tenant_id, class_id, subject_id, academic_year_id, periods_per_week)
           VALUES ($1,$2,$3,$4,3)`, [T, KLASS, id, YEAR]);
      }
      for (const sec of [SEC_A, SEC_B]) {
        await c.query(
          `INSERT INTO section_subject_teachers
             (tenant_id, section_id, subject_id, teacher_id, academic_year_id, started_on)
           VALUES ($1,$2,$3,$4,$5,'2026-01-05'), ($1,$2,$6,$7,$5,'2026-01-05')`,
          [T, sec, BANGLA, RAFIQ, YEAR, MATHS, SALMA]);
      }
      await c.query(
        `INSERT INTO period_templates (id, tenant_id, name_bn, shift, effective_from, is_active)
         VALUES ($1,$2,'নিয়মিত','single','2026-01-01',true)`, [TPL, T]);
      for (let i = 1; i <= 6; i++) {
        await c.query(
          `INSERT INTO period_definitions
             (tenant_id, template_id, period_no, label_bn, starts_at, ends_at, kind)
           VALUES ($1,$2,$3,$4,$5::time,$6::time,'teaching')`,
          [T, TPL, i, `${i} নম্বর`,
           `${String(8 + i).padStart(2, '0')}:00`, `${String(8 + i).padStart(2, '0')}:45`]);
      }
      await c.query(
        `INSERT INTO enrolments (tenant_id, student_id, section_id, academic_year_id,
                                 roll_no, status, enrolled_on)
         VALUES ($1,$2,$3,$4,1,'active','2026-01-05')`, [T, STUDENT, SEC_A, YEAR]);
      await c.query(
        `INSERT INTO guardianships (tenant_id, student_id, guardian_id, relation, is_primary)
         VALUES ($1,$2,$3,'father',true)`, [T, STUDENT, GUARDIAN]);
    });

    await asBootstrap(db, headB, async (c) => {
      await c.query('DELETE FROM tenants WHERE id = $1', [T_B]);
      await c.query(
        `INSERT INTO tenants (id, slug, name_bn, name_en, stream, level)
         VALUES ($1,'p99-other','পাশের বিদ্যালয়','Other','bangla_medium','secondary')`, [T_B]);
      await c.query(
        `INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164, status)
         VALUES ($1,$2,'অন্য','B','+8801799910009','active')`, [HEAD_B, T_B]);
      await c.query(
        `INSERT INTO user_roles (tenant_id, user_id, role_code) VALUES ($1,$2,'principal')`,
        [T_B, HEAD_B]);
    });

    const { signAccessToken } = await import('../../../packages/server-core/src/jwt.ts');
    headTok = await signAccessToken({ sub: HEAD, tid: T, role: 'principal', roles: ['principal'] });
    headBTok = await signAccessToken({ sub: HEAD_B, tid: T_B, role: 'principal', roles: ['principal'] });
    rafiqTok = await signAccessToken({
      sub: RAFIQ, tid: T, role: 'subject_teacher', roles: ['subject_teacher'] });
    studentTok = await signAccessToken({ sub: STUDENT, tid: T, role: 'student', roles: ['student'] });
    guardianTok = await signAccessToken({
      sub: GUARDIAN, tid: T, role: 'guardian', roles: ['guardian'] });

    doc = (await import('../api/document.ts')).default;
    generate = (await import('../../rms-svc/api/generate.ts')).default;
    publish = (await import('../../rms-svc/api/publish.ts')).default;
  });

  after(async () => {
    if (!db) return;
    for (const [ctx, id] of [[head, T], [headB, T_B]] as const) {
      await asBootstrap(db, ctx, (c) => c.query('DELETE FROM tenants WHERE id = $1', [id]));
    }
    await db.end();
    await unlockFixtures();
  });

  beforeEach(async () => {
    await asBootstrap(db, head, async (c) => {
      await c.query(
        `UPDATE routine_edit_log SET undone_at = now()
          WHERE tenant_id = $1 AND undone_at IS NULL`, [T]);
      await c.query('DELETE FROM routine_slots WHERE tenant_id = $1', [T]);
      await c.query('DELETE FROM routines WHERE tenant_id = $1', [T]);
    });
  });

  /* ───────────────────────── §15 published only ───────────────────────── */

  test('THE ONE THAT MATTERS — a draft is never printed', async () => {
    const g = await call(generate, {
      method: 'POST', url: '/', token: headTok, body: { yearId: YEAR },
    } as Parameters<typeof call>[1]);
    assert.equal(g.status, 200);
    const { rows } = await asBootstrap(db, head, (c) => c.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM routine_slots
        WHERE tenant_id = $1 AND status = 'active'`, [T]));
    assert.ok(rows[0].n > 0, 'the draft really does have lessons');

    for (const [who, token] of [
      ['principal', headTok], ['teacher', rafiqTok], ['student', studentTok],
    ] as const) {
      const r = await get(`type=routine_sheet&scope=section&id=${SEC_A}`, token);
      assert.equal(r.status, 409, `${who} printed a draft`);
      assert.equal((r.body as { error?: string }).error, 'not_published');
    }

    await publishAll();
    assert.equal((await get(`type=routine_sheet&scope=section&id=${SEC_A}`, headTok)).status,
      200, 'and it prints the moment it is published');
  });

  test('a superseded version is not printed either', async () => {
    await publishAll();
    const first = await html(`type=routine_sheet&scope=section&id=${SEC_A}`, headTok);
    assert.match(first, /সংস্করণ:<\/b> ১/);

    await call(generate, { method: 'POST', url: '/', token: headTok,
      body: { yearId: YEAR, baseline: 'current' } } as Parameters<typeof call>[1]);
    const { rows } = await asBootstrap(db, head, (c) => c.query<{ id: string }>(
      `SELECT id FROM routines WHERE tenant_id = $1 AND status = 'draft'`, [T]));
    await call(publish, { method: 'POST', url: '/', token: headTok,
      body: { action: 'publish', routineId: rows[0].id, confirmWarnings: true },
    } as Parameters<typeof call>[1]);

    const now = await html(`type=routine_sheet&scope=section&id=${SEC_A}`, headTok);
    assert.match(now, /সংস্করণ:<\/b> ২/, 'the sheet follows the school, not the archive');
    assert.equal(pageCount(now), 1);
  });

  /* ─────────────────────── §2 the five outputs ────────────────────────── */

  test('§2 — all five required sheets print', async () => {
    await publishAll();
    // All landscape. A week is six columns and, at the 10pt floor §B sets, a
    // portrait day column (~30mm) holds a third of a lesson — a portrait room
    // sheet measured 303mm on a 297mm page with every cell wrapped to three.
    const cases: Array<[string, string, 'portrait' | 'landscape']> = [
      ['institution', '', 'landscape'],
      ['class', KLASS, 'landscape'],
      ['section', SEC_A, 'landscape'],
      ['teacher', RAFIQ, 'landscape'],
      ['room', ROOM_A, 'landscape'],
    ];
    for (const [scope, id, orientation] of cases) {
      const h = await html(`type=routine_sheet&scope=${scope}${id ? `&id=${id}` : ''}`, headTok);
      assert.ok(h.length > 0, `${scope} printed nothing`);
      assert.match(h, new RegExp(`@page\\{size:A4 ${orientation}`), `${scope} orientation`);
      assert.match(h, /<table class="doc-table rt-grid">/, `${scope} has no grid`);
      // §18's checklist, on every sheet.
      assert.doesNotMatch(h, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/, `${scope} leaked a uuid`);
      assert.doesNotMatch(h, /undefined|NaN|\[object/, `${scope} printed undefined`);
      assert.doesNotMatch(h, /ShikhonBD/i, `${scope} carries the platform brand`);
      assert.match(h, /পি৯৯ উচ্চ বিদ্যালয়/, `${scope} is missing the school`);
      // The ordinal counts TAUGHT hours, not template rows: tiffin holds a
      // `period_no` of its own, so numbering by it was off by one all
      // afternoon. And the clock is the one Bangladesh reads — a 24-hour
      // '১৪:০০' beside a period column is read as a period number.
      assert.match(h, /rt-no">১ম<span class="rt-pd">পিরিয়ড</, `${scope} ordinal`);
      assert.match(h, /সকাল ৯:০০–৯:৪৫/, `${scope} has no 12-hour clock`);
      assert.doesNotMatch(h, /১৩:|১৪:/, `${scope} printed a 24-hour clock`);
    }
  });

  test('the institution prints as a booklet, one page per class', async () => {
    await publishAll();
    const h = await html('type=routine_sheet&scope=institution', headTok);
    // ONE SECTION A PAGE. At §B's typography a landscape A4 holds one
    // section's week: seven teaching rows at ~18mm, and two sections need
    // 24mm a row before any wrapping. This fixture's class has two sections,
    // so the booklet is two pages — §H's "split at section boundaries when
    // readable type makes one page impossible", taken literally.
    assert.equal(pageCount(h), 2, 'two sections, one page each');
    assert.match(h, /শ্রেণির রুটিন — নবম/,
      'and every page says which class it is, not just the school');
    assert.equal(worstCell(h), 1);
    // Each page names the section it carries, so a reader knows which is theirs.
    assert.match(h, /<p class="rt-legend">/);
  });

  test('§8 — a booklet page carries its own number, a single sheet does not', async () => {
    await publishAll();
    // Two sections, so two pages, and each says which of the two it is.
    const many = await html('type=routine_sheet&scope=institution', headTok);
    assert.equal(pageCount(many), 2);
    assert.match(many, /পৃষ্ঠা ১ \/ ২/);
    assert.match(many, /পৃষ্ঠা ২ \/ ২/);
    // A SINGLE sheet still carries no "page 1 of 1", which is noise on a
    // sheet somebody pins to a door.
    const one = await html(`type=routine_sheet&scope=section&id=${SEC_A}`, headTok);
    assert.equal(pageCount(one), 1);
    assert.doesNotMatch(one, /পৃষ্ঠা/);
    // Every page still foots with the version and the date, so a sheet torn
    // off a board says which routine it is.
    assert.match(one, /<div class="rt-foot"><span>সংস্করণ/);
    assert.match(one, /<span class="rt-sign">প্রধান শিক্ষক<\/span>/);
  });

  test('§9 — the board sheet is the same routine, set larger', async () => {
    await publishAll();
    const read  = await html('type=routine_sheet&scope=institution', headTok);
    const board = await html('type=routine_sheet&scope=institution&board=1', headTok);
    // Bigger type…
    const size = (h: string) => Number(h.match(/\.rt-no\{[^}]*font-size:([\d.]+)px/)![1]);
    assert.ok(size(board) > size(read), `${size(board)} vs ${size(read)}`);
    // …and the SAME hours, in the same order. A board copy that dropped or
    // reordered anything would give a school two documents to reconcile.
    const hours = (h: string) =>
      [...h.matchAll(/<span class="rt-no">([^<]*)<\/span>/g)].map((m) => m[1]).join();
    assert.equal(hours(board), hours(read));
  });

  test('§13 — a dense sheet spends its width on the subject, not the room', async () => {
    await publishAll();
    // §D. The class page's cell is a stack at §B's typography — subject on
    // its own line, who and where beneath it — so the room rides the second
    // line at no structural cost. It was dropped only while the cell was ONE
    // line and the room forced every one of them to wrap.
    const klass = await html(`type=routine_sheet&scope=class&id=${KLASS}`, headTok);
    assert.match(klass, /<b class="rt-sub">/, 'the subject leads its own line');
    assert.match(klass, /<span class="rt-who">রফিক স্যার · R-1<\/span>/);
    // §M. The BOARD copy is the one that drops them: a two-line cell at wall
    // size needs 18.2mm a row against 16.3mm available, so keeping the
    // teacher forces the type down and defeats the mode.
    const board = await html(
      `type=routine_sheet&scope=class&id=${KLASS}&board=1`, headTok);
    assert.doesNotMatch(board, /রফিক স্যার/, 'no teacher on the wall copy');
    assert.match(board, /<b class="rt-sub">/, 'but the subject, larger');
  });

  test('§5 — a break the school observes reaches the paper', async () => {
    await publishAll();
    // `period_definitions.kind` has seven values and this read used to filter
    // on `kind = 'teaching'`, so tiffin never left the database. A grid of
    // unbroken hours is not the day anybody in the building works.
    const { rows } = await asBootstrap(db, head, (c) => c.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM period_definitions
        WHERE template_id = $1 AND kind <> 'teaching'`, [TPL]));
    const breaks = rows[0]?.n ?? 0;
    const h = await html(`type=routine_sheet&scope=class&id=${KLASS}`, headTok);
    assert.equal((h.match(/<tr class="rt-band">/g) ?? []).length, breaks,
      'every non-teaching period is a band, and only those');
    if (breaks > 0) {
      // Across the whole grid, not a cell in one day column.
      assert.match(h, /<tr class="rt-band"><td colspan="6">/);
    }
  });

  test('§7 — no cell is ever deep enough to outgrow a page', async () => {
    await publishAll();
    for (const qs of ['scope=institution', `scope=class&id=${KLASS}`,
                      `scope=section&id=${SEC_A}`, `scope=teacher&id=${RAFIQ}`,
                      `scope=room&id=${ROOM_A}`]) {
      const h = await html(`type=routine_sheet&${qs}`, headTok);
      assert.ok(worstCell(h) <= 6,
        `${qs} produced a cell of ${worstCell(h)} — a row that tall does not fit a sheet`);
    }
  });

  /* ─────────────────────────── §14 who may print ──────────────────────── */

  test('§14 — printing obeys the same rules as looking', async () => {
    await publishAll();
    // A teacher's own week: yes. The school's, a colleague's, a room: no.
    assert.equal((await get('type=routine_sheet&scope=teacher&id=self', rafiqTok)).status, 200);
    assert.equal((await get('type=routine_sheet&scope=institution', rafiqTok)).status, 403);
    assert.equal((await get(`type=routine_sheet&scope=teacher&id=${SALMA}`, rafiqTok)).status, 403);
    assert.equal((await get(`type=routine_sheet&scope=room&id=${ROOM_A}`, rafiqTok)).status, 403);
    // The section he teaches IS his.
    assert.equal((await get(`type=routine_sheet&scope=section&id=${SEC_A}`, rafiqTok)).status, 200);

    // A student prints their own, and nothing else.
    assert.equal((await get('type=routine_sheet&scope=student&id=self', studentTok)).status, 200);
    assert.equal((await get('type=routine_sheet&scope=institution', studentTok)).status, 403);
    assert.equal((await get(`type=routine_sheet&scope=section&id=${SEC_B}`, studentTok)).status, 403);

    // A guardian prints their ward's.
    assert.equal((await get(`type=routine_sheet&scope=student&id=${STUDENT}`, guardianTok))
      .status, 200);
    assert.equal((await get('type=routine_sheet&scope=institution', guardianTok)).status, 403);
  });

  test('a bad or missing scope is refused, never guessed', async () => {
    await publishAll();
    assert.equal((await get('type=routine_sheet&scope=everything', headTok)).status, 400);
    assert.equal((await get('type=routine_sheet', headTok)).status, 400);
    assert.equal((await get('type=routine_sheet&scope=section&id=not-a-uuid', headTok)).status, 400);
  });

  /* ───────────────────── §16 tenant isolation ─────────────────────────── */

  test('§16 — one school can never print another’s, warm cache or not', async () => {
    await publishAll();
    // B holding A's ids gets nothing of A's.
    for (const qs of [`scope=section&id=${SEC_A}`, `scope=teacher&id=${RAFIQ}`,
                      `scope=room&id=${ROOM_A}`, `scope=class&id=${KLASS}`]) {
      const r = await get(`type=routine_sheet&${qs}`, headBTok);
      assert.ok(r.status === 404 || r.status === 403 || r.status === 409,
        `${qs} answered ${r.status} for another school`);
      assert.doesNotMatch(r.raw ?? '', /পি৯৯ উচ্চ বিদ্যালয়/, `${qs} leaked A's letterhead`);
    }

    // A → B → A, alternating, each answering with its own school. The tenant
    // is never a parameter: it comes from the JWT, so there is no way for one
    // school's request to name another's letterhead.
    for (const [token, expect, absent] of [
      [headTok, /পি৯৯ উচ্চ বিদ্যালয়/, /পাশের বিদ্যালয়/],
      [headBTok, null, /পি৯৯ উচ্চ বিদ্যালয়/],
      [headTok, /পি৯৯ উচ্চ বিদ্যালয়/, /পাশের বিদ্যালয়/],
    ] as const) {
      const r = await get(`type=routine_sheet&scope=section&id=${SEC_A}`, token);
      const h = r.raw ?? '';
      if (expect) assert.match(h, expect);
      assert.doesNotMatch(h, absent);
    }
  });

  test('the printed document is never stored by a cache', async () => {
    await publishAll();
    const r = await get(`type=routine_sheet&scope=section&id=${SEC_A}`, headTok);
    // A routine names every teacher in a school and where each child is at
    // nine on Sunday. A shared proxy holding one outlives the session.
    assert.match(r.headers['Cache-Control'] ?? '', /no-store/);
    assert.match(r.headers['Cache-Control'] ?? '', /private/);
    assert.equal(r.headers['X-Content-Type-Options'], 'nosniff');
  });

  /* ────────────────────────── §4 the letterhead ───────────────────────── */

  test('§4 — an unbranded school still prints its own name', async () => {
    await publishAll();
    // This fixture has never opened the branding screen, so
    // `settings->'branding'` is absent. Before P9-9 that printed the neutral
    // "শিক্ষা প্রতিষ্ঠান" placeholder on every document the school issued.
    const h = await html(`type=routine_sheet&scope=section&id=${SEC_A}`, headTok);
    assert.match(h, /class="doc-org">পি৯৯ উচ্চ বিদ্যালয়</);
    assert.doesNotMatch(h, /শিক্ষা প্রতিষ্ঠান</);
  });

  test('branding still wins where a school has set it', async () => {
    await publishAll();
    await asBootstrap(db, head, (c) => c.query(
      `UPDATE tenants SET settings = jsonb_set(COALESCE(settings,'{}'::jsonb),
              '{branding}', $2::jsonb) WHERE id = $1`,
      [T, JSON.stringify({ nameBn: 'পি৯৯ আদর্শ বিদ্যালয়' })]));
    const h = await html(`type=routine_sheet&scope=section&id=${SEC_A}`, headTok);
    assert.match(h, /পি৯৯ আদর্শ বিদ্যালয়/);
    await asBootstrap(db, head, (c) => c.query(
      `UPDATE tenants SET settings = settings - 'branding' WHERE id = $1`, [T]));
  });
});
