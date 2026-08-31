/**
 * The navigation model. (P1-C)
 *
 * Three properties, each of which is the reason a rule in ui/nav.ts exists:
 *
 *   1. **No path is invented.** A nav entry pointing at a route nobody
 *      registered is this route table's one recurring bug — it has shipped
 *      twice. esbuild then tree-shakes the unreferenced view out of the
 *      bundle entirely, so the link is not merely dead, the screen is gone.
 *      Both times it was caught in production, not by a suite, because no
 *      test walked the route table. This one does, by reading app.ts.
 *   2. **No permission is invented.** Every path a role's sidebar promotes is
 *      already reachable by every role through the unfiltered More menu, and
 *      the server decides who may act. Narrowing a sidebar must change what a
 *      person is OFFERED, never what they may reach.
 *   3. **Nothing becomes unreachable.** `more` closes every sidebar and holds
 *      the bottom bar's fifth slot, so the long tail keeps its one way in.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { navFor, navPaths, crumbFor, navLabel, NAV_ROLES } from '../src/ui/nav.ts';
import { hasIcon } from '../src/icon.ts';

// fileURLToPath, not URL.pathname: this repo's path contains spaces.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP_TS = readFileSync(join(ROOT, 'src', 'app.ts'), 'utf8');

/** Every `path: '…'` in app.ts's route table — the routes that really exist. */
function registeredRoutes(): Set<string> {
  return new Set([...APP_TS.matchAll(/^\s+path: '([a-z-]+)',$/gm)].map((m) => m[1]));
}

describe('P1 — the navigation model points only at real routes', () => {
  test('THE ONE THAT MATTERS — every nav path is a registered route', () => {
    // The guardian route shipped as a More-menu entry with no `mount`, and
    // esbuild removed GuardianView from the bundle as unreferenced. The
    // routine editor did the same thing a phase later. Production found both.
    const routes = registeredRoutes();
    assert.ok(routes.size > 30, `route scan found only ${routes.size} routes`);
    for (const role of NAV_ROLES) {
      for (const path of navPaths(role)) {
        assert.ok(routes.has(path),
          `${role}'s navigation points at '${path}', which app.ts does not register`);
      }
      for (const path of navFor(role).tabs) {
        assert.ok(routes.has(path),
          `${role}'s bottom bar points at '${path}', which app.ts does not register`);
      }
    }
  });

  test('every nav glyph is a real icon, not the fallback dot', () => {
    // `iconSvg` falls back to a neutral dot for an unknown name and says
    // nothing about it — which is how CARD.students carried glyph:'search'
    // from R-6 until P1 without anyone seeing a problem.
    for (const role of NAV_ROLES) {
      for (const group of navFor(role).groups) {
        for (const item of group.items) {
          assert.ok(hasIcon(item.glyph),
            `${role} → ${item.path} uses glyph '${item.glyph}', which has no icon`);
        }
      }
    }
  });
});

describe('P1 — the model grants nothing', () => {
  test('THE ONE THAT MATTERS — every role can still reach everything', () => {
    // The More menu stays unfiltered and every sidebar ends with it, so
    // narrowing navigation cannot strand a screen. If `more` ever leaves a
    // role's model, that role loses its way to two thirds of the app.
    for (const role of NAV_ROLES) {
      assert.ok(navPaths(role).includes('more'),
        `${role}'s sidebar must end with আরও, or the long tail is unreachable`);
      assert.ok(navFor(role).tabs.includes('more'),
        `${role}'s bottom bar must carry আরও`);
    }
  });

  test('no role is offered a path outside the shared catalogue', () => {
    // Every path any role sees must be one some other surface already
    // offers — the model may reorder and hide, never introduce.
    const everything = new Set(NAV_ROLES.flatMap((r) => navPaths(r)));
    for (const p of everything) assert.ok(navLabel(p), `'${p}' has no catalogue entry`);
  });

  test('an IT admin is not offered a teacher-only action', () => {
    // §28. An IT admin has no class, so an attendance row would be an
    // invitation to a 403 — the server would refuse it, and being offered a
    // door that is locked is worse than not seeing the door.
    const it = navPaths('it_admin');
    for (const teacherOnly of ['attendance', 'marks', 'scripts', 'roster']) {
      assert.ok(!it.includes(teacherOnly),
        `it_admin's sidebar offers '${teacherOnly}'`);
    }
    // …and it is still reachable, because More is not filtered.
    assert.ok(it.includes('more'));
  });

  test('a learner is not offered a staff action', () => {
    for (const role of ['student', 'guardian']) {
      const paths = navPaths(role);
      for (const staffOnly of ['attendance', 'marks', 'roster', 'users', 'publish',
        'invoices', 'audit', 'branding', 'compose', 'academic']) {
        assert.ok(!paths.includes(staffOnly),
          `${role}'s sidebar offers '${staffOnly}'`);
      }
    }
  });
});

