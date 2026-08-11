/**
 * Section picker + student roster.
 *
 * GET /api/v1/academics/sections feeds the picker; GET
 * /api/v1/academics/roster?sectionId=... feeds the list once a section is
 * chosen. Both responses are cached in localStorage (small, synchronous,
 * good enough for read-mostly reference data — unlike attendance writes,
 * which go through the outbox/IndexedDB for durability) so the screen still
 * shows the last-known roster offline, with a banner explaining that.
 *
 * Picking a section also writes shikhon_last_section / shikhon_last_roster
 * — app.ts reads these to seed the attendance screen with the real roster
 * instead of the placeholder students.
 */
import type { Auth } from './auth.ts';
import { formatCount } from '../../../packages/ui-core/src/format.ts';

export interface SectionSummary {
  id: string;
  name: string;
  shift: string;
  studentCount: number;
  className: { bn: string; en: string };
  levelNo: number;
}

export interface RosterStudent {
  rollNo: number;
  studentId: string;
  fullName: { bn: string | null; en: string | null };
  phone: string | null;
}

const SECTIONS_CACHE_KEY = 'shikhon_sections_cache';
const LAST_SECTION_KEY = 'shikhon_last_section';
const LAST_ROSTER_KEY = 'shikhon_last_roster';

function rosterCacheKey(sectionId: string): string {
  return `shikhon_roster_cache_${sectionId}`;
}

export interface RosterViewOptions {
  root: HTMLElement;
  doc: Document;
  auth: Auth;
}

export class RosterView {
  private readonly o: RosterViewOptions;
  private sections: SectionSummary[] = [];
  /** F-202: the code just issued, shown once, and for whom. */
  private issued: { studentId: string; nameBn: string; code: string } | null = null;
  private issuing: string | null = null;
  private selectedId: string | null = null;
  private roster: RosterStudent[] = [];
  private offline = false;
  private loading = false;
  private errorMsg = '';

  constructor(options: RosterViewOptions) {
    this.o = options;
    void this.init();
  }

  private async init(): Promise<void> {
    const cached = this.readCache<SectionSummary[]>(SECTIONS_CACHE_KEY);
    if (cached) this.sections = cached;

    const lastSectionId = localStorage.getItem(LAST_SECTION_KEY);
    if (lastSectionId) {
      this.selectedId = lastSectionId;
      const cachedRoster = this.readCache<RosterStudent[]>(rosterCacheKey(lastSectionId));
      if (cachedRoster) this.roster = cachedRoster;
    }

    this.render();
    await this.loadSections();
    if (this.selectedId) await this.loadRoster(this.selectedId);
  }

