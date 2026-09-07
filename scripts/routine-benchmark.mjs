/**
 * P9-3 §8/§9 — how long does "Generate" actually take?
 *
 *   node scripts/routine-benchmark.mjs            # all five profiles
 *   node scripts/routine-benchmark.mjs large      # one of them
 *   REPEATS=5 node scripts/routine-benchmark.mjs
 *
 * The product promise is "a complete usable routine in roughly one minute for
 * a normal-sized institution". That is a claim about a real school, and it
 * cannot be settled by timing the solver on four sections. So this seeds five
 * institutions of the shapes that actually exist in Bangladesh, and drives the
 * REAL `POST /api/v1/rms/generate` handler over each — same auth, same
 * readiness gate, same per-shift orchestration, same JSON.
 *
 * ── What is measured, and what is NOT ────────────────────────────────────
 * Measured: readiness-gate time, solver time as the solver reports it, and
 * the wall clock around the handler call — which is the sum of the gate, the
 * drafts, every shift's solve, and the unplaced-name lookup.
 *
 * NOT measured, and therefore not claimed: network latency to a VPS in
 * Singapore, TLS, the browser's render of the result, or a 3G phone. Every
 * number below is a LOCAL number against a container on the same machine.
 * §9 asks for the split precisely so that the missing piece is visible
 * instead of being quietly folded into a passing figure.
 *
 * ── Why each run starts from an empty routine ────────────────────────────
 * `RmsSolver` is idempotent: it tops up what is missing. Re-running over a
 * full routine places nothing and returns in milliseconds, which would be a
 * lovely number and a lie. Every repeat therefore deletes the slots and the
 * draft first, so each one is a school generating its timetable for the
 * first time — the case the promise is about.
 */
import process from 'node:process';
import { createDb } from '../packages/server-core/src/db.ts';
import { installTestKeys, call, lockFixtures, unlockFixtures, asBootstrap }
  from '../packages/server-core/test/harness.ts';

const DATABASE_URL = process.env.DATABASE_URL
  ?? 'postgres://shikhon_app:ci@127.0.0.1:55432/shikhon_ci';
const REPEATS = Number(process.env.REPEATS ?? 3);
// `sharedDb()` inside the handler reads the env, not this module's constant —
// the point is to drive the SAME code path a request takes.
process.env.DATABASE_URL = DATABASE_URL;

const BN_DIGITS = '০১২৩৪৫৬৭৮৯';
const bn = (n) => String(n).replace(/[0-9]/g, (d) => BN_DIGITS[Number(d)]);

/* ───────────────────────────── the schools ──────────────────────────── */

/**
 * A bell schedule that a school could actually ring.
 *
 * Consecutive and non-overlapping — migration 073 refuses anything else
 * within one template, and a two-shift school hands over at a clean time
 * because a teacher cannot be in both at once.
 */
function bells(startHour, startMin, count, minutes, breakAfter) {
  const out = [];
  let t = startHour * 60 + startMin;
  for (let i = 1; i <= count; i++) {
    const from = t, to = t + minutes;
    out.push({ no: out.length + 1, from, to, kind: 'teaching', label: `${i} নম্বর` });
    t = to;
    if (i === breakAfter) {
      out.push({ no: out.length + 1, from: t, to: t + 30, kind: 'tiffin', label: 'টিফিন' });
      t += 30;
    }
  }
  return out;
}
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

