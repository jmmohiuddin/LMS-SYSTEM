/**
 * নোটিশ পাঠান — the composer  (R-2, docs/11-MASTER-PLAN.md)
 *
 * Where a head teacher decides who is told something. Three decisions on one
 * screen, in the order they are actually made: what to say, who it is for, and
 * whether it also goes to a phone.
 *
 * ── The audience picker is the screen ───────────────────────────────────
 * Everything else is a text box. The audience is where the mistake happens
 * and where it is expensive: a staff-only notice sent to `all` cannot be
 * recalled from 900 phones. So the chosen audience is restated in plain
 * Bangla above the send button — not as a form value the author set six
 * fields ago, but as a sentence they read at the moment they commit.
 *
 * ── The SMS cost is shown while it is being written ─────────────────────
 * Bangla forces UCS-2: 70 characters per segment, not 160. A 300-character
 * notice is five segments, and to 900 guardians that is 4,500 messages. The
 * segment count sits next to the SMS toggle and updates as the body grows,
 * because the moment to learn this is while writing, not on the invoice.
 */
import type { Auth } from './auth.ts';
import {
  AUDIENCE_LABELS_BN,
  CATEGORY_LABELS_BN,
  NOTICE_CATEGORIES,
  NOTICE_LIMITS,
  parseNotice,
  smsDefaultFor,
  smsSegmentsFor,
  NoticeError,
  type AudienceType,
  type NoticeCategory,
} from '../../../packages/ui-core/src/notice.ts';
import { formatCount } from '../../../packages/ui-core/src/format.ts';

const bn = (n: number): string => formatCount(n, 'bn');

export interface SectionOption {
  id: string;
  label: string;
}

export interface NoticeComposeOptions {
  root: HTMLElement;
  doc: Document;
  auth: Auth;
  /** Where to go after a successful publish. */
  onPublished?: () => void;
}

/** Audiences a class teacher may use. The server enforces this too. */
const TEACHER_AUDIENCES: AudienceType[] = ['section'];
const MANAGEMENT_ROLES = new Set(['principal', 'school_owner', 'academic_coordinator']);

export class NoticeComposeView {
  private readonly o: NoticeComposeOptions;
  private title = '';
  private body = '';
  private category: NoticeCategory = 'general';
  private audienceType: AudienceType = 'all';
  private selectedSections = new Set<string>();
  private sendSms = false;
  /**
   * R-8 §4. How many people this would reach and what it would cost, from the
   * server's own audience resolver.
   *
   * The screen already restated the audience as a sentence and showed the
   * segments per person. What it could not say was how many people "সব
   * অভিভাবক" IS. Choosing between "this section" and "all guardians" was
   * choosing between two phrases, one of which costs a hundred times more,
   * with nothing on screen saying so.
   */
  private estimate: {
    recipients: number; smsRecipients: number;
    segmentsEach: number; segmentsTotal: number;
    confirmThreshold: number; needsConfirmation: boolean;
  } | null = null;
  /** Set by the operator, for a send big enough to need saying out loud. */
  private bigSendAcknowledged = false;
  private estimateSeq = 0;
  private estimateTimer: ReturnType<typeof setTimeout> | null = null;
  /** ISO local datetime, or '' for "send now". */
  private publishAt = '';
  /** Set once by the category picker; after that the author owns the toggle. */
  private smsTouched = false;
  private sections: SectionOption[] = [];
  private busy = false;
  private notice = '';
  private noticeKind: 'ok' | 'error' | '' = '';
  private fieldError: { field: string; message: string } | null = null;

  constructor(options: NoticeComposeOptions) {
    this.o = options;
    if (!this.isManagement()) this.audienceType = 'section';
    this.render();
    void this.loadSections();
  }

  private isManagement(): boolean {
    return MANAGEMENT_ROLES.has(this.o.auth.role);
  }

  private allowedAudiences(): AudienceType[] {
    return this.isManagement()
      ? ['all', 'staff', 'students', 'guardians', 'section']
      : TEACHER_AUDIENCES;
  }

