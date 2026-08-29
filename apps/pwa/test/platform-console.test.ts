/**
 * The platform console's onboarding wizard.  (R-7 completion)
 *
 * Written because `apps/pwa/src/platform.ts` — nine screens, the only way a
 * new institution comes into existence — had **no test file at all**. The
 * R-7 phase tested the endpoints beneath it thoroughly and the screen driving
 * them not at all, which is how the defect below survived to be found by
 * reading the tenant list.
 *
 * ── The defect ─────────────────────────────────────────────────────────
 * Screen 1 labelled the STREAM field "প্রতিষ্ঠানের ধরন" — institution type —
 * and the list printed the stream in its ধরন column. A stream is a teaching
 * MEDIUM. So an operator onboarding a college was shown a list of mediums,
 * picked one, and the result was visible on the console the whole time:
 * মোহাম্মদপুর কলেজ stored as `stream=madrasah, level=combined`, listed as
 * **মাদ্রাসা**. A college displayed as a madrasa.
 *
 * The four types the product supports are not a column and should not become
 * one — `stream` and `level` already carry the fact. So they are derived, and
 * these are the tests of that derivation.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  institutionTypeOf, institutionTypeLabel, defaultsForType,
  LEVELS_FOR_TYPE, STREAMS_FOR_TYPE, ALL_TYPES, INSTITUTION_TYPE_BN,
  type InstitutionType,
} from '../src/institution-type.ts';
import { slugify, resumeStepFor } from '../src/platform.ts';

describe('R-7 — the four institution types', () => {
  test('THE ONE THAT MATTERS — a college is a college, not a madrasa', () => {
    // The exact row that was wrong on the console.
    assert.equal(institutionTypeLabel('bangla_medium', 'higher_secondary'), 'কলেজ');
    // And the medium is no longer mistaken for the type.
    assert.notEqual(institutionTypeLabel('bangla_medium', 'secondary'), 'বাংলা মাধ্যম');
  });

  test('all four types the product supports are expressible', () => {
    assert.equal(institutionTypeOf('bangla_medium', 'secondary'), 'school');
    assert.equal(institutionTypeOf('bangla_medium', 'higher_secondary'), 'college');
    assert.equal(institutionTypeOf('madrasah', 'secondary'), 'madrasa');
    assert.equal(institutionTypeOf('bangla_medium', 'combined'), 'school_college');
    assert.deepEqual([...ALL_TYPES].sort(),
      ['college', 'madrasa', 'school', 'school_college']);
  });

  test('a madrasah is a madrasa at every level', () => {
    // A product decision, and the one place the medium outranks the level: a
    // madrasah teaching through আলিম is still what its board says it is.
    for (const level of ['primary', 'junior_secondary', 'secondary',
      'higher_secondary', 'combined']) {
      assert.equal(institutionTypeOf('madrasah', level), 'madrasa', level);
    }
  });

  test('every school level reads back as a school', () => {
    for (const level of ['primary', 'junior_secondary', 'secondary']) {
      assert.equal(institutionTypeOf('bangla_medium', level), 'school', level);
      assert.equal(institutionTypeOf('english_medium', level), 'school', level);
    }
  });

  test('THE ONE THAT MATTERS — every type the wizard can produce reads back as itself', () => {
    // The round trip. Without this, a type could be selectable and then
    // display as something else — which is precisely the bug.
    for (const type of ALL_TYPES) {
      for (const stream of STREAMS_FOR_TYPE[type]) {
        for (const level of LEVELS_FOR_TYPE[type]) {
          assert.equal(institutionTypeOf(stream, level), type,
            `${type} → (${stream}, ${level}) → ${institutionTypeOf(stream, level)}`);
        }
      }
    }
  });

  test('no type offers a medium that would change what it is', () => {
    // Offering "madrasah medium" under School would let an operator build a
    // school that reads back as a madrasa.
    for (const type of ALL_TYPES) {
      if (type === 'madrasa') continue;
      assert.ok(!STREAMS_FOR_TYPE[type].includes('madrasah'), type);
    }
    assert.deepEqual([...STREAMS_FOR_TYPE.madrasa], ['madrasah']);
  });

  test('a college is higher secondary and nothing else', () => {
    // Classes 11–12 are what makes it a college; any other level would make
    // the label a lie.
    assert.deepEqual([...LEVELS_FOR_TYPE.college], ['higher_secondary']);
    assert.deepEqual([...LEVELS_FOR_TYPE.school_college], ['combined']);
  });

  test('every type has a Bangla label, and they are distinct', () => {
    const labels = ALL_TYPES.map((t) => INSTITUTION_TYPE_BN[t]);
    assert.equal(new Set(labels).size, labels.length, 'two types must not read alike');
    assert.ok(labels.every((l) => l.length > 0));
  });
});

describe('R-7 — changing the type mid-draft', () => {
  test('defaults are the sensible first choice for each type', () => {
    // Most Bangladeshi schools onboarded here are secondary, so School opens
    // there rather than at primary.
    assert.deepEqual(defaultsForType('school'),
      { stream: 'bangla_medium', level: 'secondary' });
    assert.deepEqual(defaultsForType('college'),
      { stream: 'bangla_medium', level: 'higher_secondary' });
    assert.deepEqual(defaultsForType('madrasa'),
      { stream: 'madrasah', level: 'secondary' });
    assert.deepEqual(defaultsForType('school_college'),
      { stream: 'bangla_medium', level: 'combined' });
  });

  test('THE ONE THAT MATTERS — a compatible choice already made is kept', () => {
    // An operator who picked ইংরেজি মাধ্যম and then corrected School to
    // College should not silently lose the medium they chose.
    assert.equal(defaultsForType('college', { stream: 'english_medium' }).stream,
      'english_medium');
    assert.equal(defaultsForType('school', { level: 'primary' }).level, 'primary');
  });

  test('an incompatible choice is replaced rather than carried', () => {
    // Carrying madrasah into a School would produce a school that reads back
    // as a madrasa — the bug, reintroduced by the reset logic.
    assert.equal(defaultsForType('school', { stream: 'madrasah' }).stream,
      'bangla_medium');
    // A college cannot stay at secondary.
    assert.equal(defaultsForType('college', { level: 'secondary' }).level,
      'higher_secondary');
  });

  test('switching type and back does not corrupt the draft', () => {
    let draft = defaultsForType('school');
    for (const t of ['college', 'madrasa', 'school_college', 'school'] as InstitutionType[]) {
      draft = defaultsForType(t, draft);
      assert.equal(institutionTypeOf(draft.stream, draft.level), t,
        `after switching to ${t}`);
    }
  });
});

describe('R-7 — resuming an interrupted setup', () => {
  const state = (o: Partial<Parameters<typeof resumeStepFor>[0]> = {}) => ({
    years: 1, classes: 5, admins: 1, teachers: 3, students: 20, ...o,
  });

  test('THE ONE THAT MATTERS — resume lands on what is actually missing', () => {
    // R-7.15 promised resumability and every step does commit; what was
    // missing was the way back IN. An operator returning a week later should
    // not have to work out where they stopped.
    assert.equal(resumeStepFor(state({ years: 0 })), 4);             // academic year
    assert.equal(resumeStepFor(state({ classes: 0 })), 5);           // classes
    assert.equal(resumeStepFor(state({ admins: 0 })), 6);            // admins
    assert.equal(resumeStepFor(state({ teachers: 0 })), 7);          // teacher import
    assert.equal(resumeStepFor(state()), 8);                         // student import
  });

  test('the earliest gap wins, not the latest', () => {
    // The later screens depend on the earlier ones, so a school missing both
    // its academic year and its students resumes at the year.
    assert.equal(resumeStepFor(state({ years: 0, classes: 0, students: 0, teachers: 0 })), 4);
  });

  test('THE ONE THAT MATTERS — the logo never blocks resume', () => {
    // migration 045's `has_branding` measures `settings.branding.logoUrl`, and
    // the wizard cannot set a logo. Gating on it sent every operator to the
    // branding screen forever, because finishing that screen never satisfied
    // the check that sent them there.
    assert.equal(resumeStepFor(state()), 8);
  });

  test('it never lands on screens 1-3', () => {
    // Identity, slug and plan are committed the moment the tenant exists and
    // are edited from the school's own settings, not re-run here.
    for (const st of [
      state({ years: 0 }), state({ classes: 0 }),
      state({ admins: 0 }), state({ teachers: 0 }), state({ students: 0 }), state(),
    ]) {
      const step = resumeStepFor(st);
      assert.ok(step >= 4 && step <= 8, `step ${step} out of range`);
    }
  });

  test('a fully set-up school still offers the last screen rather than nothing', () => {
    // Importing another batch of students is an ordinary thing to come back
    // for; a school that looks "done" must not become unreachable.
    assert.equal(resumeStepFor(state({ students: 500 })), 8);
  });
});

describe('R-7 — the slug, which becomes a school\'s web address', () => {
  test('an English name becomes a URL a school can print', () => {
    assert.equal(slugify('Monipur High School'), 'monipur-high-school');
    assert.equal(slugify('Mohammadpur College'), 'mohammadpur-college');
  });

  test('punctuation, runs and edges collapse to single hyphens', () => {
    assert.equal(slugify('  St. Joseph’s  High   School!! '), 'st-joseph-s-high-school');
    assert.equal(slugify('A---B'), 'a-b');
    assert.equal(slugify('---'), '');
  });

  test('it is stable — the same name always gives the same address', () => {
    // A slug that varied would change a school's subdomain between two runs
    // of the wizard.
    assert.equal(slugify('Monipur High School'), slugify('Monipur High School'));
  });

  test('a Bangla name yields something, rather than an empty address', () => {
    // The wizard asks for the English name for exactly this reason, but a
    // Bangla one must not produce an empty slug that then collides with
    // every other empty slug.
    const s = slugify('মনিপুর উচ্চ বিদ্যালয়');
    assert.ok(s.length > 0);
    assert.doesNotMatch(s, /^-|-$/);
  });
});
