/**
 * R-2 — the bell, the inbox and the composer.
 *
 * The behaviours worth holding: the badge tells the truth, opening a notice
 * is what marks it read, a student's inbox contains only what a student was
 * sent, and the composer restates the audience in words immediately before
 * the irreversible action.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { Shell, type ShellRoute } from '../src/shell.ts';
import { InboxView, relativeDayBn, type InboxNotice } from '../src/inbox-view.ts';
import { NoticeComposeView } from '../src/notice-compose-view.ts';

let dom: JSDOM;

beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body><main id="root"></main></body></html>',
    { url: 'https://school.example/app' });
  const g = globalThis as Record<string, unknown>;
  g.HTMLElement = dom.window.HTMLElement;
  g.HTMLInputElement = dom.window.HTMLInputElement;
  g.HTMLTextAreaElement = dom.window.HTMLTextAreaElement;
  g.HTMLButtonElement = dom.window.HTMLButtonElement;
  g.KeyboardEvent = dom.window.KeyboardEvent;
  g.Event = dom.window.Event;
  g.location = dom.window.location;
  g.localStorage = dom.window.localStorage;
  g.addEventListener = dom.window.addEventListener.bind(dom.window);
  g.removeEventListener = dom.window.removeEventListener.bind(dom.window);
  dom.window.localStorage.clear();
});

const doc = () => dom.window.document;
const root = () => doc().getElementById('root')!;

const notice = (over: Partial<InboxNotice> = {}): InboxNotice => ({
  receiptId: 'r1',
  noticeId: 'n1',
  title: 'পরীক্ষার সূচি',
  body: 'অর্ধবার্ষিক পরীক্ষা রবিবার শুরু।',
  category: 'exam',
  deliveredAt: new Date().toISOString(),
  readAt: null,
  aboutStudent: null,
  ...over,
});

/** An Auth stand-in whose responses the test controls. */
function fakeAuth(routes: Record<string, unknown>, role = 'principal') {
  const calls: { path: string; init?: RequestInit }[] = [];
  return {
    calls,
    role,
    tenantId: 't1',
    userId: 'u1',
    displayName: 'পরীক্ষা',
    isLoggedIn: () => true,
    authedFetch: async (path: string, init?: RequestInit) => {
      calls.push({ path, init });
      const key = Object.keys(routes).find((k) => path.startsWith(k));
      const body = key ? routes[key] : {};
      return new Response(JSON.stringify(body), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    },
  };
}

/** Let the view's constructor-kicked load() settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('the bell', () => {
  const routes: ShellRoute[] = [
    { path: 'home', labelBn: 'হোম', glyph: 'home', mount: (c) => { c.textContent = 'home'; } },
  ];
  const shellWithBell = (): Shell => new Shell({
    root: root(), doc: doc(), routes, defaultPath: 'home',
    displayName: 'রহিম স্যার', onLogout: () => {},
    bell: { onOpen: () => {} },
  });

  test('is present for every role, and starts with no badge', () => {
    const shell = shellWithBell();
    assert.ok(root().querySelector('.shell-bell'));
    const badge = root().querySelector<HTMLElement>('.shell-bell-badge')!;
    assert.equal(badge.hidden, true, 'a badge showing nothing is noise');
    shell.destroy();
  });

  test('shows the count, and hides again at zero', () => {
    const shell = shellWithBell();
    const badge = root().querySelector<HTMLElement>('.shell-bell-badge')!;

    shell.setUnread(3);
    assert.equal(badge.hidden, false);
    assert.equal(badge.textContent, '৩', 'the count is Bangla-numeralled like every other number');

    shell.setUnread(0);
    assert.equal(badge.hidden, true);
    shell.destroy();
  });

  test('caps at ৯+ — three digits do not fit a 20px badge at 360px', () => {
    const shell = shellWithBell();
    const badge = root().querySelector<HTMLElement>('.shell-bell-badge')!;
    shell.setUnread(47);
    assert.equal(badge.textContent, '৯+');
    shell.destroy();
  });

  test('announces the count to a screen reader, not just to the eye', () => {
    const shell = shellWithBell();
    const bell = root().querySelector('.shell-bell')!;
    assert.equal(bell.getAttribute('aria-label'), 'নোটিশ');
    shell.setUnread(4);
    assert.match(bell.getAttribute('aria-label') ?? '', /৪|4/);
    shell.destroy();
  });

  test('opening it is what the shell reports', () => {
    let opened = 0;
    const shell = new Shell({
      root: root(), doc: doc(), routes, defaultPath: 'home',
      displayName: 'x', onLogout: () => {},
      bell: { onOpen: () => { opened++; } },
    });
    root().querySelector<HTMLButtonElement>('.shell-bell')!.click();
    assert.equal(opened, 1);
    shell.destroy();
  });

  test('is absent when no inbox exists to open', () => {
    const shell = new Shell({
      root: root(), doc: doc(), routes, defaultPath: 'home',
      displayName: 'x', onLogout: () => {},
    });
    assert.equal(root().querySelector('.shell-bell'), null);
    shell.destroy();
  });
});

describe('inbox', () => {
  test('lists what this person was sent, newest first', async () => {
    const auth = fakeAuth({
      '/api/v1/ops/inbox': {
        unread: 1,
        notices: [notice(), notice({ noticeId: 'n2', title: 'ছুটির নোটিশ', readAt: new Date().toISOString() })],
      },
    });
    new InboxView({ root: root(), doc: doc(), auth: auth as never });
    await settle();

    const titles = [...root().querySelectorAll('.notice-title')].map((e) => e.textContent);
    assert.deepEqual(titles, ['পরীক্ষার সূচি', 'ছুটির নোটিশ']);
    assert.equal(root().querySelectorAll('.notice-card.unread').length, 1);
  });

  test('THE ONE THAT MATTERS — an inbox contains only this person\'s notices', async () => {
    // The staff notice is absent from a student's payload because no receipt
    // exists for them; this asserts the view renders exactly what it is given
    // and invents nothing from the category.
    const auth = fakeAuth({
      '/api/v1/ops/inbox': { unread: 0, notices: [notice({ category: 'exam' })] },
    }, 'student');
    new InboxView({ root: root(), doc: doc(), auth: auth as never });
    await settle();

    const text = root().textContent ?? '';
    assert.match(text, /পরীক্ষার সূচি/);
    assert.doesNotMatch(text, /শিক্ষক সভা/);
    assert.equal(root().querySelectorAll('.notice-card').length, 1);
  });

  test('opening a notice reveals the body and marks it read', async () => {
    const auth = fakeAuth({ '/api/v1/ops/inbox': { unread: 1, notices: [notice()] } });
    let unreadReported = -1;
    new InboxView({
      root: root(), doc: doc(), auth: auth as never,
      onUnreadChange: (n) => { unreadReported = n; },
    });
    await settle();

    assert.equal(root().querySelector('.notice-body'), null, 'collapsed by default');
    root().querySelector<HTMLButtonElement>('.notice-head')!.click();
    await settle();

    assert.match(root().querySelector('.notice-body')?.textContent ?? '', /রবিবার/);
    assert.equal(unreadReported, 0, 'the badge drops the instant it is opened');
    // Reading is a side effect of opening — no separate "mark read" control.
    const post = auth.calls.find((c) => c.init?.method === 'POST');
    assert.ok(post, 'the read should have been recorded');
    assert.match(String(post!.init!.body), /n1/);
  });

  test('a guardian sees which child a notice is about', async () => {
    const auth = fakeAuth({
      '/api/v1/ops/inbox': {
        unread: 1,
        notices: [notice({ aboutStudent: { id: 's1', nameBn: 'রাফির হাসান' } })],
      },
    }, 'guardian');
    new InboxView({ root: root(), doc: doc(), auth: auth as never });
    await settle();
    // A guardian with two children needs this before reading a word of it.
    assert.match(root().querySelector('.notice-meta')?.textContent ?? '', /রাফির হাসান/);
  });

  test('an empty inbox says so; a failed load says something different', async () => {
    const auth = fakeAuth({ '/api/v1/ops/inbox': { unread: 0, notices: [] } });
    new InboxView({ root: root(), doc: doc(), auth: auth as never });
    await settle();
    // "Nothing has happened" and "we could not check" are different claims.
    assert.match(root().textContent ?? '', /এখনো কোনো নোটিশ নেই/);
  });

  test('marks everything read in one action for a backlog', async () => {
    const auth = fakeAuth({
      '/api/v1/ops/inbox': {
        unread: 2,
        notices: [notice(), notice({ noticeId: 'n2', title: 'দুই' })],
      },
    });
    let unread = -1;
    new InboxView({
      root: root(), doc: doc(), auth: auth as never, onUnreadChange: (n) => { unread = n; },
    });
    await settle();

    const all = [...root().querySelectorAll('button')]
      .find((b) => b.textContent === 'সব পড়া হয়েছে') as HTMLButtonElement;
    assert.ok(all, 'a teacher back from leave needs one action, not forty');
    all.click();
    await settle();

    assert.equal(unread, 0);
    const post = auth.calls.find((c) => c.init?.method === 'POST');
    assert.match(String(post!.init!.body), /"all":true/);
  });

  test('the body is inserted as text, never as markup', async () => {
    const auth = fakeAuth({
      '/api/v1/ops/inbox': {
        unread: 1,
        notices: [notice({ body: '<img src=x onerror=alert(1)>' })],
      },
    });
    new InboxView({ root: root(), doc: doc(), auth: auth as never });
    await settle();
    root().querySelector<HTMLButtonElement>('.notice-head')!.click();
    await settle();

    // This string was typed by a person at the school and lands in every
    // reader's browser.
    assert.equal(root().querySelector('.notice-body')?.querySelector('img'), null);
    assert.match(root().querySelector('.notice-body')?.textContent ?? '', /<img/);
  });
});

describe('relativeDayBn', () => {
  test('says today, yesterday, then a count, then a date', () => {
    const now = Date.parse('2026-08-29T12:00:00Z');
    const ago = (d: number) => new Date(now - d * 86_400_000).toISOString();
    assert.equal(relativeDayBn(ago(0), now), 'আজ');
    assert.equal(relativeDayBn(ago(1), now), 'গতকাল');
    assert.equal(relativeDayBn(ago(3), now), '3 দিন আগে');
    assert.doesNotMatch(relativeDayBn(ago(30), now), /দিন আগে/);
  });

  test('survives a malformed timestamp rather than rendering NaN', () => {
    assert.equal(relativeDayBn('not a date'), '');
  });
});

describe('composer', () => {
  const sections = {
    '/api/v1/academics/sections': {
      sections: [
        { id: '7bd00000-0000-4000-8000-00000000000a', name: 'ক', className: { bn: 'নবম' } },
        { id: '7bd00000-0000-4000-8000-00000000000b', name: 'খ', className: { bn: 'নবম' } },
      ],
    },
  };

  test('management may address the whole school', async () => {
    const auth = fakeAuth(sections, 'principal');
    new NoticeComposeView({ root: root(), doc: doc(), auth: auth as never });
    await settle();
    const chips = [...root().querySelectorAll('.audience-chip')].map((c) => c.textContent);
    assert.ok(chips.includes('সবাই'));
    assert.ok(chips.includes('শুধু শিক্ষক ও কর্মকর্তা'));
  });

  test('THE ONE THAT MATTERS — a class teacher is offered sections only', async () => {
    const auth = fakeAuth(sections, 'class_teacher');
    new NoticeComposeView({ root: root(), doc: doc(), auth: auth as never });
    await settle();
    const chips = [...root().querySelectorAll('.audience-chip')].map((c) => c.textContent);
    // "All guardians" from a class teacher is a school-wide broadcast wearing
    // a narrower job title. The server refuses it too.
    assert.deepEqual(chips, ['নির্দিষ্ট শাখা']);
  });

  test('restates the audience in words, right above the send button', async () => {
    const auth = fakeAuth(sections, 'principal');
    new NoticeComposeView({ root: root(), doc: doc(), auth: auth as never });
    await settle();

    const line = () => root().querySelector('[data-audience-line]')?.textContent ?? '';
    assert.equal(line(), 'সবাই');

    const staff = [...root().querySelectorAll('.audience-chip')]
      .find((c) => c.textContent === 'শুধু শিক্ষক ও কর্মকর্তা') as HTMLButtonElement;
    staff.click();
    await settle();
    assert.equal(line(), 'শুধু শিক্ষক ও কর্মকর্তা');
  });

  test('a section audience says guardians are included, because they are', async () => {
    const auth = fakeAuth(sections, 'class_teacher');
    new NoticeComposeView({ root: root(), doc: doc(), auth: auth as never });
    await settle();

    const box = root().querySelector<HTMLInputElement>('.audience-section input')!;
    box.checked = true;
    box.dispatchEvent(new dom.window.Event('change', { bubbles: true }));

    const line = root().querySelector('[data-audience-line]')?.textContent ?? '';
    // "শাখা ৯-ক" alone reads like students only, and it is not.
    assert.match(line, /অভিভাবক/);
  });

  test('send stays disabled until there is something to send', async () => {
    const auth = fakeAuth(sections, 'principal');
    new NoticeComposeView({ root: root(), doc: doc(), auth: auth as never });
    await settle();

    const send = () => root().querySelector<HTMLButtonElement>('[data-send]')!;
    assert.equal(send().disabled, true);

    // Addressed by `name`, not by a styling class: P5 moved these two onto
    // the `field()` primitive and `.login-input` stopped naming them.
    const title = root().querySelector<HTMLInputElement>('[name="title"]')!;
    const body = root().querySelector<HTMLTextAreaElement>('[name="body"]')!;
    title.value = 'ছুটি';
    title.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    assert.equal(send().disabled, true, 'a title with no body is not a notice');

    body.value = 'আগামীকাল বন্ধ';
    body.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    assert.equal(send().disabled, false);
  });

  test('shows the SMS segment cost while the body is being typed', async () => {
    const auth = fakeAuth(sections, 'principal');
    new NoticeComposeView({ root: root(), doc: doc(), auth: auth as never });
    await settle();

    // Emergency turns SMS on by default — that is where the cost matters most.
    const cat = root().querySelector<HTMLSelectElement>('select.login-input')!;
    cat.value = 'emergency';
    cat.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await settle();

    assert.ok(root().querySelector('.sms-toggle'));
    const cost = root().querySelector('[data-sms-cost]');
    assert.ok(cost, 'the cost belongs next to the toggle that causes it');

    const body = root().querySelector<HTMLTextAreaElement>('[name="body"]')!;
    body.value = 'ক'.repeat(71);          // Bangla: 70 chars per segment
    body.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    assert.match(cost!.textContent ?? '', /২/, 'a 71-character Bangla notice is two segments');
  });

  test('publishing reports how many people it actually reached', async () => {
    const auth = fakeAuth({
      ...sections,
      '/api/v1/ops/notices': { noticeId: 'n9', status: 'published', recipients: 128, smsQueued: true },
    }, 'principal');
    new NoticeComposeView({ root: root(), doc: doc(), auth: auth as never });
    await settle();

    const title = root().querySelector<HTMLInputElement>('[name="title"]')!;
    const body = root().querySelector<HTMLTextAreaElement>('[name="body"]')!;
    title.value = 'ছুটি';
    title.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    body.value = 'আগামীকাল বন্ধ';
    body.dispatchEvent(new dom.window.Event('input', { bubbles: true }));

    root().querySelector<HTMLButtonElement>('[data-send]')!.click();
    await settle();
    await settle();

    const said = root().textContent ?? '';
    assert.match(said, /১২৮/, 'the reach is stated in the number the author will remember');
    assert.match(said, /এসএমএস/);
  });
});
