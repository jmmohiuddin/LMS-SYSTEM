/**
 * P5 — the remaining IT Admin and Principal screens.
 *
 * These guard the things the browser matrix found and a unit test can hold:
 * that a refusal shows no data and offers no control, that no English backend
 * sentence reaches a Bangla screen, that a failed step is not a dead end, and
 * that each role is offered the import it may actually run.
 *
 * The one that matters most is `ledger-view`: it used to answer a 403 by
 * rendering a complete, plausible ledger.
 */
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { ImportView } from '../src/import-view.ts';
import { AdminSettingsView } from '../src/admin-settings-view.ts';
import { SystemView } from '../src/system-view.ts';
import { LedgerView } from '../src/ledger-view.ts';
import { UsersView } from '../src/users-view.ts';
import { InvoiceView } from '../src/invoice-view.ts';
import { AcademicView } from '../src/academic-view.ts';
import { serverMessage, permissionMessage } from '../src/ui/feedback.ts';
import { bnMonth } from '../src/view-states.ts';

let dom: JSDOM;

before(() => {
  dom = new JSDOM('<!doctype html><html><body><main id="root"></main></body></html>',
                  { url: 'http://localhost/' });
  const g = globalThis as Record<string, unknown>;
  for (const k of ['HTMLElement', 'HTMLInputElement', 'HTMLSelectElement',
                   'HTMLTextAreaElement', 'HTMLButtonElement', 'Node', 'Event',
                   'FileReader', 'Blob'] as const) {
    g[k] = (dom.window as unknown as Record<string, unknown>)[k];
  }
  for (const key of ['localStorage', 'location'] as const) {
    Object.defineProperty(globalThis, key, {
      value: dom.window[key], configurable: true, writable: true,
    });
  }
  Object.defineProperty(globalThis, 'navigator', {
    value: { onLine: true }, configurable: true, writable: true,
  });
});

const root = () => dom.window.document.getElementById('root') as HTMLElement;
const settle = async () => { for (let i = 0; i < 14; i++) await new Promise((r) => setTimeout(r, 0)); };
const text = () => root().textContent ?? '';
/** Controls a person could actually operate right now. */
const live = () => [...root().querySelectorAll('input,select,textarea,button')]
  .filter((e) => !(e as HTMLInputElement).disabled);

/**
 * An auth double whose `authedFetch` answers per-URL, so one view can meet a
 * 200 on one endpoint and a 403 on another — which is the case every refusal
 * test here is about.
 */
function auth(role: string, routes: Record<string, { status: number; body?: unknown }>) {
  return {
    role,
    tenantId: 't-1',
    userId: 'u-1',
    authedFetch: async (url: string) => {
      const hit = Object.entries(routes).find(([k]) => url.includes(k))?.[1]
        ?? { status: 200, body: {} };
      return {
        ok: hit.status >= 200 && hit.status < 300,
        status: hit.status,
        json: async () => hit.body ?? {},
      } as unknown as Response;
    },
  } as never;
}

