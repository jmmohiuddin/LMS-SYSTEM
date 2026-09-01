/**
 * F-202's two surfaces: the login screen's activation door and the
 * roster's issue button.
 *
 * The claims that matter:
 *
 *   • the OTP kill switch is a detour now, not a dead end — a student
 *     with a code on paper can get in while SMS stays dark;
 *   • the issued code is shown once, formatted to be read across a desk,
 *     and the card says the two facts the teacher must know;
 *   • a refusal (someone else's student) is a sentence on screen, not a
 *     silent nothing.
 */
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { LoginView, isLoginDisabled } from '../src/login-view.ts';
import { RosterView } from '../src/roster-view.ts';

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

beforeEach(() => { localStorage.clear(); });

function root(): HTMLElement {
  const r = dom.window.document.getElementById('root') as HTMLElement;
  r.textContent = '';
  return r;
}

describe('the login screen (F-202 door)', () => {
  function mountLogin(redeems: Array<{ tenantId: string; code: string }> = [],
                      onLoggedIn = () => {}) {
    const r = root();
    new LoginView({
      root: r, doc: dom.window.document,
      auth: {
        redeemActivationCode: async (tenantId: string, code: string) => {
          redeems.push({ tenantId, code });
        },
      } as never,
      tenantId: 't-1', onLoggedIn,
    });
    return r;
  }

  test('THE ONE THAT MATTERS — the kill switch is a detour, not a dead end', () => {
    // This suite is written against the dark-OTP state; if the aggregator
    // ever lands and the switch flips, the entry moves inline and this
    // assertion should be revisited rather than deleted.
    //
    // R-8 turned the hardcoded LOGIN_DISABLED constant into an answer the
    // SERVER gives, cached beside the branding. A test DOM has no cached
    // answer, so this now also asserts the fail-closed default: a client that
    // has never heard from the server offers the activation-code path rather
    // than a phone form that would 503.
    assert.equal(isLoginDisabled(), true);

    const r = mountLogin();
    const entry = [...r.querySelectorAll('button')]
      .find((b) => b.textContent?.includes('সক্রিয়ন কোড দিয়ে প্রবেশ'));
    assert.ok(entry, 'the door exists on the disabled-login screen');
    // And the screen says where codes come from — a student staring at
    // this has nobody else to ask.
    assert.match(r.textContent ?? '', /শ্রেণিশিক্ষক বা অফিস/);
  });

  test('entering the door shows the code form and submits the code', async () => {
    const redeems: Array<{ tenantId: string; code: string }> = [];
    let loggedIn = false;
    const r = mountLogin(redeems, () => { loggedIn = true; });

    ([...r.querySelectorAll('button')]
      .find((b) => b.textContent?.includes('সক্রিয়ন কোড')) as HTMLButtonElement).click();

    const input = r.querySelector('input[name="activationCode"]') as HTMLInputElement;
    assert.ok(input, 'the code field renders');
    // NOT one-time-code: that hint summons the SMS reader, and this code
    // never arrives by SMS.
    assert.notEqual(input.autocomplete, 'one-time-code');

    input.value = 'ABCD-EFGH';
    (r.querySelector('form') as HTMLFormElement)
      .dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
    for (let i = 0; i < 4; i++) await new Promise((res) => setTimeout(res, 0));

    assert.deepEqual(redeems, [{ tenantId: 't-1', code: 'ABCD-EFGH' }]);
    assert.ok(loggedIn, 'a good code signs the student in');
  });

  test('a short code is stopped client-side with instructions', async () => {
    const redeems: Array<{ tenantId: string; code: string }> = [];
    const r = mountLogin(redeems);
    ([...r.querySelectorAll('button')]
      .find((b) => b.textContent?.includes('সক্রিয়ন কোড')) as HTMLButtonElement).click();
    (r.querySelector('input[name="activationCode"]') as HTMLInputElement).value = 'ABC';
    (r.querySelector('form') as HTMLFormElement)
      .dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
    await new Promise((res) => setTimeout(res, 0));

    assert.equal(redeems.length, 0, 'nothing was sent');
    assert.match(r.textContent ?? '', /৮ অক্ষরের কোডটি সম্পূর্ণ দিন/);
  });
});