  private async loadSections(): Promise<void> {
    try {
      const res = await this.o.auth.authedFetch('/api/v1/academics/sections');
      if (!res.ok) return;
      const body = (await res.json()) as {
        sections: { id: string; name: string; className?: { bn?: string } }[];
      };
      this.sections = (body.sections ?? []).map((s) => ({
        id: s.id,
        label: `${s.className?.bn ?? ''} ${s.name}`.trim(),
      }));
      this.render();
    } catch { /* the picker simply has no options; the field error will say so */ }
  }

  private draft(): unknown {
    return {
      title: this.title,
      body: this.body,
      category: this.category,
      audience: this.audienceType === 'section'
        ? { type: 'section', ids: [...this.selectedSections] }
        : { type: this.audienceType },
      sendSms: this.sendSms,
    };
  }

  /** '' when sending now; otherwise the chosen local time as an ISO string. */
  private scheduleIso(): string | null {
    if (!this.publishAt) return null;
    const t = Date.parse(this.publishAt);
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  }

  /** The audience, as a sentence, for the confirmation line above Send. */
  private audienceSentence(): string {
    if (this.audienceType !== 'section') {
      return AUDIENCE_LABELS_BN[this.audienceType];
    }
    const n = this.selectedSections.size;
    if (n === 0) return 'কোনো শাখা বাছাই করা হয়নি';
    const names = this.sections
      .filter((s) => this.selectedSections.has(s.id))
      .map((s) => s.label);
    // Guardians receive a section notice too — say so, because "শাখা ৯-ক" reads
    // like students only, and it is not.
    return `${names.join(', ')} — শিক্ষার্থী ও অভিভাবক`;
  }

  private async send(): Promise<void> {
    if (this.busy) return;
    this.fieldError = null;
    this.notice = '';

    try {
      parseNotice(this.draft());
    } catch (err) {
      if (err instanceof NoticeError) {
        this.fieldError = { field: err.field, message: err.message };
        this.render();
        return;
      }
      throw err;
    }

    this.busy = true;
    this.render();
    try {
      const res = await this.o.auth.authedFetch('/api/v1/ops/notices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          notice: this.draft(),
          publish: true,
          publishAt: this.scheduleIso(),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        recipients?: number; smsQueued?: boolean; status?: string;
        message?: string; field?: string;
      };
      if (!res.ok) {
        if (body.field) this.fieldError = { field: body.field, message: body.message ?? 'ভুল আছে।' };
        else {
          this.notice = body.message ?? 'পাঠানো যায়নি। আবার চেষ্টা করুন।';
          this.noticeKind = 'error';
        }
        return;
      }
      const n = body.recipients ?? 0;
      if (body.status === 'scheduled') {
        // A scheduled notice has reached nobody yet, and saying "0 জনের কাছে
        // পৌঁছেছে" would read as a failure. Say what actually happened.
        this.notice = 'নির্ধারিত সময়ে পাঠানো হবে।';
      } else {
        this.notice = body.smsQueued
          ? `${bn(n)} জনের কাছে পৌঁছেছে · এসএমএস সারিতে দেওয়া হয়েছে`
          : `${bn(n)} জনের কাছে পৌঁছেছে`;
      }
      this.noticeKind = 'ok';
      this.title = '';
      this.body = '';
      this.publishAt = '';
      this.selectedSections.clear();
      this.smsTouched = false;
      this.sendSms = smsDefaultFor(this.category);
      this.o.onPublished?.();
    } catch {
      this.notice = 'সংযোগ নেই — নোটিশ পাঠানো যায়নি।';
      this.noticeKind = 'error';
    } finally {
      this.busy = false;
      this.render();
    }
  }

  /** Refresh only the parts that depend on the body: never re-render mid-type. */
  /**
   * R-8 §4. Ask again, but not on every keystroke.
   *
   * The estimate is a database query over the audience; firing it per
   * character would be a request per keystroke on a 2G connection, which is
   * the exact pattern docs/01 §8 forbids. 400 ms after typing stops is late
   * enough to be cheap and early enough to be read before the send button.
   */
  private scheduleEstimate(): void {
    if (this.estimateTimer !== null) clearTimeout(this.estimateTimer);
    this.estimateTimer = setTimeout(() => {
      this.estimateTimer = null;
      void this.refreshEstimate();
    }, 400);
  }

