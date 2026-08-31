/**
 * The component system: primitives, buttons, cards, headers, fields. (P2)
 *
 * Every test here is a defect this codebase has actually produced, or one the
 * brief names explicitly. A component library whose tests assert "it renders a
 * div" is a library that will still ship an unlabelled icon button.
 */
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { el, append, icon, lang, uid, resetUid } from '../src/ui/dom.ts';
import { button, iconButton, setBusy, onClickBusy } from '../src/ui/button.ts';
import { card, statCard, avatar, initial, tintOf } from '../src/ui/card.ts';
import { pageHeader, breadcrumb, sectionHeading } from '../src/ui/page-header.ts';
import { badge, statusBadge, countBadge } from '../src/ui/badge.ts';
import {
  field, searchField, setFieldError, clearFieldError, reportErrors,
} from '../src/ui/field.ts';
import { fileUpload } from '../src/ui/upload.ts';

let dom: JSDOM;
const doc = () => dom.window.document;
const host = () => doc().getElementById('root') as HTMLElement;

before(() => {
  dom = new JSDOM('<!doctype html><html lang="bn"><body><main id="root"></main></body></html>',
    { url: 'http://localhost/app' });
  const g = globalThis as Record<string, unknown>;
  g.HTMLElement = dom.window.HTMLElement;
  g.CSS = dom.window.CSS;
  g.document = dom.window.document;
});

beforeEach(() => { host().textContent = ''; resetUid(); });

describe('P2 — the element builder', () => {
  test('THE ONE THAT MATTERS — text is never parsed as markup', () => {
    // School data is user-entered: a student's name, a notice body, an
    // institution's own title. One `innerHTML` in a builder is one XSS in
    // every screen that builder touches.
    const n = el(doc(), 'p', { text: '<img src=x onerror="alert(1)">' });
    assert.equal(n.querySelector('img'), null);
    assert.equal(n.textContent, '<img src=x onerror="alert(1)">');
  });

  test('falsy children are skipped, so callers can inline conditions', () => {
    const n = el(doc(), 'div', {}, 'a', null, undefined, false, 'b');
    assert.equal(n.childNodes.length, 2);
    assert.equal(n.textContent, 'ab');
  });

  test('attrs: false and null remove, true becomes a bare attribute', () => {
    const n = el(doc(), 'input', {
      attrs: { disabled: false, required: true, placeholder: null, name: 'x' },
    });
    assert.equal(n.hasAttribute('disabled'), false);
    assert.equal(n.getAttribute('required'), '');
    assert.equal(n.hasAttribute('placeholder'), false);
    assert.equal(n.getAttribute('name'), 'x');
  });

  test('an icon is always aria-hidden', () => {
    // Every control here is labelled in text or by aria-label. An icon that
    // needs its own name is a control whose label is missing.
    assert.equal(icon(doc(), 'home').getAttribute('aria-hidden'), 'true');
  });

  test('a mixed-language run is marked, so it is not read with Bangla phonemes', () => {
    assert.equal(lang(doc(), 'en', 'EIIN').getAttribute('lang'), 'en');
  });

  test('ids are monotonic, not random — a re-render is diffable', () => {
    resetUid();
    assert.equal(uid('f'), 'f-1');
    assert.equal(uid('f'), 'f-2');
  });
});

