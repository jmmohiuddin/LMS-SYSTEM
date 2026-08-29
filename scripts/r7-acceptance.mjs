#!/usr/bin/env node
/**
 * R-7 end-to-end acceptance — onboard a school through the real API.
 *
 * §28 of the R-7 brief: create an institution, activate it, and have the
 * school immediately usable, with no SQL after the initial platform setup.
 * This script is that walk, against a running deployment.
 *
 * It exercises the SAME endpoints the console calls, in the same order, with
 * the same two credentials. It is not a substitute for the browser
 * acceptance — a console nobody has clicked through is not a console — it is
 * the repeatable half, so the claim survives being re-checked.
 *
 *   BASE=http://localhost:4174 \
 *   PLATFORM_TOKEN=<super_admin jwt> PLATFORM_API_KEY=<key> \
 *   node scripts/r7-acceptance.mjs monipur-high-school "মনিপুর উচ্চ বিদ্যালয়" "Monipur High School"
 *
 * Exit 0 = every stage passed. Any failure prints the stage and stops: a
 * half-onboarded school is exactly the state §22 is about, so the script
 * leaves it standing rather than tidying it away, and the console's derived
 * state will show precisely how far it got.
 */
const BASE = process.env.BASE ?? 'http://localhost:4174';
const TOKEN = process.env.PLATFORM_TOKEN ?? '';
const KEY = process.env.PLATFORM_API_KEY ?? '';

const [slug, nameBn, nameEn, streamArg, levelArg] = process.argv.slice(2);
if (!slug || !nameBn || !nameEn) {
  console.error('usage: r7-acceptance.mjs <slug> <nameBn> <nameEn> [stream] [level]');
  process.exit(2);
}
if (!TOKEN || !KEY) {
  console.error('PLATFORM_TOKEN and PLATFORM_API_KEY are required');
  process.exit(2);
}

const stream = streamArg ?? 'bangla_medium';
const level = levelArg ?? 'secondary';
const year = String(new Date().getUTCFullYear());

let failed = false;
const t0 = Date.now();
const timings = [];