const SUBJECTS_SCHOOL = [
  ['বাংলা', 5, null], ['ইংরেজি', 5, null], ['গণিত', 5, null],
  ['বিজ্ঞান', 4, null], ['বাংলাদেশ ও বিশ্বপরিচয়', 3, null],
  ['ধর্ম ও নৈতিক শিক্ষা', 3, null], ['তথ্য ও যোগাযোগ প্রযুক্তি', 2, 'computer_lab'],
  ['শারীরিক শিক্ষা', 2, null],
];
const SUBJECTS_PRIMARY = [
  ['বাংলা', 6, null], ['ইংরেজি', 6, null], ['গণিত', 6, null],
  ['প্রাথমিক বিজ্ঞান', 4, null], ['বাংলাদেশ ও বিশ্বপরিচয়', 3, null],
  ['ধর্ম ও নৈতিক শিক্ষা', 3, null], ['চারু ও কারুকলা', 2, null],
];
const SUBJECTS_COLLEGE = [
  ['বাংলা', 4, null], ['ইংরেজি', 4, null], ['তথ্য ও যোগাযোগ প্রযুক্তি', 2, 'computer_lab'],
  ['পদার্থবিজ্ঞান', 4, null], ['পদার্থ ব্যবহারিক', 2, 'physics_lab'],
  ['রসায়ন', 4, null], ['রসায়ন ব্যবহারিক', 2, 'chemistry_lab'],
  ['উচ্চতর গণিত', 4, null], ['জীববিজ্ঞান', 3, null], ['জীব ব্যবহারিক', 2, 'biology_lab'],
];
const SUBJECTS_ARTS = [
  ['বাংলা', 4, null], ['ইংরেজি', 4, null], ['তথ্য ও যোগাযোগ প্রযুক্তি', 2, 'computer_lab'],
  ['পৌরনীতি', 4, null], ['অর্থনীতি', 4, null], ['ইতিহাস', 4, null],
  ['যুক্তিবিদ্যা', 4, null], ['সমাজবিজ্ঞান', 3, null],
];
const SUBJECTS_MADRASA = [
  ['কুরআন মজীদ', 5, null], ['হাদীস শরীফ', 4, null], ['আকাইদ ও ফিকহ', 4, null],
  ['আরবি প্রথম পত্র', 4, null], ['আরবি দ্বিতীয় পত্র', 3, null],
  ['বাংলা', 4, null], ['ইংরেজি', 4, null], ['গণিত', 4, null],
  ['বিজ্ঞান', 3, null],
];

/**
 * Five institutions, in the shapes the market actually has.
 *
 * `sections` is what §8 counts, and the list deliberately spans 20 → 132 so
 * the curve is visible rather than a single point. The largest is a
 * two-shift college, which is where the work is: two solves, shared rooms
 * and a laboratory that everyone needs at once.
 */
const PROFILES = [
  {
    key: 'small', nameBn: 'ছোট স্কুল — গ্রামীণ মাধ্যমিক',
    level: 'secondary', stream: 'bangla_medium',
    shifts: [{ code: 'single', bells: bells(10, 0, 7, 45, 4),
               classes: [[6, 4], [7, 4], [8, 4], [9, 4], [10, 4]],
               subjects: SUBJECTS_SCHOOL }],
    labs: { computer_lab: 2 },
  },
  {
    key: 'medium', nameBn: 'মাঝারি স্কুল — শহরের বেসরকারি',
    level: 'combined', stream: 'bangla_medium',
    shifts: [{ code: 'single', bells: bells(9, 0, 8, 40, 4),
               classes: [[1, 4], [2, 4], [3, 4], [4, 4], [5, 4],
                         [6, 4], [7, 4], [8, 4], [9, 4], [10, 4]],
               subjects: SUBJECTS_SCHOOL }],
    labs: { computer_lab: 3 },
  },
  {
    key: 'large', nameBn: 'বড় স্কুল — দুই শিফট',
    level: 'combined', stream: 'bangla_medium',
    shifts: [
      { code: 'morning', bells: bells(7, 30, 8, 35, 4),
        classes: [[1, 8], [2, 8], [3, 8], [4, 8], [5, 8]],
        subjects: SUBJECTS_PRIMARY },
      { code: 'day', bells: bells(12, 30, 8, 35, 4),
        classes: [[6, 8], [7, 8], [8, 8], [9, 8], [10, 8]],
        subjects: SUBJECTS_SCHOOL },
    ],
    labs: { computer_lab: 3 },
  },
  {
    key: 'college', nameBn: 'কলেজ — উচ্চ মাধ্যমিক, দুই শিফট',
    level: 'higher_secondary', stream: 'bangla_medium',
    shifts: [
      // Science reads in the morning, humanities in the day — the same two
      // year-groups twice over, which is why `classes.group` exists and why
      // 132 sections fit in a college with 66 classrooms.
      { code: 'morning', bells: bells(7, 30, 8, 40, 4), group: 'science',
        classes: [[11, 30], [12, 30]], subjects: SUBJECTS_COLLEGE },
      { code: 'day', bells: bells(13, 0, 8, 40, 4), group: 'humanities',
        classes: [[11, 30], [12, 30]], subjects: SUBJECTS_ARTS },
    ],
    // Sized so the laboratories are tight but not arithmetically impossible:
    // 60 science sections x 2 practical periods = 120 a week per subject,
    // against 8 teaching periods x 5 days = 40 per laboratory per shift.
    // A fixture that cannot fit measures the fixture, not the solver.
    labs: { computer_lab: 5, physics_lab: 4, chemistry_lab: 4, biology_lab: 4 },
  },
  {
    key: 'madrasa', nameBn: 'মাদরাসা — দাখিল',
    level: 'secondary', stream: 'madrasah',
    shifts: [{ code: 'single', bells: bells(8, 0, 8, 40, 3),
               classes: [[6, 6], [7, 6], [8, 6], [9, 6], [10, 6]],
               subjects: SUBJECTS_MADRASA }],
    labs: {},
  },
];