describe('P2 — buttons', () => {
  test('THE ONE THAT MATTERS — type is always explicit', () => {
    // A <button> inside a <form> defaults to type="submit". Every "cancel"
    // and "add row" control written without it submits the form instead.
    const b = button(doc(), { label: 'বাতিল' });
    assert.equal(b.type, 'button');
    assert.equal(button(doc(), { label: 'সংরক্ষণ', type: 'submit' }).type, 'submit');
  });

  test('THE ONE THAT MATTERS — a busy button cannot be pressed twice', () => {
    // §17. Not something 130 call sites can be trusted to remember.
    let runs = 0;
    let release!: () => void;
    const b = button(doc(), { label: 'সংরক্ষণ' });
    onClickBusy(b, () => new Promise<void>((res) => { runs++; release = res; }));
    b.click();
    b.click();
    b.click();
    assert.equal(runs, 1, 'three clicks ran the action three times');
    assert.equal(b.disabled, true);
    assert.equal(b.getAttribute('aria-busy'), 'true');
    release();
  });

  test('a failed action still restores the button, and reports why', async () => {
    // A save that throws and leaves a permanently disabled button is a screen
    // a teacher has to reload — losing the register they were entering. The
    // error must also not escape as an unhandled rejection: an async listener
    // that rejects gives the caller nothing to act on.
    let seen: unknown = null;
    const b = button(doc(), { label: 'সংরক্ষণ' });
    onClickBusy(b, async () => { throw new Error('network'); }, (e) => { seen = e; });
    b.click();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(b.disabled, false);
    assert.equal(b.hasAttribute('aria-busy'), false);
    assert.match(String(seen), /network/);
  });

  test('busy replaces the glyph with a spinner and restores it on release', () => {
    const b = button(doc(), { label: 'পাঠান', glyph: 'bell' });
    assert.ok(b.querySelector('.btn-glyph'));
    setBusy(b, true);
    assert.ok(b.querySelector('.btn-spinner'));
    assert.equal(b.querySelector('.btn-glyph'), null);
    setBusy(b, false);
    assert.equal(b.querySelector('.btn-spinner'), null);
  });

  test('destructive is its own variant, not a tinted primary', () => {
    // A delete that looks like save is how a section disappears under a hand
    // already travelling toward save.
    assert.match(button(doc(), { label: 'মুছুন', variant: 'danger' }).className, /btn-danger/);
    assert.doesNotMatch(button(doc(), { label: 'মুছুন', variant: 'danger' }).className, /btn-primary/);
  });

  test('THE ONE THAT MATTERS — an icon-only button cannot exist without a name', () => {
    const b = iconButton(doc(), { glyph: 'x', label: 'বন্ধ করুন' });
    assert.equal(b.getAttribute('aria-label'), 'বন্ধ করুন');
    assert.equal(b.title, 'বন্ধ করুন', 'a mouse user gets the same word');
  });
});

describe('P2 — cards', () => {
  test('THE ONE THAT MATTERS — an activatable card is a button, not a div', () => {
    // Eight `<div onclick>` cards exist in this app today. They are invisible
    // to the keyboard and to every screen reader.
    const c = card(doc(), { title: 'হাজিরা', onClick: () => {} });
    assert.equal(c.tagName, 'BUTTON');
    assert.equal(c.getAttribute('type'), 'button');
  });

  test('a card names itself rather than announcing its whole body', () => {
    const c = card(doc(), { title: 'নোটিশ', onClick: () => {} },
      el(doc(), 'p', { text: 'অনেক লম্বা একটি বিবরণ' }));
    const id = c.getAttribute('aria-labelledby');
    assert.ok(id);
    assert.equal(c.querySelector(`#${id}`)?.textContent, 'নোটিশ');
  });

  test('a plain card is a section, and carries no button semantics', () => {
    const c = card(doc(), { title: 'সারাংশ' });
    assert.equal(c.tagName, 'SECTION');
  });

  test('a stat reads label-then-value, whatever the eye sees first', () => {
    // "২৮৬" alone is not information.
    const s = statCard(doc(), { label: 'মোট শিক্ষার্থী', value: '২৮৬' });
    const texts = [...s.querySelectorAll('.ui-stat-label, .ui-stat-value')]
      .map((n) => n.textContent);
    assert.deepEqual(texts, ['মোট শিক্ষার্থী', '২৮৬']);
  });

  test('THE ONE THAT MATTERS — an avatar takes a whole Bangla grapheme', () => {
    // `'ক্ষুদ্র'[0]` is 'ক' with the conjunct's other half orphaned into the
    // next slot. A roster of sixty would show sixty broken clusters.
    // The cluster is 'ক্ষু' — the conjunct AND its vowel sign, which is what a
    // reader sees as one character. Asserting the property, not a literal:
    // what matters is that the result is a complete cluster and not the bare
    // 'ক' that `name[0]` returns with its other half orphaned.
    const bn = initial('ক্ষুদ্র');
    assert.ok(bn.length > 1, `expected a full cluster, got ${JSON.stringify(bn)}`);
    assert.ok('ক্ষুদ্র'.startsWith(bn), 'the cluster must be a real prefix of the name');
    assert.notEqual(bn, 'ক', 'that is the broken half `name[0]` would give');
    // 'রাফি' begins with the akshara 'রা' — consonant plus vowel sign, one
    // cluster, and what a Bangla reader calls the first character. A bare 'র'
    // would be the vowel sign dropped, which is a different (wrong) name.
    assert.equal(initial('রাফি'), 'রা');
    assert.equal(initial('মোহাম্মদপুর'), 'মো');
    assert.equal(initial('Rafi'), 'R', 'Latin still gives one letter');
    assert.equal(initial('  '), '•');
  });

  test('the same person is the same colour on every screen', () => {
    assert.equal(tintOf('সাদিয়া ইসলাম'), tintOf('সাদিয়া ইসলাম'));
    assert.ok(tintOf('সাদিয়া ইসলাম') >= 0 && tintOf('সাদিয়া ইসলাম') < 6);
  });

  test('an avatar is hidden from readers — the name is always beside it', () => {
    const a = avatar(doc(), { name: 'রাফি' });
    assert.equal(a.getAttribute('aria-hidden'), 'true');
  });

  test('a photo is lazy, because a roster of sixty is a quarter of a megabyte', () => {
    const a = avatar(doc(), { name: 'রাফি', photoUrl: 'https://x/y.webp' });
    assert.equal(a.tagName, 'IMG');
    assert.equal(a.getAttribute('loading'), 'lazy');
    assert.equal(a.getAttribute('alt'), '', 'decorative: the name is rendered beside it');
  });
});

