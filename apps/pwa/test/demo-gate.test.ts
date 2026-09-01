/**
 * The demo's role gates, checked against the endpoints they imitate.  (P4)
 *
 * `/demo` has no database, no RLS and no server. Every refusal it makes is a
 * lookup in one of two tables in `demo.ts`, and for a long time one of those
 * tables held a single path while the product's own `requireStaff` guarded
 * seven. The consequence was not theoretical: driving the preview as a
 * GUARDIAN and typing a teacher's URL painted a class register — twelve
 * children's names and roll numbers — on the public marketing surface, which
 * is precisely the posture §21 says the product does not have.
 *
 * Registering every route for every role is deliberate (R-3: "the endpoints
 * and RLS are the enforcement, and a route that 403s honestly is better than
 * one that 404s confusingly"). That decision is what makes this test load
 * bearing rather than tidy: in the demo there is nothing behind the route
 * except this map.
 *
 * So the expectation is DERIVED from the services rather than written down: a
 * new staff-only endpoint added next year fails this test until the demo
 * refuses it too, and nobody has to remember.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// fileURLToPath, not URL.pathname: this repo's path contains spaces.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = join(ROOT, '..', '..');
const DEMO = readFileSync(join(ROOT, 'src', 'demo.ts'), 'utf8');

/** `services/academics-svc/api/roster.ts` → `/api/v1/academics/roster`. */
function apiPath(serviceDir: string, file: string): string {
  return `/api/v1/${serviceDir.replace(/-svc$/, '')}/${file.replace(/\.ts$/, '')}`;
}

/**
 * Every endpoint that refuses a student or guardian on a GET.
 *
 * A `requireStaff` reached only under `req.method === 'POST'` is excluded on
 * purpose: `academics/assignments` and `academics/scripts` gate their WRITES,
 * and their reads are what a student's own homework list is built from.
 * Blocking those in the demo would break the very person the gate protects.
 */
function staffOnlyGetPaths(): string[] {
  const out: string[] = [];
  const servicesDir = join(REPO, 'services');
  for (const svc of readdirSync(servicesDir)) {
    const apiDir = join(servicesDir, svc, 'api');
    if (!existsSync(apiDir)) continue;
    for (const file of readdirSync(apiDir)) {
      if (!file.endsWith('.ts') || file === 'index.ts') continue;
      const src = readFileSync(join(apiDir, file), 'utf8');
      const lines = src.split('\n');
      const at = lines.findIndex((l) => l.includes('requireStaff(claims)'));
      if (at < 0) continue;
      // Is the guard reached only for a write? Two shapes appear in this
      // repo and both mean the same thing: the branch that encloses the guard
      // (`if (req.method === 'POST')`), and the guard clause at the top that
      // 405s everything else (`if (req.method !== 'POST') …`).
      const before = lines.slice(0, at).join('\n');
      if (/req\.method === '(POST|PUT|PATCH|DELETE)'/.test(before)) continue;
      if (/req\.method !== '(POST|PUT|PATCH|DELETE)'/.test(before)) continue;
      out.push(apiPath(svc, file));
    }
  }
  return out.sort();
}

/** The literal string set in demo.ts, read from the source. */
function demoSet(name: string): Set<string> {
  const m = new RegExp(`const ${name} = new Set\\(\\[?([\\s\\S]*?)\\]?\\);`).exec(DEMO);
  assert.ok(m, `${name} must exist in demo.ts`);
  return new Set([...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]));
}

/** The keys of DEMO_GATES, whose allowlists already exclude both roles. */
function demoGatedPaths(): Map<string, string[]> {
  const block = DEMO.slice(DEMO.indexOf('const DEMO_GATES'), DEMO.indexOf('DEMO_STAFF_ONLY'));
  const map = new Map<string, string[]>();
  for (const m of block.matchAll(/'(\/api\/v1\/[^']+)':\s*\[([^\]]*)\]/g)) {
    map.set(m[1], [...m[2].matchAll(/'([^']+)'/g)].map((x) => x[1]));
  }
  return map;
}

describe('P4 — the demo refuses what the server refuses', () => {
  test('every staff-only GET endpoint is refused to students and guardians', () => {
    const staffOnly = demoSet('DEMO_STAFF_ONLY');
    const gates = demoGatedPaths();
    const missing: string[] = [];
    for (const path of staffOnlyGetPaths()) {
      if (staffOnly.has(path)) continue;
      const allow = gates.get(path);
      // A DEMO_GATES entry counts only if it also excludes both roles.
      if (allow && !allow.includes('student') && !allow.includes('guardian')) continue;
      missing.push(path);
    }
    assert.deepEqual(missing, [],
      'these endpoints call requireStaff but the demo answers a guardian: '
      + missing.join(', '));
  });

  test('the demo does not refuse a read the product allows', () => {
    // The mirror of the first test, and the reason it is not simply "block
    // everything": over-blocking makes the preview look broken to exactly the
    // audience it exists for. Both of these are POST-gated in the service and
    // their GETs feed a student's own screens.
    const staffOnly = demoSet('DEMO_STAFF_ONLY');
    for (const open of ['/api/v1/academics/assignments', '/api/v1/academics/scripts',
                        '/api/v1/academics/results', '/api/v1/academics/attendance',
                        '/api/v1/academics/next', '/api/v1/ops/inbox']) {
      assert.ok(!staffOnly.has(open), `${open} must stay readable in the demo`);
    }
  });

  test('a role switch keeps identity and drops the previous role’s caches', () => {
    // The gate alone was not enough: the screens cache their last answer in
    // localStorage, so switching roles in one browser painted the teacher's
    // roster to the guardian from cache, under an "offline" banner. The purge
    // is a keep-list, so a cache added later is dropped by default.
    const app = readFileSync(join(ROOT, 'src', 'app.ts'), 'utf8');
    const keep = demoSetIn(app, 'KEEP_ON_ROLE_SWITCH');
    for (const k of ['shikhon_auth', 'shikhon_tid', 'shikhon_demo_role',
                     'shikhon_demo_tenant', 'shikhon_d']) {
      assert.ok(keep.has(k), `${k} is identity and must survive a role switch`);
    }
    for (const cache of ['shikhon_last_roster', 'shikhon_sections_cache',
                         'shikhon_guardian_home', 'shikhon_my_attendance']) {
      assert.ok(!keep.has(cache), `${cache} is data and must not survive`);
    }
    assert.match(app, /purgeCaches\(\)\.finally\(\(\) => location\.reload\(\)\)/,
      'the reload must happen even if the purge throws');
  });
});

function demoSetIn(src: string, name: string): Set<string> {
  const m = new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\);`).exec(src);
  assert.ok(m, `${name} must exist`);
  return new Set([...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]));
}