const CLASS_BN = {
  1: 'প্রথম', 2: 'দ্বিতীয়', 3: 'তৃতীয়', 4: 'চতুর্থ', 5: 'পঞ্চম',
  6: 'ষষ্ঠ', 7: 'সপ্তম', 8: 'অষ্টম', 9: 'নবম', 10: 'দশম',
  11: 'একাদশ', 12: 'দ্বাদশ',
};
const GROUP_BN = { science: 'বিজ্ঞান', humanities: 'মানবিক',
                   business_studies: 'ব্যবসায় শিক্ষা', vocational: 'কারিগরি',
                   general: 'সাধারণ', none: '' };
const SECTION_BN = ['ক', 'খ', 'গ', 'ঘ', 'ঙ', 'চ', 'ছ', 'জ', 'ঝ', 'ঞ',
                    'ট', 'ঠ', 'ড', 'ঢ', 'ণ', 'ত', 'থ', 'দ'];

/**
 * Section names past the eighteenth letter.
 *
 * A college with thirty sections in one year-group runs out of Bangla
 * consonants, and `S19` in the middle of a Bangla routine is the kind of
 * detail that tells a head teacher this was not built for them.
 */
function sectionName(i) {
  const letter = SECTION_BN[i % SECTION_BN.length];
  const round = Math.floor(i / SECTION_BN.length);
  return round === 0 ? letter : `${letter}-${bn(round + 1)}`;
}

/* ───────────────────────────── seeding ──────────────────────────────── */

const TENANT = '7c9b0000-0000-4000-8000-00000000bea0';
const HEAD = '7c9b0000-0000-4000-8000-00000000bea1';
const YEAR = '7c9b0000-0000-4000-8000-00000000bea2';
const ctx = { tenantId: TENANT, userId: HEAD, role: 'principal' };

async function drop(db) {
  await asBootstrap(db, ctx, (c) => c.query('DELETE FROM tenants WHERE id = $1', [TENANT]));
}

/**
 * Build one whole institution.
 *
 * Teachers are sized from the demand rather than picked: a school that has
 * fewer teachers than periods cannot produce a full timetable no matter how
 * good the solver is, and benchmarking THAT would measure the fixture. Each
 * teacher is given at most `LOAD` periods a week, which is a real workload
 * for a Bangladeshi secondary teacher, and teachers belong to one shift
 * because in a two-shift school they do.
 */
const LOAD = 26;

