/**
 * Learn (পড়াশোনা) — the syllabus browse + topic reader.
 *
 * The first genuinely student-facing screen in the product. Two modes in
 * one view because they share cached data and the transition between them
 * should never hit the network twice:
 *
 *   list   — chapters for the student's class, each with a progress ring
 *   reader — one topic's blocks, with progress written to the outbox
 *
 * Offline behaviour matches attendance: chapter lists and opened topics
 * are cached in localStorage, and reading progress is enqueued as a
 * `topic_progress` op rather than PUT directly — a student on a bus with
 * no signal still records what they read.
 */
import type { Auth } from './auth.ts';
import { formatCount } from '../../../packages/ui-core/src/format.ts';
import { PracticeView, type PracticeQuestion } from './practice-view.ts';
import { pageHeader } from './ui/page-header.ts';
import { refuseUnlessOk, isDenied } from './http-status.ts';
import { permissionState, permissionMessage } from './ui/index.ts';

export interface Chapter {
  id: string;
  chapterNo: number;
  name: { bn: string; en: string | null };
  summaryBn: string | null;
  estMinutes: number;
  isPublished: boolean;
  subject: { id: string; bn: string; en: string };
  prerequisite: { id: string; nameBn: string } | null;
  topicCount: number;
  completedCount: number;
}

interface Topic {
  id: string;
  topicNo: number;
  title: { bn: string; en: string | null };
  estMinutes: number;
  isPublished: boolean;
  progress: { state: string; secondsSpent: number } | null;
}

interface Block {
  id: string;
  blockNo: number;
  kind: string;
  bodyBn: string | null;
  mediaKey: string | null;
  altTextBn: string | null;
  captionBn: string | null;
}

/** Only what this view needs from the sync engine. */
export interface LearnOutbox {
  enqueue(input: { entity: 'topic_progress' | 'practice_attempt'; payload: unknown }): Promise<{ opId: string }>;
  flush(): Promise<unknown>;
}

export interface LearnViewOptions {
  root: HTMLElement;
  doc: Document;
  auth: Auth;
  outbox: LearnOutbox;
  /** The student's class; in demo mode this is a sample id. */
  classId?: string;
}

const CHAPTERS_CACHE = 'shikhon_chapters_cache';
const TOPIC_CACHE_PREFIX = 'shikhon_topic_cache_';

type Mode = { kind: 'list' } | { kind: 'topics'; chapter: Chapter } | { kind: 'reader'; chapter: Chapter; topicId: string };

export class LearnView {
  private readonly o: LearnViewOptions;
  private mode: Mode = { kind: 'list' };
  private chapters: Chapter[] = [];
  private topics: Topic[] = [];
  private blocks: Block[] = [];
  private topicTitle = '';
  private offline = false;
  /**
   * The server refused this read (403). Distinct from `offline`, and the
   * distinction is the point: an outage is temporary and a refusal is not,
   * so this state offers no retry and shows no cached data (B-30).
   */
  private denied = false;
  private loading = true;
  private readingSince = 0;
  private lastBlockSeen = 0;
  private questions: PracticeQuestion[] = [];
  private practising = false;
  private textSize = LearnView.loadTextSize();

  constructor(options: LearnViewOptions) {
    this.o = options;
    void this.loadChapters();
  }

  /* ---------------------------------------------------------- reader text size
     §6.3: "Text-size control is persistent and remembered." A student reads
     this screen for the better part of an hour; the size that suits their
     eyes and their phone must survive being closed, not reset every open.
     Every level clears the 16px Bangla-legibility floor. */
  private static readonly TEXT_SIZES = [16, 18, 21, 25];
  private static readonly TEXT_SIZE_KEY = 'shikhon_reader_textsize';

  private static loadTextSize(): number {
    try {
      // Null-check before Number(): Number(null) is 0, a valid index, which
      // would silently make "never chosen" mean "smallest" instead of default.
      const raw = localStorage.getItem(LearnView.TEXT_SIZE_KEY);
      if (raw !== null) {
        const n = Number(raw);
        if (Number.isInteger(n) && n >= 0 && n < LearnView.TEXT_SIZES.length) return n;
      }
    } catch { /* private mode */ }
    return 1; // 18px default — a hair above the old fixed 17
  }

  private saveTextSize(): void {
    try { localStorage.setItem(LearnView.TEXT_SIZE_KEY, String(this.textSize)); } catch { /* ignore */ }
  }