  private readCache<T>(key: string): T | null {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      return null;
    }
  }

  private writeCache(key: string, value: unknown): void {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // storage full/unavailable — cache is a nicety, not load-bearing
    }
  }

  private async loadSections(): Promise<void> {
    try {
      const res = await this.o.auth.authedFetch('/api/v1/academics/sections');
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { sections: SectionSummary[] };
      this.sections = body.sections;
      this.offline = false;
      this.writeCache(SECTIONS_CACHE_KEY, this.sections);
    } catch {
      this.offline = this.sections.length > 0;
      if (this.sections.length === 0) this.errorMsg = 'সেকশনের তালিকা আনা যায়নি।';
    }
    this.render();
  }

  private async loadRoster(sectionId: string): Promise<void> {
    this.loading = true;
    this.render();
    try {
      const res = await this.o.auth.authedFetch(
        `/api/v1/academics/roster?sectionId=${encodeURIComponent(sectionId)}`,
      );
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { roster: RosterStudent[] };
      this.roster = body.roster;
      this.offline = false;
      this.writeCache(rosterCacheKey(sectionId), this.roster);
      localStorage.setItem(LAST_SECTION_KEY, sectionId);
      localStorage.setItem(LAST_ROSTER_KEY, JSON.stringify(this.roster));
    } catch {
      this.offline = this.roster.length > 0;
      if (this.roster.length === 0) this.errorMsg = 'শিক্ষার্থী তালিকা আনা যায়নি।';
    }
    this.loading = false;
    this.render();
  }

  private render(): void {
    const d = this.o.doc;
    const root = this.o.root;
    root.textContent = '';

    const header = d.createElement('header');
    header.className = 'att-header';
    const h1 = d.createElement('h1');
    h1.textContent = 'শিক্ষার্থী তালিকা';
    header.append(h1);

    if (this.offline) {
      const banner = d.createElement('p');
      banner.className = 'offline-banner';
      banner.textContent = 'অফলাইন — সর্বশেষ সংরক্ষিত তথ্য দেখানো হচ্ছে';
      header.append(banner);
    }
    // Rendered whenever set — an issue-code failure has a section list on
    // screen, and an error only visible on an empty screen is an error
    // nobody sees.
    if (this.errorMsg) {
      const err = d.createElement('p');
      err.className = 'login-error';
      err.setAttribute('role', 'alert');
      err.textContent = this.errorMsg;
      header.append(err);
    }

    const picker = d.createElement('select');
    picker.className = 'section-picker';
    picker.setAttribute('aria-label', 'সেকশন নির্বাচন করুন');
    const placeholder = d.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'সেকশন নির্বাচন করুন';
    placeholder.disabled = true;
    placeholder.selected = !this.selectedId;
    picker.append(placeholder);
    for (const s of this.sections) {
      const opt = d.createElement('option');
      opt.value = s.id;
      opt.textContent = `${s.className.bn} — ${s.name}`;
      opt.selected = s.id === this.selectedId;
      picker.append(opt);
    }
    picker.addEventListener('change', () => {
      this.selectedId = picker.value || null;
      this.roster = [];
      if (this.selectedId) void this.loadRoster(this.selectedId);
      else this.render();
    });

    root.append(header, picker);

    if (this.loading) {
      const p = d.createElement('p');
      p.className = 'att-sub';
      p.textContent = 'লোড হচ্ছে…';
      root.append(p);
      return;
    }

    if (!this.selectedId) return;

    if (this.roster.length === 0) {
      const p = d.createElement('p');
      p.className = 'att-sub';
      p.textContent = 'কোনো শিক্ষার্থী পাওয়া যায়নি।';
      root.append(p);
      return;
    }

    if (this.issued) root.append(this.issuedCard());

    const list = d.createElement('ul');
    list.className = 'roster-list';
    for (const s of this.roster) {
      const li = d.createElement('li');
      li.className = 'roster-row';
      const roll = d.createElement('span');
      roll.className = 'roster-roll';
      roll.textContent = formatCount(s.rollNo, 'bn');
      const name = d.createElement('span');
      name.className = 'roster-name';
      name.textContent = s.fullName.bn || s.fullName.en || '—';
      li.append(roll, name);

      // F-202. The teacher-mediated activation lives where the teacher
      // already is: next to the child's name on the roster. WHO may issue
      // for WHOM is the server's RLS policy — this button merely asks.
      const issueBtn = d.createElement('button');
      issueBtn.type = 'button';
      issueBtn.className = 'btn-secondary btn-small roster-issue';
      issueBtn.textContent = this.issuing === s.studentId ? '…' : 'কোড';
      issueBtn.disabled = this.issuing !== null;
      issueBtn.setAttribute('aria-label',
        `${s.fullName.bn ?? ''} এর জন্য সক্রিয়ন কোড তৈরি করুন`);
      issueBtn.addEventListener('click', () => { void this.issueCode(s); });
      li.append(issueBtn);
      list.append(li);
    }
    root.append(list);
  }

  private async issueCode(s: RosterStudent): Promise<void> {
    if (this.issuing) return;
    this.issuing = s.studentId;
    this.errorMsg = '';
    this.render();
    try {
      const res = await this.o.auth.authedFetch('/api/v1/auth/activate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'issue', userId: s.studentId }),
      });
      const body = (await res.json()) as { code?: string; error?: string; message?: string };
      if (!res.ok || !body.code) {
        this.errorMsg = body.error === 'not_your_student'
          ? 'শুধু নিজের শাখার শিক্ষার্থীর জন্য কোড তৈরি করা যায়।'
          : body.error === 'activation_unconfigured'
            ? 'এই সুবিধাটি এখনো চালু হয়নি।'
            : 'কোড তৈরি করা যায়নি। আবার চেষ্টা করুন।';
      } else {
        this.issued = {
          studentId: s.studentId,
          nameBn: s.fullName.bn || s.fullName.en || '—',
          code: body.code,
        };
      }
    } catch {
      this.errorMsg = 'সংযোগ পাওয়া যায়নি।';
    } finally {
      this.issuing = null;
      this.render();
    }
  }

  /**
   * The one and only place the code is ever visible. Large enough to be
   * read across a desk, dismissed deliberately, and honest about the two
   * facts that matter: it dies in ৭২ hours, and issuing again kills it.
   */
  private issuedCard(): HTMLElement {
    const d = this.o.doc;
    const card = d.createElement('section');
    card.className = 'card issued-code-card';
    card.setAttribute('role', 'status');
    const issued = this.issued as NonNullable<typeof this.issued>;

    const who = d.createElement('p');
    who.className = 'issued-code-who';
    who.textContent = `${issued.nameBn} এর সক্রিয়ন কোড`;

    const code = d.createElement('p');
    code.className = 'issued-code-value';
    // Split for reading aloud; the server strips separators on redeem.
    code.textContent = `${issued.code.slice(0, 4)}-${issued.code.slice(4)}`;

    const note = d.createElement('p');
    note.className = 'issued-code-note';
    note.textContent = 'কোডটি লিখে শিক্ষার্থীকে দিন — এটি আর দেখা যাবে না। '
      + 'মেয়াদ ৭২ ঘণ্টা; নতুন কোড তৈরি করলে এটি বাতিল হয়ে যাবে।';

    const done = d.createElement('button');
    done.type = 'button';
    done.className = 'btn-primary';
    done.textContent = 'বুঝেছি';
    done.addEventListener('click', () => { this.issued = null; this.render(); });

    card.append(who, code, note, done);
    return card;
  }
}
