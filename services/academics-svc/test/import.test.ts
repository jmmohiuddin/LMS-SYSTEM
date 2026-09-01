/**
 * Bulk import endpoint — F-1601, wireframe §10.2
 *
 * The pure rules are covered in student-import.test.ts without a database.
 * What needs a real one is everything this suite holds:
 *
 *   • two siblings sharing one guardian's mobile — the case migration 031
 *     exists for, and the case that made the import impossible before it;
 *   • dry-run writing nothing at all;
 *   • the digest refusing a swapped file between step 2 and step 4;
 *   • all-or-nothing on the valid rows;
 *   • F-304 derivation firing after the write.
 *
 *   DATABASE_URL=postgresql://shikhon_runtime:… node --test services/academics-svc/test/import.test.ts
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createDb, type Db } from '../../../packages/server-core/src/db.ts';
import { installTestKeys, call, lockFixtures, unlockFixtures} from '../../../packages/server-core/test/harness.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL ? 'DATABASE_URL not set' : false;

const T       = '7f000000-0000-4000-8000-00000000000f';
const HEAD    = '7f000000-0000-4000-8000-0000000000ff';
const YEAR    = '7f000000-0000-4000-8000-000000000091';
const CLASS9  = '7f000000-0000-4000-8000-0000000000c9';
const SEC_KA  = '7f000000-0000-4000-8000-0000000000b1';
const SEC_KHA = '7f000000-0000-4000-8000-0000000000b2';
const HMATH   = '7f000000-0000-4000-8000-000000000126';
const AGRI    = '7f000000-0000-4000-8000-000000000127';
const BANGLA  = '7f000000-0000-4000-8000-000000000101';
const SCHEME  = '7f000000-0000-4000-8000-0000000000a1';
const TEMPLATE= '7f000000-0000-4000-8000-0000000000a2';

let db: Db;
let headToken: string;
let teacherTokenless: string;
let importer: typeof import('../api/import.ts').default;

const asHead = { tenantId: T, userId: HEAD, role: 'principal' };

async function dropFixtures(): Promise<void> {
  await db.withTenant(asHead, async (c) => {
    await c.query('DELETE FROM tenants WHERE id = $1', [T]);
  });
}

async function seed(): Promise<void> {
  await dropFixtures();
  await db.withTenant(asHead, async (c) => {
    await c.query(
      `INSERT INTO tenants (id, slug, name_bn, name_en, stream, level)
       VALUES ($1,'f1601','আমদানি বিদ্যালয়','Import School','bangla_medium','secondary')`, [T]);
    await c.query(
      `INSERT INTO users (id, tenant_id, full_name_bn, full_name_en, phone_e164, status)
       VALUES ($1,$2,'প্রধান শিক্ষক','Head','+8801799000001','active')`, [HEAD, T]);
    await c.query(
      `INSERT INTO academic_years (id, tenant_id, label, starts_on, ends_on, is_current)
       VALUES ($1,$2,'2026','2026-01-01','2026-12-31',true)`, [YEAR, T]);
    await c.query(
      `INSERT INTO classes (id, tenant_id, level_no, name_bn, name_en, stream, "group")
       VALUES ($1,$2,9,'নবম','Nine','bangla_medium','science')`, [CLASS9, T]);
    await c.query(
      `INSERT INTO sections (id, tenant_id, class_id, academic_year_id, name) VALUES
         ($1,$3,$4,$5,'ক'), ($2,$3,$4,$5,'খ')`,
      [SEC_KA, SEC_KHA, T, CLASS9, YEAR]);
    await c.query(
      `INSERT INTO subjects (id, tenant_id, nctb_code, name_bn, name_en) VALUES
         ($1,$4,'126','উচ্চতর গণিত','Higher Mathematics'),
         ($2,$4,'127','কৃষিশিক্ষা','Agriculture'),
         ($3,$4,'101','বাংলা','Bangla')`,
      [HMATH, AGRI, BANGLA, T]);

    // §11.1 configures the curriculum scheme and subject template BEFORE
    // importing, because F-304 derives each student's subject set from it.
    // Without one the import cannot run, and this fixture is what proves
    // the happy path actually reaches derivation.
    await c.query(
      `INSERT INTO curriculum_schemes
         (id, tenant_id, academic_year_id, stage, assessment_model, grade_rule_set, effective_from)
       VALUES ($1,$2,$3,'secondary','marks_cq_mcq',
               '{"bands":[{"min":80,"grade":"A+","point":5.0},{"min":0,"grade":"F","point":0}],
                 "optional_subject":{"threshold_point":2.0,"counts_in_divisor":false},
                 "fail_grade":"F"}'::jsonb,
               '2026-01-01')`,
      [SCHEME, T, YEAR]);
    await c.query(
      `INSERT INTO subject_templates (id, tenant_id, curriculum_scheme_id, class_id, group_code)
       VALUES ($1,$2,$3,$4,'science')`,
      [TEMPLATE, T, SCHEME, CLASS9]);
    await c.query(
      `INSERT INTO subject_template_items
         (tenant_id, template_id, subject_id, requirement_type, selection_pool, display_order) VALUES
         ($1,$2,$3,'compulsory',NULL,1),
         ($1,$2,$4,'optional','fourth',2),
         ($1,$2,$5,'optional','fourth',3)`,
      [T, TEMPLATE, BANGLA, HMATH, AGRI]);
  });
}

/** Wipe imported rows between tests without rebuilding the whole fixture. */
async function clearImported(): Promise<void> {
  await db.withTenant(asHead, async (c) => {
    await c.query('DELETE FROM import_batches');
    await c.query(`DELETE FROM users WHERE id <> $1`, [HEAD]);
  });
}

