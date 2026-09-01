/**
 * Answer-script photo capture (উত্তরপত্র).
 *
 * Camera → canvas → compressed JPEG → POST metadata. Compression happens
 * on-device before any byte leaves — the 3G budget (docs/04 §6) is the
 * whole point. Target: ≤200 KB per page after downscaling to 1600px on
 * the long edge and quality 0.7 (about 6× smaller than a typical phone
 * photo). Uses `input[type=file] capture=environment` because it works on
 * every Android browser without the MediaDevices permission dance.
 */
import type { Auth } from './auth.ts';
import { formatCount } from '../../../packages/ui-core/src/format.ts';
import { pageHeader, field, card, sectionHeading, dataTable, statusBadge, button, fileUpload, el, append, permissionState, permissionMessage,} from './ui/index.ts';

const TARGET_LONG_EDGE = 1600;
const JPEG_QUALITY = 0.7;
const MAX_PAGE_BYTES = 250 * 1024;

interface Page {
  id: string;
  pageNo: number;
  originalBytes: number;
  compressedBytes: number;
  sha256: string;
  dataUrl: string;
  status: 'ready' | 'uploading' | 'saved' | 'error';
  error?: string;
}

/** The three lists this screen picks from. Same shapes the marks and roster
 *  screens already read — named here because `typeof this.x` inside a method
 *  does not resolve (TS2683) and an inline shape would drift from theirs. */
interface SectionOpt { id: string; name: string; className: { bn: string } }
interface ExamOpt {
  examId: string; nameBn: string;
  subjects: Array<{ examSubjectId: string; subject: { bn: string } }>;
}
interface RosterOpt {
  studentId: string; rollNo: number;
  fullName: { bn: string | null; en: string | null };
}

export interface ScriptsViewOptions {
  root: HTMLElement;
  doc: Document;
  auth: Auth;
}

/** Downscale + re-encode; returns a Blob under the wire budget. */
async function compress(file: File, doc: Document): Promise<{ blob: Blob; originalBytes: number }> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, TARGET_LONG_EDGE / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = doc.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas unavailable');
  ctx.drawImage(bitmap, 0, 0, w, h);
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), 'image/jpeg', JPEG_QUALITY);
  });
  return { blob, originalBytes: file.size };
}

async function sha256Hex(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(blob);
  });
}

/**
 * Mirrors `requireStaff` in server-core, which blocks exactly these two.
 * Advisory only — the endpoint is the gate; this decides whether the form is
 * offered at all.
 */
const NOT_STAFF = ['student', 'guardian'];

const bn = (n: number): string => formatCount(n, 'bn');

export class ScriptsView {
  private readonly o: ScriptsViewOptions;
  private sections: SectionOpt[] = [];
  private sectionId = '';
  private exams: ExamOpt[] = [];
  private roster: RosterOpt[] = [];
  private loadingCtx = true;
  private examSubjectId = '';
  private studentId = '';
  private pages: Page[] = [];
  private lastBlob = new Map<string, Blob>();
  private busy = false;
  private notice = '';

  constructor(options: ScriptsViewOptions) {
    this.o = options;
    this.render();
    void this.loadContext();
  }

  private async onFile(file: File): Promise<void> {
    if (!this.examSubjectId || !this.studentId) {
      this.notice = 'পরীক্ষা ও শিক্ষার্থীর তথ্য পূরণ করুন।';
      this.render();
      return;
    }
    this.busy = true;
    this.notice = '';
    this.render();
    try {
      const { blob, originalBytes } = await compress(file, this.o.doc);
      if (blob.size > MAX_PAGE_BYTES) {
        this.notice = `ফাইল এখনো বড় (${Math.round(blob.size / 1024)} KB); আবার তোলার চেষ্টা করুন।`;
        this.busy = false; this.render(); return;
      }
      const sha = await sha256Hex(blob);
      const dataUrl = await blobToDataUrl(blob);
      const id = crypto.randomUUID();
      const pageNo = this.pages.length + 1;
      this.pages.push({
        id, pageNo, originalBytes, compressedBytes: blob.size,
        sha256: sha, dataUrl, status: 'ready',
      });
      this.lastBlob.set(id, blob);
    } catch (err) {
      this.notice = `ছবি প্রস্তুত করা যায়নি: ${String((err as Error).message ?? err)}`;
    }
    this.busy = false;
    this.render();
  }

