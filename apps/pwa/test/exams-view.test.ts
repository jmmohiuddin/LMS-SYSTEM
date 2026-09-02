/**
 * P0/A1 — the exam register screen.
 *
 * The domain rules this screen has to respect are all rules of OMISSION, and
 * omissions are exactly what a later "improvement" restores without noticing:
 *
 *   * There is no delete. `exams_delete_scope ... USING (false)` refuses every
 *     role, and Postgres does not raise on rows a DELETE policy filters — so a
 *     delete button would report success (`DELETE 0`) having destroyed nothing
 *     and changed nothing. A row that IS deletable does not exist here.
 *   * There is no status control. `exam_status` is a six-value enum and no
 *     endpoint accepts one from a client; status moves only as a side effect
 *     of results publication and routine publication, each on its own screen.
 *   * Year, term and sections are not editable after creation. PATCH writes
 *     seven columns and reads none of those three, so a control for them would
 *     return 200 and change nothing.
 *
 * Each of those would look like a reasonable feature in a diff. These tests
 * are the thing that objects.
 */
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { ExamsView } from '../src/exams-view.ts';

let dom: JSDOM;

before(() => {
  dom = new JSDOM('<!doctype html><html><body><main id="root"></main></body></html>',
                  { url: 'http://localhost/' });
  (globalThis as Record<string, unknown>).HTMLElement = dom.window.HTMLElement;
  for (const key of ['localStorage', 'location'] as const) {
    Object.defineProperty(globalThis, key, {
      value: dom.window[key], configurable: true, writable: true,
    });
  }
});

const doc = () => dom.window.document;
const root = () => doc().getElementById('root') as HTMLElement;
const drawer = () => doc().querySelector('.ui-dialog');

beforeEach(() => {
  for (const s of [...doc().querySelectorAll('.ui-scrim')]) s.remove();
});

const settle = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0)); };
const byLabel = (label: string) =>
  [...doc().querySelectorAll('button')].find((b) => b.textContent?.trim() === label);

const TREE = {
  years: [{ id: 'y-1', label: '২০২৬', isCurrent: true }],
  year: { id: 'y-1', label: '২০২৬', isCurrent: true },
  classes: [{
    levelNo: 9, nameBn: 'নবম শ্রেণি',
    groups: [{
      classId: 'c-1', group: 'science', groupBn: 'বিজ্ঞান',
      sections: [{ id: 's-1', name: 'ক', studentCount: 42 }],
    }],
  }],
};

const EXAMS = (over: Record<string, unknown> = {}) => ({
  canManage: true,
  examTypes: ['class_test', 'monthly', 'annual'],
  exams: [
    {
      id: 'e-1', nameBn: 'মাসিক পরীক্ষা', nameEn: 'Monthly', examType: 'monthly',
      status: 'planned', startsOn: '2026-03-01', endsOn: '2026-03-05',
      weightPercent: 20, isGpaBearing: true,
      paperCount: 12, sectionCount: 1, markCount: 0,
    },
    {
      id: 'e-2', nameBn: 'বার্ষিক পরীক্ষা', nameEn: 'Annual', examType: 'annual',
      status: 'published', startsOn: '2026-12-01', endsOn: '2026-12-10',
      weightPercent: 60, isGpaBearing: true,
      paperCount: 24, sectionCount: 2, markCount: 480,
    },
  ],
  ...over,
});

/** Answers both GETs the view makes, and records/answers the write. */
function stub(opts: { exams?: Record<string, unknown>; refuse?: { status: number; body: unknown } } = {}) {
  const writes: { method: string; body: Record<string, unknown> }[] = [];
  const auth = {
    authedFetch: async (url: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET') {
        const payload = url.includes('/hierarchy') ? TREE : EXAMS(opts.exams);
        return {
          ok: true, status: 200,
          clone: () => ({ json: async () => payload }),
          json: async () => payload,
        } as unknown as Response;
      }
      writes.push({ method, body: JSON.parse(init?.body ?? '{}') as Record<string, unknown> });
      if (opts.refuse) {
        return {
          ok: false, status: opts.refuse.status, json: async () => opts.refuse!.body,
        } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({ nameBn: 'পরীক্ষা' }) } as unknown as Response;
    },
  } as never;
  return { auth, writes };
}