async function seed(db, profile) {
  const counts = { sections: 0, teachers: 0, rooms: 0, subjects: 0, demandPeriods: 0, pairs: 0 };

  await asBootstrap(db, ctx, async (c) => {
    await c.query(
      `INSERT INTO tenants (id, slug, name_bn, name_en, stream, level, weekend_days)
       VALUES ($1,$2,$3,'Bench',$4::institution_stream,$5::institution_level,'{5,6}')`,
      [TENANT, `bench-${profile.key}`, profile.nameBn, profile.stream, profile.level]);
    await c.query(
      `INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164, status)
       VALUES ($1,$2,'প্রধান শিক্ষক','Head','+8801700000000','active')`, [HEAD, TENANT]);
    await c.query(
      `INSERT INTO user_roles (tenant_id, user_id, role_code) VALUES ($1,$2,'principal')`,
      [TENANT, HEAD]);
    await c.query(
      `INSERT INTO academic_years (id, tenant_id, label, starts_on, ends_on, is_current)
       VALUES ($1,$2,'2026','2026-01-01','2026-12-31',true)`, [YEAR, TENANT]);

    // ── Rooms: one home classroom per CONCURRENT section, plus the labs ──
    //
    // Sized by the busiest single shift, not by the total. A two-shift
    // college with 132 sections does not have 132 classrooms — the morning
    // and the day share them, which is the whole economic reason two-shift
    // schools exist. The bells do not overlap, so sharing is legal, and the
    // room exclusion constraint is what proves it rather than this comment.
    const perShift = profile.shifts.map(
      (sh) => sh.classes.reduce((m, [, k]) => m + k, 0));
    const classrooms = Math.max(...perShift);
    const roomRows = [];
    for (let i = 1; i <= classrooms; i++) {
      roomRows.push([`R-${String(i).padStart(3, '0')}`, `কক্ষ ${bn(i)}`, 60, '{}']);
    }
    // Named the way a school names a room, not after the capability code.
    // The fixture used `${cap} ${bn(i)}` — so the editor grid, which
    // correctly shows a school's OWN room name, displayed "computer_lab ২"
    // and looked exactly like the machine-identifier leak P9-4 spent a
    // section eliminating. A fixture that manufactures a false positive
    // costs more than it saves.
    const LAB_BN = {
      computer_lab: 'কম্পিউটার ল্যাব', physics_lab: 'পদার্থ ল্যাব',
      chemistry_lab: 'রসায়ন ল্যাব', biology_lab: 'জীব ল্যাব',
    };
    for (const [cap, n] of Object.entries(profile.labs)) {
      for (let i = 1; i <= n; i++) {
        roomRows.push([`LAB-${cap}-${i}`, `${LAB_BN[cap] ?? 'বিশেষ কক্ষ'} ${bn(i)}`,
                       40, `{${cap}}`]);
      }
    }
    await c.query(
      `INSERT INTO rooms (tenant_id, code, name_bn, capacity, capabilities, is_bookable)
       SELECT $1, code, name_bn, cap, caps::text[], true
         FROM unnest($2::text[], $3::text[], $4::int[], $5::text[])
              AS t(code, name_bn, cap, caps)`,
      [TENANT, roomRows.map((r) => r[0]), roomRows.map((r) => r[1]),
       roomRows.map((r) => r[2]), roomRows.map((r) => r[3])]);
    counts.rooms = roomRows.length;
    const { rows: rooms } = await c.query(
      `SELECT id, code FROM rooms WHERE tenant_id = $1 ORDER BY code`, [TENANT]);
    const roomByCode = new Map(rooms.map((r) => [r.code, r.id]));

    // ── Subjects: named once for the school, shared by every class ────
    const subjectSet = new Map();
    for (const sh of profile.shifts) {
      for (const [name, ppw, cap] of sh.subjects) {
        if (!subjectSet.has(name)) subjectSet.set(name, { ppw, cap });
      }
    }
    const subjNames = [...subjectSet.keys()];
    await c.query(
      `INSERT INTO subjects (tenant_id, name_bn, name_en, short_name, requires_capability)
       SELECT $1, n, 'S' || i, substr(n, 1, 3), NULLIF(cap, '')
         FROM unnest($2::text[], $3::text[], $4::int[]) WITH ORDINALITY AS t(n, cap, x, i)`,
      [TENANT, subjNames, subjNames.map((n) => subjectSet.get(n).cap ?? ''),
       subjNames.map(() => 0)]);
    counts.subjects = subjNames.length;
    const { rows: subs } = await c.query(
      `SELECT id, name_bn FROM subjects WHERE tenant_id = $1`, [TENANT]);
    const subjByName = new Map(subs.map((s) => [s.name_bn, s.id]));

    let teacherSerial = 0;
    const sstRows = [];

    for (const sh of profile.shifts) {
      // ── The bell schedule for this shift ──────────────────────────
      const { rows: tplRow } = await c.query(
        `INSERT INTO period_templates (tenant_id, name_bn, shift, effective_from, is_active)
         VALUES ($1,$2,$3::shift_code,'2026-01-01',true) RETURNING id`,
        [TENANT, `${sh.code} সময়সূচি`, sh.code]);
      await c.query(
        `INSERT INTO period_definitions
           (tenant_id, template_id, period_no, label_bn, starts_at, ends_at, kind)
         SELECT $1, $2, no, label, f::time, t::time, k::period_kind
           FROM unnest($3::int[], $4::text[], $5::text[], $6::text[], $7::text[])
                AS x(no, label, f, t, k)`,
        [TENANT, tplRow[0].id, sh.bells.map((b) => b.no), sh.bells.map((b) => b.label),
         sh.bells.map((b) => hhmm(b.from)), sh.bells.map((b) => hhmm(b.to)),
         sh.bells.map((b) => b.kind)]);

      // ── Classes and their sections ────────────────────────────────
      // Each shift starts again at the first classroom: they share the building.
      let roomCursor = 0;
      const shiftSections = [];
      for (const [level, nSections] of sh.classes) {
        // `classes` is UNIQUE on (tenant, level_no, stream, group) and carries
        // no shift of its own — a class is a year-group, and which shift it
        // reads in belongs to its sections. So a college's morning science
        // eleventh and its day humanities eleventh are two classes, told
        // apart by `group`, exactly as the schema intends.
        const grp = sh.group ?? 'none';
        const { rows: cls } = await c.query(
          `INSERT INTO classes (tenant_id, level_no, name_bn, name_en, stream, "group")
           VALUES ($1,$2,$3,$4,$5::institution_stream,$6::academic_group) RETURNING id`,
          [TENANT, level,
           `${CLASS_BN[level]}${grp === 'none' ? '' : ` — ${GROUP_BN[grp]}`}`,
           `C${level}-${grp}`, profile.stream, grp]);
        const classId = cls[0].id;

        for (let s = 0; s < nSections; s++) {
          const homeRoom = roomByCode.get(`R-${String(++roomCursor).padStart(3, '0')}`);
          const { rows: sec } = await c.query(
            `INSERT INTO sections (tenant_id, class_id, academic_year_id, name, shift,
                                   student_count, home_room_id)
             VALUES ($1,$2,$3,$4,$5::shift_code,50,$6) RETURNING id`,
            [TENANT, classId, YEAR, sectionName(s), sh.code, homeRoom]);
          shiftSections.push({ id: sec[0].id, classId });
        }

        // ── What this class studies ─────────────────────────────────
        await c.query(
          `INSERT INTO class_subjects
             (tenant_id, class_id, subject_id, academic_year_id, periods_per_week)
           SELECT $1, $2, sid, $3, ppw
             FROM unnest($4::uuid[], $5::int[]) AS x(sid, ppw)`,
          [TENANT, classId, YEAR,
           sh.subjects.map(([n]) => subjByName.get(n)),
           sh.subjects.map(([, ppw]) => ppw)]);
      }
      counts.sections += shiftSections.length;

      // ── Teachers, sized from this shift's demand ──────────────────
      const perSection = sh.subjects.reduce((n, [, ppw]) => n + ppw, 0);
      const shiftPeriods = perSection * shiftSections.length;
      counts.demandPeriods += shiftPeriods;
      const nTeachers = Math.max(1, Math.ceil(shiftPeriods / LOAD));

      const tIds = [];
      const tNames = [];
      const tPhones = [];
      // Employee codes run across the whole school, not per shift — the
      // second shift restarting at EMP-1 collided with the first, which is
      // what `staff_profiles_tenant_id_employee_code_key` is for.
      const tCodes = [];
      for (let i = 0; i < nTeachers; i++) {
        teacherSerial++;
        tNames.push(`শিক্ষক ${bn(teacherSerial)}`);
        tPhones.push(`+88018${String(10_000_000 + teacherSerial).slice(-8)}`);
        tCodes.push(`EMP-${String(teacherSerial).padStart(4, '0')}`);
      }
      const { rows: made } = await c.query(
        `INSERT INTO users (tenant_id, full_name_bn, full_name_en, phone_e164, status)
         SELECT $1, n, 'T', p, 'active'
           FROM unnest($2::text[], $3::text[]) AS x(n, p)
         RETURNING id`,
        [TENANT, tNames, tPhones]);
      for (const r of made) tIds.push(r.id);
      await c.query(
        `INSERT INTO user_roles (tenant_id, user_id, role_code)
         SELECT $1, u, 'subject_teacher' FROM unnest($2::uuid[]) AS u`, [TENANT, tIds]);
      await c.query(
        `INSERT INTO staff_profiles (user_id, tenant_id, employee_code)
         SELECT u, $1, code FROM unnest($2::uuid[], $3::text[]) AS x(u, code)`,
        [TENANT, tIds, tCodes]);
      counts.teachers += tIds.length;

      // ── Who teaches what ──────────────────────────────────────────
      //
      // Round-robin by (section, subject), which spreads a teacher across
      // several sections of the same subject — how a school with one
      // physics teacher and six sections actually works, and the case that
      // makes the solver's job hard.
      let cursor = 0;
      const load = new Map(tIds.map((t) => [t, 0]));
      for (const sec of shiftSections) {
        for (const [name, ppw] of sh.subjects) {
          // Skip any teacher already at their weekly ceiling, so the fixture
          // is feasible on paper before the solver is asked.
          let picked = null;
          for (let k = 0; k < tIds.length; k++) {
            const cand = tIds[(cursor + k) % tIds.length];
            if ((load.get(cand) ?? 0) + ppw <= LOAD + 4) { picked = cand; cursor = (cursor + k + 1) % tIds.length; break; }
          }
          picked ??= tIds[cursor % tIds.length];
          load.set(picked, (load.get(picked) ?? 0) + ppw);
          sstRows.push([sec.id, subjByName.get(name), picked]);
        }
      }
    }

    await c.query(
      `INSERT INTO section_subject_teachers
         (tenant_id, section_id, subject_id, teacher_id, academic_year_id, started_on)
       SELECT $1, s, j, t, $2, '2026-01-01'
         FROM unnest($3::uuid[], $4::uuid[], $5::uuid[]) AS x(s, j, t)`,
      [TENANT, YEAR, sstRows.map((r) => r[0]), sstRows.map((r) => r[1]),
       sstRows.map((r) => r[2])]);
    counts.pairs = sstRows.length;
  });

  return counts;
}

