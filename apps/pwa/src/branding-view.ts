/**
 * প্রতিষ্ঠানের পরিচয় — the branding editor  (R-1, docs/11-MASTER-PLAN.md)
 *
 * The screen where a school stops looking like the platform and starts
 * looking like itself. Four groups, in the order a head teacher thinks
 * about them: name, logo and marks, colours, then the contact block that
 * only ever appears on printed paper.
 *
 * ── The preview is the real thing, not a mock-up ────────────────────────
 * The letterhead panel calls brandedLetterhead() from ui-core — the SAME
 * function every future receipt, report card and admit card will call. A
 * preview built from lookalike markup would drift from the document it
 * claims to predict, and the drift would be discovered by a parent holding
 * a receipt. Here, if the preview is right the document is right, because
 * they are one function.
 *
 * ── Images are downscaled before they are ever sent ─────────────────────
 * A school will upload the 4 MB PNG its signboard designer produced. The
 * limits in ui-core are bytes-on-the-wire limits, so the useful place to
 * meet them is here, on the device, before the upload: scale the longest
 * edge down and step the quality until it fits. Refusing a logo for being
 * large teaches an IT user to go and find image-editing software; quietly
 * fitting it teaches them nothing, which is the point.
 *
 * ── Validation runs twice on purpose ────────────────────────────────────
 * parseBranding() here gives the field-level error next to the input while
 * someone is typing. The server runs the identical function again on the
 * PUT, because this copy is advice — anyone can call the API directly.
 */
import type { Auth } from './auth.ts';
import {
  type Branding,
  DEFAULT_BRANDING,
  BrandingError,
  LIMITS,
  parseBranding,
  brandName,
  meetsAaOnWhiteText,
  contrastRatio,
} from '../../../packages/ui-core/src/branding.ts';
import { brandedLetterhead } from '../../../packages/ui-core/src/branded-doc.ts';
import { applyBranding, cacheBranding, cachedBranding } from './branding.ts';
import { serverMessage } from './ui/index.ts';

export interface BrandingViewOptions {
  root: HTMLElement;
  doc: Document;
  auth: Auth;
  /** Tenant key used for the branding cache; defaults to auth.tenantId. */
  tenantKey?: string;
  /**
   * Whether this person may SAVE. Mirrors BRANDING_WRITERS in the endpoint.
   *
   * Not discovered from a 403: the branding GET is public — it is what the
   * login screen draws before anybody signs in — so a reader who may not write
   * still gets 200, and a screen that waited for a refusal offered a teacher
   * twelve editable fields and a save that could only fail.
   */
  canManage?: boolean;
}

type AssetField = 'logoUrl' | 'faviconUrl' | 'watermarkUrl' | 'signatureUrl';

/** Longest edge per asset. A logo is a mark, not a photograph. */
const MAX_EDGE: Record<AssetField, number> = {
  logoUrl: 320,
  faviconUrl: 192,
  watermarkUrl: 900,
  signatureUrl: 480,
};

const FIELD_LABELS_BN: Record<string, string> = {
  nameBn: 'প্রতিষ্ঠানের নাম (বাংলা)',
  nameEn: 'Institution name (English)',
  shortName: 'সংক্ষিপ্ত নাম',
  logoUrl: 'লোগো',
  faviconUrl: 'ফেভিকন',
  watermarkUrl: 'ওয়াটারমার্ক',
  signatureUrl: 'স্বাক্ষর',
  primaryColor: 'প্রধান রং',
  accentColor: 'সহায়ক রং',
  address: 'ঠিকানা',
  phone: 'ফোন',
  email: 'ইমেইল',
  website: 'ওয়েবসাইট',
  headmasterName: 'প্রধান শিক্ষকের নাম',
  branding: 'পরিচয়',
};

export class BrandingView {
  private readonly o: BrandingViewOptions;
  /** The saved state — what Cancel returns to. */
  private saved: Branding;
  /** The edited state — what the preview shows and Save sends. */
  private draft: Branding;
  private busy = false;
  private notice = '';
  private noticeKind: 'ok' | 'error' | '' = '';
  private fieldError: { field: string; message: string } | null = null;
  private readOnly = false;