  /* ------------------------------------------------------------- caching */

  private cacheGet<T>(key: string): T | null {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch { return null; }
  }

  private cacheSet(key: string, value: unknown): void {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* best effort */ }
  }

  /* --------------------------------------------------------------- loads */

  private async loadChapters(): Promise<void> {
    const cached = this.cacheGet<Chapter[]>(CHAPTERS_CACHE);
    if (cached) { this.chapters = cached; this.loading = false; }
    this.render();

    const classId = this.o.classId ?? localStorage.getItem('shikhon_last_class') ?? '';
    try {
      const res = await this.o.auth.authedFetch(
        `/api/v1/academics/chapters?classId=${encodeURIComponent(classId)}`,
      );
      refuseUnlessOk(res);
      const body = (await res.json()) as { chapters: Chapter[] };
      this.chapters = body.chapters;
      this.offline = false;
      this.cacheSet(CHAPTERS_CACHE, this.chapters);
    } catch (err) {
      if (isDenied(err)) {
        this.denied = true; this.chapters = []; this.offline = false;
        try { localStorage.removeItem(CHAPTERS_CACHE); } catch { /* private mode */ }
        // These two have no `finally { render() }`, so a bare return
        // computed the denied state and never painted it.
        this.loading = false; this.render(); return;
      }
      this.offline = this.chapters.length > 0;
    }
    this.loading = false;
    this.render();
  }

  private async openChapter(chapter: Chapter): Promise<void> {
    this.mode = { kind: 'topics', chapter };
    this.loading = true;
    this.render();
    try {
      const res = await this.o.auth.authedFetch(
        `/api/v1/academics/topics?chapterId=${encodeURIComponent(chapter.id)}`,
      );
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { topics: Topic[] };
      this.topics = body.topics;
      this.offline = false;
    } catch {
      this.topics = [];
      this.offline = true;
    }
    this.loading = false;
    this.render();
  }

  private async openTopic(chapter: Chapter, topicId: string): Promise<void> {
    this.mode = { kind: 'reader', chapter, topicId };
    this.loading = true;
    this.readingSince = Date.now();
    this.lastBlockSeen = 0;
    this.practising = false;
    this.questions = [];

    const cached = this.cacheGet<{ title: string; blocks: Block[] }>(TOPIC_CACHE_PREFIX + topicId);
    if (cached) { this.topicTitle = cached.title; this.blocks = cached.blocks; this.loading = false; }
    this.render();

    try {
      const res = await this.o.auth.authedFetch(
        `/api/v1/academics/topics?topicId=${encodeURIComponent(topicId)}`,
      );
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as {
        topic: { title: { bn: string } }; blocks: Block[];
      };
      this.topicTitle = body.topic.title.bn;
      this.blocks = body.blocks;
      this.offline = false;
      this.cacheSet(TOPIC_CACHE_PREFIX + topicId, { title: this.topicTitle, blocks: this.blocks });
    } catch {
      this.offline = this.blocks.length > 0;
    }
    this.loading = false;
    this.render();

    // Record that reading started, immediately — a student who closes the
    // app mid-topic should still show as having begun it.
    void this.recordProgress(topicId, 'started');
    void this.loadPractice(topicId);
  }

  private async loadPractice(topicId: string): Promise<void> {
    const cacheKey = `shikhon_practice_${topicId}`;
    const cached = this.cacheGet<PracticeQuestion[]>(cacheKey);
    if (cached) this.questions = cached;
    try {
      const res = await this.o.auth.authedFetch(
        `/api/v1/academics/practice?topicId=${encodeURIComponent(topicId)}`,
      );
      if (res.ok) {
        const body = (await res.json()) as { questions?: PracticeQuestion[] };
        this.questions = body.questions ?? [];
        // Cached whole so practice works on a later offline visit.
        this.cacheSet(cacheKey, this.questions);
      }
    } catch {
      // Offline: whatever was cached is what we have.
    }
    if (this.mode.kind === 'reader') this.render();
  }

  /* ------------------------------------------------------------ progress */

  private async recordProgress(topicId: string, state: 'started' | 'completed'): Promise<void> {
    const seconds = this.readingSince ? Math.round((Date.now() - this.readingSince) / 1000) : 0;
    try {
      await this.o.outbox.enqueue({
        entity: 'topic_progress',
        payload: {
          topicId,
          state,
          secondsSpent: seconds,
          lastBlockNo: this.lastBlockSeen || null,
        },
      });
      this.readingSince = Date.now();   // reset so seconds aren't double-counted
      void Promise.resolve(this.o.outbox.flush()).catch(() => {});
    } catch {
      // Offline enqueue failure is not a user-facing error.
    }
  }

  /* -------------------------------------------------------------- render */

  private render(): void {
    const d = this.o.doc;
    const root = this.o.root;
    root.textContent = '';

    if (this.mode.kind === 'reader') { this.renderReader(); return; }
    if (this.mode.kind === 'topics') { this.renderTopics(); return; }

    // ---------------------------------------------------------- chapter list
    const header = pageHeader(d, {
      title: 'পড়াশোনা',
      subtitle: 'তোমার শ্রেণির অধ্যায় ও পাঠ',
    });
    root.append(header);

    // B-30. A refusal outranks the offline banner, the skeleton and the
    // empty state: nothing is loading, there is nothing to show, and
    // calling it "offline" is the lie this item exists to remove.
    if (this.denied) {
      root.append(permissionState(d, {
        message: permissionMessage('পড়াশোনার বিষয়বস্তু'),
        contact: 'প্রধান শিক্ষক',
      }));
      return;
    }

    if (this.offline) root.append(this.offlineBanner());

    if (this.loading && this.chapters.length === 0) {
      root.append(this.msg('লোড হচ্ছে…'));
      return;
    }
    if (this.chapters.length === 0) {
      root.append(this.msg('এখনো কোনো অধ্যায় যুক্ত হয়নি।'));
      return;
    }

    // Group by subject so the syllabus reads the way a textbook shelf does.
    const bySubject = new Map<string, Chapter[]>();
    for (const c of this.chapters) {
      const list = bySubject.get(c.subject.bn) ?? [];
      list.push(c);
      bySubject.set(c.subject.bn, list);
    }

    for (const [subjectBn, list] of bySubject) {
      const h2 = d.createElement('h2');
      h2.className = 'section-heading';
      h2.textContent = subjectBn;
      root.append(h2);

      const ul = d.createElement('ul');
      ul.className = 'chapter-list';
      for (const c of list) {
        const li = d.createElement('li');
        const btn = d.createElement('button');
        btn.type = 'button';
        btn.className = 'card chapter-card';
        btn.setAttribute('aria-label', `${c.name.bn}, ${c.completedCount} of ${c.topicCount} topics done`);

        const ring = d.createElement('span');
        ring.className = 'chapter-ring';
        const pct = c.topicCount > 0 ? Math.round((c.completedCount / c.topicCount) * 100) : 0;
        ring.style.setProperty('--pct', String(pct));
        ring.dataset.complete = pct === 100 ? 'true' : 'false';
        const ringText = d.createElement('span');
        ringText.className = 'chapter-ring-text';
        ringText.textContent = pct === 100 ? '✓' : formatCount(pct, 'bn');
        ring.append(ringText);

        const body = d.createElement('span');
        body.className = 'chapter-body';
        const title = d.createElement('span');
        title.className = 'chapter-title';
        title.textContent = c.name.bn;
        const meta = d.createElement('span');
        meta.className = 'chapter-meta';
        meta.textContent =
          `${formatCount(c.completedCount, 'bn')}/${formatCount(c.topicCount, 'bn')} পাঠ · ` +
          `${formatCount(c.estMinutes, 'bn')} মিনিট`;
        body.append(title, meta);

        if (c.prerequisite) {
          const pre = d.createElement('span');
          pre.className = 'chapter-pre';
          pre.textContent = `আগে পড়ো: ${c.prerequisite.nameBn}`;
          body.append(pre);
        }
        if (!c.isPublished) {
          const draft = d.createElement('span');
          draft.className = 'chapter-draft';
          draft.textContent = 'খসড়া';
          body.append(draft);
        }

        btn.append(ring, body);
        btn.addEventListener('click', () => { void this.openChapter(c); });
        li.append(btn);
        ul.append(li);
      }
      root.append(ul);
    }
  }

  private renderTopics(): void {
    if (this.mode.kind !== 'topics') return;
    const d = this.o.doc;
    const root = this.o.root;
    const chapter = this.mode.chapter;

    root.append(this.backBar('সব অধ্যায়', () => { this.mode = { kind: 'list' }; this.render(); }));

    const header = d.createElement('header');
    header.className = 'page-header';
    const h1 = d.createElement('h1');
    h1.textContent = chapter.name.bn;
    header.append(h1);
    if (chapter.summaryBn) {
      const sub = d.createElement('p');
      sub.className = 'page-sub';
      sub.textContent = chapter.summaryBn;
      header.append(sub);
    }
    root.append(header);

    if (this.offline) root.append(this.offlineBanner());
    if (this.loading) { root.append(this.msg('লোড হচ্ছে…')); return; }
    if (this.topics.length === 0) { root.append(this.msg('এই অধ্যায়ে এখনো পাঠ যুক্ত হয়নি।')); return; }

    const ul = d.createElement('ul');
    ul.className = 'topic-list';
    for (const l of this.topics) {
      const li = d.createElement('li');
      const btn = d.createElement('button');
      btn.type = 'button';
      btn.className = 'card topic-card';
      btn.dataset.state = l.progress?.state ?? 'new';

      const mark = d.createElement('span');
      mark.className = 'topic-mark';
      mark.setAttribute('aria-hidden', 'true');
      mark.textContent = l.progress?.state === 'completed' ? '✓'
        : l.progress?.state === 'started' ? '◐' : '○';

      const body = d.createElement('span');
      body.className = 'topic-body';
      const title = d.createElement('span');
      title.className = 'topic-title';
      title.textContent = l.title.bn;
      const meta = d.createElement('span');
      meta.className = 'topic-meta';
      meta.textContent = l.progress?.state === 'completed'
        ? `সম্পন্ন · ${formatCount(l.estMinutes, 'bn')} মিনিট`
        : `${formatCount(l.estMinutes, 'bn')} মিনিট`;
      body.append(title, meta);

      btn.append(mark, body);
      btn.addEventListener('click', () => { void this.openTopic(chapter, l.id); });
      li.append(btn);
      ul.append(li);
    }
    root.append(ul);
  }

  private renderReader(): void {
    if (this.mode.kind !== 'reader') return;
    const d = this.o.doc;
    const root = this.o.root;
    const { chapter, topicId } = this.mode;

    root.append(this.backBar(chapter.name.bn, () => {
      void this.recordProgress(topicId, 'started');
      void this.openChapter(chapter);
    }));

    const header = d.createElement('header');
    header.className = 'page-header';
    const h1 = d.createElement('h1');
    h1.textContent = this.topicTitle || 'পাঠ';
    header.append(h1);
    root.append(header);

    if (this.offline) root.append(this.offlineBanner());
    if (this.loading && this.blocks.length === 0) { root.append(this.msg('লোড হচ্ছে…')); return; }

    // Was 'topic-reader', but the stylesheet only ever styled '.lesson-reader'
    // — so the reading measure (68ch, 1.85 leading, the reader type size) had
    // never applied and the article fell back to full-width body defaults.
    const article = d.createElement('article');
    article.className = 'lesson-reader';
    article.setAttribute('lang', 'bn');
    article.style.fontSize = `${LearnView.TEXT_SIZES[this.textSize]}px`;

    // Text-size control (§6.3), above the reading so it is found before it is
    // needed. Restyles the article in place — no re-render, no lost scroll.
    const tools = d.createElement('div');
    tools.className = 'reader-tools';
    const tlabel = d.createElement('span');
    tlabel.className = 'reader-tools-label';
    tlabel.textContent = 'লেখার আকার';
    const smaller = d.createElement('button');
    smaller.type = 'button'; smaller.className = 'reader-size';
    smaller.textContent = 'অ'; smaller.setAttribute('aria-label', 'লেখা ছোট করো');
    const bigger = d.createElement('button');
    bigger.type = 'button'; bigger.className = 'reader-size reader-size-lg';
    bigger.textContent = 'অ'; bigger.setAttribute('aria-label', 'লেখা বড় করো');
    const applySize = () => {
      article.style.fontSize = `${LearnView.TEXT_SIZES[this.textSize]}px`;
      smaller.disabled = this.textSize === 0;
      bigger.disabled = this.textSize === LearnView.TEXT_SIZES.length - 1;
    };
    smaller.addEventListener('click', () => {
      if (this.textSize > 0) { this.textSize--; this.saveTextSize(); applySize(); }
    });
    bigger.addEventListener('click', () => {
      if (this.textSize < LearnView.TEXT_SIZES.length - 1) { this.textSize++; this.saveTextSize(); applySize(); }
    });
    tools.append(tlabel, smaller, bigger);
    applySize();
    root.append(tools);

    for (const b of this.blocks) {
      this.lastBlockSeen = Math.max(this.lastBlockSeen, b.blockNo);
      article.append(this.renderBlock(b));
    }
    root.append(article);

    if (this.practising && this.questions.length > 0) {
      const practiceWrap = d.createElement('section');
      practiceWrap.className = 'prac-wrap';
      const h2 = d.createElement('h2');
      h2.className = 'section-heading';
      h2.textContent = 'অনুশীলন';
      practiceWrap.append(h2);
      const host = d.createElement('div');
      practiceWrap.append(host);
      root.append(practiceWrap);
      new PracticeView({
        root: host,
        doc: d,
        questions: this.questions,
        outbox: this.o.outbox,
        onDone: () => {
          // Finishing the practice set is a far better completion signal
          // than a self-declared button, so it marks the topic done.
          void this.recordProgress(topicId, 'completed');
          this.practising = false;
          this.render();
        },
      });
      practiceWrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }

    if (this.questions.length > 0) {
      const start = d.createElement('button');
      start.type = 'button';
      start.className = 'btn-primary topic-done';
      start.textContent = `অনুশীলন করো (${formatCount(this.questions.length, 'bn')}টি প্রশ্ন)`;
      start.addEventListener('click', () => { this.practising = true; this.render(); });
      root.append(start);
    }

    const done = d.createElement('button');
    done.type = 'button';
    done.className = this.questions.length > 0 ? 'btn-secondary topic-done-alt' : 'btn-primary topic-done';
    done.textContent = 'পাঠ সম্পন্ন ✓';
    done.addEventListener('click', () => {
      void this.recordProgress(topicId, 'completed');
      done.textContent = 'সম্পন্ন হয়েছে ✓';
      done.disabled = true;
    });
    root.append(done);
  }

  private renderBlock(b: Block): HTMLElement {
    const d = this.o.doc;
    switch (b.kind) {
      case 'key_point': {
        const el = d.createElement('aside');
        el.className = 'block-key-point';
        el.textContent = b.bodyBn ?? '';
        return el;
      }
      case 'formula': {
        const el = d.createElement('div');
        el.className = 'block-formula';
        el.textContent = b.bodyBn ?? '';
        return el;
      }
      case 'example': {
        const el = d.createElement('div');
        el.className = 'block-example';
        const label = d.createElement('span');
        label.className = 'block-label';
        label.textContent = 'উদাহরণ';
        const body = d.createElement('p');
        body.textContent = b.bodyBn ?? '';
        el.append(label, body);
        return el;
      }
      case 'practice_prompt': {
        const el = d.createElement('div');
        el.className = 'block-practice';
        const label = d.createElement('span');
        label.className = 'block-label';
        label.textContent = 'নিজে করো';
        const body = d.createElement('p');
        body.textContent = b.bodyBn ?? '';
        el.append(label, body);
        return el;
      }
      case 'image': {
        const fig = d.createElement('figure');
        fig.className = 'block-figure';
        const img = d.createElement('img');
        img.src = `/media/${b.mediaKey ?? ''}`;
        img.alt = b.altTextBn ?? '';
        img.loading = 'lazy';
        fig.append(img);
        if (b.captionBn) {
          const cap = d.createElement('figcaption');
          cap.textContent = b.captionBn;
          fig.append(cap);
        }
        return fig;
      }
      default: {
        const el = d.createElement('p');
        el.className = 'block-text';
        el.textContent = b.bodyBn ?? '';
        return el;
      }
    }
  }

  /* --------------------------------------------------------------- bits */

  private backBar(label: string, onBack: () => void): HTMLElement {
    const d = this.o.doc;
    const bar = d.createElement('div');
    bar.className = 'back-bar';
    const btn = d.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-ghost back-btn';
    btn.textContent = `← ${label}`;
    btn.addEventListener('click', onBack);
    bar.append(btn);
    return bar;
  }

  private offlineBanner(): HTMLElement {
    const p = this.o.doc.createElement('p');
    p.className = 'inline-notice';
    p.textContent = 'অফলাইন — সংরক্ষিত পাঠ দেখানো হচ্ছে';
    return p;
  }

  private msg(text: string): HTMLElement {
    const p = this.o.doc.createElement('p');
    p.className = 'page-sub empty';
    p.textContent = text;
    return p;
  }
}