// ═══════════════════════════════════════════════════════════════════════
describe('P5 — a refusal never fabricates a ledger', () => {
  test('THE ONE THAT MATTERS — 403 shows the refusal and NO numbers', async () => {
    // What this replaces: `else if (res.status === 403) { this.data = DEMO }`
    // rendered a full chart of accounts, MFS reconciliation totals and three
    // double-entry batches in taka under one line reading "নমুনা ডেটা".
    root().textContent = '';
    new LedgerView({
      root: root(), doc: dom.window.document,
      auth: auth('class_teacher', { '/finance/ledger': { status: 403 } }),
    } as never);
    await settle();

    assert.match(text(), new RegExp(permissionMessage('লেজার ও পুনর্মিলন')));
    assert.equal(root().querySelectorAll('table.ui-table').length, 0, 'no tables');
    assert.doesNotMatch(text(), /MFS-BKASH|FEE-INCOME|bKash সংগ্রহ/,
      'the fabricated chart of accounts must not be on screen');
    assert.doesNotMatch(text(), /18450|36500|1250/, 'no fabricated figures');
    assert.doesNotMatch(text(), /নমুনা/,
      'and no "these are samples" caption, because there is nothing to caption');
    assert.doesNotMatch(text(), /আবার চেষ্টা/, 'no retry can help a refusal');
  });

  test('an accountant-level reader gets the real ledger', async () => {
    root().textContent = '';
    new LedgerView({
      root: root(), doc: dom.window.document,
      auth: auth('principal', { '/finance/ledger': { status: 200, body: {
        accounts: [{ code: 'CASH', nameBn: 'নগদ', type: 'asset', balance: '100.00' }],
        batches: [], reconciliation: [],
      } } }),
    } as never);
    await settle();
    assert.match(text(), /নগদ/);
    assert.ok(root().querySelector('table.ui-table'));
    // The account TYPE in words, not the English key from the database.
    assert.match(text(), /সম্পদ/);
    assert.doesNotMatch(text(), /\basset\b/);
  });

  test('a network failure is an error with a retry — NOT a refusal', async () => {
    root().textContent = '';
    new LedgerView({
      root: root(), doc: dom.window.document,
      auth: auth('principal', { '/finance/ledger': { status: 500 } }),
    } as never);
    await settle();
    assert.doesNotMatch(text(), new RegExp(permissionMessage('লেজার ও পুনর্মিলন')));
    assert.match(text(), /আবার চেষ্টা/, 'a 500 IS retryable');
  });
});

// ═══════════════════════════════════════════════════════════════════════
describe('P5 — a refusal offers no controls', () => {
  test('the user list does not put a search box under its own refusal', async () => {
    // Found by the security matrix: the refusal rendered correctly and then a
    // name box, a role filter and "খুঁজুন" underneath it — three controls
    // whose only possible outcome is a second 403.
    root().textContent = '';
    new UsersView({
      root: root(), doc: dom.window.document, canManage: false,
      auth: auth('class_teacher', { '/ops/users': { status: 403 } }),
    } as never);
    await settle();
    assert.match(text(), new RegExp(permissionMessage('ব্যবহারকারী')));
    assert.equal(live().length, 0, 'nothing on this screen can help');
    assert.doesNotMatch(text(), /খুঁজুন/);
  });

  test('invoice generation refuses without listing invoices', async () => {
    root().textContent = '';
    new InvoiceView({
      root: root(), doc: dom.window.document, canGenerate: false,
      auth: auth('student', { '/finance/invoices': { status: 200, body: {
        invoices: [{ invoiceNo: 'INV-2026-08-00001', billingPeriod: '2026-08',
                     totalAmount: '1250.00', balanceAmount: '1250.00' }],
      } } }),
    } as never);
    await settle();
    assert.match(text(), new RegExp(permissionMessage('ইনভয়েস তৈরি')));
    assert.doesNotMatch(text(), /INV-2026-08-00001/,
      'a family reading its own bills has #/fees; this screen is the billing run');
    assert.doesNotMatch(text(), /সাম্প্রতিক ইনভয়েস/);
  });
});

// ═══════════════════════════════════════════════════════════════════════
describe('P5 — no English backend sentence reaches a Bangla screen', () => {
  test('serverMessage discards a message written for a log', () => {
    // `requireRole` in server-core throws exactly this, so ANY 403 from ANY
    // endpoint used to print role codes into a Bangla UI.
    const raw = 'this endpoint requires one of: principal, school_owner, it_admin';
    assert.equal(serverMessage({ message: raw }, 403, 'হয়নি।'), permissionMessage());
    assert.equal(serverMessage({ message: raw }, 400, 'হয়নি।'), 'হয়নি।');
    assert.doesNotMatch(serverMessage({ message: raw }, 400, 'হয়নি।'), /endpoint|principal/);
  });

  test('a Bangla message from the server IS used — it was written for a person', () => {
    assert.equal(
      serverMessage({ message: 'এই মাসে ইনভয়েস আগেই তৈরি হয়েছে' }, 409, 'হয়নি।'),
      'এই মাসে ইনভয়েস আগেই তৈরি হয়েছে');
  });

  test('a known code beats the caller’s generic fallback', () => {
    assert.match(serverMessage({ error: 'not_found' }, 404, 'হয়নি।'), /খুঁজে পাওয়া যায়নি/);
  });

  test('401 and 403 never use the server’s words, in any language', () => {
    assert.equal(serverMessage({ message: 'সেশন শেষ' }, 403, 'হয়নি।'), permissionMessage());
  });
});

