/**
 * "রুটিন তৈরি করুন" — READY → GENERATE → RESULT for a whole institution.
 *
 * P9-3. The screen the whole phase exists for: a coordinator presses one
 * button and their school has a timetable. Four decisions shape it.
 *
 * ── The verdict is one sentence, and it is the server's ────────────────────
 * `summary.verdictBn` is rendered, never composed here. A browser that
 * assembled its own sentence from the counters would drift from the numbers
 * beside it the first time either changed, and this screen's entire value is
 * that a head teacher can believe the sentence at the top of it.
 *
 * ── No fabricated progress ─────────────────────────────────────────────────
 * `POST /rms/generate` is one blocking request. There is no stream, no job
 * id, no percentage — so this shows a spinner and an ELAPSED SECOND COUNT,
 * which is true, and says in words that the server is doing the whole job in
 * one go. A progress bar creeping to 90% and sitting there is a lie a person
 * learns to distrust, and once they distrust the waiting they distrust the
 * result. `ui/feedback.ts:progress` is deliberately not imported.
 *
 * ── A hard conflict outranks everything ────────────────────────────────────
 * The teacher and room exclusion constraints only bind an ACTIVE routine, so
 * a draft can hold a clash that publish will refuse. The server counts them
 * from the stored rows; if the count is non-zero this screen leads with that
 * and says the routine cannot be published, because "সব ২৩৬০টি পিরিয়ড বসানো
 * হয়েছে" would be true and would send someone to publish a routine that
 * cannot be published.
 *
 * ── Unplaced demand is a to-do list, not an error ──────────────────────────
 * Every unplaced row names the class, the subject, the teacher and how many
 * periods are missing, with the reason in a sentence — because the four
 * reasons send a coordinator to four different places, and "generation
 * failed" sends them nowhere. A partial routine is a usable routine with
 * work left, and it is presented that way.
 */
import {
  el, pageHeader, card, button, buttonRow, statusBadge, sectionHeading,
  statRow, statCard, permissionState, deniedMessage, deniedContact,
  announce, inlineLoader, listSkeleton, openDrawer, successNote,
} from './ui/index.ts';
import { refuseUnlessOk, isDenied, HttpStatus } from './http-status.ts';
import type { Auth } from './auth.ts';

const BN_DIGITS = '০১২৩৪৫৬৭৮৯';
const bn = (n: number): string => String(n).replace(/\d/g, (d) => BN_DIGITS[Number(d)]);
const SHIFT_BN: Record<string, string> = {
  morning: 'সকাল', day: 'দিবা', evening: 'সান্ধ্য', single: 'একক',
};

interface Step {
  id: string; titleBn: string; state: 'ok' | 'warn' | 'blocked';
  detailBn: string; done: number; total: number;
}
interface Unplaced {
  /** P9-5 §16. Where to open the editor, so the coordinator lands in the
   *  week they were just reading about. */
  sectionId?: string;
  sectionName: string; subjectBn: string; teacherBn: string | null;
  required: number; placed: number; missing: number;
  reason: string; reasonBn: string;
}
interface Shortage { capability: string; detailBn: string }
interface ShiftResult {
  shift: string; routineId: string; version: number; created: boolean;
  totalDemand: number; placed: number;
  unplaced: Unplaced[];
  /** A count. The sentences live in `explanations`, grouped. */
  softViolations: number;
  shortages: Shortage[];
  solverSeconds: number;
}
interface Summary {
  totalDemand: number; placed: number; unplacedPeriods: number;
  unplacedDemands: number; softViolations: number; hardConflicts: number;
  shortages: Shortage[]; solverSeconds: number; totalSeconds: number;
  verdictBn: string;
}
/** P9-4. One finding, ready to render — the server composed every sentence. */
export interface Explanation {
  id: string;
  severity: 'error' | 'warning' | 'info';
  category: string;
  titleBn: string;
  whatBn: string;
  whyBn: string;
  affectedBn: string[];
  currentBn: string;
  impactBn: string;
  suggestions: Array<{ textBn: string; evidenceBn: string }>;
}

