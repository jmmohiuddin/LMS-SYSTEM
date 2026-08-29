/**
 * R-3 completion pass — structure creation, guardian links, the audit viewer.
 *
 * The three capabilities R-3's own report named as missing. Under D13 each
 * one owes loading, empty, error and success states, so those are tested as
 * behaviour rather than trusted.
 *
 * The behaviours worth holding are the ones a school would be harmed by
 * losing:
 *
 *   - the class form does not offer a year, and SAYS why
 *   - the guardian panel searches before it offers to create
 *   - can_pay_fees states its consequence for fee notices, in words
 *   - the last primary guardian cannot be demoted into nobody
 *   - the audit diff shows only what CHANGED
 *   - a refusal is the whole answer, never a refusal above an empty state
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { structureForm, type StructureOptions } from '../src/structure-forms.ts';
import { GuardianPanel, type GuardianLink } from '../src/guardian-panel.ts';
import { AuditView } from '../src/audit-view.ts';

let dom: JSDOM;

beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body><main id="root"></main></body></html>',
    { url: 'https://school.example/app' });
  const g = globalThis as Record<string, unknown>;
  g.HTMLElement = dom.window.HTMLElement;
  g.HTMLInputElement = dom.window.HTMLInputElement;
  g.HTMLSelectElement = dom.window.HTMLSelectElement;
  g.HTMLButtonElement = dom.window.HTMLButtonElement;
  g.HTMLFormElement = dom.window.HTMLFormElement;
  g.Event = dom.window.Event;
  g.KeyboardEvent = dom.window.KeyboardEvent;
  g.location = dom.window.location;
  g.localStorage = dom.window.localStorage;
});

const doc = () => dom.window.document;
const root = () => doc().getElementById('root')!;
const text = () => root().textContent ?? '';
const settle = () => new Promise((r) => setTimeout(r, 0));
const fire = (el: Element, type = 'click') => el.dispatchEvent(new dom.window.Event(type));
const byLabel = (re: RegExp) =>
  [...root().querySelectorAll('button')].find((b) => re.test(b.textContent ?? ''));

function fakeAuth(routes: Record<string, unknown>, opts: { status?: number; throws?: boolean } = {}) {
  const calls: { path: string; init?: RequestInit }[] = [];
  return {
    calls,
    role: 'principal', tenantId: 't1', userId: 'u1', displayName: 'প্রধান',
    isLoggedIn: () => true,
    authedFetch: async (path: string, init?: RequestInit) => {
      calls.push({ path, init });
      if (opts.throws) throw new Error('offline');
      const key = Object.keys(routes)
        .filter((k) => path.startsWith(k))
        .sort((a, b) => b.length - a.length)[0];
      return new Response(JSON.stringify(key ? routes[key] : {}), {
        status: opts.status ?? 200, headers: { 'Content-Type': 'application/json' },
      });
    },
  };
}

const OPTIONS: StructureOptions = {
  defaultStream: 'bangla_medium',
  years: [{ id: 'y1', label: '২০২৬', isCurrent: true }],
  classes: [{ id: 'c1', levelNo: 9, nameBn: 'নবম শ্রেণি', group: 'science' }],
  streams: ['bangla_medium', 'english_version', 'english_medium', 'madrasah', 'technical'],
  groups: ['none', 'science', 'humanities', 'business_studies', 'vocational', 'general'],
  shifts: ['morning', 'day', 'evening', 'single'],
};

// ── Parts 1–2: class and section creation ──────────────────────────────

describe('structure creation', () => {
  const mount = (kind: 'year' | 'class' | 'section', over: Partial<StructureOptions> = {}) => {
    let submitted: Record<string, unknown> | null = null;
    const el = structureForm({
      doc: doc(), kind, options: { ...OPTIONS, ...over }, busy: false,
      onSubmit: (p) => { submitted = p; },
      onCancel: () => {},
    });
    root().append(el);
    return { el, get submitted() { return submitted; } };
  };

  test('THE ONE THAT MATTERS — the class form offers no year, and says why', () => {
    mount('class');
    const labels = [...root().querySelectorAll('label.field')]
      .map((l) => l.childNodes[0].textContent);
    assert.ok(!labels.includes('শিক্ষাবর্ষ'),
      'classes carry no academic_year_id — offering the field would claim it is stored');
    assert.match(text(), /শ্রেণি বছরনির্ভর নয়/,
      'an absent field with no explanation sends the office looking for it');
  });

  test('the Bangla name follows the level chosen, and stops once typed over', () => {
    const { el } = mount('class');
    const level = el.querySelector('select') as HTMLSelectElement;
    const name = el.querySelector('input[type=text]') as HTMLInputElement;
    level.value = '7';
    fire(level, 'change');
    assert.equal(name.value, 'সপ্তম শ্রেণি');

    name.value = 'আমার নিজের নাম';
    fire(name, 'input');
    level.value = '5';
    fire(level, 'change');
    assert.equal(name.value, 'আমার নিজের নাম', 'a typed name is not overwritten');
  });

  test('the stream defaults to the institution’s own', () => {
    const { el } = mount('class', { defaultStream: 'madrasah' });
    const selects = [...el.querySelectorAll('select')] as HTMLSelectElement[];
    assert.equal(selects[selects.length - 1].value, 'madrasah');
  });

  test('a class without a Bangla name is refused, in place', () => {
    const { el, submitted } = mount('class');
    (el.querySelector('input[type=text]') as HTMLInputElement).value = '';
    fire(el, 'submit');
    assert.equal(submitted, null);
    assert.match(el.querySelector('[role=alert]')?.textContent ?? '', /নাম লিখুন/);
  });

  test('the section form asks for the year, because sections DO carry one', () => {
    const { el } = mount('section');
    const labels = [...el.querySelectorAll('label.field')].map((l) => l.childNodes[0].textContent);
    assert.deepEqual(labels,
      ['শিক্ষাবর্ষ', 'শ্রেণি ও বিভাগ', 'সেকশনের নাম', 'শিফট', 'ধারণক্ষমতা']);
  });

  test('a section with no year to attach to says so instead of failing on submit', () => {
    mount('section', { years: [] });
    assert.match(text(), /একটি শিক্ষাবর্ষ দরকার/);
    assert.equal(root().querySelectorAll('input').length, 0);
  });

  test('a section with no class to attach to says so too', () => {
    mount('section', { classes: [] });
    assert.match(text(), /একটি শ্রেণি দরকার/);
  });

  test('capacity is bounded, and the message names the bounds', () => {
    const { el, submitted } = mount('section');
    (el.querySelector('input[type=text]') as HTMLInputElement).value = 'ক';
    (el.querySelector('input[type=number]') as HTMLInputElement).value = '900';
    fire(el, 'submit');
    assert.equal(submitted, null);
    assert.match(el.querySelector('[role=alert]')?.textContent ?? '', /১ থেকে ৩০০/);
  });

  test('a valid section submits the fields the endpoint expects', () => {
    const h = mount('section');
    (h.el.querySelector('input[type=text]') as HTMLInputElement).value = 'G';
    fire(h.el, 'submit');
    assert.deepEqual(h.submitted, {
      kind: 'section', academicYearId: 'y1', classId: 'c1',
      name: 'G', shift: 'morning', capacity: 60,
    });
  });

  test('a year needs an end after its start', () => {
    const h = mount('year');
    const inputs = [...h.el.querySelectorAll('input')] as HTMLInputElement[];
    inputs[0].value = '২০২৭';
    inputs[1].value = '2027-12-31';
    inputs[2].value = '2027-01-01';
    fire(h.el, 'submit');
    assert.equal(h.submitted, null);
    assert.match(h.el.querySelector('[role=alert]')?.textContent ?? '', /শুরুর পরে/);
  });
});

// ── Parts 3–4: guardians and can_pay_fees ──────────────────────────────

const LINK = (over: Partial<GuardianLink> = {}): GuardianLink => ({
  linkId: 'l1', guardianId: 'g1', nameBn: 'আব্দুল করিম', phone: '+8801700000011',
  relation: 'father', isPrimary: true, receivesSms: true, canPayFees: true, otherWards: 2,
  ...over,
});

describe('guardian management', () => {
  const mount = (guardians: GuardianLink[], canManage = true, opts = {}) => {
    const auth = fakeAuth({ '/api/v1/ops/guardians': { guardians } }, opts);
    new GuardianPanel({
      root: root(), doc: doc(), auth: auth as never,
      studentId: 's1', studentNameBn: 'রাফি', canManage,
    });
    return auth;
  };

  test('no guardian is not just "empty" — it says what will not happen', async () => {
    mount([]);
    await settle();
    assert.match(text(), /এসএমএস কারও কাছে যাবে না/,
      'the consequence is what makes an office act on an empty state');
    assert.ok(byLabel(/অভিভাবক যুক্ত করুন/));
  });

  test('THE ONE THAT MATTERS — can_pay_fees explains that it moves fee notices', async () => {
    mount([LINK()]);
    await settle();
    assert.match(text(), /ইনভয়েস ও ফির নোটিশ কেবল এই অনুমতি থাকা অভিভাবকদের কাছে যায়/,
      'a permission toggle whose effect is invisible is one nobody trusts');
  });

  test('and the two permissions are described as different things', async () => {
    mount([LINK()]);
    await settle();
    assert.match(text(), /হাজিরা, নোটিশ ও সাধারণ বার্তা/, 'receives_sms is who is told');
    assert.match(text(), /ইনভয়েস ও ফির নোটিশ/, 'can_pay_fees is who is asked for money');
  });

  test('the success message names the consequence, not just "saved"', async () => {
    const auth = fakeAuth({
      '/api/v1/ops/guardians': { guardians: [LINK()] },
    });
    new GuardianPanel({
      root: root(), doc: doc(), auth: auth as never,
      studentId: 's1', studentNameBn: 'রাফি', canManage: true,
    });
    await settle();
    // The PATCH response says the fee targeting moved.
    (auth as unknown as { authedFetch: unknown }).authedFetch = async () =>
      new Response(JSON.stringify({ feeNoticesChanged: true }), { status: 200 });
    const boxes = [...root().querySelectorAll('input[type=checkbox]')] as HTMLInputElement[];
    boxes[1].checked = false;
    fire(boxes[1], 'change');
    await settle(); await settle();
    assert.match(text(), /ফি ও ইনভয়েসের বার্তা পাবেন না/);
  });

  test('a guardian with other children says so — the duplicate warning', async () => {
    mount([LINK({ otherWards: 2 })]);
    await settle();
    assert.match(text(), /আরও ২ জন সন্তান/);
  });

  test('the add flow searches before it offers to create', async () => {
    mount([LINK()]);
    await settle();
    byLabel(/আরেকজন অভিভাবক/)!.dispatchEvent(new dom.window.Event('click'));
    await settle();
    assert.match(text(), /আগে খুঁজে দেখুন/);
    assert.match(text(), /এসএমএস দুইবার/, 'the cost of a duplicate is the reason to search');
    assert.ok(root().querySelector('input[type=search]'));
  });

  test('a read-only caller gets no toggles, no add button, and no phone', async () => {
    // The phone is withheld by the SERVER for anyone who may not edit it —
    // R-3 established that a number on a screen every teacher can open is a
    // number on every teacher's device, and this panel feeds that same
    // drawer. The panel renders whatever it is given, so the fixture models
    // the server's answer rather than the panel hiding a value it holds.
    mount([LINK({ phone: null })], false);
    await settle();
    assert.equal(root().querySelectorAll('input[type=checkbox]').length, 0);
    assert.equal(byLabel(/আরেকজন অভিভাবক/), undefined);
    assert.match(text(), /এসএমএস পান/, 'but the current state is still legible');
    assert.doesNotMatch(text(), /[+]8801|01[3-9][0-9]{8}/,
      'a phone number here is a phone number on every teacher’s device');
  });

  test('a 403 is the whole answer — no empty state underneath it', async () => {
    mount([], true, { status: 403 });
    await settle();
    assert.match(text(), /অনুমতি নেই/);
    assert.doesNotMatch(text(), /যুক্ত নেই/,
      '"you may not see this" and "there is nothing here" are different claims');
  });

  test('offline says so and offers a retry', async () => {
    mount([], true, { throws: true });
    await settle();
    assert.match(text(), /আনা যায়নি/);
    assert.ok(byLabel(/আবার চেষ্টা/));
  });

  test('promoting a new primary confirms, naming who is being replaced', async () => {
    mount([LINK(), LINK({ linkId: 'l2', guardianId: 'g2', nameBn: 'রোকসানা', isPrimary: false })]);
    await settle();
    byLabel(/প্রধান অভিভাবক করুন/)!.dispatchEvent(new dom.window.Event('click'));
    await settle();
    assert.match(text(), /আব্দুল করিম-এর পরিবর্তে রোকসানা/);
    assert.match(text(), /জরুরি প্রয়োজনে/, 'why the primary matters');
  });
});

// ── Part 5: the audit viewer ───────────────────────────────────────────

const ENTRY = (over: Record<string, unknown> = {}) => ({
  id: '1', at: '2026-08-28T09:12:00Z',
  actor: { id: 'p1', nameBn: 'প্রধান শিক্ষক', role: 'principal' },
  action: 'ops.guardian.permissions', entityType: 'guardianship', entityId: 'l1',
  before: { canPayFees: true, receivesSms: true, phone: '•••11' },
  after: { canPayFees: false, receivesSms: true, phone: '•••11' },
  ...over,
});

const AUDIT = (entries: unknown[], extra: Record<string, unknown> = {}) => ({
  entries, hasMore: false, offset: 0, pageSize: 50,
  facets: {
    actions: [{ value: 'ops.guardian.permissions', count: 1 }],
    entityTypes: [{ value: 'guardianship', count: 1 }],
    actors: [{ id: 'p1', nameBn: 'প্রধান শিক্ষক', count: 1 }],
  },
  ...extra,
});

describe('audit viewer', () => {
  const mount = (body: unknown, opts = {}) => {
    const auth = fakeAuth({ '/api/v1/ops/audit': body }, opts);
    new AuditView({ root: root(), doc: doc(), auth: auth as never });
    return auth;
  };

  test('actions read as Bangla, not as dotted codes', async () => {
    mount(AUDIT([ENTRY()]));
    await settle();
    assert.match(text(), /অভিভাবকের অনুমতি পরিবর্তন/);
    assert.doesNotMatch(text(), /ops\.guardian\.permissions(?![^<]*option)/);
  });

  test('THE ONE THAT MATTERS — the diff shows only what changed', async () => {
    mount(AUDIT([ENTRY()]));
    await settle();
    root().querySelector('.notice-head')!.dispatchEvent(new dom.window.Event('click'));
    await settle();
    const table = root().querySelector('.data-table')!;
    assert.match(table.textContent ?? '', /ফি পরিশোধের অনুমতি/);
    assert.match(table.textContent ?? '', /হ্যাঁ → না/);
    // receivesSms and phone are identical on both sides; burying the one
    // difference among unchanged rows is how a reader misses it.
    assert.doesNotMatch(table.textContent ?? '', /এসএমএস/);
  });

  test('a create has no before-state, and does not claim "no change"', async () => {
    mount(AUDIT([ENTRY({
      id: '2', action: 'academic.section.create', entityType: 'section',
      before: null, after: { name: 'G', capacity: 55 },
    })]));
    await settle();
    root().querySelector('.notice-head')!.dispatchEvent(new dom.window.Event('click'));
    await settle();
    assert.match(text(), /নাম/);
    assert.doesNotMatch(text(), /কোনো মান পরিবর্তিত হয়নি/);
  });

  test('the filters are built from what this school has done', async () => {
    mount(AUDIT([ENTRY()]));
    await settle();
    const selects = [...root().querySelectorAll('.card-form select')] as HTMLSelectElement[];
    assert.equal(selects.length, 3, 'action, entity, actor');
    // "সব" plus the single real value, not a list of every action in the code.
    assert.equal(selects[0].options.length, 2);
    assert.match(selects[0].options[1].textContent ?? '', /অভিভাবকের অনুমতি পরিবর্তন/);
  });

  test('an empty log explains what would fill it', async () => {
    mount(AUDIT([], { facets: { actions: [], entityTypes: [], actors: [] } }));
    await settle();
    assert.match(text(), /শিক্ষক নির্ধারণ, ফলাফল প্রকাশ/);
  });

  test('an empty FILTERED log offers to clear the filter instead', async () => {
    const auth = fakeAuth({ '/api/v1/ops/audit': AUDIT([]) });
    new AuditView({ root: root(), doc: doc(), auth: auth as never });
    await settle();
    const sel = root().querySelector('.card-form select') as HTMLSelectElement;
    sel.value = 'ops.guardian.permissions';
    fire(sel, 'change');
    await settle(); await settle();
    assert.match(text(), /ফিল্টার বদলে দেখুন/);
    assert.ok(byLabel(/ফিল্টার মুছুন/));
  });

  test('a refusal names who may read it, and shows no list underneath', async () => {
    mount(AUDIT([]), { status: 403 });
    await settle();
    assert.match(text(), /কেবল প্রধান শিক্ষক, প্রতিষ্ঠান মালিক ও আইটি অ্যাডমিন/);
    assert.doesNotMatch(text(), /এখনো কোনো পরিবর্তন রেকর্ড হয়নি/);
    assert.equal(root().querySelectorAll('.card-form').length, 0,
      'filters for a list you may not see are noise');
  });

  test('there is no control that writes anything', async () => {
    mount(AUDIT([ENTRY()]));
    await settle();
    const labels = [...root().querySelectorAll('button')].map((b) => b.textContent ?? '');
    for (const bad of ['মুছুন', 'সম্পাদনা', 'সংরক্ষণ']) {
      assert.ok(!labels.some((l) => l.includes(bad)), `audit must not offer "${bad}"`);
    }
  });

  test('redacted values survive to the screen rather than being dropped', async () => {
    mount(AUDIT([ENTRY({
      before: { phone: '•••11' }, after: { phone: '•••47' },
    })]));
    await settle();
    root().querySelector('.notice-head')!.dispatchEvent(new dom.window.Event('click'));
    await settle();
    // "changed to a number ending 47" is what makes the entry useful.
    assert.match(text(), /•••11 → •••47/);
  });
});
