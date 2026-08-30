/**
 * Two sentences the operator console has to say out loud.  (R-8 §9A, §11)
 *
 * Both of these are cases where the console was doing something reasonable
 * and not admitting it, which is the failure mode that produces a confident
 * operator and a wrong school.
 *
 *   §9A  Typing an existing teacher's number with "principal" selected
 *        changes that teacher's role. R-8's first pass added a confirmation
 *        panel naming the person — but it never named the CONSEQUENCE, and
 *        "are you sure?" without a stated outcome is how people click through.
 *
 *   §11  Provisioning classes 11–12 seeds a subject list that is ours, with
 *        codes we assigned. It is a decent starting point and it is not the
 *        board syllabus. A college registrar who assumes it was checked
 *        against a circular will build a year on it.
 *
 * These are DOM tests rather than assertions about a pure function because in
 * both cases the bug WAS the DOM: the fact existed in the response and in the
 * catalogue, and simply never reached a screen.
 */
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

let dom: JSDOM;
let PlatformConsole: new (root: HTMLElement) => unknown;

before(async () => {
  dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>',
    { url: 'https://platform.shikhonbd.com/platform.html' });
  const g = globalThis as Record<string, unknown>;
  // platform.ts captures `document` at field-initialiser time, so the globals
  // have to exist before the module is imported, not merely before the
  // constructor runs.
  g.document = dom.window.document;
  g.window = dom.window;
  g.HTMLElement = dom.window.HTMLElement;
  g.localStorage = dom.window.localStorage;
  g.sessionStorage = dom.window.sessionStorage;
  g.location = dom.window.location;
  g.fetch = async () => new Response('{}', { status: 200 });
  const mod = await import('../src/platform.ts') as {
    Console_: new (root: HTMLElement) => unknown;
  };
  PlatformConsole = mod.Console_;
});

beforeEach(() => {
  dom.window.document.getElementById('root')!.textContent = '';
});

/**
 * The console with no operator token, driven straight to the screen under
 * test. Reaching these screens through the wizard would need a live platform
 * API and a real tenant; what is being tested is what the screen SAYS, and
 * that is a pure function of the state it is given.
 */
function consoleAt(state: Record<string, unknown>): Document {
  const root = dom.window.document.getElementById('root')!;
  const c = new PlatformConsole(root as unknown as HTMLElement) as Record<string, unknown>;
  Object.assign(c, state);
  (c.render as () => void).call(c);
  return dom.window.document;
}

const WIZARD = { view: 'wizard', token: 'op-token', key: 'op-key' };

describe('R-8 §9A — the console says whose role it is about to change', () => {
  const conflict = {
    phone: '+8801711000111',
    existingName: 'রহিম আহমেদ',
    existingRoles: ['teacher'],
    requestedRole: 'principal',
    alreadyHasRole: false,
    message: 'এই নম্বরটি রহিম আহমেদ এর — তাঁকে নতুন ভূমিকা দেওয়া হবে। নিশ্চিত করুন।',
  };

  test('THE ONE THAT MATTERS — the new role is named, not merely implied', () => {
    const d = consoleAt({ ...WIZARD, step: 6, adminConflict: conflict });
    const line = d.querySelector('[data-consequence="role-change"]');
    assert.ok(line, 'the consequence line must be rendered');
    // The whole point: an operator reads this and knows a teacher is about to
    // stop being a teacher, without having to infer it from a button label.
    assert.match(line.textContent, /প্রধান শিক্ষক/);
    assert.match(line.textContent, /ভূমিকা/);
  });

  test('the person and their current role are still named', () => {
    const d = consoleAt({ ...WIZARD, step: 6, adminConflict: conflict });
    const panel = d.querySelector('[data-conflict="admin-exists"]');
    assert.ok(panel);
    assert.match(panel.textContent, /রহিম আহমেদ/);
    assert.match(panel.textContent, /শিক্ষক/);
  });

  test('both ways out are offered — this is a choice, not a warning', () => {
    const d = consoleAt({ ...WIZARD, step: 6, adminConflict: conflict });
    assert.ok(d.querySelector('[data-action="confirm-existing-admin"]'));
    assert.ok(d.querySelector('[data-action="cancel-existing-admin"]'));
  });

  test('re-issuing a code to someone who ALREADY has the role says no such thing', () => {
    // Nothing changes about this account, so a "their role will change"
    // sentence would be a lie — and a screen that cries wolf on the harmless
    // case is a screen nobody reads on the dangerous one.
    const d = consoleAt({
      ...WIZARD, step: 6,
      adminConflict: { ...conflict, existingRoles: ['principal'], alreadyHasRole: true },
    });
    assert.equal(d.querySelector('[data-consequence="role-change"]'), null);
    assert.ok(d.querySelector('[data-conflict="admin-exists"]'));
  });

  test('with no conflict the panel is absent entirely', () => {
    const d = consoleAt({ ...WIZARD, step: 6, adminConflict: null });
    assert.equal(d.querySelector('[data-conflict="admin-exists"]'), null);
  });
});

describe('R-8 §11 — the HSC catalogue does not claim to be the board syllabus', () => {
  const draft = (level: string) => ({
    nameBn: 'মোহাম্মদপুর কলেজ', nameEn: 'Mohammadpur College',
    stream: 'bangla_medium', level,
  });

  test('THE ONE THAT MATTERS — provisioning a college says the list is ours', () => {
    const d = consoleAt({ ...WIZARD, step: 5, draft: draft('higher_secondary') });
    const note = d.querySelector('[data-notice="hsc-catalogue"]');
    assert.ok(note, 'the provenance notice must appear where 11–12 are seeded');
    // Three claims it has to make: the list is shikhonBD's, it is not the
    // board's, and it can be changed.
    assert.match(note.textContent, /shikhonBD/);
    assert.match(note.textContent, /বোর্ডের অফিসিয়াল সিলেবাস নয়/);
    assert.match(note.textContent, /সম্পাদনা/);
  });

  test('D11 — the platform brand is spelled shikhonBD on the platform surface', () => {
    const d = consoleAt({ ...WIZARD, step: 5, draft: draft('higher_secondary') });
    assert.match(d.querySelector('[data-notice="hsc-catalogue"]').textContent, /shikhonBD/);
  });

  test('a combined school-and-college is warned too — it reaches class 12', () => {
    const d = consoleAt({ ...WIZARD, step: 5, draft: draft('combined') });
    assert.ok(d.querySelector('[data-notice="hsc-catalogue"]'));
  });

  test('a secondary school is not — it never sees an HSC subject', () => {
    // The notice has to be absent here or it becomes furniture, and furniture
    // is not read.
    const d = consoleAt({ ...WIZARD, step: 5, draft: draft('secondary') });
    assert.equal(d.querySelector('[data-notice="hsc-catalogue"]'), null);
  });

  test('a madrasa at secondary level is not warned either', () => {
    const d = consoleAt({
      ...WIZARD, step: 5,
      draft: { ...draft('secondary'), stream: 'madrasah' },
    });
    assert.equal(d.querySelector('[data-notice="hsc-catalogue"]'), null);
  });
});