  private syncLive(): void {
    const root = this.o.root;
    const est = this.estimate;
    const scale = root.querySelector<HTMLElement>('[data-estimate]');
    if (scale) {
      scale.textContent = !est ? ''
        : est.smsRecipients > 0
          ? `${bn(est.recipients)} জন পাবে · ${bn(est.smsRecipients)} জনকে এসএমএস`
            + ` · আনুমানিক ${bn(est.segmentsTotal)}টি এসএমএস`
          : `${bn(est.recipients)} জন পাবে`;
    }
    const seg = root.querySelector<HTMLElement>('[data-sms-cost]');
    if (seg) {
      // The server's figure when there is one, because it is computed from the
      // message that would actually be SENT — title, trimmed body, and the
      // school's signature — while `smsSegmentsFor(this.body)` measures the
      // notice text alone and under-reports every message. Two numbers on one
      // screen disagreeing is worse than one number arriving a moment late.
      const each = est ? est.segmentsEach : smsSegmentsFor(this.body);
      seg.textContent = this.body ? `প্রতি জনে ${bn(each)}টি এসএমএস` : '';
    }
    const line = root.querySelector<HTMLElement>('[data-audience-line]');
    if (line) line.textContent = this.audienceSentence();
    const send = root.querySelector<HTMLButtonElement>('[data-send]');
    // R-8 §4. A send large enough to be a mistake needs the mistake said out
    // loud first. Below the threshold nothing changes.
    const blockedByScale = this.estimate?.needsConfirmation === true
      && !this.bigSendAcknowledged;
    if (send) {
      send.disabled = this.busy || !this.title.trim() || !this.body.trim()
        || blockedByScale;
    }
  }

