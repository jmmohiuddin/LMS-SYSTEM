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
import { LoginView, LOGIN_DISABLED } from './login-view.ts';
import { Shell, type ShellRoute } from './shell.ts';
import { RosterView } from './roster-view.ts';
import { RoutineView } from './routine-view.ts';
import { MarksView } from './marks-view.ts';
import { FeesView } from './fees-view.ts';
import { MoreView } from './more-view.ts';
import { SikhokView } from './sikhok-view.ts';
import { ShikhoView } from './shikho-view.ts';
import { SubstituteView } from './substitute-view.ts';
import { ExamRoutineView } from './exam-routine-view.ts';
import { RoutineEditorView } from './routine-editor-view.ts';
import { SubjectChoiceView } from './subject-choice-view.ts';
import { ClassPerfView } from './class-perf-view.ts';
import { ImportView } from './import-view.ts';
import { GenerationView } from './generation-view.ts';
import { GuardianView } from './guardian-view.ts';
import { Tracker } from './track.ts';
import { HomeView, type DashboardItem, type Suggestion } from './home-view.ts';
import { ScriptsView } from './scripts-view.ts';
import { RolesView } from './roles-view.ts';
import { LedgerView } from './ledger-view.ts';
import { SystemView } from './system-view.ts';
import { LearnView } from './learn-view.ts';
import { SubjectsView } from './subjects-view.ts';
import { MyAttendanceView } from './my-attendance-view.ts';
import { ResultsView } from './results-view.ts';
import { AssignmentsView } from './assignments-view.ts';
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

/**
 * The home dashboard is role-aware, because the cards are actions and most
 * actions are not available to most roles. Showing a student "take
 * attendance" isn't just clutter — it's an invitation to a 403, and it
 * misrepresents what the product is for that person.
 *
 * Only the *visible* surface changes. Every route stays registered and
 * reachable by URL; RLS and the endpoint role guards are what actually
 * enforce access, exactly as before. This is orientation, not security.
 */
type DashCards = { primary: DashboardItem[]; secondary: DashboardItem[] };

// glyph is an icon name from ./icon.ts (rendered as inline SVG), never an
// emoji: one drawn set, one stroke weight, tintable with currentColor.
const CARD = {
  learn:      { path: 'learn',      glyph: 'book-open',    titleBn: 'পড়াশোনা',            subtitleBn: 'অধ্যায়, পাঠ ও অগ্রগতি' },
  subjects:   { path: 'subjects',   glyph: 'layers',       titleBn: 'আমার বিষয়',          subtitleBn: 'শ্রেণি ও বিভাগ অনুযায়ী' },
  myAtt:      { path: 'my-attendance', glyph: 'percent',   titleBn: 'আমার হাজিরা',      subtitleBn: 'মাস ও বিষয় অনুযায়ী' },
  results:    { path: 'results',    glyph: 'award',        titleBn: 'ফলাফল',              subtitleBn: 'পরীক্ষার ফলাফল ও নম্বর' },
  homework:   { path: 'assignments', glyph: 'clipboard',   titleBn: 'বাড়ির কাজ',         subtitleBn: 'জমা দিতে হবে যেসব' },
  homeworkT:  { path: 'assignments', glyph: 'clipboard',   titleBn: 'বাড়ির কাজ',         subtitleBn: 'কাজ দাও ও নম্বর দাও' },
  shikho:     { path: 'shikho',     glyph: 'message',      titleBn: 'শিখো টিউটর',         subtitleBn: 'প্রশ্ন করো, উত্তর বুঝে নাও' },
  routineStu: { path: 'routine',    glyph: 'clock',        titleBn: 'আজকের রুটিন',        subtitleBn: 'তোমার ক্লাসের সময়সূচি' },
  feesStu:    { path: 'fees',       glyph: 'wallet',       titleBn: 'বেতন ও ফি',          subtitleBn: 'ইনভয়েস ও রসিদ' },
  attendance: { path: 'attendance', glyph: 'check-square', titleBn: 'হাজিরা নিন',         subtitleBn: 'আজকের শ্রেণিকক্ষ' },
  routine:    { path: 'routine',    glyph: 'clock',        titleBn: 'আজকের রুটিন',        subtitleBn: 'ক্লাস ও বদলি চিহ্নিতসহ' },
  roster:     { path: 'roster',     glyph: 'users',        titleBn: 'শিক্ষার্থী',          subtitleBn: 'সেকশন রোস্টার' },
  marks:      { path: 'marks',      glyph: 'edit',         titleBn: 'নম্বর এন্ট্রি',        subtitleBn: 'CQ · MCQ · ব্যবহারিক' },
  scripts:    { path: 'scripts',    glyph: 'camera',       titleBn: 'উত্তরপত্র',           subtitleBn: 'ছবি তুলে আপলোড' },
  substitute: { path: 'substitute', glyph: 'repeat',       titleBn: 'বদলি শিক্ষক',        subtitleBn: 'ফাঁকা শিক্ষক খুঁজুন' },
  sikhok:     { path: 'sikhok',     glyph: 'star',         titleBn: 'শিক্ষক সহায়ক AI',    subtitleBn: 'প্রশ্নপত্র ও পাঠ পরিকল্পনা' },
  fees:       { path: 'fees',       glyph: 'wallet',       titleBn: 'বেতন ও ফি',          subtitleBn: 'ইনভয়েস ও রসিদ' },
  roles:      { path: 'roles',      glyph: 'lock',         titleBn: 'ভূমিকা ও অ্যাক্সেস',  subtitleBn: '১০ ভূমিকা · RLS' },
  ledger:     { path: 'ledger',     glyph: 'book',         titleBn: 'লেজার ও পুনর্মিলন',   subtitleBn: 'দ্বৈত-এন্ট্রি হিসাব' },
  system:     { path: 'system',     glyph: 'settings',     titleBn: 'সিস্টেম',            subtitleBn: 'সব ইন্টিগ্রেশনের অবস্থা' },
  // The guardian's own home (F-203, §9.1). It was reachable only from the
  // More menu — the persona least able to hunt for it. It now leads the
  // guardian dashboard; the glyph matches its More entry so the one control
  // reads the same in both places it appears.
  wardHome:   { path: 'guardian',   glyph: 'users',        titleBn: 'আমার সন্তান',        subtitleBn: 'হাজিরা, ফলাফল ও বকেয়া ফি' },
} satisfies Record<string, DashboardItem>;