async function mount(opts?: Parameters<typeof stub>[0]) {
  root().textContent = '';
  const s = stub(opts);
  new ExamsView({ root: root(), doc: doc(), auth: s.auth });
  await settle();
  return s;
}

describe('the exam register respects what the domain does not support', () => {
  test('THE ONE THAT MATTERS — there is no delete control anywhere', async () => {
    await mount();
    const labels = [...doc().querySelectorAll('button')].map((b) => b.textContent ?? '');
    for (const forbidden of ['সরান', 'মুছুন', 'ডিলিট', 'বাতিল করুন']) {
      assert.ok(!labels.some((l) => l.trim() === forbidden),
        `a delete control appeared ("${forbidden}") — exams_delete_scope refuses every role and it would fail silently`);
    }
  });

  test('there is no status control — status is displayed, never set', async () => {
    await mount();
    byLabel('নতুন পরীক্ষা')?.click();
    await settle();
    const names = [...doc().querySelectorAll('[role=dialog] select, [role=dialog] input')]
      .map((e) => (e as HTMLInputElement).name);
    assert.ok(!names.includes('status'),
      'the form offered a status field; no endpoint accepts one');
    // And every enum value still renders a word rather than a blank cell.
    assert.match(root().textContent ?? '', /পরিকল্পিত/);
    assert.match(root().textContent ?? '', /ফলাফল প্রকাশিত/);
  });

  test('a published exam offers no edit — the server would refuse it', async () => {
    await mount();
    const rows = [...root().querySelectorAll('tbody tr')];
    const published = rows.find((r) => (r.textContent ?? '').includes('বার্ষিক'));
    const planned = rows.find((r) => (r.textContent ?? '').includes('মাসিক'));
    assert.equal(published?.querySelectorAll('button').length, 0,
      'a published exam must not offer an edit control');
    assert.ok((planned?.querySelectorAll('button').length ?? 0) > 0,
      'a planned exam must still be editable');
  });

  test('sections are offered on create and NOT on edit', async () => {
    await mount();
    byLabel('নতুন পরীক্ষা')?.click();
    await settle();
    assert.match(drawer()?.textContent ?? '', /কোন সেকশন পরীক্ষা দেবে/,
      'creation must ask which sections sit the exam — papers are derived from them');
    drawer()?.querySelector<HTMLElement>('button')?.click();

    for (const s of [...doc().querySelectorAll('.ui-scrim')]) s.remove();
    const planned = [...root().querySelectorAll('tbody tr')]
      .find((r) => (r.textContent ?? '').includes('মাসিক'));
    planned?.querySelector<HTMLElement>('button')?.click();
    await settle();
    assert.doesNotMatch(drawer()?.textContent ?? '', /কোন সেকশন পরীক্ষা দেবে/,
      'PATCH ignores sectionIds, so offering them on an edit is a control that does nothing');
  });

  test('the exam-type list comes from the server, not from a hard-coded copy', async () => {
    // A hard-coded list drifts the day the CHECK constraint gains a value.
    await mount({ exams: { examTypes: ['board'] } });
    byLabel('নতুন পরীক্ষা')?.click();
    await settle();
    const opts = [...(doc().querySelector<HTMLSelectElement>('select[name="examType"]')?.options ?? [])];
    assert.equal(opts.length, 1);
    assert.equal(opts[0]?.textContent, 'বোর্ড পরীক্ষা');
  });
});

