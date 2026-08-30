/**
 * R-8 §11 — measuring an onboarding instead of claiming one.
 *
 * The master plan carries an "under one hour" target. R-8's instruction about
 * it is blunt: do not claim it until it has been measured. These tests hold
 * the two properties that make the measurement worth anything —
 *
 *   1. it is derived from what actually happened, so a crashed halfway
 *      onboarding cannot leave a stale "finished" timestamp behind;
 *   2. it refuses to dress a script's forty milliseconds up as a person's
 *      afternoon.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  onboardingMetrics, looksSynthetic, SETUP_STATEMENTS,
  type OnboardingMetrics, type Queryable,
} from '../src/onboarding-metrics.ts';

/**
 * A client that answers the three queries in the order they are issued.
 *
 * Generic in `R` because `Queryable.query` is, and the row shape is what the
 * production call sites use it for. Writing the fake non-generically compiled
 * under `node --test` — which strips types rather than checking them — and was
 * rejected by `tsc`, which is how the type gate came to be red without the
 * suite ever going amber.
 */
function fakeClient(answers: Array<Record<string, unknown>>) {
  let i = 0;
  const seen: Array<{ text: string; values: unknown[] }> = [];
  const client: Queryable & { seen: typeof seen } = {
    seen,
    async query<R = Record<string, unknown>>(text: string, values: unknown[] = []) {
      seen.push({ text, values });
      return { rows: [(answers[i++] ?? {}) as R] };
    },
  };
  return client;
}

const AUDIT = {
  started_at: '2026-08-30T09:05:00Z',
  finished_at: '2026-08-30T09:47:00Z',
  minutes: '42.0',
  steps: '9',
  operators: '1',
};

describe('R-8 §11 — the duration', () => {
  test('THE ONE THAT MATTERS — wall clock, from the first act to the last', async () => {
    const c = fakeClient([AUDIT,
      { first_login_at: '2026-08-30T10:02:00Z' },
      { first_attendance_on: '2026-09-01' }]);
    const m = await onboardingMetrics(c, 't-1');
    assert.equal(m.minutes, 42);
    assert.equal(m.steps, 9);
    assert.equal(m.operators, 1);
    // Wall clock includes the operator telephoning the school for its logo.
    // That is not noise to filter out — it is what onboarding a school is
    // like, and the target is a claim about a person's afternoon.
  });

  test('a single-step onboarding has NO duration, not a duration of zero', async () => {
    // Zero averages beautifully and means nothing. One audit row is one
    // moment, and the honest report of the distance between a moment and
    // itself is "there isn't one".
    const c = fakeClient([{ ...AUDIT, minutes: null, steps: '1' }, {}, {}]);
    const m = await onboardingMetrics(c, 't-1');
    assert.equal(m.minutes, null);
    assert.equal(m.steps, 1);
  });

  test('a school nobody has touched reports nulls, not zeros', async () => {
    const c = fakeClient([
      { started_at: null, finished_at: null, minutes: null, steps: '0', operators: '0' },
      { first_login_at: null }, { first_attendance_on: null }]);
    const m = await onboardingMetrics(c, 't-1');
    assert.equal(m.startedAt, null);
    assert.equal(m.minutes, null);
    assert.equal(m.firstLoginAt, null);
    assert.equal(m.minutesToFirstLogin, null);
  });

  test('more than one operator is reported, because it means somebody needed help', async () => {
    const c = fakeClient([{ ...AUDIT, operators: '3' }, {}, {}]);
    assert.equal((await onboardingMetrics(c, 't-1')).operators, 3);
  });
});

