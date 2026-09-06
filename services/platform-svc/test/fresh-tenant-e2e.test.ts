/**
 * P-ops §E — a brand-new institution, from nothing to a published exam.
 *
 * Every other suite starts from a fixture built by direct INSERT, because
 * that is the cheap way to test one endpoint. The cost of doing it everywhere
 * is that nobody ever walks the road a real school walks, and the gaps in
 * that road are invisible: `fee_structures` had no writer for months, exams
 * had a writer and no screen, `routine_slots` had zero rows in every tenant
 * on the box. Each of those was found by asking "can a school actually do
 * this?" and none by a unit test.
 *
 * So this file creates a school through the operator console and then drives
 * the product's own endpoints, in the order an office would, with no direct
 * INSERT anywhere in the happy path.
 *
 * ── The question it is really answering ────────────────────────────────────
 * "What still needs manual SQL?"
 *
 * `MANUAL` below is that answer, written down. A step listed there is one the
 * product cannot do through any API today — recorded, not hidden, and asserted
 * so that the list can only shrink deliberately. If a step that has an API
 * stops working, the walk fails at that step; if a NEW manual step appears,
 * the final assertion fails and names it.
 *
 *   DATABASE_URL=postgres://shikhon_app:… \
 *   PLATFORM_DATABASE_URL=postgres://shikhon_platform:… \
 *     node --test services/platform-svc/test/fresh-tenant-e2e.test.ts
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { createDb, type Db } from '../../../packages/server-core/src/db.ts';
import { installTestKeys, call, lockFixtures, unlockFixtures } from '../../../packages/server-core/test/harness.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const PLATFORM_URL = process.env.PLATFORM_DATABASE_URL;
const skip = !DATABASE_URL ? 'DATABASE_URL not set'
  : !PLATFORM_URL ? 'PLATFORM_DATABASE_URL not set' : false;

const KEY = 'test-platform-key-e2e';
const OPERATOR = '7e900000-0000-4000-8000-0000000000aa';
const SLUG = 'pops-e2e-school';

/**
 * Steps a real onboarding still cannot do through the product.
 *
 * Kept as data rather than prose so the final assertion can compare against
 * it. Adding a line here is a decision to ship a gap; removing one is a
 * feature landing. Either way it is visible in a diff.
 */
const MANUAL: Array<{ step: string; why: string; backlog: string }> = [
  {
    step: 'correct a school’s name, EIIN, district, upazila or address',
    why: 'no endpoint writes tenants.name_bn/name_en/eiin/district/upazila/address_bn after '
       + 'creation, and there is no deliberate lock on them — they simply have no writer. '
       + 'Classified (A), a normal platform-admin need: a school registered with a typo, an '
       + 'EIIN issued after onboarding, a district corrected. `slug` is NOT in this list and '
       + 'is classified (B): migration 069 refuses it from school accounts on purpose, and '
       + 'changing it after launch moves the school’s URLs. Note the branding screen sets a '
       + 'DISPLAY name in settings->branding, so a school’s documents can be right while the '
       + 'operator console still shows the typo — which hides the gap rather than closing it.',
    backlog: 'B-55',
  },
  {
    step: 'give a school its chart of accounts and fee heads WITHOUT provisioning it',
    why: 'app.provision_tenant seeds both inline — 15 ledger_accounts and 6 fee_heads — '
       + 'so a provisioned school has them. A school created through POST /tenants and '
       + 'never provisioned has neither, and nothing but /provision will give them to it. '
       + 'That corrects B-81, which claimed the chart was never seeded at all.',
    backlog: 'B-81 (revised)',
  },
];

let db: Db;
let plat: Db;
let platform: typeof import('../api/index.ts').default;
let opToken = '';
let tenantId = '';
let headId = '';

/** Whatever shape `call` accepts — the harness owns that contract. */
const H: Record<string, Parameters<typeof call>[0]> = {};

/** Every step that ran, so a failure says how far the road went. */
const walked: string[] = [];