/** Back to an unsolved school, so every repeat is a first generation. */
async function resetRoutines(db) {
  await asBootstrap(db, ctx, async (c) => {
    await c.query('DELETE FROM routine_slots WHERE tenant_id = $1', [TENANT]);
    await c.query('DELETE FROM routines WHERE tenant_id = $1', [TENANT]);
  });
}

/* ───────────────────────────── measuring ────────────────────────────── */

const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const f = (n, d = 2) => n.toFixed(d);

async function main() {
  const only = process.argv[2];
  const wanted = only ? PROFILES.filter((p) => p.key === only) : PROFILES;
  if (wanted.length === 0) {
    console.error(`unknown profile "${only}" — one of: ${PROFILES.map((p) => p.key).join(', ')}`);
    process.exit(2);
  }

  await installTestKeys();
  await lockFixtures(DATABASE_URL);
  const db = createDb(DATABASE_URL);
  const { signAccessToken } = await import('../packages/server-core/src/jwt.ts');
  const token = await signAccessToken({
    sub: HEAD, tid: TENANT, role: 'principal', roles: ['principal'] });
  const handler = (await import('../services/rms-svc/api/generate.ts')).default;
  const { readiness } = await import('../services/rms-svc/api/setup.ts');

  const table = [];
  try {
    for (const profile of wanted) {
      await drop(db);
      const t0 = Date.now();
      const counts = await seed(db, profile);
      const seedMs = Date.now() - t0;

      // The gate on its own, so §9's split is a measurement and not a share-out.
      const g0 = Date.now();
      const ready = await db.withTenant(ctx, (c) => readiness(c, YEAR));
      const gateMs = Date.now() - g0;
      if (!ready.canGenerate) {
        console.error(`\n${profile.key}: fixture is not generatable — `
          + ready.steps.filter((s) => s.state === 'blocked').map((s) => s.detailBn).join('; '));
        table.push({ profile, counts, blocked: true });
        continue;
      }

      const walls = [];
      let last = null;
      for (let i = 0; i < REPEATS; i++) {
        await resetRoutines(db);
        const w0 = Date.now();
        const res = await call(handler, { method: 'POST', url: '/', token, body: { yearId: YEAR } });
        const wall = Date.now() - w0;
        if (res.status !== 200) {
          console.error(`\n${profile.key}: HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 400)}`);
          break;
        }
        walls.push(wall);
        last = res;
      }
      if (!last) { table.push({ profile, counts, blocked: true }); continue; }

      // §6 again, at scale: ask the DATABASE whether the stored week is legal.
      const { rows: conflict } = await asBootstrap(db, ctx, (c) => c.query(
        `SELECT (SELECT count(*) FROM routine_slots a JOIN routine_slots b
                   ON a.id < b.id AND a.day_of_week = b.day_of_week
                  AND a.time_range && b.time_range AND a.status <> 'removed'
                  AND b.status <> 'removed'
                  AND (a.teacher_id = b.teacher_id
                       OR a.primary_section_id = b.primary_section_id
                       OR (a.room_id = b.room_id AND a.room_id IS NOT NULL))
                 WHERE a.tenant_id = $1)::text AS n`, [TENANT]));

      table.push({
        profile, counts, seedMs, gateMs, walls,
        hardConflicts: Number(conflict[0].n),
        summary: last.body.summary,
        bytes: Buffer.byteLength(last.raw, 'utf8'),
        shifts: last.body.shifts.length,
      });
    }
  } finally {
    // KEEP=1 leaves the last school in place so a failure can be dug into
    // with psql instead of re-created from memory.
    if (!process.env.KEEP) await drop(db);
    await db.end();
    await unlockFixtures();
  }

  report(table);
}