  /**
   * Sections, then that section's exams and roster.
   *
   * Exactly the three reads marks-view and roster-view already perform, so a
   * teacher who can mark a paper can also file its scan — the authorization
   * is the one they already have, not a new one.
   */
  private async loadContext(): Promise<void> {
    try {
      const res = await this.o.auth.authedFetch('/api/v1/academics/sections');
      if (res.ok) {
        const body = (await res.json()) as { sections: SectionOpt[] };
        this.sections = body.sections ?? [];
        const remembered = (() => {
          try { return localStorage.getItem('shikhon_last_section') ?? ''; }
          catch { return ''; }
        })();
        this.sectionId = this.sections.some((x) => x.id === remembered)
          ? remembered : (this.sections[0]?.id ?? '');
      }
    } catch { /* offline: the pickers stay empty and say so */ }
    this.loadingCtx = false;
    this.render();
    if (this.sectionId) await this.loadSection(this.sectionId);
  }

  private async loadSection(sectionId: string): Promise<void> {
    this.sectionId = sectionId;
    this.examSubjectId = '';
    this.studentId = '';
    const q = encodeURIComponent(sectionId);
    try {
      const [ex, ro] = await Promise.all([
        this.o.auth.authedFetch(`/api/v1/academics/exams?sectionId=${q}`),
        this.o.auth.authedFetch(`/api/v1/academics/roster?sectionId=${q}`),
      ]);
      if (ex.ok) this.exams = ((await ex.json()) as { exams: ExamOpt[] }).exams ?? [];
      if (ro.ok) this.roster = ((await ro.json()) as { roster: RosterOpt[] }).roster ?? [];
    } catch { /* offline */ }
    this.render();
  }