const asOperator = (url: string, body?: unknown) =>
  call(platform, {
    url, token: opToken,
    ...(body === undefined ? {} : { method: 'POST', body }),
    headers: { 'x-platform-key': KEY },
  } as Parameters<typeof call>[1]);

async function dropFixture(): Promise<void> {
  const { rows } = await plat.pool.query<{ id: string }>(
    `SELECT id FROM app.platform_tenants() WHERE slug = $1`, [SLUG]);
  for (const r of rows) {
    await plat.withTenant({ tenantId: r.id, userId: '', role: 'system_ingest' },
      async (c) => {
        // Money first: payment_receipts and ledger_entries are ON DELETE
        // RESTRICT to tenants, as money should be.
        await c.query('DELETE FROM payment_receipts WHERE tenant_id = $1', [r.id]);
        await c.query('DELETE FROM ledger_entries WHERE tenant_id = $1', [r.id]);
        await c.query('DELETE FROM invoices WHERE tenant_id = $1', [r.id]);
        await c.query('DELETE FROM tenants WHERE id = $1', [r.id]);
      }, { skipGate: true });
  }
}

describe('P-ops §E — a fresh school, end to end, through its own API', { skip }, () => {
  before(async () => {
    await installTestKeys();
    process.env.PLATFORM_API_KEY = KEY;
    process.env.ACTIVATION_PEPPER ??= 'test-pepper-32-bytes-of-entropy!';
    await lockFixtures(DATABASE_URL as string);
    db = createDb(DATABASE_URL as string);
    plat = createDb(PLATFORM_URL as string);
    platform = (await import('../api/index.ts')).default;

    const { signAccessToken } = await import('../../../packages/server-core/src/jwt.ts');
    opToken = await signAccessToken({
      sub: OPERATOR, tid: OPERATOR, role: 'super_admin', roles: ['super_admin'] });

    H.structure = (await import('../../ops-svc/api/structure.ts')).default;
    H.sections = (await import('../../academics-svc/api/sections.ts')).default;
    H.roster = (await import('../../academics-svc/api/roster.ts')).default;
    H.import = (await import('../../academics-svc/api/import.ts')).default;
    H.users = (await import('../../ops-svc/api/users.ts')).default;
    H.enrol = (await import('../../ops-svc/api/enrol.ts')).default;
    H.guardians = (await import('../../ops-svc/api/guardians.ts')).default;
    H.attendance = (await import('../../academics-svc/api/attendance.ts')).default;
    H.notices = (await import('../../ops-svc/api/notices.ts')).default;
    H.calendar = (await import('../../ops-svc/api/calendar.ts')).default;
    H.exams = (await import('../../academics-svc/api/exams.ts')).default;
    H.hierarchy = (await import('../../academics-svc/api/hierarchy.ts')).default;
    H.dashboard = (await import('../../ops-svc/api/dashboard.ts')).default;
    H.rooms = (await import('../../rms-svc/api/rooms.ts')).default;
    H.editor = (await import('../../rms-svc/api/editor.ts')).default;
    // The finance DISPATCHER, not the sub-route: `feestructures.ts` exports a
    // three-argument handler and only index.ts has the two-argument shape the
    // harness (and the real server) calls.
    H.finance = (await import('../../finance-svc/api/index.ts')).default;
    H.activate = (await import('../../identity-svc/api/activate.ts')).default;

    await dropFixture();
  });

  after(async () => {
    if (!db) return;
    await dropFixture();
    await db.end(); await plat.end(); await unlockFixtures();
  });

  test('THE WALK — create → provision → people → teaching → money → exam', async () => {
    /* 1. Create the school. The console's own endpoint, not an INSERT. */
    const made = await asOperator('/api/v1/platform/tenants', {
      slug: SLUG, nameBn: 'পি-অপস আদর্শ বিদ্যালয়', nameEn: 'P-ops Model School',
      stream: 'bangla_medium', level: 'secondary',
    });
    assert.equal(made.status, 200, `create: ${JSON.stringify(made.body)}`);
    tenantId = (made.body as { tenant: { id: string } }).tenant.id;
    walked.push('create');

    /* 2. It must be operable the moment it exists — B-35's lesson: a school
     *    with no `tenant_operations` row is a school nobody can log into. */
    const ops = await plat.pool.query<{ ops_state: string }>(
      'SELECT ops_state FROM tenant_operations WHERE tenant_id = $1', [tenantId]);
    assert.equal(ops.rows[0]?.ops_state, 'active',
      'a newly created school must be operable without a second call');
    walked.push('operations row');

    /* 3. Provision: year, classes, sections, grading scale. */
    const prov = await asOperator('/api/v1/platform/provision', {
      tenantId, yearLabel: '2026', startsOn: '2026-01-01', endsOn: '2026-12-31',
      minLevel: 9, maxLevel: 10, sectionsPerClass: 1,
    });
    assert.equal(prov.status, 200, `provision: ${JSON.stringify(prov.body)}`);
    walked.push('provision');

    /* 3b. The plan the school actually bought.
     *
     *     A new school defaults to `starter`, which has no finance key at
     *     all — so the fee steps below are correctly refused until this
     *     happens. That is not a gap; it is the entitlement gate working, and
     *     it makes "choose the plan" a real onboarding step rather than an
     *     afterthought. A school onboarded without it silently has no fees
     *     module and nobody would know why.
     */
    const plan = await asOperator('/api/v1/platform/plan', {
      tenantId, planCode: 'complete', reason: 'P-ops §E onboarding walk',
    });
    assert.equal(plan.status, 200, `plan: ${JSON.stringify(plan.body)}`);
    walked.push('plan');

    /* 4. Branding — the white-label identity. */
    const brand = await asOperator('/api/v1/platform/branding', {
      tenantId, branding: { primaryColor: '#1B5E20' },
    });
    assert.equal(brand.status, 200, `branding: ${JSON.stringify(brand.body)}`);
    walked.push('branding');

    /* 5. The principal, through the console. */
    const admin = await asOperator('/api/v1/platform/admin', {
      tenantId, nameBn: 'প্রধান শিক্ষক', phone: '+8801799790001',
      roleCode: 'principal', reason: 'P-ops §E onboarding walk',
    });
    assert.equal(admin.status, 200, `admin: ${JSON.stringify(admin.body)}`);
    const adminBody = admin.body as { userId?: string; user?: { id: string }; activationCode?: string };
    headId = adminBody.userId ?? adminBody.user?.id ?? '';
    assert.ok(headId, `no user id in ${JSON.stringify(admin.body)}`);
    walked.push('principal');

    /* 6. An IT admin, the same way. Two roles, because R-7 splits them. */
    const itAdmin = await asOperator('/api/v1/platform/admin', {
      tenantId, nameBn: 'আইটি অ্যাডমিন', phone: '+8801799790002',
      roleCode: 'it_admin', reason: 'P-ops §E onboarding walk',
    });
    assert.equal(itAdmin.status, 200, `it_admin: ${JSON.stringify(itAdmin.body)}`);
    walked.push('it admin');

    /* 7. ACTIVATION and LOGIN — the principal signing in for the first time
     *    with the code the console minted. This is the moment the school
     *    stops being a row and starts being usable. */
    const code = adminBody.activationCode;
    assert.ok(code, `the console must return an activation code: ${JSON.stringify(admin.body)}`);
    const deviceId = randomUUID();
    const redeemed = await call(H.activate, {
      method: 'POST', url: '/api/v1/auth/activate',
      body: { action: 'redeem', tenantId, code, deviceId },
    } as Parameters<typeof call>[1]);
    assert.equal(redeemed.status, 200, `redeem: ${JSON.stringify(redeemed.body)}`);
    const headToken = (redeemed.body as { accessToken: string }).accessToken;
    assert.ok(headToken, 'activation must yield a usable session');
    walked.push('activation + login');

    /* From here on everything is done AS THE SCHOOL, with the token its own
     * principal was issued — not with an operator key. If a step needs the
     * console, that is itself a finding. */
    const asSchool = (h: keyof typeof H, opts: Record<string, unknown>) =>
      call(H[h], { token: headToken, ...opts } as Parameters<typeof call>[1]);

    /* 8. The dashboard loads for a school with nothing in it yet. */
    const dash = await asSchool('dashboard', { url: '/' });
    assert.equal(dash.status, 200, `dashboard: ${JSON.stringify(dash.body)}`);
    walked.push('dashboard');

    /* 9. Its academic structure is readable — provision really wrote it. */
    const structure = await asSchool('structure', { url: '/' });
    assert.equal(structure.status, 200, `structure: ${JSON.stringify(structure.body)}`);
    walked.push('structure');

    /* 10. A teacher, created by the school itself. */
    const teacher = await asSchool('users', {
      method: 'POST', url: '/',
      body: { nameBn: 'রফিক স্যার', phone: '+8801799790003', roleCode: 'subject_teacher',
              employeeCode: 'EMP-001' },
    });
    assert.ok(teacher.status < 400, `teacher: ${teacher.status} ${JSON.stringify(teacher.body)}`);
    walked.push('teacher');

    /* 11. Rooms — B-49's gap, closed in P-writers. A school with zero rooms
     *     cannot have a timetable, and every tenant on the box had zero. */
    const room = await asSchool('rooms', {
      method: 'POST', url: '/', body: { code: 'R-101', nameBn: 'কক্ষ ১', capacity: 40, roomType: 'classroom' },
    });
    assert.ok(room.status < 400, `room: ${room.status} ${JSON.stringify(room.body)}`);
    walked.push('room');

    /* 12. A notice, and the calendar. */
    const notice = await asSchool('notices', {
      method: 'POST', url: '/',
      body: { notice: { title: 'শুভেচ্ছা', body: 'নতুন শিক্ষাবর্ষ শুরু হয়েছে।',
                        category: 'general', audience: { type: 'all' } }, publish: true },
    });
    assert.ok(notice.status < 400, `notice: ${notice.status} ${JSON.stringify(notice.body)}`);
    walked.push('notice');

    const cal = await asSchool('calendar', { url: '/' });
    assert.equal(cal.status, 200, `calendar: ${JSON.stringify(cal.body)}`);
    walked.push('calendar');

    /* 13. Fee structures — B-47's gap. The year comes from the school's own
     *     hierarchy, because provisioning chose it and nothing here should
     *     assume which one it picked. */
    const hier = await asSchool('hierarchy', { url: '/' });
    assert.equal(hier.status, 200, `hierarchy: ${JSON.stringify(hier.body)}`);
    const yearId = (hier.body as { years?: Array<{ id: string }> })?.years?.[0]?.id
      ?? (hier.body as { year?: { id: string } })?.year?.id;
    assert.ok(yearId, `no academic year in ${JSON.stringify(hier.body).slice(0, 300)}`);
    walked.push('academic year');

    // The sections provisioning created. Needed by the import (which places
    // students into one) and by the exam (which builds a paper per section).
    const sectionsRes = await asSchool('sections', { url: `/?yearId=${yearId}` });
    assert.equal(sectionsRes.status, 200, `sections: ${JSON.stringify(sectionsRes.body)}`);
    const sectionIds = ((sectionsRes.body as { sections?: Array<{ id: string }> }).sections ?? [])
      .map((x) => x.id);
    assert.ok(sectionIds.length > 0,
      `provisioning must have created sections: ${JSON.stringify(sectionsRes.body).slice(0, 300)}`);
    walked.push('sections');
    const sectionIdsForRoster = () => sectionIds[0];

    // Fee HEADS are seeded by provisioning (migration 012 §7), so the school
    // already has TUITION, ADMISSION, EXAM and three more. A fee STRUCTURE is
    // the amount attached to one of them for one class — B-47's gap, closed
    // in A2 — and it needs a head to hang from.
    const heads = await asSchool('finance', { url: '/api/v1/finance/feestructures' });
    assert.equal(heads.status, 200, `fee heads: ${JSON.stringify(heads.body)}`);
    const headsList = (heads.body as { heads?: Array<{ id: string; code?: string }> }).heads ?? [];
    assert.ok(headsList.length > 0,
      `provisioning must seed fee heads: ${JSON.stringify(heads.body).slice(0, 300)}`);
    walked.push('fee heads seeded');

    const tuition = headsList.find((h) => h.code === 'TUITION') ?? headsList[0];
    const classes = (structure.body as { classes?: Array<{ id: string }> }).classes ?? [];
    const fee = await asSchool('finance', {
      method: 'POST', url: '/api/v1/finance/feestructures',
      body: { feeHeadId: tuition.id, amount: 500, academicYearId: yearId,
              ...(classes[0] ? { classId: classes[0].id } : {}) },
    });
    assert.ok(fee.status < 400 || fee.status === 409,
      `fee structure: ${fee.status} ${JSON.stringify(fee.body)}`);
    walked.push('fee structure');

    /* 13b. STUDENTS, by the route an office actually uses: a CSV import,
     *      validated first and committed second. Not an INSERT and not a
     *      one-at-a-time form — a school arrives with a spreadsheet, and
     *      R-7 §13's two-step exists so they can see the errors before any
     *      row is written.
     */
    const csvHead = 'roll_no,name_bn,class,section,guardian_phone,optional_subject';
    const csvRows = [1, 2].map((n) =>
      `${n},শিক্ষার্থী ${n},9,ক,017123459${String(n).padStart(2, '0')},উচ্চতর গণিত`);
    const csv = `${csvHead}\n${csvRows.join('\n')}\n`;

    const dry = await asSchool('import', {
      method: 'POST', url: '/',
      body: { kind: 'student', academicYearId: yearId, fileName: 'students.csv', csv },
    });
    assert.equal(dry.status, 200, `import preview: ${JSON.stringify(dry.body).slice(0, 400)}`);
    const digest = (dry.body as { digest?: string }).digest;
    assert.ok(digest, `preview must return a digest: ${JSON.stringify(dry.body).slice(0, 300)}`);
    walked.push('student import preview');

    const committed = await asSchool('import', {
      method: 'POST', url: '/',
      body: { kind: 'student', academicYearId: yearId, fileName: 'students.csv', csv,
              commit: true, digest },
    });
    assert.equal(committed.status, 200,
      `import commit: ${JSON.stringify(committed.body).slice(0, 400)}`);
    walked.push('students imported');

    /* 13c. A GUARDIAN, linked to one of them. The import carried a phone;
     *      the link is what turns that into a person with their own login.
     */
    const roster = await asSchool('roster', { url: `/?sectionId=${sectionIdsForRoster()}` });
    assert.equal(roster.status, 200, `roster: ${JSON.stringify(roster.body).slice(0, 300)}`);
    const students = (roster.body as { roster?: Array<{ studentId: string }> })?.roster ?? [];
    // Asserted, not skipped. A guarded `if (students.length)` here would have
    // turned "the import committed nothing" into a silently shorter walk,
    // which is the failure mode this whole file exists to avoid.
    assert.ok(students.length > 0,
      `the imported students must appear on the roster: ${JSON.stringify(roster.body).slice(0, 400)}`);
    walked.push('roster');

    const link = await asSchool('guardians', {
      method: 'POST', url: '/',
      body: { studentId: students[0].studentId, nameBn: 'অভিভাবক', phone: '+8801799790011',
              relation: 'father', isPrimary: true },
    });
    assert.ok(link.status < 400, `guardian: ${link.status} ${JSON.stringify(link.body)}`);
    walked.push('guardian linked');

    /* 13d. A ROUTINE — B-49's gap, closed in A4. Before that, `routine_slots`
     *      had zero rows in every one of the 112 tenants on the box: the
     *      table, the editor and the conflict constraints all existed and
     *      nothing could create a routine to put in them.
     */
    const routine = await asSchool('editor', {
      method: 'POST', url: '/',
      body: { action: 'create-routine', sectionId: sectionIds[0], nameBn: 'সাপ্তাহিক রুটিন' },
    });
    assert.ok(routine.status < 400,
      `create-routine: ${routine.status} ${JSON.stringify(routine.body).slice(0, 300)}`);
    walked.push('routine created');

    /* 13e. ATTENDANCE is deliberately NOT here, and that is not a gap.
     *
     *      `/academics/attendance` is GET-only: a register is written through
     *      the offline sync queue (`/sync/push`), because a teacher marks it
     *      on a phone in a classroom with no signal and it must survive that.
     *      Walking it here would mean building a sync envelope, which tests
     *      the queue rather than the onboarding road — `packages/offline` and
     *      `services/sync-svc` own that, with 73 tests between them.
     *
     *      Recorded so a later reader does not mistake its absence for an
     *      untested step.
     */

    /* 14. An exam — B-46's gap, closed in A1. */
    const exam = await asSchool('exams', {
      method: 'POST', url: '/',
      body: { academicYearId: yearId, nameBn: 'অর্ধবার্ষিক পরীক্ষা',
              examType: 'half_yearly', startsOn: '2026-06-10', endsOn: '2026-06-20',
              sectionIds },
    });
    assert.ok(exam.status < 400, `exam: ${exam.status} ${JSON.stringify(exam.body)}`);
    walked.push('exam');
  });

  test('WHAT STILL NEEDS MANUAL SQL — recorded, not hidden', async () => {
    // Each entry is probed rather than asserted from memory. A gap that has
    // quietly been closed should stop being listed; a gap that is still open
    // must stay named, with its backlog id.
    const stillManual: string[] = [];

    // B-55 — is there any endpoint that renames a school?
    const rename = await asOperator('/api/v1/platform/tenant', { tenantId, nameBn: 'নতুন নাম' });
    if (rename.status >= 400) stillManual.push('correct a school’s name, EIIN, district, upazila or address');

    // B-81, revised. The claim to check is no longer "the chart is never
    // seeded" — provisioning seeds it — but "can a school get one WITHOUT
    // provisioning?" So: this school was provisioned and must have both, and
    // there must still be no other route to them.
    const { rows } = await plat.withTenant(
      { tenantId, userId: '', role: 'system_ingest' },
      (c) => c.query<{ accounts: string; heads: string }>(
        `SELECT (SELECT count(*)::text FROM ledger_accounts) AS accounts,
                (SELECT count(*)::text FROM fee_heads) AS heads`),
      { skipGate: true });
    assert.ok(Number(rows[0].accounts) > 0,
      'provisioning must seed the chart of accounts — B-81 says otherwise and is wrong');
    assert.ok(Number(rows[0].heads) > 0, 'provisioning must seed the fee heads');
    // No endpoint anywhere writes ledger_accounts or fee_heads, so the only
    // way to give an UNPROVISIONED school either is psql.
    stillManual.push(
      'give a school its chart of accounts and fee heads WITHOUT provisioning it');

    assert.deepEqual(stillManual.sort(), MANUAL.map((m) => m.step).sort(),
      'the set of steps needing manual SQL has changed — update MANUAL and the runbook');

    // Printed so a reader of the test output sees the answer without opening
    // the file. This is the deliverable of §E, not a side note.
    console.log('\n  Manual SQL still required for a fresh school:');
    for (const m of MANUAL) console.log(`    · ${m.step}  [${m.backlog}]\n      ${m.why}`);
    console.log(`\n  Steps completed through the product's own API: ${walked.length}`);
    console.log(`    ${walked.join(' → ')}\n`);
  });
});
