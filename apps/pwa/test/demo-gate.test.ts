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

/**
 * Every `requireRole(claims, X)` on a GET, resolved to the role list X names.
 *
 * The staff-only sweep above misses these entirely: `/academics/ward` is not
 * staff-only — a class teacher may read it — it simply excludes students. That
 * distinction is why a student could open the guardian panel in the demo and
 * read two children's fees while the P4 test stayed green.
 */
function roleGatedGetPaths(): Array<{ path: string; allowed: string[] }> {
  const out: Array<{ path: string; allowed: string[] }> = [];
  const servicesDir = join(REPO, 'services');
  for (const svc of readdirSync(servicesDir)) {
    const apiDir = join(servicesDir, svc, 'api');
    if (!existsSync(apiDir)) continue;
    for (const file of readdirSync(apiDir)) {
      if (!file.endsWith('.ts') || file === 'index.ts') continue;
      const src = readFileSync(join(apiDir, file), 'utf8');
      const lines = src.split('\n');
      const at = lines.findIndex((l) => /requireRole\(claims,\s*[A-Z_]+\)/.test(l));
      if (at < 0) continue;
      const before = lines.slice(0, at).join('\n');
      // Write-only gates are out of scope for the same reason as above, and
      // there is a THIRD shape here that the staff sweep never met: the GET
      // answers and RETURNS before the guard is reached. `ops/calendar` is
      // written that way on purpose — its read is open to every role, because
      // a guardian planning around ঈদের ছুটি is why a school publishes one.
      if (/req\.method === '(POST|PUT|PATCH|DELETE)'/.test(before)) continue;
      if (/req\.method !== '(POST|PUT|PATCH|DELETE)'/.test(before)) continue;
      if (/if \(req\.method === 'GET'\)[^\n]*return;/.test(before)) continue;

      const name = /requireRole\(claims,\s*([A-Z_]+)\)/.exec(lines[at])?.[1];
      if (!name) continue;
      // The const the handler names, read from the same file.
      const decl = new RegExp(`const ${name}[^=]*=\\s*\\[([\\s\\S]*?)\\]`).exec(src);
      if (!decl) continue;
      const allowed = [...decl[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
      if (!allowed.length) continue;
      out.push({ path: apiPath(svc, file), allowed });
    }
  }
  return out;
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

  test('every role-gated GET is gated in the demo with the SAME role list', () => {
    // Found by driving the demo as a student and typing `#/guardian`: the
    // guardian panel rendered in full — two children, their sections, roll
    // numbers, attendance, outstanding fees and published results. In
    // production `/academics/ward` answers 403 for a student. The demo had no
    // entry for it because the P4 sweep only looked at `requireStaff`.
    const gates = demoGatedPaths();
    const staffOnly = demoSet('DEMO_STAFF_ONLY');
    const wrong: string[] = [];
    for (const { path, allowed } of roleGatedGetPaths()) {
      const excludesReaders = !allowed.includes('student') || !allowed.includes('guardian');
      if (!excludesReaders) continue;                 // open to both: nothing to gate
      if (staffOnly.has(path)) continue;              // already refused outright
      // Nothing to refuse where the demo has no route: it 404s, which is a
      // refusal of a stricter kind. Requiring a gate there would be asking
      // the demo to declare policy about data it does not have.
      if (!DEMO.includes(`case '${path}'`)) continue;
      const demoAllowed = gates.get(path);
      if (!demoAllowed) { wrong.push(`${path} (no demo gate)`); continue; }
      for (const role of ['student', 'guardian']) {
        if (!allowed.includes(role) && demoAllowed.includes(role)) {
          wrong.push(`${path} (demo lets ${role} in, the service does not)`);
        }
      }
    }
    assert.deepEqual(wrong, [], wrong.join('; '));
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

  test('a role switch drops the previous role’s caches and keeps the device', () => {
    // The gate alone was not enough: the screens cache their last answer in
    // localStorage, so switching roles in one browser painted the teacher's
    // roster to the guardian from cache, under an "offline" banner.
    //
    // B-8 moved the classification out of app.ts into local-data.ts, because
    // `doLogout` needs the same one with the session tier removed. What is
    // asserted here is only that the demo picker still routes through it; the
    // tiers themselves are local-data.test.ts's subject.
    const app = readFileSync(join(ROOT, 'src', 'app.ts'), 'utf8');
    assert.match(app, /purgeLocalData\('role-switch'\)\.finally\(/,
      'the picker purges, and reloads even if the purge throws');
    // And the synchronous sweep runs BEFORE the reload, with no await between
    // them — the window a still-mounted screen used to re-cache itself into.
    const finallyBlock = /purgeLocalData\('role-switch'\)\.finally\(([\s\S]*?)\}\);/.exec(app);
    assert.ok(finallyBlock, 'the role switch must purge in a finally');
    const order = finallyBlock[1];
    assert.ok(order.indexOf("sweepNow('role-switch')") >= 0
      && order.indexOf("sweepNow('role-switch')") < order.indexOf('location.reload'),
      'sweepNow must run before the reload, in the same block');
    assert.match(app, /purgeLocalData\('logout'\)/,
      'and logout uses the same classification');
    assert.doesNotMatch(app, /KEEP_ON_ROLE_SWITCH/,
      'one classification, in one place — app.ts must not keep a second copy');
  });
});

function demoSetIn(src: string, name: string): Set<string> {
  const m = new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\);`).exec(src);
  assert.ok(m, `${name} must exist`);
  return new Set([...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]));
}