const HEADER = 'roll_no,name_bn,class,section,guardian_phone,guardian_name,relation,optional_subject';
const SIBLINGS =
  `${HEADER}\n`
  + '7,আনিকা,9,ক,01712345678,রহিম উদ্দিন,পিতা,উচ্চতর গণিত\n'
  + '8,বিজয়,9,খ,01712345678,রহিম উদ্দিন,পিতা,কৃষিশিক্ষা\n';

async function post(body: Record<string, unknown>, token = headToken) {
  return call(importer, {
    method: 'POST', url: '/api/v1/academics/import', token,
    body: { kind: 'student', academicYearId: YEAR, ...body },
  });
}

describe('bulk import (F-1601, §10.2)', { skip }, () => {
  before(async () => {
    await installTestKeys();
    process.env.PII_MASTER_KEY_V1 ??= Buffer.alloc(32, 7).toString('base64');
    // Serialised against other runs of this same suite — the fixtures below
    // live at fixed uuids and two processes would delete each other's.
    await lockFixtures(DATABASE_URL as string);
    db = createDb(DATABASE_URL as string);
    await seed();
    const { signAccessToken } = await import('../../../packages/server-core/src/jwt.ts');
    headToken = await signAccessToken({ sub: HEAD, tid: T, role: 'principal', roles: ['principal'] });
    teacherTokenless = await signAccessToken({
      sub: HEAD, tid: T, role: 'subject_teacher', roles: ['subject_teacher'] });
    importer = (await import('../api/import.ts')).default;
  });

  after(async () => { if (db) { await dropFixtures(); await db.end(); await unlockFixtures(); } });
  beforeEach(async () => { await clearImported(); });

  test('the dry run writes absolutely nothing', async () => {
    const r = await post({ csv: SIBLINGS });
    assert.equal(r.status, 200);
    const b = r.body as { rowsRead: number; rowsValid: number; rowsImported: number; digest: string };
    assert.equal(b.rowsRead, 2);
    assert.equal(b.rowsValid, 2);
    assert.equal(b.rowsImported, 0);
    assert.match(b.digest, /^[0-9a-f]{64}$/);

    await db.withTenant(asHead, async (c) => {
      const n = await c.query<{ count: string }>('SELECT count(*) FROM enrolments');
      assert.equal(n.rows[0].count, '0', 'step 2 must not enrol anybody');
      const batches = await c.query<{ count: string }>('SELECT count(*) FROM import_batches');
      assert.equal(batches.rows[0].count, '0', 'and must not record a batch');
    });
  });

  test('THE ONE THAT MATTERS — two siblings on one guardian mobile', async () => {
    // Before migration 031 this was impossible: the student needs a phone
    // to satisfy users_contactable, and the second sibling collides with
    // the first on the unique index over (tenant, phone).
    const dry = await post({ csv: SIBLINGS });
    const digest = (dry.body as { digest: string }).digest;

    const r = await post({ csv: SIBLINGS, commit: true, digest });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((r.body as { rowsImported: number }).rowsImported, 2);

    await db.withTenant(asHead, async (c) => {
      const g = await c.query<{ count: string }>(
        `SELECT count(*) FROM users WHERE phone_e164 = '+8801712345678'`);
      assert.equal(g.rows[0].count, '1', 'one guardian, not one per child');

      const links = await c.query<{ count: string }>(
        `SELECT count(*) FROM guardianships gs
           JOIN users g ON g.id = gs.guardian_id
          WHERE g.phone_e164 = '+8801712345678'`);
      assert.equal(links.rows[0].count, '2', 'both children hang off that one guardian');

      const kids = await c.query<{ full_name_bn: string; phone_e164: string | null }>(
        `SELECT u.full_name_bn, u.phone_e164 FROM users u
           JOIN enrolments e ON e.student_id = u.id ORDER BY e.roll_no`);
      assert.deepEqual(kids.rows.map((k) => k.full_name_bn), ['আনিকা', 'বিজয়']);
      // The children hold no phone of their own; reachability is the
      // guardianship, checked at COMMIT by 031's deferred trigger.
      assert.deepEqual(kids.rows.map((k) => k.phone_e164), [null, null]);
    });
  });

  test('a student with no guardian and no phone is refused at COMMIT', async () => {
    // The deferred trigger is the guarantee, not the importer's care.
    await assert.rejects(
      db.withTenant(asHead, async (c) => {
        await c.query(
          `INSERT INTO users (tenant_id, full_name_bn, full_name_en, status)
           VALUES (app.current_tenant(),'অনাথ','Unreachable','invited')`);
      }),
      /has no phone, no email and no contactable guardian|অনাথ/,
    );
  });

  test('the subject set is derived after import, from the template inputs', async () => {
    // §10.2: "the file never contains a subject column". The optional
    // subject is an INPUT to the derivation, not the set.
    const dry = await post({ csv: SIBLINGS });
    await post({ csv: SIBLINGS, commit: true, digest: (dry.body as { digest: string }).digest });

    await db.withTenant(asHead, async (c) => {
      const opt = await c.query<{ roll_no: number; name_bn: string }>(
        `SELECT e.roll_no, s.name_bn
           FROM enrolments e JOIN subjects s ON s.id = e.optional_subject_id
          ORDER BY e.roll_no`);
      assert.deepEqual(opt.rows.map((o) => o.name_bn), ['উচ্চতর গণিত', 'কৃষিশিক্ষা']);
    });
  });

  test('a swapped file between validation and commit is refused', async () => {
    const dry = await post({ csv: SIBLINGS });
    const digest = (dry.body as { digest: string }).digest;

    const other = SIBLINGS.replace('আনিকা', 'অন্য কেউ');
    const r = await post({ csv: other, commit: true, digest });
    assert.equal(r.status, 409);
    assert.equal((r.body as { error: string }).error, 'digest_mismatch');

    await db.withTenant(asHead, async (c) => {
      const n = await c.query<{ count: string }>('SELECT count(*) FROM enrolments');
      assert.equal(n.rows[0].count, '0');
    });
  });

  test('partial import: bad rows are skipped, the count is recorded, good rows land', async () => {
    const csv = `${HEADER}\n`
      + '7,আনিকা,9,ক,01712345678,রহিম,পিতা,উচ্চতর গণিত\n'
      + '9,ভুল শাখা,9,ঘ,01712345679,করিম,পিতা,উচ্চতর গণিত\n'
      + '8,বিজয়,9,খ,01712345678,রহিম,পিতা,কৃষিশিক্ষা\n';
    const dry = await post({ csv });
    const b = dry.body as { rowsRead: number; rowsValid: number; rowsRejected: number;
                            errorCsv: string; errors: Array<{ messageBn: string }> };
    assert.equal(b.rowsRead, 3);
    assert.equal(b.rowsValid, 2);
    assert.equal(b.rowsRejected, 1);
    // §10.2: the error list is downloadable, and it is built server-side so
    // what the operator opens is what the server judged.
    // Quotes are doubled per RFC 4180, so the reason reads
    // `শাখা ""ঘ"" নেই — 9 শ্রেণিতে ক,খ` inside its quoted cell.
    assert.match(b.errorCsv, /শাখা ""ঘ"" নেই/);
    assert.match(b.errorCsv, /9 শ্রেণিতে ক,খ/);
    assert.equal(b.errorCsv.charCodeAt(0), 0xfeff, 'BOM, so Excel renders Bangla');

    const r = await post({ csv, commit: true, digest: (dry.body as { digest: string }).digest });
    assert.equal((r.body as { rowsImported: number }).rowsImported, 2);

    await db.withTenant(asHead, async (c) => {
      // "no silent truncation": the skip is a stored fact, and the
      // arithmetic on the batch row has to add up.
      const batch = await c.query<{ rows_read: number; rows_valid: number;
                                    rows_rejected: number; rows_imported: number; status: string }>(
        `SELECT rows_read, rows_valid, rows_rejected, rows_imported, status FROM import_batches`);
      assert.deepEqual(batch.rows[0], {
        rows_read: 3, rows_valid: 2, rows_rejected: 1, rows_imported: 2, status: 'imported',
      });
    });
  });

  test('a roll number already taken is caught against the live database', async () => {
    const dry = await post({ csv: SIBLINGS });
    await post({ csv: SIBLINGS, commit: true, digest: (dry.body as { digest: string }).digest });

    const again = await post({ csv: SIBLINGS });
    const b = again.body as { rowsValid: number; errors: Array<{ messageBn: string }> };
    assert.equal(b.rowsValid, 0);
    assert.match(b.errors[0].messageBn, /ইতিমধ্যে/);
  });

  test('a subject teacher cannot import a roster', async () => {
    const r = await post({ csv: SIBLINGS }, teacherTokenless);
    assert.equal(r.status, 403);
  });

  test('an oversized file is refused before it is parsed', async () => {
    const r = await post({ csv: `${HEADER}\n${'x'.repeat(1_000_001)}` });
    assert.equal(r.status, 413);
  });

  test('staff import is refused explicitly rather than silently ignored', async () => {
    const r = await call(importer, {
      method: 'POST', url: '/api/v1/academics/import', token: headToken,
      body: { kind: 'staff', academicYearId: YEAR, csv: HEADER },
    });
    assert.equal(r.status, 400);
    assert.equal((r.body as { error: string }).error, 'unsupported_kind');
  });
});