// ═══════════════════════════════════════════════════════════════════════
describe('P5 — a billing period is a month, not a key', () => {
  test('2026-08 reads as a month', () => {
    const out = bnMonth('2026-08');
    assert.doesNotMatch(out, /2026-08/);
    assert.match(out, /২০২৬/);
  });
  test('a day is never invented from a month', () => {
    // `Date.parse('2026-08')` succeeds, so `bnDate` would have printed
    // "১ আগস্ট ২০২৬" — a day the invoice has nothing to do with.
    assert.doesNotMatch(bnMonth('2026-08'), /১ |১১|৩১/);
  });
  test('nonsense passes through rather than becoming a wrong date', () => {
    assert.equal(bnMonth('rubbish'), 'rubbish');
    assert.equal(bnMonth(null), '—');
  });
});

// ═══════════════════════════════════════════════════════════════════════
describe('P5 — import is offered by what the role may actually import', () => {
  const YEAR = { '/academics/hierarchy': { status: 200, body: {
    year: { id: 'y-1', label: '২০২৬' }, years: [], classes: [],
  } } };

  test('an IT admin gets STAFF import — the one thing they may run', async () => {
    // The endpoint gates students to principal · owner · coordinator and staff
    // to principal · owner · IT admin. The screen used to send
    // `kind: 'student'` unconditionally, so the only import an IT admin may
    // run was unreachable and the one they could reach refused them.
    root().textContent = '';
    new ImportView({ root: root(), doc: dom.window.document, auth: auth('it_admin', YEAR) } as never);
    await settle();
    assert.match(text(), /শিক্ষক ও কর্মী আমদানি/);
    assert.doesNotMatch(text(), /শিক্ষার্থী আমদানি/);
    assert.equal(root().querySelectorAll('.ui-tab').length, 0,
      'one choice is not a choice — no tab strip');
  });

  test('a coordinator gets STUDENT import only', async () => {
    root().textContent = '';
    new ImportView({
      root: root(), doc: dom.window.document, auth: auth('academic_coordinator', YEAR),
    } as never);
    await settle();
    assert.match(text(), /শিক্ষার্থী আমদানি/);
    assert.equal(root().querySelectorAll('.ui-tab').length, 0);
  });

  test('a principal gets both, as a real choice', async () => {
    root().textContent = '';
    new ImportView({ root: root(), doc: dom.window.document, auth: auth('principal', YEAR) } as never);
    await settle();
    const tabs = [...root().querySelectorAll('.ui-tab')].map((t) => t.textContent);
    assert.deepEqual(tabs, ['শিক্ষার্থী', 'শিক্ষক ও কর্মী']);
  });

  test('a teacher is refused, and is not shown a step to take', async () => {
    root().textContent = '';
    new ImportView({ root: root(), doc: dom.window.document, auth: auth('class_teacher', YEAR) } as never);
    await settle();
    assert.match(text(), new RegExp(permissionMessage('আমদানি')));
    assert.doesNotMatch(text(), /ধাপ ১/, 'a step count above a refusal implies a first step');
    assert.equal(root().querySelectorAll('.stepper').length, 0);
    assert.equal(live().length, 0);
  });

  test('the year comes from /hierarchy, because nobody passes one', async () => {
    // `app.ts` mounts `new ImportView({ root, doc, auth })`. Every student
    // import therefore went out with no year and came back 400 `invalid_year`.
    root().textContent = '';
    new ImportView({ root: root(), doc: dom.window.document, auth: auth('principal', YEAR) } as never);
    await settle();
    assert.match(text(), /শিক্ষাবর্ষ ২০২৬/);
  });

  test('no academic year yet is an instruction, not an error code', async () => {
    root().textContent = '';
    new ImportView({
      root: root(), doc: dom.window.document,
      auth: auth('principal', { '/academics/hierarchy': { status: 200, body: { year: null, years: [], classes: [] } } }),
    } as never);
    await settle();
    assert.match(text(), /শিক্ষাবর্ষ/);
    assert.match(text(), /একাডেমিক কাঠামোতে যান/);
    assert.doesNotMatch(text(), /uuid|academicYearId|invalid_year/);
  });
});