  constructor(options: BrandingViewOptions) {
    this.o = options;
    this.readOnly = options.canManage === false;
    const key = this.tenantKey();
    this.saved = cachedBranding(key);
    this.draft = { ...this.saved };
    this.render();
    void this.load();
  }

  private tenantKey(): string {
    return this.o.tenantKey ?? this.o.auth.tenantId ?? '';
  }

  private async load(): Promise<void> {
    try {
      const res = await this.o.auth.authedFetch('/api/v1/ops/branding');
      if (res.status === 403) {
        // A teacher who deep-links here sees the school's identity but no
        // controls. The server is the enforcement; this is orientation.
        this.readOnly = true;
        this.render();
        return;
      }
      if (!res.ok) return;
      const body = (await res.json()) as { branding?: unknown };
      this.saved = parseBranding(body.branding, DEFAULT_BRANDING);
      this.draft = { ...this.saved };
      cacheBranding(this.tenantKey(), this.saved);
      this.render();
    } catch {
      // Offline: the cached branding is already on screen and editable.
      // The save will fail loudly if it is still offline when they press it.
    }
  }

  private dirty(): boolean {
    return (Object.keys(this.draft) as (keyof Branding)[])
      .some((k) => this.draft[k] !== this.saved[k]);
  }

  private set<K extends keyof Branding>(key: K, value: Branding[K]): void {
    this.draft[key] = value;
    this.fieldError = null;
    this.notice = '';
    this.noticeKind = '';
  }

  // ── Image handling ────────────────────────────────────────────────────

