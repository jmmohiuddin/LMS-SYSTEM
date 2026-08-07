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
    if (this.errorMsg && this.sections.length === 0) {
      const err = d.createElement('p');
      err.className = 'login-error';
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
      list.append(li);
    }
    root.append(list);
  }
}
