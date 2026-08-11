/**
 * My subjects — F-802, wireframe §6.2 ⟨offline⟩
 *
 * "The subject-based model made visible. No catalog, no browse, no enrol,
 * no search-for-a-course." The student sees exactly the subjects their
 * class and group assign them (F-304) — including their religion variant
 * and their optional subject, not the class template.
 *
 * Framework-free manual DOM, same as every other view here.
 *
 * All six universal states from wireframe §4 are implemented: loading is a
 * SKELETON of the real layout (never a centred spinner — a spinner tells
 * the user nothing about what is coming), empty carries one primary
 * action, error says what failed in plain language with one retry, and
 * offline is a non-blocking banner over the last cached list rather than a
 * modal that stops work.
 */
import type { Auth } from './auth.ts';
// ui-core owns the numeral policy (counts in Bangla, identifiers always
// Latin). Three views define a local `bn` instead; this one does not add a
// fourth copy of a rule that already has a home and a test suite.
import { formatCount } from '../../../packages/ui-core/src/format.ts';

const bn = (n: number): string => formatCount(n, 'bn');

export interface SubjectRow {
  subjectId: string;
  nameBn: string;
  nctbCode: string | null;
  requirementType: string;
  requirementLabelBn: string;
  totalChapters: number;
  completedChapters: number;
  progressPercent: number;
  nextChapter: { id: string; chapterNo: number | null; nameBn: string | null } | null;
}

export interface SubjectsViewOptions {
  root: HTMLElement;
  doc: Document;
  auth: Auth;
  /** Opens the chapter reader (F-803) for a subject. */
  onOpenSubject?: (subjectId: string) => void;
}

const CACHE_KEY = 'shikhon_my_subjects';

export class SubjectsView {
  private readonly o: SubjectsViewOptions;
  private subjects: SubjectRow[] = [];
  private loading = true;
  private offline = false;
  private error = false;

  constructor(options: SubjectsViewOptions) {
    this.o = options;
    // Cache first, network second. N-01's device floor and the "no blocking
    // fetch, ever" rule mean the list must be on screen before the request
    // even leaves the phone.
    this.subjects = this.readCache();
    this.loading = this.subjects.length === 0;
    this.render();
    void this.load();
  }

