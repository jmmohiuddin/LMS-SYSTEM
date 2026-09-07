/**
 * What the operator console says once the fleet stops fitting on one page.
 * (P10-1, P10-2, P10-5, P10-7)
 *
 * Every test here is a DOM test for the same reason the R-8 pair are: the
 * defect P10 existed to fix WAS the DOM. The counts were right in the
 * database and right in the response, and the screen was computing them from
 * `this.rows` — which used to be the whole fleet and, the moment the list was
 * paginated, became twenty-five schools. Nothing about that is visible from a
 * unit test of a pure function, because there is no pure function: the bug is
 * a page of twenty-five rendered as if it were Bangladesh.
 *
 * So these assert on sentences an operator reads, at the state the server
 * hands over. The `call` stub never resolves, which parks `load()` and leaves
 * the state exactly as each test set it.
 */
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

let dom: JSDOM;
let OpsView: new (o: Record<string, unknown>) => unknown;

before(async () => {
  dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>',
    { url: 'https://platform.sikhon.systems/platform.html' });
  const g = globalThis as Record<string, unknown>;
  g.document = dom.window.document;
  g.window = dom.window;
  g.HTMLElement = dom.window.HTMLElement;
  g.localStorage = dom.window.localStorage;
  g.sessionStorage = dom.window.sessionStorage;
  g.location = dom.window.location;
  g.fetch = async () => new Response('{}', { status: 200 });
  const mod = await import('../src/platform-ops.ts') as {
    PlatformOpsView: new (o: Record<string, unknown>) => unknown;
  };
  OpsView = mod.PlatformOpsView;
});

beforeEach(() => {
  dom.window.document.getElementById('root')!.textContent = '';
});

/** A school, filled in enough to be drawn. */
function school(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    slug: 'ek-school', nameBn: 'এক বিদ্যালয়', nameEn: 'Ek School',
    stream: 'school', level: 'secondary', district: 'ঢাকা',
    status: 'active', access: 'full', opsState: 'active',
    billingState: 'active', stateReason: null,
    planCode: 'starter', planName: 'স্টার্টার', planPrice: '1000',
    billingCycle: 'monthly', studentCap: 500, studentCount: 10, userCount: 3,
    paidTotal: '1000', nextDueOn: null, graceUntil: null, trialEndsOn: null,
    createdAt: '2026-01-01T00:00:00Z', lastActiveAt: '2026-09-01T00:00:00Z',
    portals: {}, services: {},
    ...over,
  };
}

const SUMMARY = {
  total: 258,
  attention: { critical: 3, warning: 9, info: 14 },
  access: { full: 240, readOnly: 12, none: 6 },
  billing: { trial: 30, active: 200, grace: 20, overdue: 8 },
  usage: { students: 84_000, users: 5_100, classes: 2_400, sections: 6_100,
           paid: 4_500_000 },
  quiet: 11, neverActive: 4, planUsage: { starter: 200, pilot: 58 },
};

/**
 * The console parked at one state.
 *
 * `call` returns a promise that never settles, so the constructor's `load()`
 * renders its skeleton and then waits forever — it cannot come back mid-test
 * and overwrite what the test just assigned.
 */
function opsAt(state: Record<string, unknown>): Document {
  const root = dom.window.document.getElementById('root')!;
  const v = new OpsView({
    root, doc: dom.window.document,
    call: () => new Promise(() => { /* parked */ }),
    onOpenTenant: () => {}, onNewTenant: () => {},
  }) as Record<string, unknown>;
  Object.assign(v, { loading: false, error: '', ...state });
  (v.render as () => void).call(v);
  return dom.window.document;
}

const text = (d: Document): string => d.getElementById('root')!.textContent ?? '';

/**
 * The value shown on the stat card with this label.
 *
 * Asserting on the page's whole textContent looked like it worked and did
 * not: a mutation that swapped the fleet total for the page length left the
 * page still matching `/২৫৮/` from another card, and the negative assertion
 * guarding it used `\b`, which is ASCII-only and therefore never fires next
 * to a Bangla digit. Both halves passed a broken screen. This reads the one
 * card being tested.
 */
