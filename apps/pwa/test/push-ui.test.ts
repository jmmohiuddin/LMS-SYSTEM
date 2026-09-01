/**
 * R-9's browser side: the notification screen and the service worker's
 * payload handling.
 *
 * Two things are worth holding still here, and neither is the happy path.
 *
 * The first is that EVERY state renders something useful. A person whose
 * browser has blocked notifications gets a button that silently does nothing —
 * `requestPermission()` returns 'denied' without showing a prompt — so that
 * state must explain where the block is instead. Likewise a deployment with no
 * VAPID keys, and a browser with no Push API at all: three states with no
 * working button between them, and all three are ones a real person hits.
 *
 * The second is that a push payload is untrusted input rendered on a lock
 * screen. It arrives encrypted end-to-end, but "the server sent it" is not a
 * reason to skip validating a blob that came over the network into a context
 * where an OS will display it verbatim.
 */
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { notificationFor, PUSH_FALLBACK } from '../src/sw-router.ts';
import { pushState, urlBase64ToUint8Array, deviceLabelFor } from '../src/push-client.ts';
import { NotificationsView } from '../src/notifications-view.ts';

// ─────────────────────────────────────────── the service worker's half

describe('R-9 — what a push payload becomes on a lock screen', () => {
  test('THE ONE THAT MATTERS — an unreadable payload still shows something', () => {
    // A push event that shows NOTHING is worse than a vague one: Chrome
    // replaces it with its own "This site has been updated in the background",
    // in English, on a Bangla-speaking parent's phone.
    for (const raw of [null, undefined, '', 'not json', '[]', 'null', '{}',
      '{"title":"","body":""}']) {
      const n = notificationFor(raw as string | null);
      assert.ok(n.title.length > 0, JSON.stringify(raw));
      assert.ok(n.body.length > 0, JSON.stringify(raw));
    }
    assert.deepEqual(notificationFor('nope'), PUSH_FALLBACK);
  });

  test('the fallback does not name the platform (D11)', () => {
    // It renders on a parent's lock screen, and the school's identity is
    // exactly what has failed to be read — the platform's is not a substitute.
    assert.doesNotMatch(JSON.stringify(PUSH_FALLBACK), /ShikhonBD/i);
  });

  test('a well-formed payload is passed through', () => {
    const n = notificationFor(JSON.stringify({
      title: 'মিরপুর বালিকা বিদ্যালয়',
      body: 'আপনার সন্তান আজ অনুপস্থিত ছিল।',
      tag: 'notice:n1:u1', url: '#/inbox',
    }));
    assert.equal(n.title, 'মিরপুর বালিকা বিদ্যালয়');
    assert.equal(n.body, 'আপনার সন্তান আজ অনুপস্থিত ছিল।');
    assert.equal(n.tag, 'notice:n1:u1');
    assert.equal(n.url, '#/inbox');
  });

  test('THE ONE THAT MATTERS — the click target can only be an in-app route', () => {
    // The url is what the OS opens on tap. An absolute one would make a
    // notification carrying a school's name into an open redirect.
    for (const url of [
      'https://evil.example/', 'http://evil.example/', '//evil.example/',
      'javascript:alert(1)', 'data:text/html,x', '/absolute', '#/../../etc',
      '#/inbox?next=https://evil.example',
    ]) {
      const n = notificationFor(JSON.stringify({ title: 'x', body: 'y', url }));
      assert.equal(n.url, PUSH_FALLBACK.url, url);
    }
    assert.equal(notificationFor(JSON.stringify({ title: 'x', body: 'y', url: '#/home' })).url,
      '#/home');
  });

  test('absurd lengths are trimmed rather than shown', () => {
    const n = notificationFor(JSON.stringify({
      title: 'ক'.repeat(500), body: 'খ'.repeat(5000), tag: 'g'.repeat(500), url: '#/inbox',
    }));
    assert.ok(n.title.length <= 80);
    assert.ok(n.body.length <= 300);
    assert.ok(n.tag.length <= 120);
  });

  test('newlines are flattened — a lock screen has one line', () => {
    const n = notificationFor(JSON.stringify({ title: 'a\n\nb', body: 'c\r\n\td', url: '#/inbox' }));
    assert.equal(n.title, 'a b');
    assert.equal(n.body, 'c d');
  });
});

// ─────────────────────────────────────────── the client's decisions