function report(table) {
  console.log(`\nP9-3 §8 — routine generation benchmark`);
  console.log(`  database   ${DATABASE_URL.replace(/:[^:@]*@/, ':***@')}`);
  console.log(`  repeats    ${REPEATS} per profile, each from an EMPTY routine`);
  console.log(`  scope      local container; no network, no TLS, no browser render\n`);

  const head = ['profile', 'sec', 'tchr', 'room', 'shift', 'demand', 'placed',
                'unplaced', 'soft', 'gate', 'solver', 'p50', 'p95', 'kB', 'hard'];
  const rows = table.map((r) => {
    if (r.blocked) {
      return [r.profile.key, String(r.counts.sections), '—', '—', '—', '—',
              'BLOCKED', '—', '—', '—', '—', '—', '—', '—', '—'];
    }
    const s = r.summary;
    return [
      r.profile.key, String(r.counts.sections), String(r.counts.teachers),
      String(r.counts.rooms), String(r.shifts), String(s.totalDemand), String(s.placed),
      String(s.unplacedPeriods), String(s.softViolations),
      `${r.gateMs}ms`, `${f(s.solverSeconds)}s`,
      `${f(pct(r.walls, 50) / 1000)}s`, `${f(pct(r.walls, 95) / 1000)}s`,
      f(r.bytes / 1024, 0), String(r.hardConflicts),
    ];
  });
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells) => '  ' + cells.map((c, i) => c.padEnd(w[i])).join('  ');
  console.log(line(head));
  console.log('  ' + w.map((n) => '─'.repeat(n)).join('  '));
  for (const r of rows) console.log(line(r));

  // A run where nothing generated must not print a pass. An all-blocked
  // table has no slowest anything, and "under 60s" said about zero
  // measurements is exactly the fake the brief forbids.
  const done = table.filter((r) => !r.blocked);
  if (done.length === 0) {
    console.log(`\n  NOTHING GENERATED — no timing claim can be made from this run.\n`);
    return;
  }
  if (done.length < table.length) {
    console.log(`\n  ${table.length - done.length} of ${table.length} profiles did not generate;`
      + ` the lines below cover only the ones that did.`);
  }
  const worst = done.reduce((a, r) => Math.max(a, pct(r.walls, 95)), 0);
  console.log(`\n  slowest p95 across ${done.length} profile(s): ${f(worst / 1000)}s`);
  console.log(worst <= 60_000
    ? `  under the 60s target LOCALLY. Network, TLS and render are NOT in this number.`
    : `  OVER the 60s target even locally — the bottleneck is above, before any network cost.`);
  const dirty = done.filter((r) => r.hardConflicts > 0);
  console.log(dirty.length === 0
    ? `  hard conflicts in stored slots: 0 (re-queried, not self-reported)`
    : `  HARD CONFLICTS FOUND: ${dirty.map((d) => d.profile.key).join(', ')}`);
  console.log('');
}

await main().catch((err) => {
  console.error('benchmark failed:', err);
  process.exitCode = 1;
});
