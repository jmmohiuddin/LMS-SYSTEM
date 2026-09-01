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
import {
  el, append, pageHeader, field, button, dataTable,
  listSkeleton, emptyState, errorState, announce, type Column,
} from './ui/index.ts';

export interface SectionSummary {
  id: string;
  name: string;
  shift: string;
  studentCount: number;
  className: { bn: string; en: string };
  levelNo: number;
  /**
   * The year this section belongs to. Carried because the attendance screen
   * needs it and previously had a hardcoded placeholder — see
   * `services/academics-svc/api/sections.ts` for what that cost.
   */
  academicYearId: string;
}

export interface RosterStudent {
  rollNo: number;
  studentId: string;
  fullName: { bn: string | null; en: string | null };
  phone: string | null;
}

const SECTIONS_CACHE_KEY = 'shikhon_sections_cache';
const LAST_SECTION_KEY = 'shikhon_last_section';
/** The chosen section's full descriptor — class label and academic year. */
export const LAST_SECTION_META_KEY = 'shikhon_last_section_meta';
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
      // The whole descriptor, so the attendance screen can name the class and
      // the year instead of guessing at both.
      const picked = this.sections.find((x) => x.id === sectionId);
      if (picked) localStorage.setItem(LAST_SECTION_META_KEY, JSON.stringify(picked));
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

    const picked = this.sections.find((x) => x.id === this.selectedId);
    append(root, pageHeader(d, {
      title: 'শিক্ষার্থী তালিকা',
      subtitle: picked
        ? `${picked.className.bn} — ${picked.name} শাখার ভর্তি হওয়া শিক্ষার্থীরা।`
        : 'সেকশন বেছে নিলে সেই শাখার শিক্ষার্থীদের তালিকা দেখা যাবে।',
      actions: [this.sectionPicker()],
    }));

    // Offline is a statement about the data on screen, not a failure: the
    // cached roster is exactly as usable as a fresh one for taking a register.
    if (this.offline) {
      append(root, el(d, 'p', { className: 'att-offline-note' },
        el(d, 'span', {
          text: 'অফলাইন — সর্বশেষ সংরক্ষিত তালিকা দেখানো হচ্ছে। সংযোগ পেলে নিজেই হালনাগাদ হবে।',
        })));
    }

    // Rendered wherever it is set, not only on an empty screen: an
    // issue-code failure happens WITH a roster on screen, and an error only
    // visible on an empty page is an error nobody sees.
    if (this.errorMsg) {
      append(root, errorState(d, this.errorMsg));
    }

    if (this.issued) append(root, this.issuedCard());

    if (this.loading) { append(root, listSkeleton(d, 6)); return; }

    if (!this.selectedId) {
      append(root, emptyState(d, {
        message: 'উপরে একটি সেকশন বেছে নিন — তারপর সেই শাখার শিক্ষার্থীদের তালিকা দেখা যাবে।',
      }));
      return;
    }

    if (this.roster.length === 0) {
      append(root, emptyState(d, {
        message: picked
          ? `${picked.className.bn} — ${picked.name} শাখায় এখনো কোনো শিক্ষার্থী ভর্তি হয়নি।`
          : 'এই শাখায় এখনো কোনো শিক্ষার্থী ভর্তি হয়নি।',
      }));
      return;
    }

    // One declaration, two renderings: a table on a laptop, a list of cards on
    // a phone. §7 — a six-column table squeezed into 360px is where a teacher
    // reads a student's name two characters at a time.
    const columns: Array<Column<RosterStudent>> = [
      {
        key: 'roll', header: 'রোল', numeric: true, width: '88px', mobile: 'meta',
        cell: (r) => formatCount(r.rollNo, 'bn'),
      },
      {
        key: 'name', header: 'নাম', mobile: 'title',
        cell: (r) => r.fullName.bn || r.fullName.en || '—',
      },
      {
        key: 'phone', header: 'অভিভাবকের ফোন', mobile: 'meta',
        // LTR: a Bangladeshi number inside a Bangla run renders its digits in
        // the wrong order often enough to matter.
        cell: (r) => r.phone
          ? el(d, 'span', { text: r.phone, attrs: { dir: 'ltr' } })
          : el(d, 'span', { className: 'roster-nophone', text: 'নেই' }),
      },
      {
        key: 'code', header: 'সক্রিয়ন কোড', mobile: 'status',
        cell: (r) => button(d, {
          label: this.issuing === r.studentId ? 'তৈরি হচ্ছে…' : 'কোড',
          variant: 'secondary', size: 'sm',
          // Kept as a placement hook: `activation-ui.test.ts` selects it, and
          // F-202's "every issue button waits" property is asserted through
          // it. `className` exists for exactly this — placement, not restyling.
          className: 'roster-issue',
          disabled: this.issuing !== null,
          busy: this.issuing === r.studentId,
          // F-202. The teacher-mediated activation lives where the teacher
          // already is — beside the child's name. WHO may issue for WHOM is
          // the server's RLS policy; this button only asks.
          ariaLabel: `${r.fullName.bn ?? ''} এর জন্য সক্রিয়ন কোড তৈরি করুন`,
          onClick: () => { void this.issueCode(r); },
        }),
      },
    ];

    append(root, dataTable(d, {
      columns,
      rows: this.roster,
      rowKey: (r) => r.studentId,
      caption: picked
        ? `${picked.className.bn} — ${picked.name} শাখার শিক্ষার্থী তালিকা`
        : 'শিক্ষার্থী তালিকা',
    }));
  }

  private sectionPicker(): HTMLElement {
    const f = field(this.o.doc, {
      label: 'সেকশন',
      name: 'section',
      kind: 'select',
      value: this.selectedId ?? '',
      options: [
        { value: '', label: 'সেকশন নির্বাচন করুন' },
        ...this.sections.map((x) => ({
          value: x.id, label: `${x.className.bn} — ${x.name}`,
        })),
      ],
      onChange: (v) => {
        this.selectedId = v || null;
        this.roster = [];
        if (this.selectedId) void this.loadRoster(this.selectedId);
        else this.render();
      },
      className: 'att-section-picker',
    });
    return f.root;
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
    const issued = this.issued as NonNullable<typeof this.issued>;
    const wrap = el(d, 'section', {
      className: 'card issued-code-card', attrs: { role: 'status' },
    });
    append(wrap,
      el(d, 'p', { className: 'issued-code-who', text: `${issued.nameBn} এর সক্রিয়ন কোড` }),
      // Split for reading aloud across a desk; the server strips separators
      // on redeem. `dir=ltr` because the code is Latin and must not reorder.
      el(d, 'p', {
        className: 'issued-code-value', attrs: { dir: 'ltr' },
        text: `${issued.code.slice(0, 4)}-${issued.code.slice(4)}`,
      }),
      el(d, 'p', {
        className: 'issued-code-note',
        text: 'কোডটি লিখে শিক্ষার্থীকে দিন — এটি আর দেখা যাবে না। '
          + 'মেয়াদ ৭২ ঘণ্টা; নতুন কোড তৈরি করলে এটি বাতিল হয়ে যাবে।',
      }),
      button(d, {
        label: 'বুঝেছি', variant: 'primary',
        onClick: () => { this.issued = null; this.render(); },
      }));
    announce(d, `${issued.nameBn} এর সক্রিয়ন কোড তৈরি হয়েছে`);
    return wrap;
  }
}