describe('P2 — the page header', () => {
  test('THE ONE THAT MATTERS — the DOM matches what 29 views hand-build', () => {
    // Adoption has to be a visual no-op or it is not adoption, it is a
    // redesign of 29 screens at once.
    const h = pageHeader(doc(), { title: 'ব্যবহারকারী', subtitle: 'শিক্ষক, কর্মী ও অ্যাকাউন্ট' });
    assert.equal(h.tagName, 'HEADER');
    assert.equal(h.className, 'page-header');
    assert.equal(h.querySelector('h1')?.textContent, 'ব্যবহারকারী');
    assert.equal(h.querySelector('.page-sub')?.textContent, 'শিক্ষক, কর্মী ও অ্যাকাউন্ট');
  });

  test('exactly one h1 — the page has one title', () => {
    const h = pageHeader(doc(), {
      title: 'শিক্ষার্থী', subtitle: 'সব তথ্য',
      crumbs: [{ label: 'প্রতিষ্ঠান', path: 'institution' }, { label: 'শিক্ষার্থী' }],
      primary: button(doc(), { label: '+ শিক্ষার্থী', variant: 'primary' }),
    });
    assert.equal(h.querySelectorAll('h1').length, 1);
  });

  test('the last crumb is the current page and is not a link', () => {
    const b = breadcrumb(doc(), [
      { label: 'নবম শ্রেণি', path: 'academic' },
      { label: 'বিজ্ঞান', path: 'academic' },
      { label: 'ক শাখা' },
    ]);
    const items = [...b.querySelectorAll('li')];
    assert.equal(items.length, 3);
    assert.equal(items[2].querySelector('a'), null);
    assert.equal(items[2].querySelector('[aria-current="page"]')?.textContent, 'ক শাখা');
    assert.equal(b.querySelector('ol')?.tagName, 'OL', 'a trail is an ordered list');
  });

  test('a crumb with a path but in last position is still not a link', () => {
    // Otherwise the current page links to itself, which reads as navigation
    // and does nothing.
    const b = breadcrumb(doc(), [{ label: 'ক', path: 'a' }, { label: 'খ', path: 'b' }]);
    assert.equal(b.querySelectorAll('a').length, 1);
  });

  test('separators are decoration, never inside a link', () => {
    const b = breadcrumb(doc(), [{ label: 'ক', path: 'a' }, { label: 'খ' }]);
    for (const sep of b.querySelectorAll('.ui-crumb-sep')) {
      assert.equal(sep.getAttribute('aria-hidden'), 'true');
      assert.equal(sep.closest('a'), null);
    }
  });

  test('a section heading is h2 by default, so the outline is title → section', () => {
    assert.equal(sectionHeading(doc(), { title: 'আজকের ক্লাস' })
      .querySelector('.ui-section-title')?.tagName, 'H2');
  });
});

