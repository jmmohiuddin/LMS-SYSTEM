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

export class ScriptsView {
  private readonly o: ScriptsViewOptions;
  private examSubjectId = '';
  private studentId = '';
  private pages: Page[] = [];
  private lastBlob = new Map<string, Blob>();
  private busy = false;
  private notice = '';

  constructor(options: ScriptsViewOptions) {
    this.o = options;
    this.render();
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

    const header = d.createElement('header');
    header.className = 'page-header';
    const h1 = d.createElement('h1');
    h1.textContent = 'উত্তরপত্র আপলোড';
    const sub = d.createElement('p');
    sub.className = 'page-sub';
    sub.textContent = 'হাতে-লেখা উত্তরপত্রের ছবি — অন-ডিভাইস কম্প্রেশন সহ';
    header.append(h1, sub);
    root.append(header);

    const card = d.createElement('div');
    card.className = 'card card-form';

    const esLabel = d.createElement('label');
    esLabel.className = 'field';
    esLabel.append(this.textNode('পরীক্ষা-বিষয় আইডি (examSubjectId)'));
    const esInput = d.createElement('input');
    esInput.type = 'text';
    esInput.className = 'field-input';
    esInput.value = this.examSubjectId;
    esInput.placeholder = 'exam_subject uuid';
    esInput.addEventListener('input', () => { this.examSubjectId = esInput.value.trim(); });
    esLabel.append(esInput);

    const stLabel = d.createElement('label');
    stLabel.className = 'field';
    stLabel.append(this.textNode('শিক্ষার্থী আইডি'));
    const stInput = d.createElement('input');
    stInput.type = 'text';
    stInput.className = 'field-input';
    stInput.value = this.studentId;
    stInput.placeholder = 'student uuid';
    stInput.addEventListener('input', () => { this.studentId = stInput.value.trim(); });
    stLabel.append(stInput);

    const captureLabel = d.createElement('label');
    captureLabel.className = 'btn-primary btn-capture';
    captureLabel.textContent = this.busy ? 'প্রস্তুত হচ্ছে…' : '📷 পৃষ্ঠা তুলুন';
    const fileInput = d.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.setAttribute('capture', 'environment');
    fileInput.hidden = true;
    fileInput.addEventListener('change', () => {
      const f = fileInput.files?.[0];
      if (f) void this.onFile(f);
      fileInput.value = '';
    });
    captureLabel.append(fileInput);

    card.append(esLabel, stLabel, captureLabel);
    root.append(card);

    if (this.notice) {
      const n = d.createElement('p');
      n.className = 'inline-notice';
      n.setAttribute('role', 'alert');
      n.textContent = this.notice;
      root.append(n);
    }

    if (this.pages.length === 0) {
      const empty = d.createElement('p');
      empty.className = 'page-sub empty';
      empty.textContent = 'এখনো কোনো পৃষ্ঠা তোলা হয়নি।';
      root.append(empty);
      return;
    }

    const list = d.createElement('ul');
    list.className = 'script-pages';
    for (const p of this.pages) {
      const li = d.createElement('li');
      li.className = 'script-page card';
      li.dataset.status = p.status;

      const img = d.createElement('img');
      img.className = 'script-thumb';
      img.src = p.dataUrl;
      img.alt = `পৃষ্ঠা ${p.pageNo}`;

      const info = d.createElement('div');
      info.className = 'script-info';
      const title = d.createElement('span');
      title.className = 'script-title';
      title.textContent = `পৃষ্ঠা ${p.pageNo}`;
      const meta = d.createElement('span');
      meta.className = 'script-meta';
      const compressed = Math.round(p.compressedBytes / 1024);
      const ratio = Math.max(1, Math.round(p.originalBytes / p.compressedBytes));
      meta.textContent = `${compressed} KB · ${ratio}× ছোট`;
      const status = d.createElement('span');
      status.className = 'script-status';
      status.textContent =
        p.status === 'saved' ? '✓ সংরক্ষিত'
        : p.status === 'uploading' ? '⏳ আপলোড হচ্ছে…'
        : p.status === 'error' ? `⚠ ${p.error ?? 'সমস্যা'}`
        : 'প্রস্তুত';
      info.append(title, meta, status);

      const actions = d.createElement('div');
      actions.className = 'script-actions';
      if (p.status !== 'saved') {
        const upload = d.createElement('button');
        upload.type = 'button';
        upload.className = 'btn-primary btn-small';
        upload.textContent = p.status === 'uploading' ? '…' : 'আপলোড';
        upload.disabled = p.status === 'uploading';
        upload.addEventListener('click', () => { void this.upload(p); });
        actions.append(upload);
      }
      const remove = d.createElement('button');
      remove.type = 'button';
      remove.className = 'btn-ghost btn-small';
      remove.textContent = '×';
      remove.setAttribute('aria-label', 'সরান');
      remove.addEventListener('click', () => { this.removePage(p.id); });
      actions.append(remove);

      li.append(img, info, actions);
      list.append(li);
    }
    root.append(list);
  }

  private textNode(text: string): Text {
    return this.o.doc.createTextNode(text);
  }
}