describe('R-9 — which state the notification screen is in', () => {
  const base = {
    hasServiceWorker: true, hasPushManager: true, hasNotification: true,
    isSecureContext: true, permission: 'default' as NotificationPermission,
    serverEnabled: true, subscribed: false,
  };

  test('a browser missing any piece is "unsupported"', () => {
    for (const k of ['hasServiceWorker', 'hasPushManager', 'hasNotification',
      'isSecureContext'] as const) {
      assert.equal(pushState({ ...base, [k]: false }), 'unsupported', k);
    }
  });

  test('THE ONE THAT MATTERS — an unconfigured server outranks a denied browser', () => {
    // Otherwise a person who blocked notifications years ago is sent to fix
    // their browser for a feature the school has not turned on at all.
    assert.equal(pushState({ ...base, serverEnabled: false, permission: 'denied' }),
      'unconfigured');
  });

  test('denied, off and on', () => {
    assert.equal(pushState({ ...base, permission: 'denied' }), 'denied');
    assert.equal(pushState({ ...base, permission: 'default' }), 'off');
    assert.equal(pushState({ ...base, permission: 'granted', subscribed: true }), 'on');
    // Permission granted but no subscription — the person turned it on and
    // then cleared site data. Offerable again.
    assert.equal(pushState({ ...base, permission: 'granted', subscribed: false }), 'off');
  });
});

describe('R-9 — the VAPID key the browser is handed', () => {
  test('THE ONE THAT MATTERS — base64url without padding decodes to 65 bytes', () => {
    // atob needs standard base64 WITH padding; a VAPID key is base64url
    // without it. Get this wrong and some browsers throw while others
    // subscribe with a wrong key and silently fail to decrypt every message.
    const key = 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4';
    const bytes = urlBase64ToUint8Array(key);
    assert.equal(bytes.length, 65);
    assert.equal(bytes[0], 0x04, 'uncompressed P-256 point');
  });

  test('the two url-safe characters are translated', () => {
    // A key containing - or _ decoded as standard base64 gives wrong bytes,
    // which is the silent-failure case above.
    const withDashes = urlBase64ToUint8Array('a-b_cw');
    const withPlus = urlBase64ToUint8Array('a+b/cw');
    assert.deepEqual([...withDashes], [...withPlus]);
  });
});

describe('R-9 — a browser whose service worker never registers', () => {
  /**
   * The bug a real browser found and the unit tests could not.
   *
   * `navigator.serviceWorker.ready` resolves when there is an ACTIVE worker,
   * and when registration has failed it does not resolve at all — so the
   * notification screen sat on its loading skeleton permanently, with no error
   * and no way out. A corporate policy, a private window, or a failed update
   * all produce it.
   */
  const hangingNav = () => ({
    userAgent: 'test',
    serviceWorker: {
      // Never settles — exactly what a failed registration gives you.
      ready: new Promise<never>(() => {}),
      getRegistration: async () => undefined,
    },
  });

  const winWith = (nav: unknown): Window => ({
    isSecureContext: true, navigator: nav,
    PushManager: function () {}, Notification: { permission: 'default' },
  } as unknown as Window);

  test('THE ONE THAT MATTERS — isSubscribed settles rather than hanging', async () => {
    const { PushClient } = await import('../src/push-client.ts');
    const client = new PushClient(async () => new Response('{}'), winWith(hangingNav()));

    const answered = await Promise.race([
      client.isSubscribed(),
      new Promise((r) => setTimeout(() => r('HUNG'), 300)),
    ]);
    assert.equal(answered, false, 'a browser with no worker is simply not subscribed');
  });

  test('enable() gives up with a sentence rather than spinning forever', async () => {
    const { PushClient } = await import('../src/push-client.ts');
    const win = winWith(hangingNav()) as unknown as Record<string, unknown>;
    (win.Notification as Record<string, unknown>).requestPermission =
      async () => 'granted' as NotificationPermission;

    const client = new PushClient(async () => new Response('{}'), win as unknown as Window);
    // The timeout is 5s in production; this asserts it terminates at all,
    // which is the property that was missing.
    const r = await Promise.race([
      client.enable('BKEY'),
      new Promise((res) => setTimeout(() => res('HUNG'), 8000)),
    ]);
    assert.notEqual(r, 'HUNG', 'enable must not hang on a browser with no worker');
    assert.equal((r as { ok: boolean }).ok, false);
    assert.match((r as { message: string }).message, /রিফ্রেশ|ব্যাকগ্রাউন্ড/);
  });
});

