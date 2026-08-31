/**
 * The navigation model. (UI integration plan, P1-C)
 *
 * One question, answered once: **for this role, what is in the sidebar, what
 * is on the bottom bar, and what does the breadcrumb say?** Before P1 the
 * answers were scattered — the bottom bar took "the first five registered
 * routes" (identical for every role, which is why a student's phone offered
 * হাজিরা নিন and a section roster), the More menu listed all 31 entries for
 * everyone, and nothing named a page except the view that happened to render
 * its own `<h1>`.
 *
 * Three rules this module is built on, each of which is also a test:
 *
 *   1. **It invents no permissions.** Every path here is already registered
 *      and already reachable by every role through the More menu — the server
 *      decides who may act, and a 403 is the answer for anyone who should not.
 *      A role's sidebar is therefore a statement about RELEVANCE, never about
 *      access, and narrowing it can only reduce what a person is offered, not
 *      what they are allowed.
 *   2. **It removes nothing from reach.** `more` closes every role's sidebar
 *      and holds the bottom bar's fifth slot, and the More menu itself stays
 *      unfiltered. Anything not promoted for a role is one tap away, exactly
 *      as it is today.
 *   3. **Every path is a registered route.** The one bug this route table has
 *      produced twice is a nav entry pointing at a route nobody mounted —
 *      esbuild then tree-shakes the view out of the bundle and the link dies
 *      silently. `nav.test.ts` scans app.ts and fails on a path with no route.
 *
 * The role names are the ten already in the system; anything unrecognised
 * falls to the teaching set, which is what `dashboardFor` does too.
 */

export interface NavItem {
  /** Hash route, without `#/`. Must be a registered route (rule 3). */
  path: string;
  labelBn: string;
  /** Icon name from ../icon.ts. */
  glyph: string;
}

export interface NavGroup {
  /** Section heading in the sidebar. Empty string = ungrouped, rendered flush. */
  labelBn: string;
  items: NavItem[];
}

export interface RoleNav {
  groups: NavGroup[];
  /** Bottom-bar paths, in order. Capped at five by the shell (Wireframe §2). */
  tabs: string[];
}

/* ── the page catalogue ───────────────────────────────────────────────────
   Label and glyph for every path that appears in navigation chrome. This is
   the CHROME's vocabulary — what the sidebar row, the tab and the breadcrumb
   say — and it is deliberately not the dashboard card catalogue in app.ts:
   the same path is framed differently there ("কাজ দাও ও নম্বর দাও" for a
   teacher, "জমা দিতে হবে যেসব" for a student), and collapsing those into one
   string would lose the framing rather than remove a duplication. */