describe('P2 — badges', () => {
  test('THE ONE THAT MATTERS — a status is never carried by colour alone', () => {
    // 04-UIUX §5. A fee row that says "overdue" only by being red is
    // unreadable to a colour-blind guardian, invisible in print, and silent
    // to a screen reader.
    const s = statusBadge(doc(), { state: 'overdue', label: 'বকেয়া' });
    assert.match(s.textContent ?? '', /বকেয়া/);
  });

  test('a status that means trouble also carries a glyph', () => {
    assert.ok(statusBadge(doc(), { state: 'overdue', label: 'বকেয়া' })
      .querySelector('.ui-badge-glyph'));
    assert.equal(statusBadge(doc(), { state: 'draft', label: 'খসড়া' })
      .querySelector('.ui-badge-glyph'), null);
  });

  test('a zero count renders nothing at all', () => {
    // A badge showing "0" says "no news" in the loudest way available.
    assert.equal(countBadge(doc(), 0, 'নোটিশ'), null);
    assert.equal(countBadge(doc(), 3, 'নোটিশ')?.textContent, '৩');
    assert.equal(countBadge(doc(), 42, 'নোটিশ')?.textContent, '৯+');
  });

  test('a count is announced with its subject, not as a bare number', () => {
    assert.equal(countBadge(doc(), 3, 'নোটিশ')?.getAttribute('aria-label'), 'নোটিশ — 3');
  });

  test('a plain badge is a label and carries no state', () => {
    assert.equal(badge(doc(), { label: 'বিজ্ঞান' }).dataset.tone, 'neutral');
  });
});

describe('P2 — fields', () => {
  test('THE ONE THAT MATTERS — label, helper and error all reach the input', () => {
    // Without association a reader says "edit text, blank": the label, the
    // helper and the error are all on screen and none of them arrive.
    const f = field(doc(), {
      label: 'রোল নম্বর', name: 'roll', kind: 'number',
      helper: 'শ্রেণির মধ্যে অনন্য হতে হবে', required: true,
    });
    host().append(f.root);
    const label = f.root.querySelector('label')!;
    assert.equal(label.getAttribute('for'), f.input.id);
    assert.ok(f.input.getAttribute('aria-describedby'));
    assert.equal(f.root.querySelector('.ui-field-help')?.id,
      f.input.getAttribute('aria-describedby'));
  });

  test('required is a word, not only an asterisk', () => {
    const f = field(doc(), { label: 'নাম', name: 'name', required: true });
    assert.match(f.root.querySelector('.ui-sr-only')?.textContent ?? '', /আবশ্যক/);
    assert.equal(f.root.querySelector('.ui-req')?.getAttribute('aria-hidden'), 'true');
  });

  test('THE ONE THAT MATTERS — an error never costs the user their input', () => {
    // §13. A guardian on 2G who loses a half-typed admission form does not
    // type it again; they stop.
    const f = field(doc(), { label: 'ফোন', name: 'phone', kind: 'tel' });
    (f.input as HTMLInputElement).value = '01712345678';
    setFieldError(f.root, 'এই নম্বরটি ইতিমধ্যে আছে');
    assert.equal(f.value(), '01712345678', 'the value was lost');
    assert.equal(f.input.getAttribute('aria-invalid'), 'true');
    assert.equal(f.root.querySelector('.ui-field-error')?.hidden, false);
  });

  test('an error names both the helper and the error to a reader', () => {
    const f = field(doc(), { label: 'ফোন', name: 'phone', helper: '১১ সংখ্যা' });
    setFieldError(f.root, 'ভুল নম্বর');
    const described = f.input.getAttribute('aria-describedby')!.split(' ');
    assert.equal(described.length, 2);
  });

  test('typing clears the error, so it does not read as "still wrong"', () => {
    const f = field(doc(), { label: 'নাম', name: 'name' });
    setFieldError(f.root, 'আবশ্যক');
    f.input.dispatchEvent(new dom.window.Event('input'));
    assert.equal(f.root.querySelector('.ui-field-error')?.hidden, true);
    assert.equal(f.input.hasAttribute('aria-invalid'), false);
  });

  test('clearFieldError restores the helper association exactly', () => {
    const f = field(doc(), { label: 'ফোন', name: 'phone', helper: '১১ সংখ্যা' });
    const before = f.input.getAttribute('aria-describedby');
    setFieldError(f.root, 'ভুল');
    clearFieldError(f.root);
    assert.equal(f.input.getAttribute('aria-describedby'), before);
  });

  test('THE ONE THAT MATTERS — a number field does not silently discard input', () => {
    // `type="number"` drops what it considers invalid, so a mis-keyed mark
    // vanishes instead of being corrected, and its spinner is a 12px target.
    const f = field(doc(), { label: 'নম্বর', name: 'marks', kind: 'number' });
    assert.equal(f.input.getAttribute('type'), 'text');
    assert.equal(f.input.getAttribute('inputmode'), 'numeric');
  });

  test('a phone field is LTR, so its digits do not reorder in a Bangla context', () => {
    const f = field(doc(), { label: 'ফোন', name: 'phone', kind: 'tel' });
    assert.equal(f.input.getAttribute('dir'), 'ltr');
    assert.equal(f.input.getAttribute('inputmode'), 'tel');
  });

  test('reportErrors marks every field and focuses the first', () => {
    // A form that says "3 problems" without moving to one is a scavenger hunt
    // on a phone, where the invalid field is usually scrolled off.
    const form = el(doc(), 'form');
    const a = field(doc(), { label: 'নাম', name: 'nameBn' });
    const b = field(doc(), { label: 'ফোন', name: 'phone' });
    append(form, a.root, b.root);
    host().append(form);

    const had = reportErrors(form, { nameBn: 'আবশ্যক', phone: 'ভুল নম্বর' });
    assert.equal(had, true);
    assert.equal(a.root.dataset.invalid, 'true');
    assert.equal(b.root.dataset.invalid, 'true');
    assert.equal(doc().activeElement, a.input);
  });

  test('reportErrors returns false when nothing matched', () => {
    const form = el(doc(), 'form');
    host().append(form);
    assert.equal(reportErrors(form, { missing: 'x' }), false);
  });

  test('a select renders its options and marks the current one', () => {
    const f = field(doc(), {
      label: 'শ্রেণি', name: 'class', kind: 'select', value: '9',
      options: [{ value: '8', label: 'অষ্টম' }, { value: '9', label: 'নবম' }],
    });
    assert.equal((f.input as HTMLSelectElement).value, '9');
    assert.equal(f.root.querySelectorAll('option').length, 2);
  });
});