  private async upload(page: Page): Promise<void> {
    page.status = 'uploading';
    page.error = undefined;
    this.render();
    try {
      const res = await this.o.auth.authedFetch('/api/v1/academics/scripts', {
        method: 'POST',
        body: JSON.stringify({
          id: page.id,
          examSubjectId: this.examSubjectId,
          studentId: this.studentId,
          pageNo: page.pageNo,
          byteSize: page.compressedBytes,
          originalBytes: page.originalBytes,
          sha256: page.sha256,
          capturedAt: new Date().toISOString(),
          contentType: 'image/jpeg',
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (res.ok && body.ok) {
        page.status = 'saved';
      } else if (body.error === 'script_storage_unconfigured') {
        page.status = 'error';
        page.error = 'সংরক্ষণ এখনো চালু হয়নি — অ্যাডমিন চালু করলেই আপলোড হবে।';
      } else {
        page.status = 'error';
        page.error = body.error ?? 'আপলোড ব্যর্থ';
      }
    } catch (err) {
      page.status = 'error';
      page.error = `সংযোগ নেই — পরে আবার চেষ্টা করুন`;
      void err;
    }
    this.render();
  }

  private removePage(id: string): void {
    this.pages = this.pages.filter((p) => p.id !== id);
    this.pages.forEach((p, i) => { p.pageNo = i + 1; });
    this.lastBlob.delete(id);
    this.render();
  }

  private render(): void {
    const d = this.o.doc;
    const root = this.o.root;
    root.textContent = '';

    root.append(pageHeader(d, {
      title: 'উত্তরপত্র আপলোড',
      subtitle: 'হাতে-লেখা উত্তরপত্রের ছবি — অন-ডিভাইস কম্প্রেশন সহ',
    }));

    // Mirrors `requireStaff` on the endpoint. Uploading a child's answer
    // script is a teacher's job, and a student meeting three pickers and a
    // camera trigger here is being offered somebody else's work.
    if (NOT_STAFF.includes(this.o.auth.role)) {
      root.append(permissionState(d, {
        message: permissionMessage('উত্তরপত্র আপলোড'),
        contact: 'বিষয় শিক্ষক বা প্রধান শিক্ষক',
      }));
      return;
    }

    const form = el(d, 'div', { className: 'ui-card-form' });

    // Three pickers where there were two uuid boxes. The uuid still travels
    // in the request — it is the identifier the API takes — but it is chosen
    // by name and never typed, seen or spelled out (§15).
    const esLabel = field(d, {
      label: 'সেকশন', name: 'section', kind: 'select', value: this.sectionId,
      options: this.sections.length
        ? this.sections.map((x) => ({ value: x.id, label: `${x.className.bn} — ${x.name}` }))
        : [{ value: '', label: 'কোনো সেকশন পাওয়া যায়নি' }],
      onChange: (v) => { void this.loadSection(v); },
    }).root;

    const examOptions = this.exams.flatMap((ex) =>
      ex.subjects.map((sub) => ({
        value: sub.examSubjectId, label: `${ex.nameBn} — ${sub.subject.bn}`,
      })));
    const stLabel = field(d, {
      label: 'পরীক্ষা ও বিষয়', name: 'examSubject', kind: 'select',
      value: this.examSubjectId,
      options: [{ value: '', label: examOptions.length ? 'বেছে নিন' : 'এই সেকশনে কোনো পরীক্ষা নেই' },
                ...examOptions],
      onChange: (v) => { this.examSubjectId = v; this.render(); },
    }).root;

    const stuLabel = field(d, {
      label: 'শিক্ষার্থী', name: 'student', kind: 'select', value: this.studentId,
      options: [{ value: '', label: this.roster.length ? 'বেছে নিন' : 'এই সেকশনে কোনো শিক্ষার্থী নেই' },
                ...this.roster.map((r) => ({
                  value: r.studentId,
                  // Roll first: it is how a teacher identifies a script, and
                  // how the scripts are stacked on the desk.
                  label: `${r.rollNo} · ${r.fullName.bn || r.fullName.en || '—'}`,
                }))],
      onChange: (v) => { this.studentId = v; this.render(); },
    }).root;

    // `capture: 'environment'` opens the rear camera directly on a phone,
    // which is the whole interaction: a teacher points at a page on a desk.
    // The primitive keeps that and stops this screen hand-rolling a label
    // that hides its own input.
    const capture = fileUpload(d, {
      label: this.busy ? 'প্রস্তুত হচ্ছে…' : 'পৃষ্ঠা তুলুন',
      name: 'page',
      accept: 'image/*',
      capture: 'environment',
      helper: 'ছবি এই যন্ত্রেই ছোট করা হয় — ২জি সংযোগেও যায়।',
      onFiles: (files) => { if (files[0]) void this.onFile(files[0]); },
    }).root;

    append(form, esLabel, stLabel, stuLabel, capture);
    root.append(card(d, {
      title: 'কোন উত্তরপত্র', glyph: 'camera', headingLevel: 2,
    }, form));

    if (this.notice) {
      root.append(el(d, 'p', {
        className: 'inline-notice', attrs: { role: 'alert' }, text: this.notice,
      }));
    }

    root.append(sectionHeading(d, {
      title: `তোলা পৃষ্ঠা · ${bn(this.pages.length)}`,
    }));

    root.append(dataTable(d, {
      caption: 'তোলা পৃষ্ঠার তালিকা',
      rows: this.pages,
      rowKey: (pg) => pg.id,
      empty: {
        glyph: 'camera',
        message: 'এখনো কোনো পৃষ্ঠা তোলা হয়নি। উপরের বোতাম দিয়ে উত্তরপত্রের ছবি তুলুন।',
      },
      columns: [
        { key: 'thumb', header: 'ছবি', mobile: 'hidden', width: '90px',
          cell: (pg) => el(d, 'img', {
            className: 'script-thumb',
            attrs: { src: pg.dataUrl, alt: `পৃষ্ঠা ${bn(pg.pageNo)}-এর ছবি`, loading: 'lazy' },
          }) },
        { key: 'page', header: 'পৃষ্ঠা', mobile: 'title',
          cell: (pg) => `পৃষ্ঠা ${bn(pg.pageNo)}`, width: 'minmax(0, 1fr)' },
        // Bangla digits: a kilobyte count is a count, and every other count
        // in this product is Bangla.
        { key: 'size', header: 'আকার', mobile: 'subtitle', width: 'minmax(0, 1.4fr)',
          cell: (pg) => {
            const kb = Math.round(pg.compressedBytes / 1024);
            const ratio = Math.max(1, Math.round(pg.originalBytes / pg.compressedBytes));
            return `${bn(kb)} KB · ${bn(ratio)}× ছোট`;
          } },
        { key: 'state', header: 'অবস্থা', mobile: 'status', width: '150px',
          cell: (pg) => (
            pg.status === 'saved'     ? statusBadge(d, { state: 'synced', label: 'সংরক্ষিত' })
            : pg.status === 'uploading' ? statusBadge(d, { state: 'queued', label: 'আপলোড হচ্ছে' })
            : pg.status === 'error'     ? statusBadge(d, { state: 'failed', label: pg.error ?? 'সমস্যা' })
            : statusBadge(d, { state: 'pending', label: 'প্রস্তুত' })) },
        { key: 'actions', header: 'ব্যবস্থা', width: '190px',
          cell: (pg) => el(d, 'div', { className: 'ui-row-actions' },
            pg.status !== 'saved'
              ? button(d, {
                  label: 'আপলোড', variant: 'primary', size: 'sm',
                  // Per-page: six buttons called "আপলোড" are six identical
                  // announcements, and the pages differ only by number.
                  ariaLabel: `পৃষ্ঠা ${bn(pg.pageNo)} আপলোড করুন`,
                  busy: pg.status === 'uploading',
                  onClick: () => { void this.upload(pg); },
                })
              : null,
            button(d, {
              label: 'সরান', variant: 'ghost', size: 'sm',
              ariaLabel: `পৃষ্ঠা ${bn(pg.pageNo)} সরান`,
              onClick: () => { this.removePage(pg.id); },
            })) },
      ],
    }));
  }

  private textNode(text: string): Text {
    return this.o.doc.createTextNode(text);
  }
}