const P = {
  home:        { path: 'home',        labelBn: 'হোম',              glyph: 'home' },
  attendance:  { path: 'attendance',  labelBn: 'হাজিরা',           glyph: 'check-square' },
  routine:     { path: 'routine',     labelBn: 'রুটিন',            glyph: 'clock' },
  roster:      { path: 'roster',      labelBn: 'সেকশন রোস্টার',    glyph: 'users' },
  marks:       { path: 'marks',       labelBn: 'নম্বর এন্ট্রি',     glyph: 'edit' },
  scripts:     { path: 'scripts',     labelBn: 'উত্তরপত্র',        glyph: 'camera' },
  assignments: { path: 'assignments', labelBn: 'বাড়ির কাজ',        glyph: 'clipboard' },
  results:     { path: 'results',     labelBn: 'ফলাফল',            glyph: 'award' },
  learn:       { path: 'learn',       labelBn: 'পড়াশোনা',          glyph: 'book-open' },
  subjects:    { path: 'subjects',    labelBn: 'আমার বিষয়',        glyph: 'layers' },
  myAtt:       { path: 'my-attendance', labelBn: 'আমার হাজিরা',    glyph: 'percent' },
  fees:        { path: 'fees',        labelBn: 'বেতন ও ফি',        glyph: 'wallet' },
  invoices:    { path: 'invoices',    labelBn: 'ইনভয়েস তৈরি',      glyph: 'wallet' },
  ledger:      { path: 'ledger',      labelBn: 'লেজার',            glyph: 'book' },
  inbox:       { path: 'inbox',       labelBn: 'নোটিশ',            glyph: 'bell' },
  compose:     { path: 'compose',     labelBn: 'নোটিশ পাঠান',      glyph: 'edit' },
  calendar:    { path: 'calendar',    labelBn: 'শিক্ষাপঞ্জি',       glyph: 'calendar' },
  documents:   { path: 'documents',   labelBn: 'নথি ও ছাপা',       glyph: 'book' },
  students:    { path: 'students',    labelBn: 'শিক্ষার্থী',        glyph: 'search' },
  institution: { path: 'institution', labelBn: 'প্রতিষ্ঠান',        glyph: 'trending-up' },
  academic:    { path: 'academic',    labelBn: 'একাডেমিক কাঠামো',  glyph: 'layers' },
  publish:     { path: 'publish',     labelBn: 'ফলাফল প্রকাশ',      glyph: 'award' },
  users:       { path: 'users',       labelBn: 'ব্যবহারকারী',       glyph: 'users' },
  rollover:    { path: 'rollover',    labelBn: 'বার্ষিক উন্নয়ন',    glyph: 'repeat' },
  imports:     { path: 'import',      labelBn: 'শিক্ষার্থী আমদানি', glyph: 'upload' },
  branding:    { path: 'branding',    labelBn: 'প্রতিষ্ঠানের পরিচয়', glyph: 'star' },
  settings:    { path: 'adminsettings', labelBn: 'সেটিংস',         glyph: 'settings' },
  audit:       { path: 'audit',       labelBn: 'কার্যবিবরণী',       glyph: 'lock' },
  system:      { path: 'system',      labelBn: 'সিস্টেম',           glyph: 'settings' },
  guardian:    { path: 'guardian',    labelBn: 'আমার সন্তান',       glyph: 'users' },
  substitute:  { path: 'substitute',  labelBn: 'বদলি শিক্ষক',       glyph: 'repeat' },
  more:        { path: 'more',        labelBn: 'আরও',              glyph: 'more-horizontal' },
} satisfies Record<string, NavItem>;

/** Group headings. Named once so the breadcrumb and the sidebar agree. */
const G = {
  daily:   'দৈনন্দিন',
  teach:   'পাঠ ও মূল্যায়ন',
  study:   'পড়াশোনা',
  progress: 'অগ্রগতি',
  child:   'সন্তান',
  people:  'শিক্ষার্থী ও শিক্ষক',
  money:   'আর্থিক',
  comms:   'যোগাযোগ',
  org:     'প্রতিষ্ঠান',
  admin:   'ব্যবস্থাপনা',
} as const;

/**
 * The tail every sidebar ends with.
 *
 * `more` is not decoration: it is rule 2 made structural. Whatever a role's
 * sidebar does not promote is still one click away in the unfiltered More
 * menu, which is why narrowing the sidebar cannot strand a screen.
 */
const TAIL: NavGroup = { labelBn: '', items: [P.more] };

const TEACHER: RoleNav = {
  groups: [
    { labelBn: G.daily, items: [P.home, P.attendance, P.routine, P.roster, P.students] },
    { labelBn: G.teach, items: [P.assignments, P.marks, P.scripts, P.results] },
    { labelBn: G.comms, items: [P.inbox, P.calendar, P.documents] },
    TAIL,
  ],
  // Attendance leads the bar, not the dashboard: §26 — a teacher's highest
  // frequency action must not be reached through a menu.
  tabs: ['home', 'attendance', 'roster', 'routine', 'more'],
};

const STUDENT: RoleNav = {
  groups: [
    { labelBn: G.study, items: [P.home, P.subjects, P.learn, P.assignments] },
    { labelBn: G.progress, items: [P.results, P.myAtt] },
    { labelBn: G.comms, items: [P.inbox, P.calendar, P.fees, P.documents] },
    TAIL,
  ],
  // The wireframe's student bar. `attendance` and `roster` are teacher
  // screens and were on it for every role before P1 — the bar was built from
  // route order, which has no idea who is holding the phone.
  tabs: ['home', 'learn', 'assignments', 'results', 'more'],
};

const GUARDIAN: RoleNav = {
  groups: [
    { labelBn: G.child, items: [P.home, P.guardian] },
    { labelBn: G.progress, items: [P.results, P.fees] },
    { labelBn: G.comms, items: [P.inbox, P.calendar, P.documents] },
    TAIL,
  ],
  // §25: the child panel is the guardian's whole reason for opening the app,
  // so it sits on the bar rather than behind হোম.
  tabs: ['home', 'guardian', 'results', 'fees', 'more'],
};