  /**
   * Downscale and encode to a data URL that fits the field's byte cap.
   *
   * PNG first because a logo with a transparent background is the common
   * case and JPEG would fill it with black. If PNG will not fit, step down
   * through WebP qualities, which handles the photographic signature scan.
   */
  private async encodeAsset(file: File, field: AssetField): Promise<string> {
    const d = this.o.doc;
    const bitmap = await createImageBitmap(file);
    const cap = LIMITS[field];
    const edge = MAX_EDGE[field];

    const draw = (scale: number): HTMLCanvasElement => {
      const canvas = d.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      return canvas;
    };

    const baseScale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));

    // Progressively smaller, and for each size PNG then WebP. The first
    // candidate under the cap wins, so a small logo stays lossless.
    for (const shrink of [1, 0.8, 0.62, 0.5, 0.38]) {
      const canvas = draw(baseScale * shrink);
      const candidates = [
        canvas.toDataURL('image/png'),
        canvas.toDataURL('image/webp', 0.88),
        canvas.toDataURL('image/webp', 0.7),
      ];
      for (const url of candidates) {
        // toDataURL falls back to PNG when a type is unsupported; a
        // candidate that is not the type we asked for is simply a
        // duplicate and the length check treats it as one.
        if (url.length <= cap) return url;
      }
    }
    throw new BrandingError(field, `${FIELD_LABELS_BN[field]} ছবিটি খুব বড় — ছোট ছবি ব্যবহার করুন।`);
  }

  private async pickAsset(field: AssetField): Promise<void> {
    const d = this.o.doc;
    const input = d.createElement('input');
    input.type = 'file';
    // Raster only, matching the ui-core allowlist. An SVG picked here
    // would be refused by the validator anyway; not offering it avoids
    // teaching someone to try.
    input.accept = 'image/png,image/jpeg,image/webp';
    const file: File | null = await new Promise((resolve) => {
      input.addEventListener('change', () => resolve(input.files?.[0] ?? null), { once: true });
      input.click();
    });
    if (!file) return;

    try {
      const url = await this.encodeAsset(file, field);
      this.set(field, url);
      this.render();
    } catch (err) {
      this.fieldError = {
        field,
        message: err instanceof BrandingError
          ? err.message
          : 'ছবিটি পড়া যায়নি। অন্য একটি ছবি চেষ্টা করুন।',
      };
      this.render();
    }
  }

  // ── Save / cancel ─────────────────────────────────────────────────────

  private async save(): Promise<void> {
    if (this.busy) return;
    this.fieldError = null;

    // Local check first: a field error belongs beside its input, and a
    // round-trip to learn the colour is malformed is a round-trip wasted.
    let candidate: Branding;
    try {
      candidate = parseBranding(this.draft, this.saved);
    } catch (err) {
      if (err instanceof BrandingError) {
        this.fieldError = { field: err.field, message: err.message };
        this.render();
        return;
      }
      throw err;
    }

    this.busy = true;
    this.render();
    try {
      const res = await this.o.auth.authedFetch('/api/v1/ops/branding', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ branding: candidate }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        branding?: unknown; message?: string; field?: string; error?: string;
      };
      if (!res.ok) {
        if (res.status === 403) {
          this.notice = 'পরিচয় পরিবর্তনের অনুমতি আপনার নেই।';
          this.noticeKind = 'error';
        } else if (body.field) {
          this.fieldError = { field: body.field, message: body.message ?? 'মানটি সঠিক নয়।' };
        } else {
          this.notice = serverMessage(body, res.status, 'সংরক্ষণ করা যায়নি। আবার চেষ্টা করুন।', 'প্রতিষ্ঠানের পরিচয়');
          this.noticeKind = 'error';
        }
        return;
      }
      // The server's answer, not the draft, becomes the saved state — it
      // has been through normalisation (#ABC → #aabbcc) and the client
      // must not keep believing in a value the database does not hold.
      this.saved = parseBranding(body.branding, DEFAULT_BRANDING);
      this.draft = { ...this.saved };
      cacheBranding(this.tenantKey(), this.saved);
      // Repaint the whole app immediately: the point of this screen is
      // that the change is visible, and making someone reload to see their
      // own logo would undercut it.
      applyBranding(this.o.doc, this.saved, { tenantKey: this.tenantKey() });
      this.notice = 'সংরক্ষিত হয়েছে।';
      this.noticeKind = 'ok';
    } catch {
      this.notice = 'সংযোগ নেই — সংরক্ষণ করা যায়নি।';
      this.noticeKind = 'error';
    } finally {
      this.busy = false;
      this.render();
    }
  }

  private cancel(): void {
    this.draft = { ...this.saved };
    this.fieldError = null;
    this.notice = 'পরিবর্তন বাতিল করা হয়েছে।';
    this.noticeKind = 'ok';
    this.render();
  }

  // ── Rendering ─────────────────────────────────────────────────────────

  private card(titleBn: string, hintBn?: string): HTMLElement {
    const d = this.o.doc;
    const card = d.createElement('section');
    card.className = 'card brand-card';
    const h = d.createElement('h2');
    h.className = 'brand-card-title';
    h.textContent = titleBn;
    card.append(h);
    if (hintBn) {
      const p = d.createElement('p');
      p.className = 'att-sub';
      p.textContent = hintBn;
      card.append(p);
    }
    return card;
  }

  private textField(
    parent: HTMLElement,
    field: keyof Branding,
    opts: { multiline?: boolean; placeholder?: string; type?: string } = {},
  ): void {
    const d = this.o.doc;
    const label = d.createElement('label');
    label.className = 'login-label brand-field';
    const span = d.createElement('span');
    span.textContent = FIELD_LABELS_BN[field] ?? field;
    label.append(span);

    const input = opts.multiline
      ? d.createElement('textarea')
      : d.createElement('input');
    input.className = 'login-input';
    if (!opts.multiline && input instanceof HTMLInputElement) {
      input.type = opts.type ?? 'text';
      if (opts.placeholder) input.placeholder = opts.placeholder;
    }
    (input as HTMLInputElement | HTMLTextAreaElement).value = String(this.draft[field] ?? '');
    input.disabled = this.readOnly;
    input.addEventListener('input', () => {
      this.draft[field] = (input as HTMLInputElement).value as Branding[typeof field];
      this.fieldError = null;
      this.paintPreview();
      this.syncControls();
    });
    label.append(input);

    if (this.fieldError?.field === field) {
      const err = d.createElement('p');
      err.className = 'login-error';
      err.setAttribute('role', 'alert');
      err.textContent = this.fieldError.message;
      label.append(err);
    }
    parent.append(label);
  }

  private colorField(parent: HTMLElement, field: 'primaryColor' | 'accentColor'): void {
    const d = this.o.doc;
    const row = d.createElement('div');
    row.className = 'brand-color-row';

    const label = d.createElement('label');
    label.className = 'login-label brand-field';
    const span = d.createElement('span');
    span.textContent = FIELD_LABELS_BN[field];
    label.append(span);

    const swatchWrap = d.createElement('div');
    swatchWrap.className = 'brand-color-inputs';

    const picker = d.createElement('input');
    picker.type = 'color';
    picker.className = 'brand-color-swatch';
    picker.value = /^#[0-9a-f]{6}$/i.test(this.draft[field]) ? this.draft[field] : '#000000';
    picker.disabled = this.readOnly;

    const hex = d.createElement('input');
    hex.type = 'text';
    hex.className = 'login-input brand-color-hex';
    hex.value = this.draft[field];
    hex.disabled = this.readOnly;

    const sync = (value: string, alsoSet: HTMLInputElement) => {
      this.draft[field] = value;
      if (/^#[0-9a-f]{6}$/i.test(value)) alsoSet.value = value;
      this.fieldError = null;
      this.paintPreview();
      this.syncControls();
    };
    picker.addEventListener('input', () => sync(picker.value, hex));
    hex.addEventListener('input', () => sync(hex.value.trim(), picker));

    swatchWrap.append(picker, hex);
    label.append(swatchWrap);
    row.append(label);

    // Contrast warning. A brand colour that cannot carry white text turns
    // every primary button in the product into unreadable text at once —
    // the single highest-blast-radius mistake this screen can make.
    //
    // The element always exists and is toggled by syncControls(), because
    // typing must not trigger a re-render (that would move focus out of
    // the input mid-keystroke) and a warning that only appears after a
    // save is a warning that arrives too late to be advice.
    if (field === 'primaryColor') {
      const warn = d.createElement('p');
      warn.className = 'brand-warn';
      warn.setAttribute('role', 'status');
      warn.setAttribute('data-warn-for', field);
      warn.hidden = true;
      row.append(warn);
    }
    parent.append(row);
  }

  /**
   * Refresh the controls that depend on the draft but must not trigger a
   * re-render: the Save/Cancel enabled state and the contrast advice.
   *
   * render() rebuilds the form, which is correct on load and after a save
   * and wrong on every keystroke — the input being typed into would lose
   * focus and the caret would jump to the end.
   */
  private syncControls(): void {
    const root = this.o.root;

    const buttons = root.querySelectorAll<HTMLButtonElement>('.brand-actions button');
    const dirty = this.dirty();
    for (const b of buttons) b.disabled = this.busy || !dirty;

    const warn = root.querySelector<HTMLElement>('[data-warn-for="primaryColor"]');
    if (!warn) return;
    const c = this.draft.primaryColor;
    if (/^#[0-9a-f]{6}$/i.test(c) && !meetsAaOnWhiteText(c)) {
      warn.textContent =
        `এই রঙে সাদা লেখা পড়া কঠিন (কনট্রাস্ট ${contrastRatio(c, '#ffffff').toFixed(1)}:১, `
        + 'প্রয়োজন ৪.৫:১)। গাঢ় রং বেছে নিন।';
      warn.hidden = false;
    } else {
      warn.hidden = true;
    }
  }

  private assetField(parent: HTMLElement, field: AssetField, hintBn: string): void {
    const d = this.o.doc;
    const block = d.createElement('div');
    block.className = 'brand-asset';

    const head = d.createElement('div');
    head.className = 'brand-asset-head';
    const name = d.createElement('span');
    name.className = 'brand-asset-name';
    name.textContent = FIELD_LABELS_BN[field];
    head.append(name);
    block.append(head);

    const hint = d.createElement('p');
    hint.className = 'att-sub';
    hint.textContent = hintBn;
    block.append(hint);

    const preview = d.createElement('div');
    preview.className = 'brand-asset-preview';
    if (this.draft[field]) {
      const img = d.createElement('img');
      img.src = this.draft[field];
      img.alt = '';
      preview.append(img);
    } else {
      const empty = d.createElement('span');
      empty.className = 'brand-asset-empty';
      empty.textContent = 'নেই';
      preview.append(empty);
    }
    block.append(preview);

    if (!this.readOnly) {
      const actions = d.createElement('div');
      actions.className = 'action-row';
      const pick = d.createElement('button');
      pick.type = 'button';
      pick.className = 'btn-secondary btn-small';
      pick.textContent = this.draft[field] ? 'পরিবর্তন করুন' : 'আপলোড করুন';
      pick.addEventListener('click', () => { void this.pickAsset(field); });
      actions.append(pick);
      if (this.draft[field]) {
        const clear = d.createElement('button');
        clear.type = 'button';
        clear.className = 'btn-ghost btn-small';
        clear.textContent = 'সরান';
        clear.addEventListener('click', () => { this.set(field, ''); this.render(); });
        actions.append(clear);
      }
      block.append(actions);
    }

    if (this.fieldError?.field === field) {
      const err = d.createElement('p');
      err.className = 'login-error';
      err.setAttribute('role', 'alert');
      err.textContent = this.fieldError.message;
      block.append(err);
    }
    parent.append(block);
  }

  /**
   * Repaint only the preview panel. Called on every keystroke, so it must
   * not rebuild the form — doing that would move focus out of the input
   * being typed into after each character.
   */
  private paintPreview(): void {
    const host = this.o.root.querySelector<HTMLElement>('[data-brand-preview]');
    if (!host) return;
    host.textContent = '';
    host.append(this.previewContent());
  }

  private previewContent(): HTMLElement {
    const d = this.o.doc;
    const wrap = d.createElement('div');

    // Safe to preview even mid-edit: a half-typed colour must not throw and
    // must not be written into a stylesheet.
    let safe: Branding;
    try {
      safe = parseBranding(this.draft, this.saved);
    } catch {
      safe = this.saved;
    }

    // 1 — the app's own chrome.
    const shellRow = d.createElement('div');
    shellRow.className = 'brand-preview-shell';
    shellRow.style.setProperty('--preview-primary', safe.primaryColor);
    const mark = d.createElement('span');
    mark.className = 'brand-preview-mark';
    if (safe.logoUrl) {
      const img = d.createElement('img');
      img.src = safe.logoUrl;
      img.alt = '';
      mark.append(img);
    } else {
      mark.textContent = [...brandName(safe)][0] ?? '';
    }
    const nm = d.createElement('span');
    nm.className = 'brand-preview-name';
    nm.textContent = brandName(safe);
    const btn = d.createElement('span');
    btn.className = 'brand-preview-btn';
    btn.textContent = 'প্রধান বোতাম';
    shellRow.append(mark, nm, btn);

    const shellCap = d.createElement('p');
    shellCap.className = 'brand-preview-cap';
    shellCap.textContent = 'অ্যাপের শীর্ষ বার ও বোতাম';

    // 2 — the letterhead, rendered by the SAME function the documents use.
    const paper = d.createElement('div');
    paper.className = 'brand-preview-paper';
    paper.innerHTML = brandedLetterhead(safe);
    paper.style.setProperty('--doc-primary', safe.primaryColor);
    if (safe.watermarkUrl) {
      const wm = d.createElement('div');
      wm.className = 'brand-preview-watermark';
      wm.style.backgroundImage = `url("${safe.watermarkUrl}")`;
      paper.prepend(wm);
    }
    const sigRow = d.createElement('div');
    sigRow.className = 'brand-preview-sig';
    if (safe.signatureUrl) {
      const img = d.createElement('img');
      img.src = safe.signatureUrl;
      img.alt = '';
      sigRow.append(img);
    }
    const sigName = d.createElement('div');
    sigName.className = 'brand-preview-signame';
    sigName.textContent = safe.headmasterName || '—';
    sigRow.append(sigName);
    paper.append(sigRow);

    const paperCap = d.createElement('p');
    paperCap.className = 'brand-preview-cap';
    paperCap.textContent = 'রসিদ ও সনদের শীর্ষভাগ';

    wrap.append(shellCap, shellRow, paperCap, paper);
    return wrap;
  }

  private render(): void {
    const d = this.o.doc;
    const root = this.o.root;
    root.textContent = '';

    // .att-header is this app's sticky screen header — the same element
    // roster, fees and every other view uses. Reaching for it rather than
    // a new class is what keeps one design system instead of a dozen
    // one-screen ones.
    const head = d.createElement('header');
    head.className = 'att-header brand-head';
    const h1 = d.createElement('h1');
    h1.textContent = 'প্রতিষ্ঠানের পরিচয়';
    const sub = d.createElement('p');
    sub.className = 'att-sub';
    sub.textContent = this.readOnly
      ? 'আপনি শুধু দেখতে পারবেন — পরিবর্তনের অনুমতি প্রধান শিক্ষক বা আইটি প্রশাসকের।'
      : 'এখানে যা দেন, শিক্ষার্থী-অভিভাবক-শিক্ষক সবাই সেটিই দেখবে — লগইন পর্দা, অ্যাপ ও ছাপা কাগজে।';
    head.append(h1, sub);
    root.append(head);

    if (this.notice) {
      const n = d.createElement('p');
      n.className = this.noticeKind === 'error' ? 'login-error' : 'brand-ok';
      n.setAttribute('role', this.noticeKind === 'error' ? 'alert' : 'status');
      n.textContent = this.notice;
      root.append(n);
    }

    const layout = d.createElement('div');
    layout.className = 'brand-layout';

    // ── Editing column ──────────────────────────────────────────────
    const form = d.createElement('div');
    form.className = 'brand-form';

    const idCard = this.card('নাম', 'বাংলা নামটি সর্বত্র প্রধান; ইংরেজিটি ছাপা কাগজে ব্যবহৃত হয়।');
    this.textField(idCard, 'nameBn');
    this.textField(idCard, 'nameEn');
    this.textField(idCard, 'shortName', { placeholder: 'ছোট জায়গার জন্য' });
    form.append(idCard);

    const markCard = this.card('লোগো ও ছবি', 'ছবি স্বয়ংক্রিয়ভাবে ছোট করে নেওয়া হবে।');
    this.assetField(markCard, 'logoUrl', 'অ্যাপ, লগইন পর্দা ও প্রতিটি ছাপা কাগজের শীর্ষে।');
    this.assetField(markCard, 'faviconUrl', 'ব্রাউজার ট্যাব ও ইনস্টল করা অ্যাপের আইকন।');
    this.assetField(markCard, 'watermarkUrl', 'ছাপা কাগজের পেছনে হালকা ছাপ।');
    this.assetField(markCard, 'signatureUrl', 'রসিদ ও সনদে অনুমোদিত স্বাক্ষর।');
    form.append(markCard);

    const colorCard = this.card('রং', 'প্রধান রং বোতাম ও সক্রিয় মেনুতে ব্যবহৃত হয়।');
    this.colorField(colorCard, 'primaryColor');
    this.colorField(colorCard, 'accentColor');
    form.append(colorCard);

    const contactCard = this.card('যোগাযোগ ও স্বাক্ষর', 'এগুলো কেবল ছাপা কাগজে দেখা যায়।');
    this.textField(contactCard, 'address', { multiline: true });
    this.textField(contactCard, 'phone', { placeholder: '+8801XXXXXXXXX' });
    this.textField(contactCard, 'email', { type: 'email' });
    this.textField(contactCard, 'website', { placeholder: 'https://…' });
    this.textField(contactCard, 'headmasterName');
    form.append(contactCard);

    if (!this.readOnly) {
      const actions = d.createElement('div');
      actions.className = 'action-row brand-actions';
      const save = d.createElement('button');
      save.type = 'button';
      save.className = 'btn-primary';
      save.textContent = this.busy ? 'সংরক্ষণ হচ্ছে…' : 'সংরক্ষণ করুন';
      save.disabled = this.busy || !this.dirty();
      save.addEventListener('click', () => { void this.save(); });
      const cancel = d.createElement('button');
      cancel.type = 'button';
      cancel.className = 'btn-secondary';
      cancel.textContent = 'বাতিল';
      cancel.disabled = this.busy || !this.dirty();
      cancel.addEventListener('click', () => this.cancel());
      actions.append(save, cancel);
      form.append(actions);
    }

    // ── Preview column ──────────────────────────────────────────────
    const previewCard = this.card('পূর্বরূপ');
    const previewHost = d.createElement('div');
    previewHost.setAttribute('data-brand-preview', '');
    previewHost.append(this.previewContent());
    previewCard.append(previewHost);

    layout.append(form, previewCard);
    root.append(layout);
    // The contrast advice is toggled rather than conditionally built, so
    // it has to be evaluated once after every full render too.
    this.syncControls();
  }
}