describe('the roster issue button (F-202 counter)', () => {
  const STUDENTS = [
    { rollNo: 1, studentId: 's-1', fullName: { bn: 'আনিকা', en: 'Anika' }, phone: null },
    { rollNo: 2, studentId: 's-2', fullName: { bn: 'বিজয়', en: 'Bijoy' }, phone: null },
  ];

  function mountRoster(reply: (body: Record<string, unknown>) => Record<string, unknown> & { __status?: number }) {
    // Prime the caches so the view renders a roster without fetching.
    localStorage.setItem('shikhon_sections_cache', JSON.stringify([
      { id: 'sec-1', name: 'ক', className: { bn: 'নবম', en: 'Nine' } }]));
    localStorage.setItem('shikhon_last_section', 'sec-1');
    localStorage.setItem('shikhon_roster_cache_sec-1', JSON.stringify(STUDENTS));

    const r = root();
    new RosterView({
      root: r, doc: dom.window.document,
      auth: {
        authedFetch: async (url: string, init?: { body?: string }) => {
          // The view fetches its own sections and roster on mount; the
          // issue POST is the only call this suite is interrogating.
          if (url.includes('/sections')) {
            return { ok: true, status: 200, json: async () => ({ sections: [
              { id: 'sec-1', name: 'ক', className: { bn: 'নবম', en: 'Nine' } }] }),
            } as unknown as Response;
          }
          if (url.includes('/roster')) {
            return { ok: true, status: 200,
              json: async () => ({ roster: STUDENTS }) } as unknown as Response;
          }
          const body = JSON.parse(init?.body ?? '{}') as Record<string, unknown>;
          const out = reply(body);
          const status = out.__status ?? 200;
          return { ok: status === 200, status, json: async () => out } as unknown as Response;
        },
      } as never,
    });
    return r;
  }

  test('issuing shows the code ONCE, formatted to be read across a desk', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const r = mountRoster((body) => {
      sent.push(body);
      return { code: 'ABCDEFGH', expiresAt: '2026-08-14T00:00:00Z' };
    });
    for (let i = 0; i < 6; i++) await new Promise((res) => setTimeout(res, 0));

    const btn = r.querySelector('.roster-issue') as HTMLButtonElement;
    assert.ok(btn, 'each roster row carries the issue control');
    btn.click();
    for (let i = 0; i < 4; i++) await new Promise((res) => setTimeout(res, 0));

    assert.deepEqual(sent, [{ action: 'issue', userId: 's-1' }]);
    const card = r.querySelector('.issued-code-card');
    assert.ok(card, 'the code card renders');
    // Grouped for reading aloud; the server strips separators on redeem.
    assert.equal(card!.querySelector('.issued-code-value')?.textContent, 'ABCD-EFGH');
    assert.match(card!.textContent ?? '', /আনিকা এর সক্রিয়ন কোড/);
    // The two facts the teacher must know before the slip leaves the desk.
    assert.match(card!.textContent ?? '', /আর দেখা যাবে না/);
    assert.match(card!.textContent ?? '', /৭২ ঘণ্টা/);

    // Dismissal is deliberate, and the code does not linger.
    (card!.querySelector('button') as HTMLButtonElement).click();
    assert.equal(r.querySelector('.issued-code-card'), null);
    assert.ok(!(r.textContent ?? '').includes('ABCD-EFGH'));
  });

  test('a refusal is a sentence on screen, not a silent nothing', async () => {
    const r = mountRoster(() => ({ __status: 403, error: 'not_your_student' }));
    for (let i = 0; i < 6; i++) await new Promise((res) => setTimeout(res, 0));
    (r.querySelector('.roster-issue') as HTMLButtonElement).click();
    for (let i = 0; i < 4; i++) await new Promise((res) => setTimeout(res, 0));

    assert.equal(r.querySelector('.issued-code-card'), null);
    assert.match(r.textContent ?? '', /শুধু নিজের শাখার শিক্ষার্থীর জন্য/);
  });

  test('while one code is being issued, every issue button waits', async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    const r = mountRoster(() => ({ code: 'ABCDEFGH' }));
    for (let i = 0; i < 6; i++) await new Promise((res) => setTimeout(res, 0));

    // Swap in a slow fetch for this assertion.
    const view = r; void gate; void release; void view;
    const buttons = [...r.querySelectorAll('.roster-issue')] as HTMLButtonElement[];
    // Two students, and from P3 TWO renderings of each row: the roster uses
    // the shared DataTable, which emits a desktop table and a mobile list
    // together and lets a media query hide one. jsdom has no CSS, so both are
    // present here. The count is asserted per STUDENT rather than as a magic
    // number, because the number is now a fact about the layout and the
    // property being guarded is not.
    const students = 2;
    assert.equal(buttons.length % students, 0, 'one control per student per rendering');
    assert.ok(buttons.length >= students);
    buttons[0].click();
    // Synchronously after the click, EVERY issue button is disabled — in both
    // renderings. Two codes issued at once is two slips of paper and one
    // confused teacher, and a control that is live in the hidden rendering is
    // still live for a keyboard.
    const after = [...r.querySelectorAll('.roster-issue')] as HTMLButtonElement[];
    assert.equal(after.length, buttons.length);
    assert.ok(after.every((b) => b.disabled), 'a button stayed clickable');
  });
});