  /**
   * Ask the server what this would cost.
   *
   * Debounced by sequence rather than by timer: the audience picker fires on
   * every click and the body on every keystroke, and a stale reply arriving
   * after a newer one would show the cost of a message that is no longer being
   * written. Only the newest answer is allowed to land.
   */
  private async refreshEstimate(): Promise<void> {
    const seq = ++this.estimateSeq;
    if (!this.title.trim() && !this.body.trim()) { this.estimate = null; return; }
    try {
      const res = await this.o.auth.authedFetch('/api/v1/ops/notices?preview=1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          audience: this.audienceType === 'section'
            ? { type: 'section', ids: [...this.selectedSections] }
            : { type: this.audienceType },
          title: this.title, body: this.body, sendSms: this.sendSms,
        }),
      });
      if (seq !== this.estimateSeq) return;
      if (!res.ok) { this.estimate = null; this.syncLive(); return; }
      const next = await res.json() as NonNullable<typeof this.estimate>;
      if (seq !== this.estimateSeq) return;
      // A changed audience invalidates an acknowledgement: saying yes to
      // "৮টি এসএমএস" must not carry over to "৪,৫০০টি".
      if (this.estimate && next.segmentsTotal !== this.estimate.segmentsTotal) {
        this.bigSendAcknowledged = false;
      }
      // A full render when the GATE changes, not just the numbers.
      //
      // `syncLive` updates text and button state in place — it does not build
      // the acknowledgement checkbox, which exists only in `render`. So an
      // estimate that arrived and flipped `needsConfirmation` to true disabled
      // the send button and drew nothing to re-enable it: a dead end, and a
      // worse outcome than having no gate at all. Caught by the test that asks
      // for the checkbox after a large estimate.
      const gateChanged = (this.estimate?.needsConfirmation ?? false)
        !== next.needsConfirmation;
      this.estimate = next;
      if (gateChanged) this.render(); else this.syncLive();
    } catch {
      // Offline: no estimate rather than a wrong one. The send button stays
      // enabled — the composer already works offline and the server counts
      // again at publish.
      if (seq === this.estimateSeq) { this.estimate = null; this.syncLive(); }
    }
  }

  private field(
    parent: HTMLElement,
    labelBn: string,
    key: 'title' | 'body',
    opts: { multiline?: boolean; max: number },
  ): void {
    const d = this.o.doc;
    const label = d.createElement('label');
    label.className = 'login-label brand-field';
    const span = d.createElement('span');
    span.textContent = labelBn;
    label.append(span);

    const input = opts.multiline ? d.createElement('textarea') : d.createElement('input');
    input.className = 'login-input';
    if (opts.multiline) (input as HTMLTextAreaElement).rows = 6;
    (input as HTMLInputElement | HTMLTextAreaElement).value = this[key];
    (input as HTMLInputElement).maxLength = opts.max;
    input.addEventListener('input', () => {
      this[key] = (input as HTMLInputElement).value;
      this.fieldError = null;
      this.syncLive();
      // The body decides the segment count and the title is part of the sent
      // message, so both change the estimate.
      this.scheduleEstimate();
    });
    label.append(input);

    if (this.fieldError?.field === key) {
      const err = d.createElement('p');
      err.className = 'login-error';
      err.setAttribute('role', 'alert');
      err.textContent = this.fieldError.message;
      label.append(err);
    }
    parent.append(label);
  }

  private render(): void {
    const d = this.o.doc;
    const root = this.o.root;
    root.textContent = '';

    const header = d.createElement('header');
    header.className = 'att-header brand-head';
    const h1 = d.createElement('h1');
    h1.textContent = 'নোটিশ পাঠান';
    const sub = d.createElement('p');
    sub.className = 'att-sub';
    sub.textContent = this.isManagement()
      ? 'যাদের জন্য পাঠাবেন, শুধু তারাই দেখবে।'
      : 'আপনি নিজের শাখাগুলোতে নোটিশ পাঠাতে পারবেন।';
    header.append(h1, sub);
    root.append(header);

    if (this.notice) {
      const n = d.createElement('p');
      n.className = this.noticeKind === 'error' ? 'login-error' : 'brand-ok';
      n.setAttribute('role', this.noticeKind === 'error' ? 'alert' : 'status');
      n.textContent = this.notice;
      root.append(n);
    }

    const form = d.createElement('div');
    form.className = 'brand-form';
    form.style.padding = '0 var(--s-4) var(--s-6)';

    // ── What ────────────────────────────────────────────────────────
    const what = d.createElement('section');
    what.className = 'card brand-card';
    const wh = d.createElement('h2');
    wh.className = 'brand-card-title';
    wh.textContent = 'বার্তা';
    what.append(wh);
    this.field(what, 'শিরোনাম', 'title', { max: NOTICE_LIMITS.title });
    this.field(what, 'বিস্তারিত', 'body', { multiline: true, max: NOTICE_LIMITS.body });

    const catLabel = d.createElement('label');
    catLabel.className = 'login-label brand-field';
    const catSpan = d.createElement('span');
    catSpan.textContent = 'ধরন';
    catLabel.append(catSpan);
    const cat = d.createElement('select');
    cat.className = 'login-input';
    for (const c of NOTICE_CATEGORIES) {
      const opt = d.createElement('option');
      opt.value = c;
      opt.textContent = CATEGORY_LABELS_BN[c];
      opt.selected = c === this.category;
      cat.append(opt);
    }
    cat.addEventListener('change', () => {
      this.category = cat.value as NoticeCategory;
      // The category suggests a default until the author touches the toggle;
      // after that it is theirs.
      if (!this.smsTouched) this.sendSms = smsDefaultFor(this.category);
      this.render();
    });
    catLabel.append(cat);
    what.append(catLabel);
    form.append(what);

    // ── Who ─────────────────────────────────────────────────────────
    const who = d.createElement('section');
    who.className = 'card brand-card';
    const whoH = d.createElement('h2');
    whoH.className = 'brand-card-title';
    whoH.textContent = 'কারা পাবে';
    who.append(whoH);

    const chips = d.createElement('div');
    chips.className = 'audience-chips';
    for (const a of this.allowedAudiences()) {
      const chip = d.createElement('button');
      chip.type = 'button';
      chip.className = 'audience-chip';
      chip.setAttribute('aria-pressed', String(this.audienceType === a));
      chip.textContent = AUDIENCE_LABELS_BN[a];
      chip.addEventListener('click', () => {
        this.audienceType = a;
        // The audience IS the cost. Changing it invalidates any
        // acknowledgement of the previous one.
        this.bigSendAcknowledged = false;
        void this.refreshEstimate();
        this.render();
      });
      chips.append(chip);
    }
    who.append(chips);

    if (this.audienceType === 'section') {
      const list = d.createElement('div');
      list.className = 'audience-sections';
      if (this.sections.length === 0) {
        const p = d.createElement('p');
        p.className = 'att-sub';
        p.textContent = 'কোনো শাখা পাওয়া যায়নি।';
        list.append(p);
      }
      for (const s of this.sections) {
        const row = d.createElement('label');
        row.className = 'audience-section';
        const box = d.createElement('input');
        box.type = 'checkbox';
        box.checked = this.selectedSections.has(s.id);
        box.addEventListener('change', () => {
          if (box.checked) this.selectedSections.add(s.id);
          else this.selectedSections.delete(s.id);
          this.bigSendAcknowledged = false;
          void this.refreshEstimate();
          this.syncLive();
        });
        const name = d.createElement('span');
        name.textContent = s.label;
        row.append(box, name);
        list.append(row);
      }
      who.append(list);
    }

    if (this.fieldError?.field === 'audience') {
      const err = d.createElement('p');
      err.className = 'login-error';
      err.setAttribute('role', 'alert');
      err.textContent = this.fieldError.message;
      who.append(err);
    }
    form.append(who);

    // ── How ─────────────────────────────────────────────────────────
    const how = d.createElement('section');
    how.className = 'card brand-card';
    const howH = d.createElement('h2');
    howH.className = 'brand-card-title';
    howH.textContent = 'কীভাবে পৌঁছাবে';
    how.append(howH);

    const inapp = d.createElement('p');
    inapp.className = 'att-sub';
    inapp.textContent = 'অ্যাপের নোটিফিকেশনে সবসময় যাবে।';
    how.append(inapp);

    const smsRow = d.createElement('label');
    smsRow.className = 'sms-toggle';
    const smsBox = d.createElement('input');
    smsBox.type = 'checkbox';
    smsBox.checked = this.sendSms;
    smsBox.addEventListener('change', () => {
      this.sendSms = smsBox.checked;
      this.smsTouched = true;
      // Turning SMS on is the single change that takes the cost from zero to
      // whatever the audience is, so it re-asks immediately rather than after
      // the typing debounce.
      this.bigSendAcknowledged = false;
      void this.refreshEstimate();
      this.render();
    });
    const smsText = d.createElement('span');
    smsText.textContent = 'মোবাইলে এসএমএসও পাঠান';
    smsRow.append(smsBox, smsText);
    how.append(smsRow);

    if (this.sendSms) {
      const cost = d.createElement('p');
      cost.className = 'sms-cost';
      cost.setAttribute('data-sms-cost', '');
      cost.setAttribute('role', 'status');
      cost.textContent = this.body
        ? `প্রতি জনে ${bn(this.estimate?.segmentsEach ?? smsSegmentsFor(this.body))}টি এসএমএস`
        : '';
      how.append(cost);
      const warn = d.createElement('p');
      warn.className = 'att-sub';
      // SMS is an alert, not the notice. Saying so here is what stops someone
      // pasting four paragraphs in and wondering why the bill grew.
      warn.textContent =
        'এসএমএসে সংক্ষিপ্ত বার্তা যাবে; পুরো নোটিশ অ্যাপে থাকবে। '
        + 'বাংলা লেখায় প্রতি ৭০ অক্ষরে একটি এসএমএস গণনা হয়।';
      how.append(warn);
    }

    // ── When ────────────────────────────────────────────────────────
    const when = d.createElement('label');
    when.className = 'login-label brand-field';
    const whenSpan = d.createElement('span');
    whenSpan.textContent = 'কখন পাঠানো হবে';
    when.append(whenSpan);
    const at = d.createElement('input');
    at.type = 'datetime-local';
    at.className = 'login-input';
    at.value = this.publishAt;
    at.addEventListener('change', () => { this.publishAt = at.value; this.render(); });
    when.append(at);
    const whenHint = d.createElement('p');
    whenHint.className = 'att-sub';
    // Honest about the granularity rather than implying minute precision the
    // nightly sweeper cannot deliver.
    whenHint.textContent = this.publishAt
      ? 'নির্ধারিত সময়ের পর পরবর্তী রক্ষণাবেক্ষণ চক্রে পাঠানো হবে।'
      : 'খালি রাখলে এখনই পাঠানো হবে।';
    when.append(whenHint);
    how.append(when);

    form.append(how);

    // ── Confirm ─────────────────────────────────────────────────────
    const confirm = d.createElement('div');
    confirm.className = 'notice-confirm';
    const line = d.createElement('p');
    line.className = 'notice-confirm-line';
    line.setAttribute('data-audience-line', '');
    line.textContent = this.audienceSentence();
    const lineLabel = d.createElement('span');
    lineLabel.className = 'notice-confirm-label';
    lineLabel.textContent = 'পাবে:';
    confirm.append(lineLabel, line);

    // ── R-8 §4. The scale of what is about to happen ────────────────
    const scale = d.createElement('p');
    scale.className = 'sms-cost';
    scale.setAttribute('data-estimate', '');
    scale.setAttribute('role', 'status');
    confirm.append(scale);

    const est = this.estimate;
    if (est) {
      // Two numbers, and the second is almost always the surprise: everyone
      // who gets the in-app notice, and the far smaller set who have a phone
      // on file and (for guardians) have consented. The bill is made of the
      // second one.
      scale.textContent = est.smsRecipients > 0
        ? `${bn(est.recipients)} জন পাবে · ${bn(est.smsRecipients)} জনকে এসএমএস`
          + ` · আনুমানিক ${bn(est.segmentsTotal)}টি এসএমএস`
        : `${bn(est.recipients)} জন পাবে`;
    }

    if (est?.needsConfirmation) {
      // Above the threshold the send button is not enough. A notice to a whole
      // school cannot be recalled from nine hundred phones, and the moment to
      // notice that is before the click, not in the invoice.
      const ack = d.createElement('label');
      ack.className = 'sms-toggle';
      ack.setAttribute('data-big-send', '');
      const box = d.createElement('input');
      box.type = 'checkbox';
      box.checked = this.bigSendAcknowledged;
      box.addEventListener('change', () => {
        this.bigSendAcknowledged = box.checked;
        this.syncLive();
      });
      const txt = d.createElement('span');
      txt.textContent = `আমি নিশ্চিত — ${bn(est.smsRecipients)} জনকে `
        + `${bn(est.segmentsTotal)}টি এসএমএস পাঠানো হবে`;
      ack.append(box, txt);
      confirm.append(ack);

      const why = d.createElement('p');
      why.className = 'att-sub';
      why.textContent = 'পাঠানো হয়ে গেলে আর ফেরানো যায় না।';
      confirm.append(why);
    }

    const actions = d.createElement('div');
    actions.className = 'action-row';
    const send = d.createElement('button');
    send.type = 'button';
    send.className = 'btn-primary';
    send.setAttribute('data-send', '');
    send.textContent = this.busy
      ? 'পাঠানো হচ্ছে…'
      : this.publishAt ? 'নির্ধারিত সময়ে পাঠান' : 'পাঠান';
    send.disabled = this.busy || !this.title.trim() || !this.body.trim()
      || (this.estimate?.needsConfirmation === true && !this.bigSendAcknowledged);
    send.addEventListener('click', () => { void this.send(); });
    actions.append(send);

    form.append(confirm, actions);
    root.append(form);
  }
}
