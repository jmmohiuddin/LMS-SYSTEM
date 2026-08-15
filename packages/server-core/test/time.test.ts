/**
 * The routine endpoint's "today" default.
 *
 *   node --test packages/server-core/test/time.test.ts
 *
 * No DATABASE_URL: what is under test is a clock reading, not a query. The
 * bug these assertions pin down shipped once — dhakaToday() read the host's
 * zone, and a serverless host in UTC is six hours behind the teacher, so
 * between 00:00 and 06:00 Dhaka the routine screen opened on yesterday.
 * Every case below is a real moment in a Bangladeshi teacher's morning.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { dhakaToday, sundayOnOrBefore } from '../src/time.ts';

/** An instant, named the way the host clock would name it. */
const at = (iso: string): number => Date.parse(iso);

describe('dhakaToday — the date the teacher gets when the PWA sends none', () => {
  test('19:00 UTC is already tomorrow in Dhaka', () => {
    // 01:00 on Tuesday the 15th, Dhaka. The host clock still says Monday.
    // The teacher wants Tuesday's periods.
    assert.equal(dhakaToday(at('2026-12-14T19:00:00Z')), '2026-12-15');
  });

  test('the day turns at 18:00 UTC, not at midnight UTC', () => {
    assert.equal(dhakaToday(at('2026-12-14T17:59:59Z')), '2026-12-14');
    assert.equal(dhakaToday(at('2026-12-14T18:00:00Z')), '2026-12-15');
  });

  test('during school hours the host clock happens to agree', () => {
    // 10:00 Dhaka — the window in which the old implementation looked fine,
    // which is why this went unnoticed.
    assert.equal(dhakaToday(at('2026-12-15T04:00:00Z')), '2026-12-15');
  });

  test('rolls the month and the year with it', () => {
    assert.equal(dhakaToday(at('2026-12-31T18:30:00Z')), '2027-01-01');
    assert.equal(dhakaToday(at('2026-02-28T20:00:00Z')), '2026-03-01');
  });

  test('the zero-argument call — the one the handler makes — reads Dhaka too', (t) => {
    // The injected `now` above would prove nothing if the default parameter
    // were still a host-local read.
    t.mock.timers.enable({ apis: ['Date'], now: at('2026-12-14T19:00:00Z') });
    assert.equal(dhakaToday(), '2026-12-15');
  });
});

describe('the week default, which compounds the error sevenfold', () => {
  test('Saturday night in UTC is Sunday in Dhaka — a new week, not the old one', () => {
    // 01:00 Sunday 20 December, Dhaka. Reading the host clock gives Saturday
    // the 19th, whose week began Sunday the 13th: the teacher opens the week
    // grid and sees the week that just ended.
    const now = at('2026-12-19T19:00:00Z');
    assert.equal(dhakaToday(now), '2026-12-20');
    assert.equal(sundayOnOrBefore(dhakaToday(now)), '2026-12-20');
    assert.equal(sundayOnOrBefore('2026-12-19'), '2026-12-13', 'what the old default produced');
  });

  test('mid-week, the Sunday is unchanged by the shift', () => {
    assert.equal(sundayOnOrBefore(dhakaToday(at('2026-12-15T04:00:00Z'))), '2026-12-13');
  });
});
