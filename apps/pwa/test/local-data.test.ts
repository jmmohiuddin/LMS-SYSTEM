/**
 * B-8 — what a logout removes, and the one thing it must never touch.
 *
 * The shared device is the case: a staff-room phone, a family tablet, the
 * school office laptop. The next person to sign in is not the last one, and
 * before this the app had no opinion about that — a logout dropped the token
 * and left every screen's cached answer in `localStorage`, so the next
 * person's first paint could be the previous person's roster.
 *
 * Two properties, and they pull in opposite directions:
 *
 *   * nothing of the previous person survives a logout, **and**
 *   * their unsent attendance survives absolutely everything.
 *
 * The second is why this was not done in P4: the outbox lives beside the
 * caches, and a purge written carelessly takes a teacher's register with it.
 * The register exists nowhere else. So the test that matters most here is the
 * one asserting a deletion did NOT happen.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  purgeLocalData, SESSION_KEYS, DEVICE_KEYS, DEMO_KEYS,
} from '../src/local-data.ts';

/** A localStorage that records what was asked of it. */
function fakeStorage(seed: Record<string, string>): Storage & { removed: string[] } {
  const map = new Map(Object.entries(seed));
  const removed: string[] = [];
  return {
    removed,
    get length() { return map.size; },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v); },
    removeItem: (k: string) => { removed.push(k); map.delete(k); },
    clear: () => map.clear(),
  } as unknown as Storage & { removed: string[] };
}

/** Every `shikhon_` key the app writes today, one of each tier. */
const SEEDED = {
  // tier 1 — session
  shikhon_auth: '{"accessToken":"…"}',
  shikhon_otp_login: '{"phone":"+8801…"}',
  // tier 2 — screen caches, the tier that leaks
  shikhon_last_roster: '[{"name":"আরিফুল"}]',
  shikhon_sections_cache: '[…]',
  shikhon_guardian_home: '{…}',
  shikhon_my_attendance: '{…}',
  shikhon_results_cache: '[…]',
  shikhon_invoices_cache: '[…]',
  shikhon_assignments_cache: '[…]',
  shikhon_chapters_cache: '[…]',
  shikhon_routine_day_2026_09_01: '[…]',
  shikhon_marks_cache_x: '[…]',
  shikhon_exams_cache_x: '[…]',
  shikhon_topic_cache_x: '[…]',
  shikhon_last_section: 'sec-1',
  shikhon_last_section_meta: '{…}',
  shikhon_last_class: 'cls-1',
  shikhon_last_perf_exam: 'exam-1',
  shikhon_my_subjects: '[…]',
  shikhon_teacher_day_2026_09_01: '[…]',
  shikhon_practice_x: '{…}',
  shikhon_assign_draft_x: '{…}',
  // tier 4 — device
  shikhon_d: '16010074-6302-4e9c-80a9-31b91f532c4f',
  shikhon_tid: 'tenant-a',
  shikhon_theme: 'dark',
  shikhon_sidebar_rail: 'collapsed',
  shikhon_reader_textsize: 'lg',
  shikhon_branding_tenant_a: '{"nameBn":"…"}',
  // demo selectors
  shikhon_demo_role: 'class_teacher',
  shikhon_demo_tenant: 'a',
  // and something that is not ours at all
  unrelated_key: 'left alone',
};

function fakeCaches(names: string[]) {
  const deleted: string[] = [];
  return {
    deleted,
    keys: async () => names,
    delete: async (n: string) => { deleted.push(n); return true; },
  } as unknown as CacheStorage & { deleted: string[] };
}

