/**
 * B-30 — a refusal is not an outage, on every student-facing screen.
 *
 * Nine views shared one shape:
 *
 *     if (!res.ok) throw new Error(String(res.status));
 *     } catch { this.offline = this.data.length > 0; }
 *
 * The status was stringified and then dropped by a bare `catch`, so a 403 and
 * a dead network arrived at the same place. Two of the three consequences are
 * usability problems — the wrong sentence, and a retry that cannot work. The
 * third is not: the screen kept showing the data the server had just refused,
 * out of a cache filled while this person was allowed to see it, or by
 * somebody else on a shared device.
 *
 * So each test below asserts the same three things about one screen:
 *
 *   1. the canonical sentence is shown — one pattern, not five wordings;
 *   2. **the cached data is gone from the DOM and from localStorage**;
 *   3. it is not called an offline state, and offers no retry.
 *
 * Plus the case that keeps this honest: an ordinary network failure must
 * STILL show the cache with an offline banner. A fix that turned every error
 * into a lockout would pass tests 1–3 and ruin the product.
 */
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { permissionMessage, permissionMessageWithContact } from '../src/ui/feedback.ts';
import { HttpStatus, isDenied, statusOf, refuseUnlessOk } from '../src/http-status.ts';

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
  Object.defineProperty(globalThis, 'navigator', {
    value: { onLine: true }, configurable: true, writable: true,
  });
});

/** A fetch that answers one status for everything. */
function auth(status: number, body: unknown = {}) {
  return {
    authedFetch: async () => {
      if (status === 0) throw new TypeError('Failed to fetch');
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
      } as unknown as Response;
    },
  } as never;
}

const root = () => dom.window.document.getElementById('root') as HTMLElement;
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); };

describe('B-30 — the canonical pattern', () => {
  test('one shape, with the subject kept', () => {
    assert.equal(permissionMessage(), 'এই কাজটি করার অনুমতি আপনার নেই।');
    assert.equal(permissionMessage('শিক্ষাপঞ্জি'), 'শিক্ষাপঞ্জি দেখার অনুমতি আপনার নেই।');
    // The subject is the good part of the bespoke strings this replaced:
    // it tells a person WHAT they cannot see. What was unified is the shape.
    assert.match(permissionMessageWithContact('রসিদ'), /^রসিদ দেখার অনুমতি আপনার নেই।/);
    assert.match(permissionMessageWithContact(), /প্রধান শিক্ষকের সাথে যোগাযোগ করুন।$/);
  });

  test('humanError routes 403 through it, in both call shapes', async () => {
    const { humanError } = await import('../src/ui/feedback.ts');
    assert.equal(humanError('forbidden'), permissionMessage());
    assert.equal(humanError(null, 403), permissionMessage());
    assert.equal(humanError(null, 403, 'ফলাফল'), permissionMessage('ফলাফল'));
    // And nothing else was collapsed into it.
    assert.notEqual(humanError(null, 500), permissionMessage());
    assert.notEqual(humanError('offline'), permissionMessage());
  });

  test('the status survives the throw — the bug in one assertion', () => {
    // `new Error(String(res.status))` typechecks, reads fine, and loses the
    // one fact the catch needs. This is the replacement.
    const err = new HttpStatus(403);
    assert.equal(statusOf(err), 403);
    assert.ok(isDenied(err));
    assert.ok(!isDenied(new Error('403')), 'a plain Error carries nothing');
    assert.ok(!isDenied(new HttpStatus(401)),
      '401 is recoverable by signing in again and is not a lockout');
    assert.throws(() => refuseUnlessOk({ ok: false, status: 403 }), HttpStatus);
    assert.doesNotThrow(() => refuseUnlessOk({ ok: true, status: 200 }));
  });
});

/**
 * Each screen, driven twice: once refused, once merely offline.
 *
 * `mount` is per-view because the constructors differ; everything else about
 * the case is identical, which is the point — the behaviour is now uniform.
 */
const SCREENS: Array<{
  name: string;
  cacheKey: string;
  cached: unknown;
  /** A word from the cached data that must NOT survive a refusal. */
  secret: string;
  subject: string;
  mount: (a: never) => void;
}> = [];

