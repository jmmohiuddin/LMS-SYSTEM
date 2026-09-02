/**
 * Every column this service names in SQL must exist in the database.
 *
 * ── Why this is a test ──────────────────────────────────────────────────
 * `services/rms-svc/api/editor.ts` selected `rm.name` from `rooms`. There is
 * no `name` column — `rooms` has `code` (NOT NULL) and `name_bn` (nullable).
 * PostgreSQL rejects the statement at parse time, so BOTH of the editor's slot
 * queries raised `column rm.name does not exist` on every call: the routine
 * editor could never render a grid, and the Bangla clash explanation it builds
 * ("… তখন … ক্লাসে ব্যবহৃত হচ্ছে") had never once been shown to anybody.
 *
 * Nothing caught it because nothing had run it. The rms-svc suites exercise
 * the SOLVER, and the editor sits downstream of a `routines` row that no code
 * in the product could create — so the query was unreachable from any test,
 * and unreachable code that names a nonexistent column looks exactly like
 * working code.
 *
 * A type checker cannot help here: the SQL is a string. So the check is
 * against the live schema, which is the only thing that actually knows.
 *
 * ── What it does ────────────────────────────────────────────────────────
 * Reads this service's handler sources, finds every `alias.column` reference
 * whose alias is bound by a `FROM`/`JOIN <table> <alias>`, and asserts the
 * column exists on that table. It is deliberately conservative — an alias it
 * cannot resolve is skipped rather than guessed at, because a false failure
 * here would train somebody to ignore it.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDb, type Db } from '../../../packages/server-core/src/db.ts';
import { lockFixtures, unlockFixtures } from '../../../packages/server-core/test/harness.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL ? 'DATABASE_URL not set' : false;

// fileURLToPath, not URL.pathname: this repo's path contains spaces.
const API_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'api');

let db: Db;
let columns: Map<string, Set<string>>;

/** `FROM users u` / `JOIN rooms rm ON …` / `LEFT JOIN subjects sub` */
const ALIAS_RE = /\b(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*)\s+(?:AS\s+)?([a-z][a-z0-9_]*)\b/gi;
/** `rm.name`, `s.day_of_week` — but not `$1.` or a number. */
const REF_RE = /\b([a-z][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\b/gi;

/** SQL keywords that can follow FROM/JOIN and are not an alias. */
const NOT_AN_ALIAS = new Set(['on', 'as', 'where', 'and', 'or', 'left', 'right',
  'inner', 'outer', 'full', 'cross', 'lateral', 'join', 'using', 'select', 'group',
  'order', 'limit', 'having', 'set', 'values', 'returning']);

describe('rms-svc SQL names columns that exist', { skip }, () => {
  before(async () => {
    await lockFixtures(DATABASE_URL as string);
    db = createDb(DATABASE_URL as string);
    columns = new Map();
    await db.withTenant(
      { tenantId: '00000000-0000-4000-8000-000000000000', userId: '', role: 'system_ingest' },
      async (c) => {
        const { rows } = await c.query<{ table_name: string; column_name: string }>(
          `SELECT table_name, column_name FROM information_schema.columns
            WHERE table_schema = 'public'`);
        for (const r of rows) {
          if (!columns.has(r.table_name)) columns.set(r.table_name, new Set());
          columns.get(r.table_name)!.add(r.column_name);
        }
      },
      { skipGate: true },
    );
  });

  after(async () => { if (db) { await db.end(); await unlockFixtures(); } });

  test('THE ONE THAT MATTERS — no handler selects a column the table does not have', () => {
    const bad: string[] = [];

    for (const file of readdirSync(API_DIR).filter((f) => f.endsWith('.ts'))) {
      const src = readFileSync(join(API_DIR, file), 'utf8');

      // SQL ONLY. The first draft scanned whole files and reported four
      // "missing columns" that were all TypeScript property accesses on a
      // query's result row — `rt.unfilled` reading a computed SQL alias,
      // `s.subject_bn` reading a row object. A guard that cries wolf four
      // times on a clean tree is a guard somebody switches off, so it now
      // looks only inside template literals that contain SQL.
      const code = [...src.matchAll(/`([^`]*)`/g)]
        .map((m) => m[1])
        .filter((s) => /\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b/i.test(s))
        // Line comments inside the SQL, including this fix's own header where
        // it quotes the broken reference while explaining it.
        .map((s) => s.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n'))
        .join('\n');
      if (!code) continue;

      const alias = new Map<string, string>();
      for (const m of code.matchAll(ALIAS_RE)) {
        const [, table, a] = m;
        if (NOT_AN_ALIAS.has(a.toLowerCase())) continue;
        if (!columns.has(table)) continue;       // a CTE, or not a base table
        alias.set(a, table);
      }
      if (alias.size === 0) continue;

      for (const m of code.matchAll(REF_RE)) {
        const [, a, col] = m;
        const table = alias.get(a);
        if (!table) continue;                     // unresolvable alias: skip, do not guess
        const cols = columns.get(table)!;
        if (!cols.has(col)) {
          bad.push(`${file}: ${a}.${col} — ${table} has no column "${col}"`);
        }
      }
    }

    assert.deepEqual([...new Set(bad)], [],
      'SQL in rms-svc references columns that do not exist:\n  ' + bad.join('\n  '));
  });

  test('the check would catch the defect it was written for', () => {
    // The guard passes on a clean tree, which says nothing until we know it
    // can fail. Planted defect, in memory, through the same matcher.
    const planted = `
      const q = \`SELECT rm.name AS room_name
                    FROM routine_slots s
                    LEFT JOIN rooms rm ON rm.id = s.room_id\`;
    `;
    const alias = new Map<string, string>();
    for (const m of planted.matchAll(ALIAS_RE)) {
      const [, table, a] = m;
      if (!NOT_AN_ALIAS.has(a.toLowerCase()) && columns.has(table)) alias.set(a, table);
    }
    assert.equal(alias.get('rm'), 'rooms', 'the alias binder must resolve rm -> rooms');

    const hits: string[] = [];
    for (const m of planted.matchAll(REF_RE)) {
      const [, a, col] = m;
      const t = alias.get(a);
      if (t && !columns.get(t)!.has(col)) hits.push(`${a}.${col}`);
    }
    assert.ok(hits.includes('rm.name'),
      `the detector must flag rm.name; it flagged ${JSON.stringify(hits)}`);
  });

  test('the scan actually reads this service', () => {
    // A detector that scans nothing passes everything.
    const files = readdirSync(API_DIR).filter((f) => f.endsWith('.ts'));
    assert.ok(files.length >= 5, `expected rms-svc handlers, found ${files.length}`);
    assert.ok(columns.size >= 50, `expected the public schema, found ${columns.size} tables`);
    assert.ok(columns.get('rooms')?.has('code'), 'rooms.code must exist');
    assert.equal(columns.get('rooms')?.has('name'), false,
      'rooms.name must NOT exist — if it does, this test has lost its point');
  });
});