interface GenerateResult {
  shifts: ShiftResult[];
  summary: Summary;
  explanations?: Explanation[];
  severity?: { error: number; warning: number; info: number };
}

/**
 * §4/§14. The severity, as a WORD as well as a colour.
 *
 * A red dot is invisible to a screen reader and to the eight percent of men
 * who cannot separate it from the amber one, so the label carries the
 * meaning and the colour only reinforces it.
 */
/** How many rows of one severity to print before folding the rest into a count. */
const ROWS_SHOWN = 25;

const SEVERITY_BN: Record<Explanation['severity'], string> = {
  error: 'ঠিক করা দরকার', warning: 'সতর্কতা', info: 'তথ্য',
};
const SEVERITY_TONE: Record<Explanation['severity'],
  { state: 'blocked' | 'pending' | 'active'; tone: 'danger' | 'warn' | 'info' }> = {
  error: { state: 'blocked', tone: 'danger' },
  warning: { state: 'pending', tone: 'warn' },
  info: { state: 'active', tone: 'info' },
};
interface PriorRun {
  routineId: string; shift: string; version: number; status: string;
  slots: number; solverSeconds: number | null; generatedAt: string | null;
}

export interface RoutineGenerateViewOptions {
  root: HTMLElement;
  doc: Document;
  auth: Auth;
  yearId?: string;
  /** Where "প্রস্তুতি সম্পূর্ণ করুন" and "বিস্তারিত ব্যাখ্যা" send people. */
  onNavigate?: (path: string) => void;
  /** Injectable so the elapsed counter is testable without a real clock. */
  now?: () => number;
}

export class RoutineGenerateView {
  private readonly o: RoutineGenerateViewOptions;
  private readonly now: () => number;
  private yearId = '';

  private steps: Step[] = [];
  private canGenerate = false;
  private prior: PriorRun[] = [];
  private result: GenerateResult | null = null;

  private loading = true;
  private running = false;
  private startedAt = 0;
  private elapsed = 0;
  private ticker: ReturnType<typeof setInterval> | null = null;

  private denied = false;
  private deniedErr: unknown = null;
  private error = '';
  /** Set when a run was refused; keeps the retry button honest about why. */
  private failure: 'not_ready' | 'validation' | 'server' | 'offline' | null = null;

  constructor(options: RoutineGenerateViewOptions) {
    this.o = options;
    this.now = options.now ?? Date.now;
    this.yearId = options.yearId ?? '';
    void this.start();
  }

  /** Stop the elapsed counter when the router swaps this view out. */
  destroy(): void { this.stopTicker(); }

  private async start(): Promise<void> {
    if (!this.yearId) {
      try {
        const res = await this.o.auth.authedFetch('/api/v1/academics/hierarchy');
        await refuseUnlessOk(res);
        const b = await res.json() as
          { years?: Array<{ id: string; isCurrent?: boolean }>; year?: { id: string } };
        this.yearId = b.years?.find((y) => y.isCurrent)?.id ?? b.years?.[0]?.id
          ?? b.year?.id ?? '';
      } catch (err) {
        this.absorb(err, 'শিক্ষাবর্ষ আনা যায়নি — সংযোগ পেলে আবার দেখা যাবে।');
        this.loading = false; this.render(); return;
      }
    }
    await this.load();
  }

  /**
   * Readiness and any previous run, together.
   *
   * Both, always: a coordinator arriving after a refresh must see the result
   * they generated ten minutes ago, and a coordinator arriving for the first
   * time must see what is still missing. Which of those they are is not
   * knowable before both answers are in.
   */
  private async load(): Promise<void> {
    this.loading = true; this.render();
    const year = encodeURIComponent(this.yearId);
    try {
      const [setup, runs] = await Promise.all([
        this.o.auth.authedFetch(`/api/v1/rms/setup?yearId=${year}`),
        this.o.auth.authedFetch(`/api/v1/rms/generate?yearId=${year}`),
      ]);
      await refuseUnlessOk(setup);
      const s = await setup.json() as { steps?: Step[]; canGenerate?: boolean };
      this.steps = s.steps ?? [];
      this.canGenerate = Boolean(s.canGenerate);

      // A prior run that cannot be read is not a reason to hide the button.
      if (runs.ok) {
        this.prior = ((await runs.json()) as { runs?: PriorRun[] }).runs ?? [];
      }
      this.error = ''; this.failure = null;
    } catch (err) {
      this.absorb(err, 'প্রস্তুতির তথ্য আনা যায়নি — সংযোগ পেলে আবার দেখা যাবে।');
    } finally {
      this.loading = false; this.render();
    }
  }