const { SubjectsView } = await import('../src/subjects-view.ts');
SCREENS.push({
  name: 'subjects', cacheKey: 'shikhon_my_subjects', subject: 'আমার বিষয়',
  secret: 'গোপন-বিষয়',
  cached: [{
    subjectId: 's1', nameBn: 'গোপন-বিষয়', nctbCode: null, requirementType: 'compulsory',
    requirementLabelBn: 'আবশ্যিক', totalChapters: 5, completedChapters: 2,
    progressPercent: 40, nextChapter: null,
  }],
  mount: (a) => { new SubjectsView({ root: root(), doc: dom.window.document, auth: a }); },
});

const { MyAttendanceView } = await import('../src/my-attendance-view.ts');
SCREENS.push({
  name: 'my-attendance', cacheKey: 'shikhon_my_attendance', subject: 'আমার হাজিরা',
  secret: '৯৯',
  cached: {
    totals: { present: 99, late: 0, absent: 0, excused: 0, halfDay: 0,
              counted: 99, attendedPercent: 99 },
    byMonth: [], bySubject: [], recent: [],
  },
  mount: (a) => { new MyAttendanceView({ root: root(), doc: dom.window.document, auth: a }); },
});

const { ResultsView } = await import('../src/results-view.ts');
SCREENS.push({
  name: 'results', cacheKey: 'shikhon_results_cache', subject: 'ফলাফল',
  // The GPA, not the exam name: with a single result the name lives only in
  // the tab strip, which is not rendered. The GPA is on screen and is exactly
  // as privileged — it is the thing a refused reader must not still see.
  secret: '5\.00',
  cached: [{
    examId: 'e1', examNameBn: 'গোপন-পরীক্ষা', examType: 'terminal',
    totalMarks: '500', totalMax: '500', percentage: '100', gpa: '5.00',
    letterGrade: 'A+', subjectsFailed: 0, isPass: true, rankInSection: 1,
    publishedAt: '2026-01-01', subjects: [],
  }],
  mount: (a) => { new ResultsView({ root: root(), doc: dom.window.document, auth: a }); },
});

const { FeesView } = await import('../src/fees-view.ts');
SCREENS.push({
  name: 'fees', cacheKey: 'shikhon_invoices_cache', subject: 'বেতন ও ফি',
  secret: 'INV-গোপন',
  cached: [{
    id: 'i1', invoiceNo: 'INV-গোপন', billingPeriod: '2026-01',
    issuedOn: '2026-01-01', dueOn: '2026-01-10', totalAmount: '1000.00',
    paidAmount: '0.00', balanceAmount: '1000.00', status: 'due', lines: [],
  }],
  mount: (a) => { new FeesView({ root: root(), doc: dom.window.document, auth: a }); },
});

for (const s of SCREENS) {
  describe(`B-30 — ${s.name}`, () => {
    beforeEach(() => {
      localStorage.clear();
      localStorage.setItem(s.cacheKey, JSON.stringify(s.cached));
      root().textContent = '';
    });

    test('a 403 shows the canonical sentence', async () => {
      s.mount(auth(403));
      await settle();
      assert.match(root().textContent ?? '', new RegExp(permissionMessage(s.subject)));
    });

    test('THE ONE THAT MATTERS — the cache is gone from the screen and the store',
      async () => {
        s.mount(auth(403));
        await settle();
        assert.doesNotMatch(root().textContent ?? '', new RegExp(s.secret),
          'the server just refused this person; the screen must stop showing it');
        assert.equal(localStorage.getItem(s.cacheKey), null,
          'and it must not be there for the next paint either');
      });

    test('a refusal is never dressed as an outage, and offers no retry', async () => {
      s.mount(auth(403));
      await settle();
      const text = root().textContent ?? '';
      assert.doesNotMatch(text, /অফলাইন/, 'nothing is wrong with the connection');
      assert.doesNotMatch(text, /আবার চেষ্টা/, 'no retry will ever succeed');
      assert.doesNotMatch(text, /আনা যায়নি/, 'that was the old, wrong sentence');
    });

    test('an ordinary network failure STILL shows the cache, with a banner', async () => {
      // The test that keeps the fix honest. Turning every failure into a
      // lockout would satisfy every assertion above and ruin the product:
      // this app is offline-first, and a cached list under a banner is the
      // whole point of it.
      s.mount(auth(0));
      await settle();
      assert.match(root().textContent ?? '', new RegExp(s.secret),
        'a flat tyre is not a refusal');
      assert.notEqual(localStorage.getItem(s.cacheKey), null, 'and the cache stays');
    });

    test('a 500 is a server problem, not a permission problem', async () => {
      s.mount(auth(500));
      await settle();
      assert.doesNotMatch(root().textContent ?? '', new RegExp(permissionMessage(s.subject)));
    });
  });
}