describe('R-8 §11 — what counts as setup', () => {
  test('THE ONE THAT MATTERS — later console actions are not part of onboarding', () => {
    // Suspending a school two months on is a console action. If the query
    // matched every audit row, that school's onboarding would be reported as
    // having taken nine weeks — and the average would be ruined by the one
    // school that had a billing problem in October.
    for (const s of ['set_tenant_status active → suspended', 'set_tenant_status trial → active']) {
      assert.ok(!SETUP_STATEMENTS.some((p) => s.startsWith(p)),
        `"${s}" must not count as setup`);
    }
  });

  test('the statements platform-svc actually writes are all matched', () => {
    // Taken verbatim from audit.platform_access on a real database. If
    // platform-svc changes its wording, this test is where it surfaces —
    // rather than as an onboarding that silently reports 3 steps instead of 9.
    const real = [
      'create_tenant slug=r7-test-alpha status=trial cap=3',
      'set branding',
      'provision_tenant 2027 6-8, 6 sections',
      'created principal',
      'created it_admin',
      'granted it_admin',
      'granted principal',
    ];
    for (const r of real) {
      assert.ok(SETUP_STATEMENTS.some((p) => r.startsWith(p)), `unmatched: "${r}"`);
    }
  });

  test('the query is parameterised, never interpolated', async () => {
    const c = fakeClient([AUDIT, {}, {}]);
    await onboardingMetrics(c, "t-1'; DROP TABLE tenants; --");
    const first = c.seen[0];
    assert.ok(!first.text.includes('DROP TABLE'));
    assert.equal(first.values[0], "t-1'; DROP TABLE tenants; --");
    // One placeholder for the tenant plus one per statement prefix.
    assert.equal(first.values.length, SETUP_STATEMENTS.length + 1);
  });
});

describe('R-8 §11 — time to first login', () => {
  test('it is measured from the END of setup, not the start', async () => {
    // The question is "how long did the activation code sit unused", and
    // measuring from the start would flatter every slow onboarding.
    const c = fakeClient([AUDIT,
      { first_login_at: '2026-08-30T10:47:00Z' },   // one hour after 09:47
      { first_attendance_on: null }]);
    const m = await onboardingMetrics(c, 't-1');
    assert.equal(m.minutesToFirstLogin, 60);
  });

  test('THE ONE THAT MATTERS — signing in DURING setup is negative, not broken', async () => {
    // The principal logs in while the operator is still importing students.
    // That is ordinary and it is a good sign. The value is signed and the
    // caller renders it as "during setup" — the console's first version
    // printed "-১৭ মিনিট পরে" on the one school onboarded by hand, which is
    // how this test came to exist.
    const c = fakeClient([AUDIT,
      { first_login_at: '2026-08-30T09:30:00Z' },   // 17 min before 09:47
      { first_attendance_on: null }]);
    const m = await onboardingMetrics(c, 't-1');
    assert.equal(m.minutesToFirstLogin, -17);
    assert.notEqual(m.minutesToFirstLogin, null);
  });

  test('nobody having signed in is null, and is the thing worth noticing', async () => {
    // A code handed over in person and never used is the commonest silent
    // failure of an onboarding — invisible in every other number.
    const c = fakeClient([AUDIT, { first_login_at: null }, { first_attendance_on: null }]);
    const m = await onboardingMetrics(c, 't-1');
    assert.equal(m.minutesToFirstLogin, null);
    assert.equal(m.firstLoginAt, null);
    assert.notEqual(m.finishedAt, null);
  });
});

describe('R-8 §11 — refusing to flatter the numbers', () => {
  const base: OnboardingMetrics = {
    tenantId: 't', startedAt: 'x', finishedAt: 'y', minutes: 42, steps: 9,
    operators: 1, firstLoginAt: null, minutesToFirstLogin: null, firstAttendanceOn: null,
  };

  test('THE ONE THAT MATTERS — a seeded tenant is flagged as synthetic', () => {
    // Nine console actions in under a minute is a script, not a registrar.
    // Letting it into an average produces a number no human could reproduce.
    assert.equal(looksSynthetic({ ...base, minutes: 0.04 }), true);
    assert.equal(looksSynthetic({ ...base, minutes: 0.9, steps: 6 }), true);
  });

  test('a real onboarding is not', () => {
    assert.equal(looksSynthetic(base), false);
    assert.equal(looksSynthetic({ ...base, minutes: 61 }), false);
  });

  test('a single fast step is not synthetic — there is nothing to measure', () => {
    assert.equal(looksSynthetic({ ...base, minutes: 0.1, steps: 1 }), false);
    assert.equal(looksSynthetic({ ...base, minutes: null }), false);
  });
});