// ═══════════════════════════════════════════════════════════════════════
describe('P5 — settings is grouped, and says who may change it', () => {
  const SETTINGS = { '/ops/settings': { status: 200, body: {
    sms: { noticeMaxChars: 180, default: 180, min: 70, max: 480, charsPerSegment: 70 },
    push: { replacesSms: false, available: true },
  } } };

  test('two groups: what this screen owns, and what lives elsewhere', async () => {
    root().textContent = '';
    new AdminSettingsView({
      root: root(), doc: dom.window.document, canManage: true, auth: auth('it_admin', SETTINGS),
    } as never);
    await settle();
    assert.match(text(), /বার্তা ও খরচ/);
    assert.match(text(), /অন্যান্য সেটিংস/);
    // Named, never re-implemented: a second place to change one row is how
    // two places end up disagreeing.
    for (const label of ['প্রতিষ্ঠানের পরিচয়', 'শিক্ষাপঞ্জি', 'একাডেমিক কাঠামো']) {
      assert.match(text(), new RegExp(label));
    }
  });

  test('a reader who may not change gets no live control and the right names', async () => {
    root().textContent = '';
    new AdminSettingsView({
      root: root(), doc: dom.window.document, canManage: false, auth: auth('class_teacher', SETTINGS),
    } as never);
    await settle();
    const editable = [...root().querySelectorAll('input,textarea')]
      .filter((i) => !(i as HTMLInputElement).disabled);
    assert.equal(editable.length, 0);
    // The old sentence named two of the four roles that may in fact change it.
    assert.match(text(), /প্রধান শিক্ষক, প্রতিষ্ঠান মালিক, আইটি অ্যাডমিন ও একাডেমিক সমন্বয়ক/);
  });

  test('a 403 on the GET is a refusal, not an empty form', async () => {
    root().textContent = '';
    new AdminSettingsView({
      root: root(), doc: dom.window.document, canManage: false,
      auth: auth('student', { '/ops/settings': { status: 403 } }),
    } as never);
    await settle();
    assert.match(text(), /অনুমতি/);
    assert.doesNotMatch(text(), /সর্বোচ্চ অক্ষর/, 'no form under a refusal');
    assert.doesNotMatch(text(), /৪৮০/, 'and none of the school’s numbers');
  });
});

// ═══════════════════════════════════════════════════════════════════════
describe('P5 — system health speaks in states a person reads', () => {
  test('four states, none of them a colour', async () => {
    root().textContent = '';
    new SystemView({ root: root(), doc: dom.window.document, auth: auth('it_admin', {}) } as never);
    await settle();
    for (const label of ['চালু আছে', 'সবসময় চালু', 'যাচাই করা যায়নি']) {
      assert.match(text(), new RegExp(label));
    }
    assert.doesNotMatch(text(), /\bdark\b|\binvisible\b|\bunknown\b/,
      'the old vocabulary was words from a commit, not words a school reads');
  });

  test('a kill switch is explained as a decision, never as a fault', async () => {
    root().textContent = '';
    new SystemView({ root: root(), doc: dom.window.document, auth: auth('it_admin', {}) } as never);
    await settle();
    // A school that reads "সমস্যা" against AI files a support ticket about a
    // decision somebody made on purpose.
    assert.match(text(), /এটি সমস্যা নয়, সিদ্ধান্ত/);
  });

  test('every state is defined on the screen, not only in the code', async () => {
    root().textContent = '';
    new SystemView({ root: root(), doc: dom.window.document, auth: auth('it_admin', {}) } as never);
    await settle();
    assert.match(text(), /অবস্থাগুলোর মানে/);
    assert.equal(root().querySelectorAll('.ui-facts-val').length, 4);
  });

  test('a desktop gets a table', async () => {
    root().textContent = '';
    new SystemView({ root: root(), doc: dom.window.document, auth: auth('it_admin', {}) } as never);
    await settle();
    const heads = [...root().querySelectorAll('thead th')].map((h) => h.textContent);
    assert.deepEqual(heads, ['সেবা', 'কী করে', 'অবস্থা', 'কারিগরি অবস্থান']);
  });
});