function stat(d: Document, label: string): string | null {
  for (const c of d.querySelectorAll('.ui-stat')) {
    if ((c.querySelector('.ui-stat-label')?.textContent ?? '') === label) {
      return c.querySelector('.ui-stat-value')?.textContent ?? null;
    }
  }
  return null;
}

describe('P10-2 — the dashboard counts the fleet, not the page', () => {
  test('THE ONE THAT MATTERS — 258 schools with 2 on screen reads as ২৫৮', () => {
    // The exact shape of the old bug. `rows` is one page; every number on the
    // dashboard has to come from `summary`. If any of these ever falls back
    // to `rows.length` again, the console will quietly report a page as a
    // country — and it will look completely plausible while doing it.
    const d = opsAt({
      tab: 'dashboard', rows: [school(), school({ id: 'b', slug: 'dui' })],
      summary: SUMMARY,
      page: { page: 1, size: 25, total: 258, pages: 11, sort: 'name', dir: 'asc' },
    });
    assert.equal(stat(d, 'মোট'), '২৫৮',
      'the dashboard reported the page length as the fleet total');
    // The other three cards on that row are fleet-wide too, and each of them
    // was a `rows.filter(...).length` before P10-2.
    assert.equal(stat(d, 'পূর্ণ সক্রিয়'), '২৪০');
    assert.equal(stat(d, 'শুধু পড়া'), '১২');
    assert.equal(stat(d, 'স্থগিত'), '৬');
  });

  test('students and money are the fleet-wide sums, not a reduce over a page', () => {
    // `rows` here holds ten students between them. The screen must say
    // 84,000 — the database's sum — because a fraction of the country's
    // students shown as its total is a number somebody plans against.
    const d = opsAt({
      tab: 'dashboard', rows: [school()], summary: SUMMARY,
      page: { page: 1, size: 25, total: 258, pages: 11, sort: 'name', dir: 'asc' },
    });
    assert.match(stat(d, 'মোট শিক্ষার্থী') ?? '', /^৮৪,?০০০$/,
      'the student total came from the page');
    assert.match(stat(d, 'সক্রিয় ব্যবহারকারী') ?? '', /^৫,?১০০$/,
      'the user total came from the page');
  });

  test('before the summary arrives the dashboard shows zeroes, not a wrong number', () => {
    // A null summary must not be papered over with whatever `rows` happens to
    // hold: an honest ০ that is about to be replaced beats a confident ২.
    const d = opsAt({
      tab: 'dashboard', rows: [school(), school({ id: 'b' })], summary: null,
      page: { page: 1, size: 25, total: 0, pages: 1, sort: 'name', dir: 'asc' },
    });
    assert.equal(stat(d, 'মোট'), '০',
      'the dashboard filled a missing summary in from the page');
  });
});