describe('B-8 — logout', () => {
  let ls: ReturnType<typeof fakeStorage>;
  let caches: ReturnType<typeof fakeCaches>;

  beforeEach(() => {
    ls = fakeStorage({ ...SEEDED });
    caches = fakeCaches(['shikhon-shell-v3', 'shikhon-data-v3']);
  });

  test('every screen cache goes', async () => {
    await purgeLocalData('logout', { localStorage: ls, caches });
    for (const k of ['shikhon_last_roster', 'shikhon_sections_cache',
                     'shikhon_guardian_home', 'shikhon_my_attendance',
                     'shikhon_results_cache', 'shikhon_invoices_cache',
                     'shikhon_routine_day_2026_09_01', 'shikhon_teacher_day_2026_09_01',
                     'shikhon_marks_cache_x', 'shikhon_last_section']) {
      assert.equal(ls.getItem(k), null, `${k} is a previous user's data`);
    }
  });

  test('the session goes — that is what a logout is', async () => {
    await purgeLocalData('logout', { localStorage: ls, caches });
    for (const k of SESSION_KEYS) assert.equal(ls.getItem(k), null, k);
  });

  test('the device survives, so the school keeps its door and its id', async () => {
    await purgeLocalData('logout', { localStorage: ls, caches });
    for (const k of DEVICE_KEYS) {
      assert.notEqual(ls.getItem(k), null, `${k} describes the device, not the person`);
    }
    assert.equal(ls.getItem('shikhon_d'), SEEDED.shikhon_d,
      'a new device id on every logout would churn push and sync registrations');
    assert.notEqual(ls.getItem('shikhon_branding_tenant_a'), null,
      'branding is public and is what draws the school’s own login screen (D12)');
  });

  test('keys that are not ours are not ours to delete', async () => {
    await purgeLocalData('logout', { localStorage: ls, caches });
    assert.equal(ls.getItem('unrelated_key'), 'left alone');
  });

  test('the service worker’s cached responses go too', async () => {
    const r = await purgeLocalData('logout', { localStorage: ls, caches });
    assert.equal(r.caches, 2);
    assert.deepEqual(caches.deleted, ['shikhon-shell-v3', 'shikhon-data-v3']);
  });

  test('THE ONE THAT MATTERS — the outbox is never touched', async () => {
    const r = await purgeLocalData('logout', { localStorage: ls, caches });
    assert.equal(r.outboxTouched, false);
    // Asserted against the SOURCE, not just the return value: the outbox is
    // in IndexedDB, so a careless `deleteDatabase('shikhon')` would destroy a
    // teacher's unsent register and this module's own result flag would still
    // say false. The register exists nowhere else.
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, '..', 'src', 'local-data.ts'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    assert.doesNotMatch(code, /deleteDatabase/,
      'purgeLocalData must never delete an IndexedDB database');
    assert.doesNotMatch(code, /indexedDB/,
      'it must not reach IndexedDB at all');
  });

  test('a purge survives storage being unavailable', async () => {
    const hostile = {
      get length(): number { throw new Error('SecurityError'); },
    } as unknown as Storage;
    // Private mode, or a browser with site data blocked. A logout that throws
    // half way is a logout that did not happen.
    const r = await purgeLocalData('logout', { localStorage: hostile, caches });
    assert.equal(r.removed.length, 0);
    assert.equal(r.caches, 2, 'the cache step still runs');
  });

  test('with no Cache API at all it still clears storage', async () => {
    const r = await purgeLocalData('logout', { localStorage: ls });
    assert.ok(r.removed.length > 0);
    assert.equal(r.caches, 0);
  });
});

describe('B-8 — a demo role switch is not a logout', () => {
  test('screen caches go, but the session and the selectors stay', async () => {
    const ls = fakeStorage({ ...SEEDED });
    await purgeLocalData('role-switch', { localStorage: ls, caches: fakeCaches([]) });

    assert.equal(ls.getItem('shikhon_last_roster'), null,
      'the previous role’s roster is the leak this fixed in P4');
    // Nobody signed out. The demo has no session to end, and clearing the
    // selectors would send the picker back to the default role mid-switch.
    for (const k of [...SESSION_KEYS, ...DEMO_KEYS]) {
      assert.notEqual(ls.getItem(k), null, k);
    }
  });

  test('the two reasons differ in exactly one tier', async () => {
    const a = fakeStorage({ ...SEEDED });
    const b = fakeStorage({ ...SEEDED });
    const out = await purgeLocalData('logout', { localStorage: a });
    const sw = await purgeLocalData('role-switch', { localStorage: b });
    const diff = out.removed.filter((k) => !sw.removed.includes(k)).sort();
    assert.deepEqual(diff, [...SESSION_KEYS].sort(),
      'logout removes the session; a role switch does not. Nothing else differs.');
  });
});
