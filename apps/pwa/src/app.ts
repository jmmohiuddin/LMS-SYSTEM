/**
 * PWA entry point.
 *
 * Now a small app rather than one hard-coded screen: Auth gates a Shell
 * (hash router + tab bar) with three routes — attendance, roster, routine.
 * A JWT (via Auth/login-view) replaces the old ?tid=&uid=&key= params for
 * identifying who's using the device; ?tid= is kept only as the one-time
 * way a school's install link tells a fresh device which tenant it belongs
 * to (see login-view.ts's tenantId resolution).
 */
import { openDb, IndexedDbOutboxStore } from '../../../packages/offline/src/store.ts';
import { SyncEngine } from '../../../packages/offline/src/sync-engine.ts';
import { AttendanceView } from './attendance-view.ts';
import { FetchTransport } from './transport.ts';
import { Auth } from './auth.ts';
import { DemoAuth } from './demo.ts';
import { LoginView } from './login-view.ts';
import { Shell, type ShellRoute } from './shell.ts';
import { RosterView } from './roster-view.ts';
import { RoutineView } from './routine-view.ts';
import { MarksView } from './marks-view.ts';
import type { Student } from '../../../packages/ui-core/src/attendance-grid.ts';
import type { RosterStudent } from './roster-view.ts';

const params  = new URLSearchParams(location.search);
const apiBase = location.origin;

// The tenant ID is baked into the school's install link once and cached
// from then on, so re-opening the PWA (no query string) still knows who it
// belongs to. login-view.ts falls back to an inline field if this is empty.
const tenantIdFromUrl = params.get('tid') ?? '';
if (tenantIdFromUrl) localStorage.setItem('shikhon_tid', tenantIdFromUrl);
const tenantId = tenantIdFromUrl || localStorage.getItem('shikhon_tid') || '';

// 60 placeholder students — used only until a real roster has been picked
// in the roster view (see roster-view.ts's shikhon_last_roster cache).
const placeholderStudents: Student[] = Array.from({ length: 60 }, (_, i) => ({
  studentId: `demo-${i + 1}`,
  rollNo:    i + 1,
  nameBn:    `শিক্ষার্থী ${i + 1}`,
  nameEn:    `Student ${i + 1}`,
}));

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function deviceId(key: string): string {
  const k = `shikhon_${key}`;
  const existing = localStorage.getItem(k);
  if (existing) return existing;
  const id = crypto.randomUUID();
  localStorage.setItem(k, id);
  return id;
}

function loadRosterStudents(): { students: Student[]; sectionId: string | null } {
  try {
    const raw = localStorage.getItem('shikhon_last_roster');
    const sectionId = localStorage.getItem('shikhon_last_section');
    if (!raw || !sectionId) return { students: placeholderStudents, sectionId: null };
    const roster = JSON.parse(raw) as RosterStudent[];
    if (!Array.isArray(roster) || roster.length === 0) return { students: placeholderStudents, sectionId: null };
    return {
      sectionId,
      students: roster.map((r) => ({
        studentId: r.studentId,
        rollNo: r.rollNo,
        nameBn: r.fullName.bn ?? r.fullName.en ?? `রোল ${r.rollNo}`,
        nameEn: r.fullName.en ?? r.fullName.bn ?? `Roll ${r.rollNo}`,
      })),
    };
  } catch {
    return { students: placeholderStudents, sectionId: null };
  }
}

async function main() {
  const rootEl = document.getElementById('root');
  if (!rootEl) return;
  // Rebound as a fresh const: TS doesn't carry the null-check narrowing of
  // `rootEl` into the nested function declarations below (startShell,
  // showLogin), since they're hoisted and could in principle be called
  // before the check. `root` here is guaranteed non-null at every use site.
  const root: HTMLElement = rootEl;

  // ?demo=1 — preview every screen with sample data while real login is
  // disabled (LOGIN_DISABLED in login-view.ts). DemoAuth answers all API
  // calls locally, so no session is needed and no request leaves the device.
  const demoMode = params.get('demo') === '1';
  const auth = demoMode ? new DemoAuth() : new Auth({ apiBase, deviceId: deviceId('d') });

  // Demo visits share the same localStorage caches as real sessions (the
  // views neither know nor care where their data came from), so purge any
  // demo leftovers on a normal boot — a later real login must never see
  // sample sections or students.
  if (!demoMode) {
    try {
      if (localStorage.getItem('shikhon_last_section')?.startsWith('demo-')) {
        localStorage.removeItem('shikhon_last_section');
        localStorage.removeItem('shikhon_last_roster');
      }
      const sections = JSON.parse(localStorage.getItem('shikhon_sections_cache') ?? 'null') as { id?: string }[] | null;
      if (Array.isArray(sections) && sections[0]?.id?.startsWith('demo-')) {
        localStorage.removeItem('shikhon_sections_cache');
      }
      for (const k of Object.keys(localStorage)) {
        if (k.startsWith('shikhon_roster_cache_demo-')) localStorage.removeItem(k);
      }
    } catch {
      // cache hygiene only — never block boot on it
    }
  }

  const idb       = await openDb(indexedDB);
  const store     = new IndexedDbOutboxStore(idb);

  function startShell(): Shell {
    const { students, sectionId } = loadRosterStudents();

    const transport = new FetchTransport({ auth });
    const engine = new SyncEngine({
      deviceId: deviceId('d'),
      tenantId: auth.tenantId || 'demo',
      actorId: auth.userId,
      store,
      transport,
    });
    navigator.serviceWorker?.addEventListener('message', (e) => {
      if ((e.data as { type?: string })?.type === 'outbox-flush') void engine.flush();
    });

    const routes: ShellRoute[] = [
      {
        path: 'attendance',
        labelBn: 'হাজিরা',
        glyph: '✓',
        mount: (container) => {
          new AttendanceView({
            root: container,
            doc: document,
            students,
            section: { id: sectionId ?? 'demo-section', labelBn: '৯-ক', academicYearId: 'yr-2026' },
            takenOn: todayIso(),
            subjectBn: 'পদার্থবিজ্ঞান',
            outbox: engine,
            newId: () => crypto.randomUUID(),
          });
        },
      },
      {
        path: 'routine',
        labelBn: 'রুটিন',
        glyph: '⏲',
        mount: (container) => { new RoutineView({ root: container, doc: document, auth }); },
      },
      {
        path: 'roster',
        labelBn: 'শিক্ষার্থী',
        glyph: '☰',
        mount: (container) => { new RosterView({ root: container, doc: document, auth }); },
      },
      {
        path: 'marks',
        labelBn: 'নম্বর',
        glyph: '✎',
        mount: (container) => {
          new MarksView({ root: container, doc: document, auth, outbox: engine });
        },
      },
    ];

    return new Shell({
      root,
      doc: document,
      routes,
      defaultPath: 'attendance',
      displayName: auth.displayName,
      onLogout: () => { void doLogout(); },
    });
  }

  let shell: Shell | null = null;

  function showLogin(): void {
    shell?.destroy();
    shell = null;
    new LoginView({
      root,
      doc: document,
      auth,
      tenantId,
      onLoggedIn: () => { shell = startShell(); },
    });
  }

  async function doLogout(): Promise<void> {
    await auth.logout();
    showLogin();
  }

  if (auth.isLoggedIn()) {
    shell = startShell();
  } else {
    showLogin();
  }
}

main().catch((err) => {
  console.error('[app] startup failed:', err);
  const root = document.getElementById('root');
  if (root) {
    root.textContent = 'অ্যাপ চালু করা যায়নি। পেজ রিলোড করুন।';
  }
});
