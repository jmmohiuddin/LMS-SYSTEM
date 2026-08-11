/**
 * Group & optional-subject selection — §10.3, F-305 / F-304.
 *
 * Two rules here are load-bearing and neither is visible in a screenshot:
 *
 *  • The regeneration warning is MANDATORY and must fire BEFORE the write.
 *    Changing a fourth subject re-cuts the student's timetable and
 *    invalidates their content assignments. A one-tap save that posts and
 *    then explains is the failure mode; these assert that no request
 *    leaves until a second, deliberate press.
 *
 *  • Derived compulsories are read-only. §10.3: "the coordinator never
 *    types them." A future commit that helpfully makes them editable —
 *    or merely pressable — breaks the derivation contract, because
 *    app.derive_student_subjects would overwrite the edit on the next run.
 *    The assertion is that there is physically nothing to press.
 */
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { SubjectChoiceView } from '../src/subject-choice-view.ts';

let dom: JSDOM;

const ROSTER = {
  roster: [
    { studentId: 's-1', rollNo: 1, fullName: { bn: 'আরিফুল ইসলাম', en: 'Ariful Islam' } },
  ],
};

const CHOICE = () => ({
  student: {
    id: 's-1', nameBn: 'আরিফুল ইসলাম', rollNo: 1,
    classBn: 'নবম শ্রেণি', sectionName: 'ক', groupCode: 'science',
  },
  hasTemplate: true,
  derived: [
    { subjectId: 'sub-bn', nameBn: 'বাংলা', requirementType: 'compulsory' },
    { subjectId: 'sub-ph', nameBn: 'পদার্থবিজ্ঞান', requirementType: 'group_compulsory' },
  ],
  religionOptions: [
    { subjectId: 'sub-isl', nameBn: 'ইসলাম ও নৈতিক শিক্ষা', variant: 'islam' },
    { subjectId: 'sub-hin', nameBn: 'হিন্দুধর্ম ও নৈতিক শিক্ষা', variant: 'hindu' },
  ],
  optionalOptions: [
    { subjectId: 'sub-hma', nameBn: 'উচ্চতর গণিত' },
    { subjectId: 'sub-agr', nameBn: 'কৃষিশিক্ষা' },
  ],
  current: { religionVariant: 'islam', religionSubjectId: 'sub-isl', optionalSubjectId: 'sub-hma' },
});

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

beforeEach(() => { localStorage.clear(); localStorage.setItem('shikhon_last_section', 'sec-1'); });

const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };

async function mount() {
  const posts: Array<{ url: string; body: unknown }> = [];
  const root = dom.window.document.getElementById('root') as HTMLElement;
  root.textContent = '';
  new SubjectChoiceView({
    root, doc: dom.window.document,
    auth: {
      authedFetch: async (url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
          posts.push({ url, body: JSON.parse(String(init.body ?? '{}')) });
          return { ok: true, status: 200,
            json: async () => ({ ok: true, subjectCount: 9, invalidated: ['routine', 'content'] }) } as unknown as Response;
        }
        if (url.includes('/roster')) {
          return { ok: true, status: 200, json: async () => ROSTER } as unknown as Response;
        }
        return { ok: true, status: 200, json: async () => CHOICE() } as unknown as Response;
      },
    } as never,
  });
  await settle();
  return { root, posts };
}

const byText = (root: HTMLElement, sel: string, text: string) =>
  [...root.querySelectorAll(sel)].find((n) => (n.textContent ?? '').includes(text)) as HTMLElement | undefined;

describe('subject choice §10.3', () => {
  test('the group is reported, not offered', async () => {
    const { root } = await mount();
    // The group is a property of the CLASS (classes are unique on
    // tenant/level/stream/group), so changing it is a re-enrolment into a
    // different class — not something a dropdown on this screen can
    // honestly do. It renders as a value plus an explanation of where it
    // is actually set.
    assert.equal(root.querySelector('.choice-readonly-value')?.textContent, 'বিজ্ঞান');
    assert.ok((root.textContent ?? '').includes('অন্য শাখায় স্থানান্তর'));
    // Exactly one select on the screen: the student picker. Not the group.
    assert.equal(root.querySelectorAll('select').length, 1);
  });

  test('derived compulsories are text, with nothing to press', async () => {
    const { root } = await mount();
    const derived = root.querySelector('.choice-derived') as HTMLElement;
    assert.ok(derived, 'derived list renders');
    assert.ok((derived.textContent ?? '').includes('পদার্থবিজ্ঞান'));
    // §10.3: "the coordinator never types them". No buttons, no inputs —
    // the derivation is the authority and the screen offers no way to
    // contradict it.
    assert.equal(derived.querySelectorAll('button, input, select, [role="radio"]').length, 0);
  });

  test('F-304: only the template pools are offered, as two radiogroups', async () => {
    const { root } = await mount();
    const groups = root.querySelectorAll('[role="radiogroup"]');
    assert.equal(groups.length, 2, 'religion and optional');
    // Four options total — the pools as supplied, nothing invented.
    assert.equal(root.querySelectorAll('.choice-option').length, 4);
    // The student's current choices arrive pre-selected, so the screen
    // opens on their real state rather than an empty one.
    const chosen = [...root.querySelectorAll('.choice-option[data-chosen="true"]')]
      .map((b) => b.textContent);
    assert.deepEqual(chosen.sort(), ['ইসলাম ও নৈতিক শিক্ষা', 'উচ্চতর গণিত'].sort());
  });

  test('the regeneration warning fires before any write, and needs a second press', async () => {
    const { root, posts } = await mount();

    // Nothing has changed yet: the footer says so and offers no save.
    assert.ok((root.querySelector('.choice-footer')?.textContent ?? '').includes('কোনো পরিবর্তন করা হয়নি'));
    assert.equal(root.querySelector('.choice-warning'), null, 'no premature warning');

    // Change the fourth subject.
    byText(root, '.choice-option', 'কৃষিশিক্ষা')?.click();
    await settle();
    assert.equal(root.querySelector('.choice-warning'), null, 'still no warning — nothing submitted yet');

    // Press save. This must NOT write; it must explain first.
    byText(root, 'button', 'পরিবর্তন সংরক্ষণ করুন')?.click();
    await settle();

    const warn = root.querySelector('.choice-warning') as HTMLElement;
    assert.ok(warn, 'the warning is mandatory');
    assert.equal(warn.getAttribute('role'), 'alert');
    // It has to name BOTH consequences, not just "are you sure?".
    assert.ok((warn.textContent ?? '').includes('রুটিন'), 'names the routine');
    assert.ok((warn.textContent ?? '').includes('পাঠ বরাদ্দ'), 'names content assignment');
    assert.equal(posts.length, 0, 'NOTHING may be written before confirmation');

    // Only the second, deliberate press writes.
    byText(root, '.choice-confirm-row button', 'নিশ্চিত করুন')?.click();
    await settle();
    assert.equal(posts.length, 1);
    assert.equal((posts[0]?.body as { optionalSubjectId?: string }).optionalSubjectId, 'sub-agr');
  });

  test('cancelling the warning writes nothing', async () => {
    const { root, posts } = await mount();
    byText(root, '.choice-option', 'হিন্দুধর্ম ও নৈতিক শিক্ষা')?.click();
    await settle();
    byText(root, 'button', 'পরিবর্তন সংরক্ষণ করুন')?.click();
    await settle();
    byText(root, '.choice-confirm-row button', 'বাতিল')?.click();
    await settle();
    assert.equal(posts.length, 0);
    assert.equal(root.querySelector('.choice-warning'), null, 'warning clears on cancel');
  });
});