describe('P10-1 — the pager tells the operator what they have not seen', () => {
  const listAt = (page: Record<string, unknown>, rows = [school()]): Document =>
    opsAt({ tab: 'institutions', rows, summary: SUMMARY, page });

  test('the count is the server’s filtered total, not the page length', () => {
    const d = listAt({ page: 1, size: 25, total: 258, pages: 11,
                       sort: 'name', dir: 'asc' });
    const t = text(d);
    assert.match(t, /১–২৫ \/ মোট ২৫৮টি/,
      'the pager did not state the range and the true total');
    assert.match(t, /পৃষ্ঠা ১ \/ ১১/, 'the pager did not say which page of how many');
  });

  test('page 11 of 11 names the last row, not size × page', () => {
    // 11 × 25 = 275, and there are 258. An operator who reads "২৭৫" on the
    // last page learns the console cannot count.
    const d = listAt({ page: 11, size: 25, total: 258, pages: 11,
                       sort: 'name', dir: 'asc' });
    assert.match(text(d), /২৫১–২৫৮ \/ মোট ২৫৮টি/);
  });

  test('an empty result says so in words', () => {
    const d = listAt({ page: 1, size: 25, total: 0, pages: 1,
                       sort: 'name', dir: 'asc' }, []);
    assert.match(text(d), /কোনো প্রতিষ্ঠান পাওয়া যায়নি/);
    assert.doesNotMatch(text(d), /০–০/, 'an empty list rendered as a range');
  });

  test('the pager is a landmark, and its count announces itself', () => {
    // After pressing "next" the only thing that changes for a screen-reader
    // user is this sentence.
    const d = listAt({ page: 2, size: 25, total: 258, pages: 11,
                       sort: 'name', dir: 'asc' });
    const nav = d.querySelector('nav.plat-pager');
    assert.ok(nav, 'the pager is not a nav landmark');
    assert.equal(nav!.getAttribute('aria-label'), 'পৃষ্ঠা');
    assert.ok(d.querySelector('.plat-pager-count[aria-live="polite"]'),
      'the page count does not announce itself');
  });

  test('the edges are disabled rather than hidden', () => {
    // A control that disappears at the boundary moves the one next to it
    // under the finger that was reaching for it.
    const first = opsAt({ tab: 'institutions', rows: [school()], summary: SUMMARY,
      page: { page: 1, size: 25, total: 258, pages: 11, sort: 'name', dir: 'asc' } });
    const btns = [...first.querySelectorAll('nav.plat-pager button')];
    assert.equal(btns.length, 2, 'a pager button vanished at the first page');
    assert.ok(btns[0]!.hasAttribute('disabled'), '"previous" was live on page 1');
    assert.ok(!btns[1]!.hasAttribute('disabled'), '"next" was dead on page 1');
  });
});

describe('P10-7 — sorting is reachable without a mouse', () => {
  const sorted = (page: Record<string, unknown>): Document =>
    opsAt({ tab: 'institutions', rows: [school()], summary: SUMMARY, page });

  test('THE ONE THAT MATTERS — the sort control has a name a screen reader reads', () => {
    // Clickable column headers were the obvious build and the wrong one:
    // below 1024px this table is a list of cards with no headers at all, and
    // twelve sortable headers are twelve tab stops that each announce a
    // column name and leave the reader to infer that it sorts.
    const d = sorted({ page: 1, size: 25, total: 258, pages: 11,
                       sort: 'students', dir: 'desc' });
    const sel = d.querySelector('.plat-sort select') as HTMLSelectElement | null;
    assert.ok(sel, 'there is no sort control');
    const label = d.querySelector(`label[for="${sel!.id}"]`);
    assert.ok(label, 'the sort control has no label bound to it');
    assert.match(label!.textContent ?? '', /সাজান/);
  });

  test('the control shows the sort the server actually applied', () => {
    // If the select says "নাম" while the server sorted by students, the
    // operator is reading a list they did not ask for and cannot tell.
    const d = sorted({ page: 1, size: 25, total: 258, pages: 11,
                       sort: 'students', dir: 'desc' });
    const sel = d.querySelector('.plat-sort select') as HTMLSelectElement;
    assert.equal(sel.value, 'students');
  });

  test('direction is a word, not an arrow alone', () => {
    // 04-UIUX §5: no meaning carried by a single glyph. "↓" is a direction
    // only if you already know what is being sorted.
    const desc = sorted({ page: 1, size: 25, total: 258, pages: 11,
                          sort: 'students', dir: 'desc' });
    assert.match(text(desc), /বড় থেকে ছোট/);
    const asc = sorted({ page: 1, size: 25, total: 258, pages: 11,
                         sort: 'students', dir: 'asc' });
    assert.match(text(asc), /ছোট থেকে বড়/);
  });

  test('every offered sort key is one the server accepts', () => {
    // The database whitelists these; an option the server does not know
    // silently falls back to `name`, which looks like the sort did nothing.
    const d = sorted({ page: 1, size: 25, total: 258, pages: 11,
                       sort: 'name', dir: 'asc' });
    const opts = [...d.querySelectorAll('.plat-sort select option')]
      .map((o) => (o as HTMLOptionElement).value);
    const server = ['name', 'severity', 'students', 'active', 'status',
                    'plan', 'created'];
    for (const v of opts) {
      assert.ok(server.includes(v), `the console offers an unknown sort key: ${v}`);
    }
  });
});