// ═══════════════════════════════════════════════════════════════════════
describe('P5 — the academic hierarchy is a table at every depth', () => {
  const TREE = { '/academics/hierarchy': { status: 200, body: {
    years: [{ id: 'y-1', label: '২০২৬', isCurrent: true }],
    year: { id: 'y-1', label: '২০২৬' },
    classes: [{
      levelNo: 9, nameBn: 'নবম শ্রেণি', nameEn: 'Class 9',
      sectionCount: 2, studentCount: 80,
      groups: [{
        classId: 'c-1', group: 'science', groupBn: 'বিজ্ঞান',
        sectionCount: 2, studentCount: 80,
        sections: [
          { id: 's-1', name: 'A', shift: 'day', capacity: 40, studentCount: 40,
            classTeacher: { id: 't-1', nameBn: 'রহিম স্যার' }, subjectTeacherCount: 5 },
          { id: 's-2', name: 'B', shift: 'day', capacity: 40, studentCount: 40,
            classTeacher: null, subjectTeacherCount: 3 },
        ],
      }],
    }],
  } } };

  beforeEach(async () => {
    root().textContent = '';
    new AcademicView({
      root: root(), doc: dom.window.document, canManage: true, canManageGuardians: true,
      auth: auth('it_admin', TREE),
    } as never);
    await settle();
  });

  test('the class list is a table with the counts as columns', () => {
    const heads = [...root().querySelectorAll('thead th')].map((h) => h.textContent);
    assert.deepEqual(heads.slice(0, 4), ['শ্রেণি', 'বিভাগ', 'সেকশন', 'শিক্ষার্থী']);
    assert.ok(root().querySelector('.ui-list'), 'and a list for a phone');
  });

  test('a section with no class teacher is a STATE, not a clause', async () => {
    (root().querySelector('table.ui-table tbody .ui-row-open') as HTMLElement | null)?.click();
    await settle();
    const heads = [...root().querySelectorAll('thead th')].map((h) => h.textContent);
    assert.ok(heads.includes('অবস্থা'));
    assert.match(text(), /শিক্ষক নেই/);
    assert.match(text(), /সম্পূর্ণ/);
  });

  test('drilling in gives a crumb that goes back', async () => {
    (root().querySelector('table.ui-table tbody .ui-row-open') as HTMLElement | null)?.click();
    await settle();
    const crumbs = [...root().querySelectorAll('.ui-crumb-link')];
    assert.ok(crumbs.length >= 1, 'a real control, not a sentence');
    assert.equal(crumbs[0].tagName, 'BUTTON',
      'this depth is in memory, not in the URL — an <a> with no href is dead to a keyboard');
    (crumbs[0] as HTMLElement).click();
    await settle();
    assert.equal((root().querySelector('h1') ?? {}).textContent, 'একাডেমিক কাঠামো');
  });

  test('no uuid reaches the screen at any depth', async () => {
    assert.doesNotMatch(text(), /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/);
    (root().querySelector('table.ui-table tbody .ui-row-open') as HTMLElement | null)?.click();
    await settle();
    assert.doesNotMatch(text(), /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/);
  });

  test('a refusal shows no hierarchy', async () => {
    root().textContent = '';
    new AcademicView({
      root: root(), doc: dom.window.document, canManage: false, canManageGuardians: false,
      auth: auth('student', { '/academics/hierarchy': { status: 403 } }),
    } as never);
    await settle();
    assert.match(text(), /অনুমতি/);
    assert.doesNotMatch(text(), /নবম শ্রেণি/);
    assert.equal(root().querySelectorAll('table.ui-table').length, 0);
  });
});