  private absorb(err: unknown, fallbackBn: string): void {
    if (isDenied(err)) { this.denied = true; this.deniedErr = err; return; }
    this.error = fallbackBn;
  }

  private startTicker(): void {
    this.stopTicker();
    this.startedAt = this.now();
    this.elapsed = 0;
    this.ticker = setInterval(() => {
      this.elapsed = Math.floor((this.now() - this.startedAt) / 1000);
      this.render();
    }, 1000);
  }

  private stopTicker(): void {
    if (this.ticker !== null) { clearInterval(this.ticker); this.ticker = null; }
  }

  /**
   * The one action.
   *
   * Every failure below leaves the screen saying something a person can act
   * on. §3 forbids the bare "Generation failed." — a coordinator who is told
   * only that has no next step, and the four causes have four different ones.
   */
  private async generate(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.error = ''; this.failure = null;
    this.startTicker();
    this.render();
    announce(this.o.doc, 'রুটিন তৈরি শুরু হয়েছে');

    try {
      const res = await this.o.auth.authedFetch('/api/v1/rms/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ yearId: this.yearId }),
      });
      if (res.status === 403) { await refuseUnlessOk(res); }

      const body = await res.json().catch(() => ({})) as Record<string, unknown>;
      if (!res.ok) { this.refused(res.status, body); return; }

      this.result = body as unknown as GenerateResult;
      // The readiness panel and the prior-run list are both stale now.
      await this.load();
      announce(this.o.doc, (this.result.summary?.verdictBn ?? 'রুটিন তৈরি হয়েছে'));
      return;
    } catch (err) {
      if (err instanceof HttpStatus && err.status === 403) {
        this.denied = true; this.deniedErr = err;
      } else {
        this.failure = 'offline';
        this.error = 'সার্ভারে পৌঁছানো যায়নি। সংযোগ ফিরলে আবার চেষ্টা করুন।';
      }
    } finally {
      this.running = false;
      this.stopTicker();
      this.render();
    }
  }

  /** Turn a refusal into the sentence and the next step it implies. */
  private refused(status: number, body: Record<string, unknown>): void {
    const message = typeof body.message === 'string' ? body.message : '';
    const code = typeof body.error === 'string' ? body.error : '';

    if (status === 409 && code === 'not_ready') {
      // The server's list wins over the one this screen loaded, because it
      // is the one the refusal was actually made on.
      const steps = Array.isArray(body.steps) ? body.steps as Step[] : [];
      if (steps.length > 0) {
        const byId = new Map(steps.map((s) => [s.id, s]));
        this.steps = this.steps.map((s) => byId.get(s.id) ?? s);
        for (const s of steps) if (!this.steps.some((x) => x.id === s.id)) this.steps.push(s);
      }
      this.canGenerate = false;
      this.failure = 'not_ready';
      this.error = message || 'কিছু ধাপ এখনও বাকি আছে।';
      return;
    }
    if (status === 400) {
      this.failure = 'validation';
      this.error = message || 'তথ্যে সমস্যা আছে — প্রস্তুতির ধাপগুলো দেখে নিন।';
      return;
    }
    this.failure = 'server';
    this.error = message
      || 'সার্ভারে সমস্যা হয়েছে। আবার চেষ্টা করুন — আগের কাজ হারায়নি, '
       + 'দ্বিতীয়বার চাপলে বাকি অংশটুকুই বসবে।';
  }

  /* ────────────────────────────── rendering ───────────────────────────── */

  private render(): void {
    const d = this.o.doc;
    const root = this.o.root;
    root.textContent = '';
    root.append(pageHeader(d, {
      title: 'রুটিন তৈরি করুন',
      subtitle: 'পুরো প্রতিষ্ঠানের সাপ্তাহিক ক্লাস রুটিন — এক ধাপে',
    }));

    if (this.denied) {
      root.append(permissionState(d, {
        message: deniedMessage(this.deniedErr, 'রুটিন তৈরি'),
        contact: deniedContact(this.deniedErr),
      }));
      return;
    }
    if (this.loading && !this.running) { root.append(listSkeleton(d, 3)); return; }
    if (this.running) { root.append(this.runningCard()); return; }

    if (this.error) {
      root.append(this.problemCard());
    }
    root.append(this.actionCard());
    if (this.result) root.append(...this.resultCards());
    else if (this.prior.length > 0) root.append(this.priorCard());
  }

  /** §3 — generating. Elapsed seconds, and no invented percentage. */
  private runningCard(): HTMLElement {
    const d = this.o.doc;
    const body = el(d, 'div', { className: 'ui-stack' });
    body.append(inlineLoader(d, 'রুটিন তৈরি হচ্ছে'));
    body.append(el(d, 'p', {
      className: 'gen-counter',
      text: `${bn(this.elapsed)} সেকেন্ড চলছে`,
    }));
    // Honest about the shape of the wait, because there is no percentage to
    // give and a made-up one would be worse than none.
    body.append(el(d, 'p', {
      className: 'ui-card-note',
      text: 'সার্ভার পুরো কাজটি একবারেই করছে, তাই কত শতাংশ হয়েছে তা বলা যাচ্ছে না। '
          + 'বড় প্রতিষ্ঠানে কয়েক সেকেন্ড লাগতে পারে। পাতা বন্ধ করবেন না।',
    }));
    return card(d, { title: 'অপেক্ষা করুন', glyph: 'clock' }, body);
  }

  /** §3 — validation-failure, server-error, offline, and not-ready. */
  private problemCard(): HTMLElement {
    const d = this.o.doc;
    const body = el(d, 'div', { className: 'ui-stack' });
    body.append(el(d, 'p', { className: 'ui-card-lead', text: this.error }));

    if (this.failure === 'not_ready') {
      body.append(el(d, 'p', {
        className: 'ui-card-note',
        text: 'নিচের ধাপগুলো শেষ হলে বোতামটি নিজে থেকেই চালু হবে।',
      }));
    }
    if (this.failure === 'server' || this.failure === 'offline') {
      body.append(buttonRow(d, button(d, {
        label: 'আবার চেষ্টা করুন', variant: 'primary',
        onClick: () => void this.generate(),
      })));
    }
    return card(d, {
      title: this.failure === 'not_ready' ? 'এখনই তৈরি করা যাবে না' : 'সমস্যা হয়েছে',
      glyph: 'alert-triangle', tone: 'warn',
    }, body);
  }

  /** The readiness panel and the one button. */
  private actionCard(): HTMLElement {
    const d = this.o.doc;
    const body = el(d, 'div', { className: 'ui-stack' });

    const blocked = this.steps.filter((s) => s.state === 'blocked');
    const warned = this.steps.filter((s) => s.state === 'warn');

    if (blocked.length > 0) {
      body.append(el(d, 'p', {
        className: 'ui-card-lead',
        text: `${bn(blocked.length)}টি ধাপ বাকি — সেগুলো ছাড়া রুটিন তৈরি করা যাবে না।`,
      }));
      const list = el(d, 'ul', { className: 'gen-trades' });
      for (const s of blocked) {
        const li = el(d, 'li');
        li.append(el(d, 'span', { className: 'gen-trade-what', text: s.titleBn }));
        li.append(el(d, 'span', { className: 'gen-trade-why', text: s.detailBn }));
        list.append(li);
      }
      body.append(list);
    } else {
      body.append(el(d, 'p', {
        className: 'ui-card-lead', text: 'সব প্রয়োজনীয় তথ্য পাওয়া গেছে।',
      }));
      if (warned.length > 0) {
        body.append(el(d, 'p', {
          className: 'ui-card-note',
          text: `${bn(warned.length)}টি ঐচ্ছিক বিষয় বাকি — রুটিন তৈরি হবে, `
              + 'তবে সেগুলো দিলে ফলাফল আরও ভালো হয়।',
        }));
      }
    }

    const go = button(d, {
      label: this.prior.length > 0 ? 'আবার তৈরি করুন' : 'রুটিন তৈরি করুন',
      variant: 'primary',
      disabled: !this.canGenerate,
      onClick: () => void this.generate(),
    });
    const row = buttonRow(d, go, button(d, {
      label: 'প্রস্তুতি দেখুন', variant: 'ghost',
      onClick: () => this.o.onNavigate?.('routinesetup'),
    }));
    body.append(row);

    if (this.prior.length > 0) {
      // Idempotency, said out loud. The commonest fear at this button is
      // that a second press will produce a second timetable.
      body.append(el(d, 'p', {
        className: 'ui-card-note',
        text: 'আবার চাপলে নতুন রুটিন তৈরি হবে না — যেগুলো এখনও বসেনি, '
            + 'শুধু সেগুলোই বসানোর চেষ্টা হবে।',
      }));
    }
    return card(d, { title: 'তৈরি করুন', glyph: 'check-square' }, body);
  }

  /* ─────────────────────────────── result ─────────────────────────────── */

  /**
   * §4/§12 — the findings, separated by severity, or a calm success state.
   *
   * A school with nothing wrong must not be handed a panel of empty headings
   * to read. The `info` rows still show, because "০ সমস্যা" means "০ of the
   * rules we checked" and saying which rules were not checked is what makes
   * the clean report believable — but they sit under a success note rather
   * than under a warning.
   */
  private findingsCard(items: Explanation[], summary: Summary): HTMLElement {
    const d = this.o.doc;
    const body = el(d, 'div', { className: 'ui-stack' });
    const errors = items.filter((i) => i.severity === 'error');
    const warnings = items.filter((i) => i.severity === 'warning');
    const infos = items.filter((i) => i.severity === 'info');

    // "No problems found" is a CLAIM, and it is checked against the summary
    // before it is made. An empty list is not the same as a clean run: a
    // response from an older build, or one that lost its explanations on the
    // way, would produce an empty array beside twelve unplaced periods — and
    // the reassuring sentence would be the only thing on screen that was
    // wrong. Caught by a P9-3 fixture that predates this field.
    const clean = summary.unplacedPeriods === 0 && summary.hardConflicts === 0;
    if (items.length === 0 && !clean) {
      body.append(el(d, 'p', {
        className: 'ui-card-lead',
        text: 'এই ফলাফলের ব্যাখ্যা পাওয়া যায়নি।',
      }));
      body.append(el(d, 'p', {
        className: 'ui-card-note',
        text: `উপরের সংখ্যাগুলো অনুযায়ী ${bn(summary.unplacedPeriods)}টি পিরিয়ড বাকি আছে — `
            + 'কারণ জানতে আবার তৈরি করুন।',
      }));
      return card(d, { title: 'কী পাওয়া গেল', glyph: 'alert-triangle' }, body);
    }

    if (errors.length === 0 && warnings.length === 0) {
      body.append(successNote(d, 'কোনো সমস্যা পাওয়া যায়নি — রুটিনটি ব্যবহারের জন্য প্রস্তুত।'));
    } else {
      body.append(el(d, 'p', {
        className: 'ui-card-lead',
        text: [
          errors.length > 0 ? `${bn(errors.length)}টি বিষয় ঠিক করা দরকার` : '',
          warnings.length > 0 ? `${bn(warnings.length)}টি সতর্কতা` : '',
        ].filter(Boolean).join(' · '),
      }));
      if (errors.length === 0) {
        // The distinction §4 exists for: nothing here blocks anything.
        body.append(el(d, 'p', {
          className: 'ui-card-note',
          text: 'কোনোটিই রুটিন ব্যবহারে বাধা দেয় না — ঠিক করলে ফলাফল আরও ভালো হবে।',
        }));
      }
    }

    for (const [heading, group] of [
      ['ঠিক করা দরকার', errors],
      ['সতর্কতা', warnings],
      ['যা যাচাই করা হয়নি', infos],
    ] as const) {
      if (group.length === 0) continue;
      body.append(sectionHeading(d, {
        title: `${heading} — ${bn(group.length)}টি`, level: 3,
      }));
      const list = el(d, 'ul', { className: 'gen-findings' });
      // A backstop, not the mechanism. The server groups the repetitive
      // findings already; this exists so that a category nobody has grouped
      // yet cannot put 1,500 interactive rows on a phone — which the
      // 80-section benchmark did before the grouping landed.
      for (const item of group.slice(0, ROWS_SHOWN)) list.append(this.findingRow(item));
      body.append(list);
      if (group.length > ROWS_SHOWN) {
        body.append(el(d, 'p', {
          className: 'ui-card-note',
          text: `আরও ${bn(group.length - ROWS_SHOWN)}টি একই ধরনের বিষয় আছে।`,
        }));
      }
    }
    return card(d, { title: 'কী পাওয়া গেল', glyph: 'alert-triangle' }, body);
  }

  /** One finding: a severity word, the sentence, and a way into the detail. */
  private findingRow(item: Explanation): HTMLElement {
    const d = this.o.doc;
    const li = el(d, 'li', { className: 'gen-finding', data: { severity: item.severity } });
    const badge = SEVERITY_TONE[item.severity];
    // The button IS the row, so the whole line is one tap target on a phone
    // and one stop for a keyboard.
    const open = el(d, 'button', {
      className: 'gen-finding-open',
      attrs: { type: 'button', 'aria-label': `${SEVERITY_BN[item.severity]}: ${item.titleBn}` },
    });
    open.append(statusBadge(d, { state: badge.state, label: SEVERITY_BN[item.severity],
                                 tone: badge.tone }));
    open.append(el(d, 'span', { className: 'gen-finding-title', text: item.titleBn }));
    open.append(el(d, 'span', { className: 'gen-finding-more', text: 'কেন?' }));
    open.addEventListener('click', () => this.openExplanation(item));
    li.append(open);
    return li;
  }

  /**
   * §6 — the focused panel: কারণ → বর্তমান অবস্থা → প্রভাব → সম্ভাব্য সমাধান.
   *
   * `openDrawer` owns the dialog semantics, the focus trap and the return of
   * focus to the row that opened it, so none of that is re-implemented here.
   * Every sentence is the server's; nothing on this screen composes an
   * explanation, because a browser-side rewrite is how a claim drifts away
   * from the evidence that justified it.
   */
  private openExplanation(item: Explanation): void {
    const d = this.o.doc;
    const body = el(d, 'div', { className: 'ui-stack' });
    const badge = SEVERITY_TONE[item.severity];
    body.append(statusBadge(d, { state: badge.state, label: SEVERITY_BN[item.severity],
                                 tone: badge.tone }));

    const section = (headingBn: string, ...children: HTMLElement[]) => {
      body.append(sectionHeading(d, { title: headingBn, level: 3 }));
      for (const c of children) body.append(c);
    };

    section('কারণ',
      el(d, 'p', { className: 'ui-card-lead', text: item.whatBn }),
      el(d, 'p', { className: 'ui-card-note', text: item.whyBn }));

    if (item.affectedBn.length > 0) {
      const who = el(d, 'ul', { className: 'gen-affected' });
      for (const a of item.affectedBn) who.append(el(d, 'li', { text: a }));
      section('কারা জড়িত', who);
    }

    section('বর্তমান অবস্থা', el(d, 'p', { className: 'ui-card-note', text: item.currentBn }));
    section('প্রভাব', el(d, 'p', { className: 'ui-card-note', text: item.impactBn }));

    if (item.suggestions.length > 0) {
      const list = el(d, 'ul', { className: 'gen-trades' });
      for (const s of item.suggestions) {
        const li = el(d, 'li');
        li.append(el(d, 'span', { className: 'gen-trade-what', text: s.textBn }));
        // Why this is worth trying HERE. Without it a suggestion is advice;
        // with it, it is an argument.
        li.append(el(d, 'span', { className: 'gen-trade-why', text: s.evidenceBn }));
        list.append(li);
      }
      section('সম্ভাব্য সমাধান', list);
    } else {
      // Saying so beats an empty heading, and beats inventing one.
      section('সম্ভাব্য সমাধান', el(d, 'p', {
        className: 'ui-card-note',
        text: 'এই তথ্য থেকে নিশ্চিত কোনো সমাধান বলা যাচ্ছে না।',
      }));
    }

    openDrawer(d, { title: item.titleBn, body });
  }


  private resultCards(): HTMLElement[] {
    const d = this.o.doc;
    const r = this.result as GenerateResult;
    const s = r.summary;
    const out: HTMLElement[] = [];

    const head = el(d, 'div', { className: 'ui-stack' });
    head.append(el(d, 'p', {
      className: `gen-counter ${s.hardConflicts > 0 || s.unplacedPeriods > 0 ? 'is-warn' : 'is-ok'}`,
      text: s.verdictBn,
    }));
    head.append(statRow(d,
      statCard(d, {
        label: 'শাখা', value: bn(r.shifts.length),
        note: r.shifts.map((x) => SHIFT_BN[x.shift] ?? x.shift).join(' · '),
        glyph: 'layers',
      }),
      statCard(d, {
        label: 'বসানো পিরিয়ড', value: `${bn(s.placed)} / ${bn(s.totalDemand)}`,
        note: s.unplacedPeriods === 0 ? 'সবগুলো' : `${bn(s.unplacedPeriods)}টি বাকি`,
        tone: s.unplacedPeriods === 0 ? 'success' : 'warn', glyph: 'check-square',
      }),
      statCard(d, {
        label: 'কঠিন শর্ত লঙ্ঘন', value: bn(s.hardConflicts),
        note: s.hardConflicts === 0
          ? 'একই সময়ে দুই জায়গায় কেউ নেই'
          : 'এই রুটিন প্রকাশ করা যাবে না',
        tone: s.hardConflicts === 0 ? 'success' : 'warn', glyph: 'alert-triangle',
      }),
      statCard(d, {
        label: 'নরম শর্তে ছাড়', value: bn(s.softViolations),
        note: 'ভালো হতে পারত, কিন্তু আটকায়নি', glyph: 'trending-up',
      }),
      statCard(d, {
        label: 'সময় লেগেছে', value: `${bn(Math.round(s.totalSeconds))} সেকেন্ড`,
        note: `সমাধানে ${bn(Math.round(s.solverSeconds * 10) / 10)} সেকেন্ড`,
        glyph: 'clock',
      }),
    ));
    out.push(card(d, { title: 'ফলাফল', glyph: 'award' }, head));

    // P9-4. ONE list of problems, not three. The unplaced rows, the room
    // shortages, the soft trades and the optional gaps were separate sections
    // saying overlapping things; a coordinator had to read all of them to
    // learn what to do first. `explanations` is that list, already ordered,
    // already worded, already ranked by severity.
    out.push(this.findingsCard(r.explanations ?? [], s));

    if (s.hardConflicts > 0) {
      // The one finding that also needs a control: the editor is where it
      // gets fixed, and a routine carrying one cannot be published.
      out.push(card(d, { title: 'সংঘর্ষ রয়ে গেছে', glyph: 'alert-triangle', tone: 'warn' },
        el(d, 'div', { className: 'ui-stack' },
          el(d, 'p', {
            className: 'ui-card-note',
            text: 'রুটিন সম্পাদনা পাতায় গিয়ে সংঘর্ষগুলো সরালে প্রকাশ করা যাবে।',
          }),
          buttonRow(d, button(d, {
            label: 'রুটিন সম্পাদনা', variant: 'primary',
            onClick: () => this.o.onNavigate?.('routineeditor'),
          })))));
    }

    for (const shift of r.shifts) out.push(this.shiftCard(shift));
    return out;
  }

  private shiftCard(shift: ShiftResult): HTMLElement {
    const d = this.o.doc;
    const body = el(d, 'div', { className: 'ui-stack' });
    const name = SHIFT_BN[shift.shift] ?? shift.shift;

    const line = el(d, 'div', { className: 'ui-cell-line' });
    line.append(shift.unplaced.length === 0
      ? statusBadge(d, { state: 'active', label: 'সম্পূর্ণ', tone: 'success' })
      : statusBadge(d, { state: 'pending', label: 'আংশিক', tone: 'warn' }));
    line.append(el(d, 'span', {
      className: 'ui-cell-meta',
      text: `${bn(shift.placed)} / ${bn(shift.totalDemand)} পিরিয়ড · সংস্করণ ${bn(shift.version)}`,
    }));
    body.append(line);

    if (shift.unplaced.length > 0) {
      // The rows themselves live in "কী পাওয়া গেল", once, with their
      // reasons and their fixes. Repeating them per shift gave a coordinator
      // the same list twice and no way to tell which copy was the real one.
      body.append(el(d, 'p', {
        className: 'ui-card-note',
        text: `${bn(shift.unplaced.length)}টি বিষয়ে পিরিয়ড বাকি আছে — `
            + 'কারণ ও সমাধান উপরের তালিকায়।',
      }));
    }

    body.append(buttonRow(d,
      button(d, {
        label: 'বিস্তারিত ব্যাখ্যা', variant: 'secondary',
        onClick: () => this.o.onNavigate?.(`generation?routineId=${shift.routineId}`),
      }),
      button(d, {
        label: 'রুটিন সম্পাদনা', variant: 'ghost',
        // P9-5 §16. The first unplaced demand names a section; opening the
        // editor there puts the coordinator in the week they were just
        // reading about rather than in whichever one the picker defaults to.
        onClick: () => this.o.onNavigate?.(
          shift.unplaced[0]?.sectionId
            ? `routineeditor?sectionId=${shift.unplaced[0].sectionId}`
            : 'routineeditor'),
      })));
    return card(d, { title: `${name} শিফট`, glyph: 'clock', headingLevel: 3 }, body);
  }

  /** §13 — a run from before this page was opened. */
  private priorCard(): HTMLElement {
    const d = this.o.doc;
    const body = el(d, 'div', { className: 'ui-stack' });
    body.append(el(d, 'p', {
      className: 'ui-card-note',
      text: 'আগে তৈরি করা খসড়া রুটিন পাওয়া গেছে। আবার তৈরি করলে এগুলোই পূরণ হবে।',
    }));
    const list = el(d, 'ul', { className: 'gen-trades' });
    for (const run of this.prior) {
      const li = el(d, 'li');
      li.append(el(d, 'span', {
        className: 'gen-trade-what',
        text: `${SHIFT_BN[run.shift] ?? run.shift} শিফট — ${bn(run.slots)}টি পিরিয়ড বসানো আছে`,
      }));
      li.append(el(d, 'span', {
        className: 'gen-trade-why',
        text: `সংস্করণ ${bn(run.version)}`
            + (run.solverSeconds === null
              ? '' : ` · ${bn(Math.round(run.solverSeconds * 10) / 10)} সেকেন্ডে তৈরি`),
      }));
      list.append(li);
    }
    body.append(list);
    body.append(buttonRow(d, ...this.prior.map((run) => button(d, {
      label: `${SHIFT_BN[run.shift] ?? run.shift} — বিস্তারিত`,
      variant: 'ghost',
      onClick: () => this.o.onNavigate?.(`generation?routineId=${run.routineId}`),
    }))));
    return card(d, { title: 'আগের ফলাফল', glyph: 'clock' }, body);
  }
}