describe('P10-5 — the audit trail names who acted (B-39)', () => {
  const feedAt = (entries: Array<Record<string, unknown>>): Document =>
    opsAt({ tab: 'dashboard', rows: [school()], summary: SUMMARY, feed: entries,
      page: { page: 1, size: 25, total: 258, pages: 11, sort: 'name', dir: 'asc' } });

  const entry = (over: Record<string, unknown>): Record<string, unknown> => ({
    id: 'a1', reason: 'বকেয়া', statement: 'সীমিত করা হয়েছে',
    at: '2026-09-01T10:00:00Z', tenantId: null, ...over,
  });

  test('THE ONE THAT MATTERS — a named actor appears on the feed', () => {
    // Before P10-5 this column could not exist: `admin_id` was a JWT subject
    // with no row behind it, so the tab said what, why and when and never who.
    const d = feedAt([entry({ actor: 'করিম উদ্দিন' })]);
    assert.match(text(d), /করিম উদ্দিন/);
  });

  test('an unnamed credential reads as unnamed, not as nobody', () => {
    // A LEFT join, deliberately. An empty cell reads as "no one did this".
    const d = feedAt([entry({ actor: null })]);
    assert.match(text(d), /নাম নেই/);
  });

  test('a revoked operator’s past actions stay, and say so', () => {
    // The rows they wrote must stay resolvable for as long as the rows do —
    // that is why revocation keeps the row instead of deleting it.
    const d = feedAt([entry({ actor: 'পুরনো অপারেটর', actorRevoked: true })]);
    assert.match(text(d), /পুরনো অপারেটর \(প্রত্যাহৃত\)/);
  });

  test('the actor’s credential id never reaches the screen', () => {
    const d = feedAt([entry({ actor: 'করিম উদ্দিন' })]);
    assert.doesNotMatch(text(d), /[0-9a-f]{8}-[0-9a-f]{4}-/i,
      'a raw uuid was rendered');
  });
});

describe('P10-5 — the operator directory holds no secret', () => {
  const op = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: '7c9c0000-0000-4000-8000-0000000000a1', fullName: 'করিম উদ্দিন',
    email: 'karim@example.com', status: 'active', note: null,
    createdAt: '2026-01-01T00:00:00Z', lastSeenAt: '2026-09-01T00:00:00Z',
    revokedAt: null, actions: 12, lastAction: '2026-09-01T00:00:00Z',
    ...over,
  });

  const dirAt = (operators: Array<Record<string, unknown>>): Document =>
    opsAt({ tab: 'operators', rows: [], summary: SUMMARY, operators,
      page: { page: 1, size: 25, total: 0, pages: 1, sort: 'name', dir: 'asc' } });

  test('THE ONE THAT MATTERS — a credential issued and never used says so', () => {
    // "কখনো নয়" is a real answer and the one worth asking about: a
    // credential that exists, can suspend any school in the country, and
    // nobody has ever signed in with.
    const d = dirAt([op({ lastSeenAt: null, actions: 0 })]);
    assert.match(text(d), /কখনো নয়/);
  });

  test('status is a word, never colour alone', () => {
    const d = dirAt([op({ status: 'revoked', revokedAt: '2026-08-01T00:00:00Z' })]);
    assert.match(text(d), /প্রত্যাহৃত/);
  });

  test('the screen says what it does not store', () => {
    // The console is only worth stealing if it holds credentials. It does
    // not, and it says so where somebody might assume otherwise.
    const d = dirAt([op()]);
    assert.match(text(d), /পাসওয়ার্ড|টোকেন/,
      'the directory does not state that it stores no credential');
  });

  test('an empty directory explains the consequence of leaving it empty', () => {
    const d = dirAt([]);
    assert.match(text(d), /নাম নেই|নাম রাখা হয়নি/);
  });
});