const ACCOUNTANT: RoleNav = {
  groups: [
    { labelBn: G.money, items: [P.home, P.fees, P.invoices, P.ledger] },
    { labelBn: G.people, items: [P.students, P.documents] },
    { labelBn: G.comms, items: [P.inbox, P.calendar] },
    TAIL,
  ],
  tabs: ['home', 'fees', 'invoices', 'ledger', 'more'],
};

const PRINCIPAL: RoleNav = {
  groups: [
    { labelBn: G.org, items: [P.home, P.institution, P.academic, P.calendar] },
    { labelBn: G.people, items: [P.students, P.users, P.attendance] },
    { labelBn: G.teach, items: [P.publish, P.results, P.documents] },
    { labelBn: G.money, items: [P.fees, P.invoices, P.ledger] },
    { labelBn: G.comms, items: [P.inbox, P.compose] },
    { labelBn: G.admin, items: [P.branding, P.settings, P.rollover, P.audit] },
    TAIL,
  ],
  tabs: ['home', 'institution', 'academic', 'students', 'more'],
};

const IT_ADMIN: RoleNav = {
  groups: [
    // §28: structure and accounts, not teaching. An IT admin has no class, so
    // there is no attendance row here to invite a 403.
    { labelBn: G.org, items: [P.home, P.academic, P.rollover] },
    { labelBn: G.people, items: [P.users, P.students, P.imports] },
    { labelBn: G.admin, items: [P.branding, P.settings, P.system, P.audit] },
    TAIL,
  ],
  tabs: ['home', 'academic', 'users', 'students', 'more'],
};

const COORDINATOR: RoleNav = {
  groups: [
    { labelBn: G.org, items: [P.home, P.academic, P.routine, P.calendar] },
    { labelBn: G.people, items: [P.students, P.attendance, P.substitute] },
    { labelBn: G.teach, items: [P.publish, P.results, P.documents] },
    { labelBn: G.comms, items: [P.inbox, P.compose] },
    TAIL,
  ],
  tabs: ['home', 'academic', 'routine', 'students', 'more'],
};

/**
 * The sidebar and bottom bar for a role.
 *
 * Unknown roles fall to the teaching set — the same default `dashboardFor`
 * takes, and the safe one: a teacher's navigation offers nothing a school
 * would not want an unrecognised staff account to see, and every row is
 * still gated by the server.
 */
export function navFor(role: string): RoleNav {
  switch (role) {
    case 'student':              return STUDENT;
    case 'guardian':             return GUARDIAN;
    case 'accountant':           return ACCOUNTANT;
    case 'principal':
    case 'school_owner':         return PRINCIPAL;
    case 'it_admin':             return IT_ADMIN;
    case 'academic_coordinator': return COORDINATOR;
    default:                     return TEACHER;
  }
}

/** Every path this role's sidebar promotes, flattened. */
export function navPaths(role: string): string[] {
  return navFor(role).groups.flatMap((g) => g.items.map((i) => i.path));
}

/**
 * The breadcrumb for a path, under a role: `[section, page]`.
 *
 * Two crumbs, never more. The app's hierarchy is one level deep — a route is
 * in a section or it is not — and a breadcrumb that invents depth to look
 * like a breadcrumb is worse than none. Returns just the page name when the
 * role's sidebar does not carry the path (reached from More or a deep link),
 * because claiming a section it is not filed under would be a lie about
 * where the person is.
 */
export function crumbFor(role: string, path: string): string[] {
  for (const group of navFor(role).groups) {
    const hit = group.items.find((i) => i.path === path);
    if (hit) return group.labelBn ? [group.labelBn, hit.labelBn] : [hit.labelBn];
  }
  const known = Object.values(P).find((i) => i.path === path);
  return known ? [known.labelBn] : [];
}

/** Label for a path from the chrome catalogue, or null if it has none. */
export function navLabel(path: string): string | null {
  return Object.values(P).find((i) => i.path === path)?.labelBn ?? null;
}

/** Every role the navigation model answers for, for tests and the demo picker. */
export const NAV_ROLES = [
  'class_teacher', 'subject_teacher', 'dept_head', 'student', 'guardian',
  'accountant', 'principal', 'school_owner', 'it_admin', 'academic_coordinator',
] as const;