  private readCache(): SubjectRow[] {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      const parsed = raw ? (JSON.parse(raw) as SubjectRow[]) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private async load(): Promise<void> {
    try {
      const res = await this.o.auth.authedFetch('/api/v1/academics/subjects');
      if (!res.ok) throw new Error(`http ${res.status}`);
      const body = (await res.json()) as { subjects?: SubjectRow[] };
      this.subjects = body.subjects ?? [];
      this.offline = false;
      this.error = false;
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(this.subjects)); } catch { /* quota */ }
    } catch {
      // A cached list plus an offline banner beats an error screen: the
      // student's subject set changes about twice a year.
      if (this.subjects.length > 0) this.offline = true;
      else this.error = true;
    } finally {
      this.loading = false;
      this.render();
    }
  }

  private render(): void {
    const d = this.o.doc;
    const root = this.o.root;
    root.textContent = '';
    root.setAttribute('lang', 'bn');

    const header = d.createElement('header');
    header.className = 'page-header';
    const h1 = d.createElement('h1');
    h1.textContent = 'আমার বিষয়';
    const sub = d.createElement('p');
    sub.className = 'page-sub';
    sub.textContent = this.loading
      ? 'লোড হচ্ছে…'
      : `${bn(this.subjects.length)}টি বিষয়`;
    header.append(h1, sub);
    root.append(header);

    if (this.offline) {
      root.append(this.banner('অফলাইন — সংরক্ষিত তালিকা দেখানো হচ্ছে', 'inline-notice'));
    }

    if (this.loading) { this.renderSkeleton(root); return; }
    if (this.error)   { this.renderError(root);    return; }
    if (this.subjects.length === 0) { this.renderEmpty(root); return; }

    const ul = d.createElement('ul');
    ul.className = 'subj-list';
    for (const s of this.subjects) ul.append(this.card(s));
    root.append(ul);
  }

  /** Wireframe §4: a skeleton OF THE REAL LAYOUT, never a spinner. */
  private renderSkeleton(root: HTMLElement): void {
    const d = this.o.doc;
    const ul = d.createElement('ul');
    ul.className = 'subj-list';
    ul.setAttribute('aria-busy', 'true');
    ul.setAttribute('aria-label', 'বিষয় লোড হচ্ছে');
    for (let i = 0; i < 4; i++) {
      const li = d.createElement('li');
      li.className = 'card subj-card is-skeleton';
      const a = d.createElement('div'); a.className = 'skel skel-title';
      const b = d.createElement('div'); b.className = 'skel skel-bar';
      const c = d.createElement('div'); c.className = 'skel skel-line';
      li.append(a, b, c);
      ul.append(li);
    }
    root.append(ul);
  }

  private renderEmpty(root: HTMLElement): void {
    const d = this.o.doc;
    const box = d.createElement('div');
    box.className = 'empty-state';
    const glyph = d.createElement('div');
    glyph.className = 'empty-glyph';
    glyph.textContent = '⃝';
    glyph.setAttribute('aria-hidden', 'true');
    const msg = d.createElement('p');
    // One sentence, and it says what to DO — a student seeing this has not
    // had their subject set derived yet (F-304), which is a school action.
    msg.textContent = 'এখনো কোনো বিষয় নির্ধারণ হয়নি। আপনার শ্রেণিশিক্ষকের সাথে কথা বলুন।';
    box.append(glyph, msg);
    root.append(box);
  }

  private renderError(root: HTMLElement): void {
    const d = this.o.doc;
    const box = d.createElement('div');
    box.className = 'empty-state';
    const glyph = d.createElement('div');
    glyph.className = 'empty-glyph';
    // U+2715, which has no emoji form at all. This element held the warning
    // sign, which the no-emoji sweep stripped — leaving the string empty and
    // the error state silently iconless. Not re-fixed with a variation
    // selector: that only asks a font for text presentation and is ignored
    // often enough to reintroduce the bug. A glyph with no emoji form cannot.
    glyph.textContent = '✕';
    glyph.setAttribute('aria-hidden', 'true');
    const msg = d.createElement('p');
    msg.textContent = 'বিষয়ের তালিকা লোড হয়নি।';
    const retry = d.createElement('button');
    retry.type = 'button';
    retry.className = 'btn-secondary';
    retry.textContent = 'আবার চেষ্টা করুন';
    retry.addEventListener('click', () => {
      this.loading = true; this.error = false; this.render(); void this.load();
    });
    box.append(glyph, msg, retry);
    root.append(box);
  }

  private card(s: SubjectRow): HTMLElement {
    const d = this.o.doc;
    const li = d.createElement('li');
    // A real <button> when the card opens something, matching .chapter-card,
    // .assign-card and .next-card. This was a <li role="button"> with its own
    // tabIndex and Enter/Space handling — the documented workaround, but a
    // workaround: it re-implements by hand what the element gives for free,
    // and it made this the one card in the product that was not a button.
    const openable = Boolean(this.o.onOpenSubject);
    const card = d.createElement(openable ? 'button' : 'div');
    if (openable) (card as HTMLButtonElement).type = 'button';
    card.className = 'card subj-card';
    card.dataset.requirement = s.requirementType;

    const head = d.createElement('div');
    head.className = 'subj-head';
    const name = d.createElement('span');
    name.className = 'subj-name';
    name.textContent = s.nameBn;

    // The requirement-type chip: "the surface expression of the subject
    // taxonomy" (§6.2). Carries a LABEL, so the requirement type is never
    // conveyed by colour alone (F-812).
    const chip = d.createElement('span');
    chip.className = 'status-chip subj-chip';
    chip.dataset.requirement = s.requirementType;
    chip.textContent = s.requirementLabelBn;
    head.append(name, chip);
    card.append(head);

    // progress-bar, "with numeric label, never bar-only" (§3 component
    // vocabulary). The number is the point: a bar alone is unreadable at
    // 360px and meaningless to a guardian.
    const track = d.createElement('div');
    track.className = 'progress-track';
    track.setAttribute('role', 'progressbar');
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', String(s.totalChapters));
    track.setAttribute('aria-valuenow', String(s.completedChapters));
    // Bangla numerals in the spoken label too: the visible count already uses
    // them, and a screen reader that says the figures in English mid-Bangla
    // is reading a different sentence than the one on screen.
    track.setAttribute('aria-label',
      `${s.nameBn}: ${bn(s.totalChapters)}টির মধ্যে ${bn(s.completedChapters)}টি অধ্যায় শেষ`);
    const fill = d.createElement('div');
    fill.className = 'progress-fill';
    fill.style.width = `${s.progressPercent}%`;
    track.append(fill);

    const count = d.createElement('span');
    count.className = 'subj-count';
    count.textContent = `${bn(s.completedChapters)}/${bn(s.totalChapters)} অধ্যায়`;

    const row = d.createElement('div');
    row.className = 'subj-progress-row';
    row.append(track, count);
    card.append(row);

    if (s.nextChapter?.nameBn) {
      const next = d.createElement('p');
      next.className = 'subj-next';
      const no = s.nextChapter.chapterNo;
      next.textContent = no
        ? `পরবর্তী: অধ্যায় ${bn(no)} — ${s.nextChapter.nameBn}`
        : `পরবর্তী: ${s.nextChapter.nameBn}`;
      card.append(next);
    } else if (s.totalChapters > 0) {
      const done = d.createElement('p');
      done.className = 'subj-next subj-next-done';
      done.textContent = 'সব অধ্যায় শেষ ✓';
      card.append(done);
    }

    if (openable) {
      // No tabIndex, no role, no hand-rolled Enter/Space: a <button> brings
      // all three. Only the accessible name has to be said out loud.
      card.setAttribute('aria-label', `${s.nameBn} খুলুন`);
      card.addEventListener('click', () => this.o.onOpenSubject?.(s.subjectId));
    }
    li.append(card);
    return li;
  }

  private banner(text: string, cls: string): HTMLElement {
    const p = this.o.doc.createElement('p');
    p.className = cls;
    p.textContent = text;
    return p;
  }
}