async function call(path, init = {}) {
  const res = await fetch(`${BASE}/api/v1/platform/${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${TOKEN}`,
      'X-Platform-Key': KEY,
      ...(init.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
    e.code = body.error;
    e.detail = body;
    throw e;
  }
  return body;
}

async function stage(label, fn) {
  const s = Date.now();
  try {
    const out = await fn();
    const ms = Date.now() - s;
    timings.push([label, ms]);
    console.log(`ok    ${label.padEnd(34)} ${String(ms).padStart(6)} ms`);
    return out;
  } catch (err) {
    failed = true;
    console.error(`FAIL  ${label}\n      ${err.message}`);
    if (err.detail?.blockers) console.error(`      blockers: ${err.detail.blockers.join(', ')}`);
    throw err;
  }
}

const TEACHERS = [
  'নাম,আইডি,মোবাইল,পদবি,ভূমিকা',
  `মোঃ রফিকুল ইসলাম,${slug}-T1,01711000101,সহকারী শিক্ষক,subject_teacher`,
  `সালমা খাতুন,${slug}-T2,01711000102,সহকারী শিক্ষক,class_teacher`,
  `আব্দুল হালিম,${slug}-T3,01711000103,সিনিয়র শিক্ষক,subject_teacher`,
  // One row that must be REJECTED: no phone and no email. A dry run that
  // never rejects anything has not been tested.
  `নাসরিন আক্তার,${slug}-T4,,প্রভাষক,subject_teacher`,
].join('\n');

/**
 * Students in classes 6–8, and the fourth-subject column is absent on purpose.
 *
 * F-304 makes a fourth subject compulsory from class 9, and the subject has to
 * exist in THAT school's catalogue. A madrasah's catalogue is আকাইদ ও ফিকহ and
 * আরবি, not উচ্চতর গণিত — which is institution type behaving as configuration
 * exactly as D4/D9 intend, and which made the first version of this script
 * pass for a school and fail for a madrasah with the same file.
 *
 * A portable acceptance file cannot name a subject. Classes 6–8 exercise the
 * whole import path — parse, validate, guardians, enrolment, subject
 * derivation — without depending on one stream's curriculum. The class-9
 * optional-subject path has its own coverage in the academics tests.
 */
const STUDENTS = [
  'রোল,নাম,শ্রেণি,শাখা,অভিভাবক,মোবাইল,সম্পর্ক',
  '১,রাফি হাসান,6,ক,মোঃ হাসান,01712000201,father',
  '২,নুসরাত জাহান,6,ক,মোঃ জাহান,01712000202,father',
  // Siblings: the same guardian mobile twice must collapse to ONE guardian
  // with two children, not two guardians.
  '৩,সাদিয়া হাসান,7,খ,মোঃ হাসান,01712000201,father',
  '৪,ইমরান হোসেন,8,ক,রোকসানা বেগম,01712000203,mother',
].join('\n');

async function importFile(tenantId, kind, csv) {
  const dry = await call('import', {
    method: 'POST',
    body: JSON.stringify({ tenantId, kind, csv, fileName: `${kind}.csv` }),
  });
  if (dry.rowsValid === 0) throw new Error(`${kind}: nothing valid to import`);
  const done = await call('import', {
    method: 'POST',
    body: JSON.stringify({
      tenantId, kind, csv, commit: true, digest: dry.digest, fileName: `${kind}.csv`,
    }),
  });
  return { dry, done };
}

try {
  const created = await stage('create institution', () => call('tenants', {
    method: 'POST',
    body: JSON.stringify({
      slug, nameBn, nameEn, stream, level,
      district: 'ঢাকা', addressBn: 'ঢাকা, বাংলাদেশ',
      weekendDays: stream === 'madrasah' ? [5] : [5, 6],
      shifts: ['single'], planCode: 'pilot', studentCap: 600,
    }),
  }));
  const id = created.tenant.id;

  await stage('branding', () => call('branding', {
    method: 'POST',
    body: JSON.stringify({
      tenantId: id,
      branding: {
        nameBn, nameEn,
        primaryColor: stream === 'madrasah' ? '#0D47A1' : '#1B5E20',
        headmasterName: 'প্রধান শিক্ষক',
      },
    }),
  }));

  const prov = await stage('provision academic spine', () => call('provision', {
    method: 'POST',
    body: JSON.stringify({
      tenantId: id, yearLabel: year,
      startsOn: `${year}-01-01`, endsOn: `${year}-12-31`,
      minLevel: 6, maxLevel: 10, sectionsPerClass: 2,
    }),
  }));

  // The one that hides: without grading bands the first result publication of
  // the year fails, months later, with no obvious cause.
  if (!prov.seeded.some((s) => s.includes('grading_bands'))) {
    throw new Error('provisioning did not seed grading bands');
  }

  const admin = await stage('first principal + activation code', () => call('admin', {
    method: 'POST',
    body: JSON.stringify({
      tenantId: id, nameBn: 'প্রধান শিক্ষক', phone: `+8801711${String(Math.abs(hash(slug)) % 900000 + 100000)}`,
      roleCode: 'principal',
    }),
  }));
  if (!admin.activationCode) throw new Error('no activation code returned');

  const t = await stage('import teachers', () => importFile(id, 'teacher', TEACHERS));
  if (t.dry.rowsRejected !== 1) {
    throw new Error(`expected 1 rejected teacher row, got ${t.dry.rowsRejected}`);
  }
  const s = await stage('import students + guardians', () => importFile(id, 'student', STUDENTS));

  const detail = await stage('read derived onboarding state', () => call(`tenant?id=${id}`));
  const st = detail.state;
  // Three siblings' worth of rows, two guardians: 01712000201 appears twice.
  if (st.students !== s.done.rowsImported) {
    throw new Error(`state says ${st.students} students, import said ${s.done.rowsImported}`);
  }
  if (st.guardians !== 3) {
    throw new Error(`expected 3 guardians for 4 students sharing a mobile, got ${st.guardians}`);
  }

  await stage('activate', () => call('status', {
    method: 'POST', body: JSON.stringify({ tenantId: id, status: 'active' }),
  }));

  const after = await stage('confirm active', () => call(`tenant?id=${id}`));
  if (after.tenant.status !== 'active') throw new Error(`status is ${after.tenant.status}`);

  console.log('');
  console.log(`institution   ${nameBn}  (${slug})`);
  console.log(`tenant id     ${id}`);
  console.log(`door          ${BASE}/app?tid=${id}`);
  console.log(`activation    ${admin.activationCode}`);
  console.log(`seeded        ${prov.seeded.join(' ')}`);
  console.log(`counts        classes ${st.classes} · sections ${st.sections}`
    + ` · subjects ${st.subjects} · teachers ${st.teachers}`
    + ` · students ${st.students} · guardians ${st.guardians}`);
  console.log(`TOTAL         ${Date.now() - t0} ms`);
} catch {
  console.error('\nonboarding stopped. The institution is left as it is — the console '
    + 'shows how far it got, and every stage is safe to retry.');
}

function hash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return h;
}

process.exit(failed ? 1 : 0);