describe('P1 — the bottom bar is role-aware, and still five', () => {
  test('THE ONE THAT MATTERS — a student is not offered "take attendance"', () => {
    // Before P1 the bar was the first five REGISTERED routes, which is the
    // same five for everyone: হোম / পড়াশোনা / হাজিরা / শিক্ষার্থী / আরও. A
    // fourteen-year-old's phone offered to take a class register.
    const tabs = navFor('student').tabs;
    assert.ok(!tabs.includes('attendance'), 'student bar must not carry attendance');
    assert.ok(!tabs.includes('roster'), 'student bar must not carry the section roster');
    assert.deepEqual(tabs, ['home', 'learn', 'assignments', 'results', 'more']);
  });

  test('a teacher reaches attendance from the bar, not through a menu', () => {
    // §26: attendance is the highest-frequency action in the product and the
    // one taken while a class waits. It is on the bar for every teacher role.
    for (const role of ['class_teacher', 'subject_teacher', 'dept_head']) {
      assert.ok(navFor(role).tabs.includes('attendance'), `${role} lost attendance`);
    }
  });

  test('a guardian reaches the child panel from the bar', () => {
    // §25. It is the guardian's whole reason for opening the app and it used
    // to live in the More menu — the persona least able to go hunting.
    assert.ok(navFor('guardian').tabs.includes('guardian'));
  });

  test('never more than five, for any role', () => {
    for (const role of NAV_ROLES) {
      assert.ok(navFor(role).tabs.length <= 5,
        `${role} asks for ${navFor(role).tabs.length} tabs; Wireframe §2 caps it at 5`);
    }
  });

  test('every tab is also somewhere in that role’s sidebar', () => {
    // Otherwise a route is on the phone's bar and missing from the laptop's
    // navigation entirely — the same person, the same account, two answers.
    for (const role of NAV_ROLES) {
      const side = new Set(navPaths(role));
      for (const t of navFor(role).tabs) {
        assert.ok(side.has(t), `${role}: '${t}' is a tab but not in the sidebar`);
      }
    }
  });
});

describe('P1 — breadcrumbs describe where you are, and no more', () => {
  test('a promoted path gets its section and its name', () => {
    assert.deepEqual(crumbFor('class_teacher', 'attendance'), ['দৈনন্দিন', 'হাজিরা']);
    assert.deepEqual(crumbFor('student', 'results'), ['অগ্রগতি', 'ফলাফল']);
  });

  test('a path the role does not promote gets its name only', () => {
    // Reached from More or a deep link. Naming a section it is not filed
    // under would be a lie about where the person is standing.
    const c = crumbFor('student', 'branding');
    assert.equal(c.length, 1, `expected one crumb, got ${JSON.stringify(c)}`);
  });

  test('an unknown path yields nothing rather than an empty crumb', () => {
    assert.deepEqual(crumbFor('student', 'no-such-page'), []);
  });

  test('never more than two crumbs — the hierarchy is one level deep', () => {
    for (const role of NAV_ROLES) {
      for (const p of navPaths(role)) {
        assert.ok(crumbFor(role, p).length <= 2, `${role}/${p} produced 3+ crumbs`);
      }
    }
  });
});

describe('P1 — roles resolve, including the ones nobody listed', () => {
  test('an unrecognised role falls to the teaching set, not to nothing', () => {
    // `dashboardFor` does the same. A shell with an empty sidebar is worse
    // than one showing a teacher's, every row of which the server still gates.
    assert.deepEqual(navFor('librarian'), navFor('class_teacher'));
    assert.deepEqual(navFor(''), navFor('class_teacher'));
  });

  test('school_owner and principal share one model', () => {
    assert.equal(navFor('school_owner'), navFor('principal'));
  });

  test('no role is given an empty sidebar', () => {
    for (const role of NAV_ROLES) {
      assert.ok(navPaths(role).length >= 6, `${role} has only ${navPaths(role).length} rows`);
    }
  });
});