// Home is an orientation surface, not an index. Each dashboard is trimmed to
// ~6 tiles — two primary actions and a short shortcut row — and the long tail
// lives in the "আরও" menu, which is Wireframe §2's deliberate home for it
// ("Everything else is reachable but does not compete for bar space"). The
// two rules behind the cut: never seat a card that only duplicates a bottom
// tab (learn, attendance, roster are tabs already), and never carry a tile
// whose only home is this grid — every secondary tile below is also in More,
// so trimming relocates nothing, it only stops the screen from being a wall.
function dashboardFor(role: string): DashCards {
  switch (role) {
    case 'student':
      // learn and routine are tabs; homework leads because a due date is the
      // one thing a student arrives worried about.
      return {
        primary: [CARD.subjects, CARD.homework],
        secondary: [CARD.results, CARD.myAtt, CARD.shikho, CARD.feesStu],
      };
    case 'guardian':
      // The ward home leads — it is the guardian's whole reason for opening
      // the app, and it was previously buried in More. Fees second: §9.1 puts
      // payment one tap from home.
      return {
        primary: [CARD.wardHome, CARD.feesStu],
        secondary: [CARD.results, CARD.routineStu, CARD.myAtt],
      };
    case 'accountant':
      return {
        primary: [CARD.fees, CARD.ledger],
        secondary: [CARD.roster, CARD.system],
      };
    case 'principal':
    case 'school_owner':
      return {
        primary: [CARD.routine, CARD.ledger],
        secondary: [CARD.roster, CARD.marks, CARD.fees, CARD.system],
      };
    default:
      // Teachers and coordinators — teaching-first. roster and attendance are
      // tabs, so the shortcut row is the grading tail a teacher reaches for
      // after class; the rest (sikhok, shikho, fees, roles, ledger, system)
      // is one tap away in More.
      return {
        primary: [CARD.attendance, CARD.routine],
        secondary: [CARD.homeworkT, CARD.marks, CARD.scripts, CARD.substitute],
      };
  }
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

  // Demo mode: DemoAuth answers every API call locally with sample data —
  // no session needed, no request leaves the device, real tenant data
  // unreachable. Entered explicitly via ?demo=1, and AUTOMATICALLY for any
  // visitor without a session while login is disabled (LOGIN_DISABLED),
  // so the plain URL never dead-ends on the disabled-login notice. The
  // moment LOGIN_DISABLED flips back to false, the automatic path turns
  // itself off and session-less visitors see the login form again.
  const realAuth = new Auth({ apiBase, deviceId: deviceId('d') });
  const demoMode = params.get('demo') === '1' || (LOGIN_DISABLED && !realAuth.isLoggedIn());
  const auth = demoMode ? new DemoAuth() : realAuth;
  // F-1503. One tracker for the session; flushed on boot (draining
  // whatever a previous offline session queued) and after login.
  const tracker = new Tracker({ auth });
  if (!demoMode) void tracker.flush();

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
        path: 'home',
        labelBn: 'হোম',
        glyph: 'home',
        mount: (container) => {
          const { primary, secondary } = dashboardFor(auth.role);
          const learner = ['student', 'guardian'].includes(auth.role);
          new HomeView({
            root: container,
            doc: document,
            displayName: auth.displayName,
            primary,
            secondary,
            // Staff don't get a "what should I study next" block — their
            // day is set by the routine, not by their own progress.
            loadNext: learner
              ? async () => {
                  const res = await auth.authedFetch('/api/v1/academics/next');
                  if (!res.ok) return [];
                  const body = (await res.json()) as { suggestions: Suggestion[] };
                  return body.suggestions;
                }
              : undefined,
          });
        },
      },
      {
        path: 'my-attendance',
        labelBn: 'আমার হাজিরা',
        glyph: 'check-square',
        // Not a tab: the wireframe's student bar is হোম / পড়াশোনা / বাড়ির কাজ /
        // রুটিন / আরও. Reached from the dashboard card and the More menu.
        hidden: true,
        mount: (container) => {
          new MyAttendanceView({ root: container, doc: document, auth });
        },
      },
      {
        // F-802. Registered before 'learn' because the subject list is the
        // entry point to chapters, not a sibling of them (wireframe §6.2).
        path: 'subjects',
        labelBn: 'আমার বিষয়',
        glyph: 'layers',
        hidden: true,   // see my-attendance above — §2 caps the bar at five

        mount: (container) => {
          new SubjectsView({
            root: container, doc: document, auth,
            onOpenSubject: () => { location.hash = '#/learn'; },
          });
        },
      },
      {
        path: 'learn',
        labelBn: 'পড়াশোনা',
        glyph: 'book-open',
        mount: (container) => {
          new LearnView({ root: container, doc: document, auth, outbox: engine });
        },
      },
      {
        path: 'attendance',
        labelBn: 'হাজিরা',
        glyph: 'check-square',
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
        glyph: 'clock',
        hidden: true,
        mount: (container) => { new RoutineView({ root: container, doc: document, auth }); },
      },
      {
        path: 'roster',
        labelBn: 'শিক্ষার্থী',
        glyph: 'users',
        mount: (container) => { new RosterView({ root: container, doc: document, auth }); },
      },
      {
        path: 'marks',
        labelBn: 'নম্বর',
        glyph: 'edit',
        hidden: true,
        mount: (container) => {
          new MarksView({ root: container, doc: document, auth, outbox: engine });
        },
      },
      {
        path: 'more',
        labelBn: 'আরও',
        glyph: 'more-horizontal',
        mount: (container) => {
          new MoreView({
            root: container,
            doc: document,
            // glyph is an icon name from ./icon.ts (inline SVG), not an emoji.
            items: [
              { path: 'assignments', glyph: 'clipboard', titleBn: 'বাড়ির কাজ', subtitleBn: 'কাজ দাও, জমা দেখো ও নম্বর দাও' },
              { path: 'results', glyph: 'award', titleBn: 'ফলাফল', subtitleBn: 'প্রকাশিত পরীক্ষার ফলাফল' },
              { path: 'routine', glyph: 'clock', titleBn: 'রুটিন', subtitleBn: 'দৈনিক ও সাপ্তাহিক ক্লাস সময়সূচি' },
              { path: 'marks', glyph: 'edit', titleBn: 'নম্বর এন্ট্রি', subtitleBn: 'অফলাইন CQ / MCQ / ব্যবহারিক' },
              { path: 'scripts', glyph: 'camera', titleBn: 'উত্তরপত্র আপলোড', subtitleBn: 'হাতে-লেখা উত্তরপত্রের ছবি' },
              { path: 'fees', glyph: 'wallet', titleBn: 'বেতন ও ফি', subtitleBn: 'ইনভয়েস, মওকুফ ও ডিজিটাল রসিদ' },
              { path: 'substitute', glyph: 'repeat', titleBn: 'বদলি শিক্ষক', subtitleBn: 'ফাঁকা ও বিষয়-মিল শিক্ষক নির্ধারণ' },
              { path: 'routineeditor', glyph: 'clock', titleBn: 'রুটিন সম্পাদনা', subtitleBn: 'ক্লাস সরান — সংঘর্ষ হলে কারণ জানায়' },
              { path: 'subjectchoice', glyph: 'layers', titleBn: 'বিভাগ ও বিষয় নির্বাচন', subtitleBn: 'ধর্ম শিক্ষা ও চতুর্থ বিষয় নির্ধারণ' },
              { path: 'classperf', glyph: 'trending-up', titleBn: 'শ্রেণির ফলাফল বিশ্লেষণ', subtitleBn: 'কোন অংশে দুর্বলতা · কাদের সহায়তা লাগতে পারে' },
              { path: 'examroutine', glyph: 'alert-triangle', titleBn: 'পরীক্ষার রুটিন', subtitleBn: 'শিক্ষার্থীভিত্তিক সময় সংঘর্ষ যাচাই' },
              { path: 'import', glyph: 'upload', titleBn: 'শিক্ষার্থী আমদানি', subtitleBn: 'CSV থেকে — যাচাই করে, ভুল সারি বাদ দিয়ে' },
              { path: 'guardian', glyph: 'users', titleBn: 'আমার সন্তান', subtitleBn: 'হাজিরা, ফলাফল ও বকেয়া ফি' },
              { path: 'sikhok', glyph: 'star', titleBn: 'শিক্ষক সহায়ক AI', subtitleBn: 'CQ · MCQ · রুব্রিক · পাঠ পরিকল্পনা' },
              { path: 'shikho', glyph: 'message', titleBn: 'শিখো টিউটর', subtitleBn: 'শিক্ষার্থীদের জন্য AI সহপাঠী' },
              { path: 'roles', glyph: 'lock', titleBn: 'ভূমিকা ও অ্যাক্সেস', subtitleBn: '১০ ভূমিকা · RLS আইসোলেশন' },
              { path: 'ledger', glyph: 'book', titleBn: 'লেজার ও পুনর্মিলন', subtitleBn: 'দ্বৈত-এন্ট্রি · MFS পুনর্মিলন' },
              { path: 'system', glyph: 'settings', titleBn: 'সিস্টেম ও ইন্টিগ্রেশন', subtitleBn: 'ওয়ার্কার · কিল-সুইচ · অদৃশ্য গ্যারান্টি' },
            ],
          });
        },
      },
      {
        path: 'fees',
        labelBn: 'বেতন',
        glyph: 'wallet',
        hidden: true,
        mount: (container) => { new FeesView({ root: container, doc: document, auth }); },
      },
      {
        path: 'substitute',
        labelBn: 'বদলি',
        glyph: 'repeat',
        hidden: true,
        mount: (container) => { new SubstituteView({ root: container, doc: document, auth }); },
      },
      {
        // Reached from the routine editor with ?routineId=…; there is no
        // generation result without a routine to be the result of.
        path: 'generation',
        labelBn: 'রুটিন ফলাফল',
        glyph: 'settings',
        hidden: true,
        mount: (container) => {
          const routineId = new URLSearchParams(
            (location.hash.split('?')[1] ?? '')).get('routineId') ?? '';
          new GenerationView({ root: container, doc: document, auth, routineId });
        },
      },
      {
        path: 'import',
        labelBn: 'আমদানি',
        glyph: 'upload',
        hidden: true,
        mount: (container) => { new ImportView({ root: container, doc: document, auth }); },
      },
      {
        // §9.1's guardian home. The mount was missing in the commit that
        // introduced the view — the more-menu carried a nav item pointing
        // to a route nobody had registered, and esbuild correctly
        // tree-shook GuardianView out of the bundle as unused. Prod
        // testing found it; my automated suites did not, because the
        // route table is not what they walk.
        path: 'guardian',
        labelBn: 'আমার সন্তান',
        glyph: 'users',
        hidden: true,
        mount: (container) => {
          new GuardianView({
            root: container, doc: document, auth,
            onOpenFees: () => { location.hash = '#/fees'; },
            onOpenResults: () => { location.hash = '#/results'; },
          });
        },
      },
      {
        // Coordinator surface, so hidden from the bar — §2 caps it at five
        // and those five belong to the people who open the app every day.
        path: 'examroutine',
        labelBn: 'পরীক্ষার রুটিন',
        glyph: 'alert-triangle',
        hidden: true,
        mount: (container) => { new ExamRoutineView({ root: container, doc: document, auth }); },
      },
      {
        // §8.1's routine editor. Mounted here, not only listed in the More
        // menu — a menu entry whose route nobody registered is a dead link,
        // and esbuild tree-shakes the unreferenced view out of the bundle
        // entirely (see the guardian route above for how that shipped once).
        path: 'routineeditor',
        labelBn: 'রুটিন সম্পাদনা',
        glyph: 'clock',
        hidden: true,
        mount: (container) => { new RoutineEditorView({ root: container, doc: document, auth }); },
      },
      {
        // §10.3. The input to the subject-based model: what this writes is
        // what "আমার বিষয়" reads and what the exam-clash check exists to catch.
        path: 'subjectchoice',
        labelBn: 'বিভাগ ও বিষয়',
        glyph: 'layers',
        hidden: true,
        mount: (container) => { new SubjectChoiceView({ root: container, doc: document, auth }); },
      },
      {
        // §7.5. F-1501 + F-1502. The attention list here is a soft signal
        // and is never persisted — see class-perf-view.ts.
        path: 'classperf',
        labelBn: 'ফলাফল বিশ্লেষণ',
        glyph: 'trending-up',
        hidden: true,
        mount: (container) => { new ClassPerfView({ root: container, doc: document, auth }); },
      },
      {
        path: 'sikhok',
        labelBn: 'শিক্ষক AI',
        glyph: 'star',
        hidden: true,
        mount: (container) => { new SikhokView({ root: container, doc: document, auth }); },
      },
      {
        path: 'shikho',
        labelBn: 'শিখো',
        glyph: 'message',
        hidden: true,
        mount: (container) => { new ShikhoView({ root: container, doc: document, auth }); },
      },
      {
        path: 'scripts',
        labelBn: 'উত্তরপত্র',
        glyph: 'camera',
        hidden: true,
        mount: (container) => { new ScriptsView({ root: container, doc: document, auth }); },
      },
      {
        path: 'assignments',
        labelBn: 'বাড়ির কাজ',
        glyph: 'clipboard',
        hidden: true,
        mount: (container) => {
          new AssignmentsView({ root: container, doc: document, auth, outbox: engine });
        },
      },
      {
        path: 'results',
        labelBn: 'ফলাফল',
        glyph: 'award',
        hidden: true,
        mount: (container) => { new ResultsView({ root: container, doc: document, auth }); },
      },
      {
        path: 'roles',
        labelBn: 'ভূমিকা',
        glyph: 'lock',
        hidden: true,
        mount: (container) => { new RolesView({ root: container, doc: document }); },
      },
      {
        path: 'ledger',
        labelBn: 'লেজার',
        glyph: 'book',
        hidden: true,
        mount: (container) => { new LedgerView({ root: container, doc: document, auth }); },
      },
      {
        path: 'system',
        labelBn: 'সিস্টেম',
        glyph: 'settings',
        hidden: true,
        mount: (container) => { new SystemView({ root: container, doc: document, auth }); },
      },
    ];

    return new Shell({
      root,
      doc: document,
      routes,
      defaultPath: 'home',
      displayName: auth.displayName,
      onLogout: () => { void doLogout(); },
      roleSwitcher: demoMode
        ? {
            current: auth.role,
            onChange: (role) => {
              try { localStorage.setItem('shikhon_demo_role', role); } catch { /* ignore */ }
              // Full reload: routes and the dashboard are both built from
              // the role at construction time, so re-deriving them in place
              // would be a second, divergent code path to keep correct.
              location.reload();
            },
          }
        : undefined,
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
      onLoggedIn: () => {
        // F-1503's activation domain: first-login-per-role is the funnel's
        // first step, and the flush drains anything queued while offline.
        tracker.track('activation.login', { role: auth.role || 'unknown' });
        void tracker.flush();
        shell = startShell();
      },
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