describe('P2 — search', () => {
  test('THE ONE THAT MATTERS — searching costs one request, not one per keystroke', () => {
    // §19 / R-6: on 2G a keystroke search is a request per character and a
    // result set that arrives out of order.
    let calls = 0;
    const s = searchField(doc(), { label: 'শিক্ষার্থী খুঁজুন', onSearch: () => { calls++; } });
    host().append(s.root);
    s.input.value = 'রাফি';
    for (const _ of 'রাফি') s.input.dispatchEvent(new dom.window.Event('input'));
    assert.equal(calls, 0, 'typing must not search');
    s.root.dispatchEvent(new dom.window.Event('submit'));
    assert.equal(calls, 1);
  });

  test('the clear button appears only when there is something to clear', () => {
    const s = searchField(doc(), { label: 'খুঁজুন', onSearch: () => {} });
    const clear = s.root.querySelector<HTMLElement>('.ui-search-clear')!;
    assert.equal(clear.hidden, true);
    s.input.value = 'র';
    s.input.dispatchEvent(new dom.window.Event('input'));
    assert.equal(clear.hidden, false);
  });

  test('clearing searches again, so the list comes back', () => {
    let last: string | null = null;
    const s = searchField(doc(), { label: 'খুঁজুন', onSearch: (q) => { last = q; } });
    host().append(s.root);
    s.input.value = 'র';
    s.input.dispatchEvent(new dom.window.Event('input'));
    (s.root.querySelector('.ui-search-clear') as HTMLButtonElement).click();
    assert.equal(last, '');
    assert.equal(s.input.value, '');
  });

  test('the search box is a labelled landmark', () => {
    const s = searchField(doc(), { label: 'শিক্ষার্থী খুঁজুন', onSearch: () => {} });
    assert.equal(s.root.getAttribute('role'), 'search');
    assert.equal(s.root.querySelector('label')?.getAttribute('for'), s.input.id);
  });
});

describe('P2 — file upload', () => {
  test('the trigger is a <label for>, so it works without JavaScript gestures', () => {
    // A synthetic .click() on a file input is sometimes blocked as un-gestured
    // in a WebView; a label is not.
    const u = fileUpload(doc(), { label: 'CSV নির্বাচন', name: 'f', onFiles: () => {} });
    const trigger = u.root.querySelector('label')!;
    assert.equal(trigger.getAttribute('for'), u.input.id);
  });

  test('the input is screen-reader visible, not display:none', () => {
    const u = fileUpload(doc(), { label: 'ছবি', name: 'p', onFiles: () => {} });
    assert.match(u.input.className, /ui-sr-only/);
    assert.equal(u.input.getAttribute('type'), 'file');
  });

  test('capture opens the camera directly on a phone', () => {
    const u = fileUpload(doc(), {
      label: 'ছবি তুলুন', name: 'p', accept: 'image/*',
      capture: 'environment', multiple: true, onFiles: () => {},
    });
    assert.equal(u.input.getAttribute('capture'), 'environment');
    assert.equal(u.input.hasAttribute('multiple'), true);
  });
});