describe('R-9 — the device label', () => {
  test('it is coarse, on purpose', () => {
    assert.equal(deviceLabelFor('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Mobile/15E148'), 'মোবাইল');
    assert.equal(deviceLabelFor('Mozilla/5.0 (Linux; Android 13; SM-A536E) Mobile Safari'), 'মোবাইল');
    assert.equal(deviceLabelFor('Mozilla/5.0 (iPad; CPU OS 17_0)'), 'ট্যাবলেট');
    assert.equal(deviceLabelFor('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), 'কম্পিউটার');
    assert.equal(deviceLabelFor(''), 'কম্পিউটার');
  });

  test('it carries no version, no build, nothing identifying', () => {
    const ua = 'Mozilla/5.0 (Linux; Android 13; SM-A536E Build/TP1A.220624.014) Mobile';
    const label = deviceLabelFor(ua);
    // A full user-agent is a fingerprint, it would sit in the database, and
    // "which of my devices is this" needs three words.
    assert.ok(label.length < 20);
    assert.doesNotMatch(label, /\d/);
    assert.doesNotMatch(label, /SM-A536E/);
  });
});

// ─────────────────────────────────────────── the screen

describe('R-9 — the notification screen renders every state', () => {
  let dom: JSDOM;

  before(() => {
    dom = new JSDOM('<!doctype html><html><body><main id="root"></main></body></html>',
      { url: 'https://school.example/' });
    (globalThis as Record<string, unknown>).HTMLElement = dom.window.HTMLElement;
  });

  beforeEach(() => {
    dom.window.document.getElementById('root')!.textContent = '';
  });

  /** A window stand-in, so every browser capability can be posed. */
  const fakeWin = (o: {
    sw?: boolean; push?: boolean; notif?: boolean; secure?: boolean;
    permission?: NotificationPermission;
  } = {}): Window => {
    const w: Record<string, unknown> = {
      isSecureContext: o.secure !== false,
      navigator: { userAgent: 'test' },
    };
    if (o.sw !== false) (w.navigator as Record<string, unknown>).serviceWorker = {};
    if (o.push !== false) w.PushManager = function () {};
    if (o.notif !== false) w.Notification = { permission: o.permission ?? 'default' };
    return w as unknown as Window;
  };

  /** A PushClient stand-in — the impure half, posed rather than driven. */
  const fakeClient = (o: {
    enabled?: boolean; devices?: unknown[]; subscribed?: boolean;
    permission?: NotificationPermission | 'unavailable';
    status?: null;
  } = {}) => ({
    permission: () => o.permission ?? 'default',
    supported: () => true,
    status: async () => (o.status === null ? null : {
      enabled: o.enabled !== false,
      publicKey: o.enabled === false ? null : 'BKEY',
      devices: o.devices ?? [],
    }),
    isSubscribed: async () => o.subscribed === true,
    enable: async () => ({ ok: true as const }),
    disable: async () => true,
    forget: async () => true,
  });

  const mount = async (client: unknown, win: Window) => {
    const root = dom.window.document.getElementById('root')!;
    new NotificationsView({
      root: root as unknown as HTMLElement,
      doc: dom.window.document,
      auth: { authedFetch: async () => new Response('{}') } as never,
      client: client as never,
      win,
    });
    // Two microtask turns: the constructor renders, then load() resolves.
    await new Promise((r) => setTimeout(r, 0));
    return root;
  };

  test('loading first, then content — never a blank screen', async () => {
    const root = dom.window.document.getElementById('root')!;
    new NotificationsView({
      root: root as unknown as HTMLElement, doc: dom.window.document,
      auth: { authedFetch: async () => new Response('{}') } as never,
      client: fakeClient() as never, win: fakeWin(),
    });
    // Synchronously after construction, before any await resolves.
    assert.match(root.innerHTML, /skeleton/,
      'a person on 2G sees a skeleton, not an empty page');
  });

  test('THE ONE THAT MATTERS — "denied" explains where the block is', async () => {
    const root = await mount(
      fakeClient({ permission: 'denied' }), fakeWin({ permission: 'denied' }));
    assert.equal(root.querySelector('[data-push-state]')?.getAttribute('data-push-state'), 'denied');
    // No button: requestPermission() would return 'denied' without showing
    // anything, which looks like a broken app.
    assert.equal(root.querySelectorAll('button').length, 0);
    assert.match(root.textContent ?? '', /ব্রাউজারের সেটিংস|তালা/);
  });

  test('"unsupported" says the SMS still arrives', async () => {
    const root = await mount(fakeClient(), fakeWin({ push: false }));
    assert.equal(root.querySelector('[data-push-state]')?.getAttribute('data-push-state'),
      'unsupported');
    // Not a dead end: without this, somebody concludes they will now miss
    // their child's absence.
    assert.match(root.textContent ?? '', /এসএমএস/);
  });

  test('"unconfigured" points at the school, not at the person', async () => {
    const root = await mount(fakeClient({ enabled: false }), fakeWin());
    assert.equal(root.querySelector('[data-push-state]')?.getAttribute('data-push-state'),
      'unconfigured');
    assert.equal(root.querySelectorAll('button').length, 0);
  });

  test('"off" offers the button; "on" offers the way back', async () => {
    const off = await mount(fakeClient(), fakeWin());
    assert.equal(off.querySelector('[data-push-state]')?.getAttribute('data-push-state'), 'off');
    assert.match(off.textContent ?? '', /চালু করুন/);

    dom.window.document.getElementById('root')!.textContent = '';
    const on = await mount(
      fakeClient({ subscribed: true, permission: 'granted' }),
      fakeWin({ permission: 'granted' }));
    assert.equal(on.querySelector('[data-push-state]')?.getAttribute('data-push-state'), 'on');
    assert.match(on.textContent ?? '', /বন্ধ করুন/);
  });

  test('the empty state names what would appear there', async () => {
    const root = await mount(fakeClient({ devices: [] }), fakeWin());
    assert.match(root.textContent ?? '', /কোনো যন্ত্র যুক্ত নেই/);
  });

  test('devices are listed with a way to remove each', async () => {
    const root = await mount(fakeClient({
      devices: [
        { id: 'd1', label: 'মোবাইল', createdAt: '2026-08-01T00:00:00Z',
          lastSuccessAt: '2026-08-28T00:00:00Z', fingerprint: 'abc123abc123' },
        { id: 'd2', label: 'কম্পিউটার', createdAt: '2026-08-02T00:00:00Z',
          lastSuccessAt: null, fingerprint: 'def456def456' },
      ],
    }), fakeWin());
    // P6 made this a `dataTable`, which keys its rows by `data-key`. The
    // assertion is stronger than the row count it replaces: each device must
    // have its OWN remove control, named for the device — two buttons both
    // called "সরান" are two identical announcements.
    assert.equal(root.querySelectorAll('table.ui-table tbody tr').length, 2);
    assert.match(root.textContent ?? '', /মোবাইল/);
    const removes = [...root.querySelectorAll('table.ui-table button[aria-label]')]
      .map((b) => b.getAttribute('aria-label') ?? '')
      .filter((l) => l.includes('সরান'));
    assert.equal(removes.length, 2);
    assert.equal(new Set(removes).size, 2, 'each names the device it removes');
    assert.ok(removes.some((l) => l.includes('মোবাইল')));
    // A device that has never received anything says so, rather than showing
    // a blank where a date would be.
    assert.match(root.textContent ?? '', /এখনো কোনো বার্তা যায়নি/);
  });

  test('THE ONE THAT MATTERS — an endpoint never reaches the DOM', async () => {
    const root = await mount(fakeClient({
      devices: [{ id: 'd1', label: 'মোবাইল', createdAt: '2026-08-01T00:00:00Z',
        lastSuccessAt: null, fingerprint: 'abc123abc123' }],
    }), fakeWin());
    // The API does not return one; this is the second line of defence, since
    // a rendered endpoint would sit in the DOM of a shared school computer.
    assert.doesNotMatch(root.innerHTML, /fcm\.googleapis|https:\/\/.*push/);
  });

  test('a failed load offers a retry rather than an empty page', async () => {
    const root = await mount(fakeClient({ status: null }), fakeWin());
    assert.match(root.textContent ?? '', /আনা যায়নি/);
    assert.ok(root.querySelector('button'), 'an error state must offer a way out');
  });

  test('D11 — the platform brand is nowhere on a tenant screen', async () => {
    const root = await mount(fakeClient(), fakeWin());
    assert.doesNotMatch(root.innerHTML, /ShikhonBD/i);
  });
});