describe('the exam register reports what the server says', () => {
  test('a 409 is shown in the drawer and the typed values survive', async () => {
    const s = await mount({
      refuse: {
        status: 409,
        body: { error: 'duplicate_name', message: 'এই শিক্ষাবর্ষে এই নামে একটি পরীক্ষা ইতিমধ্যে আছে।', field: 'nameBn' },
      },
    });
    byLabel('নতুন পরীক্ষা')?.click();
    await settle();
    const name = doc().querySelector<HTMLInputElement>('input[name="nameBn"]');
    name!.value = 'বার্ষিক পরীক্ষা';
    byLabel('পরীক্ষা তৈরি করুন')?.click();
    await settle();

    assert.equal(s.writes.length, 1, 'the POST must actually have been attempted');
    assert.ok(drawer(), 'the drawer closed on a refusal — the form was discarded');
    assert.match(doc().body.textContent ?? '', /এই নামে একটি পরীক্ষা ইতিমধ্যে আছে/);
    assert.equal(doc().querySelector<HTMLInputElement>('input[name="nameBn"]')?.value,
      'বার্ষিক পরীক্ষা', 'the typed name must not have to be retyped');
  });

  test('the setup-gap refusal is shown verbatim, not flattened into a form error', async () => {
    // 409 no_class_subjects carries no `field`: it means "go configure
    // subjects", which is a different screen, not a box to correct.
    const msg = 'এই সেকশনগুলোর শ্রেণিতে কোনো বিষয় নির্ধারণ করা নেই — আগে বিষয় যোগ করুন।';
    await mount({ refuse: { status: 409, body: { error: 'no_class_subjects', message: msg } } });
    byLabel('নতুন পরীক্ষা')?.click();
    await settle();
    byLabel('পরীক্ষা তৈরি করুন')?.click();
    await settle();
    assert.match(doc().body.textContent ?? '', /আগে বিষয় যোগ করুন/);
  });

  test('a successful create closes the drawer and confirms', async () => {
    // Without this, "never close the drawer" would pass every test above.
    const s = await mount();
    byLabel('নতুন পরীক্ষা')?.click();
    await settle();
    doc().querySelector<HTMLInputElement>('input[name="nameBn"]')!.value = 'নতুন';
    byLabel('পরীক্ষা তৈরি করুন')?.click();
    await settle();
    assert.equal(s.writes[0]?.method, 'POST');
    assert.equal(drawer(), null, 'a successful save must close the drawer');
    assert.match(doc().body.textContent ?? '', /তৈরি করা হয়েছে/);
  });

  test('create sends sectionIds and the year; edit sends neither', async () => {
    const s = await mount();
    byLabel('নতুন পরীক্ষা')?.click();
    await settle();
    doc().querySelector<HTMLInputElement>('input[name="nameBn"]')!.value = 'নতুন';
    // Pick the one section in the fixture.
    [...doc().querySelectorAll('[role=dialog] button')]
      .find((b) => /\(.*জন\)/.test(b.textContent ?? ''))?.click();
    byLabel('পরীক্ষা তৈরি করুন')?.click();
    await settle();

    const post = s.writes[0];
    assert.deepEqual(post?.body.sectionIds, ['s-1']);
    assert.equal(post?.body.academicYearId, 'y-1');
    assert.equal(post?.body.id, undefined);

    for (const el of [...doc().querySelectorAll('.ui-scrim')]) el.remove();
    const planned = [...root().querySelectorAll('tbody tr')]
      .find((r) => (r.textContent ?? '').includes('মাসিক'));
    planned?.querySelector<HTMLElement>('button')?.click();
    await settle();
    byLabel('সংরক্ষণ করুন')?.click();
    await settle();

    const patch = s.writes[1];
    assert.equal(patch?.method, 'PATCH');
    assert.equal(patch?.body.id, 'e-1');
    assert.equal(patch?.body.sectionIds, undefined,
      'PATCH must not send sectionIds — the server ignores them');
    assert.equal(patch?.body.academicYearId, undefined);
  });

  test('a role that cannot manage gets no create button and no row actions', async () => {
    await mount({ exams: { canManage: false } });
    assert.equal(byLabel('নতুন পরীক্ষা'), undefined);
    assert.equal(root().querySelectorAll('tbody button').length, 0);
    // But it still reads the list — this endpoint is staff-wide by design.
    assert.equal(root().querySelectorAll('tbody tr').length, 2);
  });

  test('an empty year explains what will not work, and offers the way out', async () => {
    await mount({ exams: { exams: [] } });
    const t = root().textContent ?? '';
    assert.match(t, /এখনো কোনো পরীক্ষা তৈরি করা হয়নি/);
    // The consequence, not just the absence.
    assert.match(t, /নম্বর দেওয়া বা ফলাফল প্রকাশ করা যাবে না/);
    assert.ok(byLabel('প্রথম পরীক্ষা তৈরি করুন'));
  });
});
