/**
 * "রুটিন প্রকাশ" — read the timetable, then make it the school's.  (P9-7)
 *
 * The last screen in the routine workstream, and the only one whose button
 * cannot be undone. Everything before it is reversible: a draft can be
 * regenerated, an edit undone, a scoped re-solve rolled back. The moment
 * `status` becomes `active`, three thousand guardians are looking at it.
 *
 * ── The server decides; this screen reports ──────────────────────────────
 * `canPublish`, the blockers and the warnings are all computed by
 * `src/publish-gate.ts`, which is the same function the publish endpoint
 * enforces. Nothing here re-derives them. A screen that made its own ruling
 * would eventually say "প্রকাশ করা যাবে" about a routine the server refuses,
 * and a head who has been lied to once stops reading the screen.
 *
 * The button is still disabled when there are blockers — but as a courtesy,
 * not as the gate. §3: the UI is not authoritative.
 *
 * ── What a head is actually deciding ─────────────────────────────────────
 * §2 asks for the facts and §6 for the consequence. A head is not auditing
 * five hundred rows; they are answering "is this the week we will teach?".
 * So the screen leads with the verdict, then the numbers that would change
 * their mind — conflicts, gaps, what is being replaced — and the confirmation
 * says in words what publishing does to the people downstream.
 *
 * ── Two decisions, kept apart ────────────────────────────────────────────
 * "পর্যালোচনার জন্য পাঠান" hands the draft to the head. "প্রকাশ করুন" makes
 * it real. In most Bangladeshi schools that is one person doing both, which
 * is why neither is required — but a school where the coordinator builds and
 * the head signs off now has somewhere to do it, and `review` is a status the
 * schema has carried since migration 006 with nothing ever writing it.
 *
 * ── Online only, and it says why ─────────────────────────────────────────
 * §14. Publishing is not queued. Whether a routine can go live depends on
 * every other routine in the school at that instant, so two offline devices
 * could queue two publications that are each valid alone and together are
 * not. Offline, the action is disabled with that reason in a sentence — not
 * hidden, because a coordinator who cannot find the button assumes the
 * feature is broken.
 */
import {
  el, pageHeader, card, button, buttonRow, statusBadge, sectionHeading,
  statRow, statCard, permissionState, deniedMessage, deniedContact,
  announce, listSkeleton, confirmOverlay, emptyState, errorState,
} from './ui/index.ts';
import { refuseUnlessOk, isDenied } from './http-status.ts';
import {
  formatCount, formatDayMonth, formatTime,
} from '../../../packages/ui-core/src/format.ts';
import type { Auth } from './auth.ts';

/** One thing wrong, in the server's words. */
export interface Finding {
  code: string;
  messageBn: string;
  actionBn?: string;
}

/** One routine, as the review endpoint describes it. */
export interface ReviewEntry {
  routineId: string;
  status: string;
  statusBn: string;
  version: number;
  shift: string;
  shiftBn: string;
  nameBn: string;
  yearLabel: string;
  slots: number;
  sections: number;
  teachers: number;
  pinned: number;
  hardConflicts: number;
  softViolations: number;
  unplacedDemands: number;
  lastModified: string | null;
  fingerprint: string;
  publishedAt: string | null;
  publishedByBn: string | null;
  supersedes: { version: number; publishedAt: string | null } | null;
  /** §6. What publishing would do — the server's sentences, not ours. */
  consequenceBn: string[];
  verdictBn: string;
  blockers: Finding[];
  warnings: Finding[];
  canPublish: boolean;
}

export interface RoutinePublishViewOptions {
  root: HTMLElement;
  doc: Document;
  auth: Auth;
  yearId?: string;
  /** Where "রুটিন সম্পাদনা করুন" and "রুটিন তৈরি করুন" send people. */
  onNavigate?: (path: string) => void;
  /** Injectable so the offline branch is testable. */
  online?: () => boolean;
}

/**
 * A timestamp a head reads, built from the product's own formatters.
 *
 * NOT `Intl.DateTimeFormat('bn-BD')`, which was the first version of this and
 * produced "৭ সেপ্টেম্বর, ২০২৬ এ ১০:৩৮ AM" — a Latin meridiem in the middle
 * of a Bangla sentence, and exactly the kind of leak P9-4 spent a section
 * removing. Bangla uses a 24-hour clock, which is what `formatTime` writes.
 */
const dateBn = (iso: string | null): string => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
            + `-${String(d.getDate()).padStart(2, '0')}`;
  const hm = `${String(d.getHours()).padStart(2, '0')}:`
           + `${String(d.getMinutes()).padStart(2, '0')}`;
  return `${formatDayMonth(ymd, 'bn')} ${formatCount(d.getFullYear(), 'bn')}, `
       + `${formatTime(hm, 'bn')}`;
};

export class RoutinePublishView {
  private readonly o: RoutinePublishViewOptions;
  private readonly online: () => boolean;
  private yearId = '';

  private tenantNameBn = '';
  private yearLabel = '';
  private entries: ReviewEntry[] = [];

  private loading = true;
  private busy = '';
  private denied = false;
  private deniedErr: unknown = null;
  private error = '';
  private notice: { text: string; tone: 'ok' | 'warn' } | null = null;

  constructor(options: RoutinePublishViewOptions) {
    this.o = options;
    this.online = options.online ?? (() => navigator.onLine);
    this.yearId = options.yearId ?? '';
    void this.start();
  }

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

  private async load(): Promise<void> {
    this.loading = true; this.render();
    try {
      const res = await this.o.auth.authedFetch(
        `/api/v1/rms/publish?yearId=${encodeURIComponent(this.yearId)}`);
      await refuseUnlessOk(res);
      const b = await res.json() as {
        tenantNameBn?: string; yearLabel?: string; routines?: ReviewEntry[];
      };
      this.tenantNameBn = b.tenantNameBn ?? '';
      this.yearLabel = b.yearLabel ?? '';
      this.entries = b.routines ?? [];
      this.error = '';
    } catch (err) {
      this.absorb(err, this.online()
        ? 'রুটিনের তথ্য আনা যায়নি — একটু পরে আবার চেষ্টা করুন।'
        : 'সংযোগ নেই — রুটিন প্রকাশের তথ্য দেখতে ইন্টারনেট লাগবে।');
    } finally {
      this.loading = false; this.render();
    }
  }

  private absorb(err: unknown, fallbackBn: string): void {
    if (isDenied(err)) { this.denied = true; this.deniedErr = err; return; }
    this.error = fallbackBn;
  }

  /* ------------------------------------------------------------ actions */

  /**
   * One request for all three transitions.
   *
   * Every refusal below leaves a sentence on screen. The server's `message`
   * is preferred over anything composed here, because it is the one that
   * knows WHY — "একই সময়ে একই শিক্ষক" rather than "প্রকাশ করা গেল না".
   */
  private async send(
    action: 'submit' | 'withdraw' | 'publish', e: ReviewEntry,
    extra: Record<string, unknown> = {},
  ): Promise<boolean> {
    this.busy = `${action}:${e.routineId}`;
    this.notice = null;
    this.render();
    try {
      const res = await this.o.auth.authedFetch('/api/v1/rms/publish', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, routineId: e.routineId, ...extra }),
      });
      const body = await res.json().catch(() => ({})) as {
        ok?: boolean; message?: string; messageBn?: string; error?: string;
        warnings?: Finding[]; actionBn?: string;
      };
      // A refused ACTION is not a refused SCREEN. This used to call
      // `refuseUnlessOk`, which throws and replaces the whole review with the
      // permission panel — so a head who was reading their timetable lost it
      // and was told they may not see it, which was not what happened. Found
      // in the demo, whose 403 means "this build does not write" and which
      // wiped the page it had just drawn. The denial panel stays for a
      // refused READ in `load()`, where it is the truth.
      //
      // The server's own sentence is rendered below either way, and it is the
      // one that knows whether this was a role, a conflict or a demo.
      if (res.ok && body.ok) {
        this.notice = {
          text: body.messageBn ?? 'হয়ে গেছে।',
          tone: 'ok',
        };
        announce(this.o.doc, this.notice.text);
        this.busy = '';
        await this.load();
        return true;
      }
      // §5. The server refuses an unconfirmed publish and hands back what it
      // wanted confirmed. Re-asking with those warnings on screen is the
      // point of the refusal, not an error to report.
      if (body.error === 'warnings_unconfirmed') {
        this.busy = ''; this.render();
        this.confirmPublish(e, body.warnings ?? []);
        return false;
      }
      this.notice = {
        text: [body.message, body.actionBn].filter(Boolean).join(' ')
          || 'কাজটি করা যায়নি।',
        tone: 'warn',
      };
      announce(this.o.doc, this.notice.text);
      return false;
    } catch (err) {
      if (isDenied(err)) { this.denied = true; this.deniedErr = err; return false; }
      this.notice = {
        text: this.online()
          ? 'কাজটি করা যায়নি — রুটিন আগের অবস্থাতেই আছে।'
          : 'সংযোগ নেই — রুটিন প্রকাশ করতে ইন্টারনেট লাগবে।',
        tone: 'warn',
      };
      return false;
    } finally {
      this.busy = ''; this.render();
    }
  }

  /**
   * §6. The confirmation names the consequence, not the action.
   *
   * "আপনি কি নিশ্চিত?" carries no information and teaches people to click
   * through. This says how many lessons, who will see them, what it replaces
   * and what is being accepted — and it is `danger` styled with focus on
   * Cancel, because it cannot be undone.
   */
  private confirmPublish(e: ReviewEntry, extra: Finding[] = []): void {
    // The server's sentences. Anything this screen composed from the counters
    // beside them would drift the first time either changed — the rule P9-3's
    // generate screen states about its verdict, and the same one applies to
    // the only irreversible button in the workstream.
    //
    // `extra` is what a REFUSAL wanted acknowledged: the server hands those
    // back when it declines an unconfirmed publish, and they belong in the
    // second ask even though the review that drew this card did not have them.
    // `?? []` is not defensive noise: a service worker holding a response
    // from before the server composed these, or an older deployment behind a
    // newer client, makes this undefined — and spreading undefined throws
    // inside a click handler, which loses the dialog and leaves the button
    // dead with nothing on screen to say why. Observed exactly once, in the
    // browser, from a cached payload.
    const lines = [...(e.consequenceBn ?? [])];
    for (const w of extra) {
      const line = `মেনে নেওয়া হচ্ছে: ${w.messageBn}`;
      if (!lines.includes(line)) lines.splice(lines.length - 1, 0, line);
    }

    confirmOverlay(this.o.doc, {
      title: 'রুটিন প্রকাশ করবেন?',
      body: lines.join(' '),
      confirmLabel: 'হ্যাঁ, প্রকাশ করুন',
      danger: true,
      onConfirm: async () => {
        // §9. The routine as THIS screen was drawn from. If somebody edited
        // it since, the server refuses rather than publishing something the
        // head never read.
        await this.send('publish', e, {
          confirmWarnings: true, fingerprint: e.fingerprint,
        });
      },
    });
  }

  /* ------------------------------------------------------------ render */

  private render(): void {
    const d = this.o.doc;
    const root = this.o.root;
    root.textContent = '';
    root.append(pageHeader(d, {
      title: 'রুটিন প্রকাশ',
      subtitle: this.tenantNameBn
        ? `${this.tenantNameBn} · ${this.yearLabel} শিক্ষাবর্ষ`
        : 'তৈরি হওয়া রুটিন দেখে নিন, তারপর প্রকাশ করুন',
    }));

    if (this.denied) {
      root.append(permissionState(d, {
        message: deniedMessage(this.deniedErr),
        contact: deniedContact(this.deniedErr),
      }));
      return;
    }
    if (this.loading) { root.append(listSkeleton(d, 3)); return; }
    if (this.error) {
      root.append(errorState(d, this.error, () => { void this.load(); }));
      return;
    }
    if (this.notice) {
      root.append(el(d, 'p', {
        className: this.notice.tone === 'ok' ? 'ui-note-ok' : 'ui-note-warn',
        text: this.notice.text,
        attrs: { role: 'status' },
      }));
    }
    if (this.entries.length === 0) {
      // §15. Never a blank screen — and the empty state carries the next
      // step, because "no routines" without "make one" is a dead end.
      root.append(emptyState(d, {
        glyph: 'clock',
        message: 'এই শিক্ষাবর্ষে এখনো কোনো রুটিন তৈরি হয়নি — আগে একটি তৈরি করুন।',
        action: {
          label: 'রুটিন তৈরি করুন',
          onClick: () => this.o.onNavigate?.('routinegenerate'),
        },
      }));
      return;
    }
    if (!this.online()) {
      root.append(el(d, 'p', {
        className: 'ui-note-warn',
        text: 'সংযোগ নেই — রুটিন দেখা যাচ্ছে, কিন্তু প্রকাশ করতে ইন্টারনেট লাগবে।',
        attrs: { role: 'status' },
      }));
    }
    for (const e of this.entries) root.append(this.entryCard(e));
  }

  private entryCard(e: ReviewEntry): HTMLElement {
    const d = this.o.doc;
    const published = e.status === 'active';
    // B-108 introduced a fourth state on this screen. A routine that is still
    // the coordinator's — draft or review — has work in it; anything else is
    // either the school's timetable or its history.
    const editable = e.status === 'draft' || e.status === 'review';
    const retired = !published && !editable;
    const body = el(d, 'div', { className: 'ui-stack' });

    // §2. The verdict first — a head reads one line and knows where they are.
    body.append(el(d, 'p', {
      className: 'ui-card-lead',
      // The dari closes a sentence; a clause continuing it must not follow
      // one, or the line reads "এই রুটিন চালু আছে। — ৭ সেপ্টেম্বর".
      text: published
        ? (e.verdictBn ?? '').replace(/।$/, '') + ` — ${dateBn(e.publishedAt)}`
          + (e.publishedByBn ? `, প্রকাশ করেছেন ${e.publishedByBn}` : '')
        : e.verdictBn ?? '',
    }));

    // §2's list, as labelled numbers. Each word says what it counts, because
    // "৫৬০ / ২০ / ২৩" makes a reader guess.
    body.append(statRow(d,
      statCard(d, { label: 'মোট ক্লাস', value: `${formatCount(e.slots, 'bn')}টি` }),
      statCard(d, { label: 'শাখা', value: `${formatCount(e.sections, 'bn')}টি` }),
      statCard(d, { label: 'শিক্ষক', value: `${formatCount(e.teachers, 'bn')} জন` }),
      statCard(d, {
        // The one number that can stop a publication, and it is never hidden
        // when it is zero — a head who sees "০টি" has been told, whereas an
        // absent row leaves them to assume.
        label: 'সময়ের সংঘর্ষ',
        value: `${formatCount(e.hardConflicts, 'bn')}টি`,
        ...(e.hardConflicts > 0 ? { tone: 'warn' as const, glyph: 'alert-triangle' } : {}),
      }),
      statCard(d, {
        label: 'বসানো যায়নি',
        value: `${formatCount(e.unplacedDemands, 'bn')}টি বিষয়`,
        ...(e.unplacedDemands > 0 ? { tone: 'warn' as const } : {}),
      }),
      statCard(d, { label: 'পিন করা', value: `${formatCount(e.pinned, 'bn')}টি` }),
    ));

    body.append(el(d, 'p', {
      className: 'ui-card-note',
      text: `সর্বশেষ পরিবর্তন: ${dateBn(e.lastModified)} · খসড়া নম্বর `
          + `${formatCount(e.version, 'bn')}`
          + (e.supersedes && !published
            ? ` · প্রকাশ করলে এখনকার চালু রুটিনটি (নম্বর `
              + `${formatCount(e.supersedes.version, 'bn')}) বাতিল হবে`
            : ''),
    }));

    // A PUBLISHED routine's only blocker is "already published", which is
    // the reason it cannot be published a second time — not a defect in it.
    // Rendering that under "যা ঠিক করতে হবে" told a head their live
    // timetable was broken. The warnings stay: what the routine actually
    // carries is still worth reading after it goes live.
    for (const [heading, items, cls] of [
      // Only a routine somebody can still work on has anything "to fix". A
      // published one's single blocker is "already published", and a
      // SUPERSEDED one's is the same — neither is a defect, and P9-7 fixed
      // only the first of the two because the second did not exist yet.
      ['যা ঠিক করতে হবে', editable ? e.blockers : [], 'ui-note-danger'],
      // A retired version's warnings are history, not work. The live one's
      // still say what the school is teaching around.
      ['যা জেনে রাখা দরকার', retired ? [] : e.warnings, 'ui-note-warn'],
    ] as const) {
      if (items.length === 0) continue;
      body.append(sectionHeading(d, { title: heading, level: 3 }));
      const list = el(d, 'ul', { className: 'gen-trades' });
      for (const f of items) {
        const li = el(d, 'li', { className: cls });
        li.append(el(d, 'span', { className: 'gen-trade-what', text: f.messageBn }));
        if (f.actionBn) {
          li.append(el(d, 'span', { className: 'gen-trade-why', text: f.actionBn }));
        }
        list.append(li);
      }
      body.append(list);
    }

    const actions: HTMLElement[] = [];
    // B-108. `!published` was right while the only two states were draft and
    // active. A SUPERSEDED routine is neither, and it was being offered
    // "প্রকাশ করুন" and "সম্পাদনা করুন" — one would 409 and the other opens an
    // editor that refuses every write. Offering a control that cannot work is
    // the defect this whole phase keeps finding from the other side.
    if (editable) {
      actions.push(button(d, {
        label: 'রুটিন দেখুন ও সম্পাদনা করুন', variant: 'secondary',
        onClick: () => this.o.onNavigate?.('routineeditor'),
      }));
      if (e.status === 'draft') {
        actions.push(button(d, {
          label: 'পর্যালোচনার জন্য পাঠান', variant: 'secondary',
          disabled: this.busy !== '' || !this.online(),
          onClick: () => { void this.send('submit', e); },
        }));
      } else {
        actions.push(button(d, {
          label: 'খসড়ায় ফেরত নিন', variant: 'secondary',
          disabled: this.busy !== '' || !this.online(),
          onClick: () => { void this.send('withdraw', e); },
        }));
      }
      // §16. One primary action, and it is the one the screen exists for.
      // Disabled is a courtesy; `publish-gate.ts` is what actually refuses.
      actions.push(button(d, {
        label: 'প্রকাশ করুন', variant: 'primary',
        disabled: !e.canPublish || this.busy !== '' || !this.online(),
        onClick: () => this.confirmPublish(e),
      }));
    }

    if (actions.length > 0) body.append(buttonRow(d, ...actions));
    return card(this.o.doc, {
      title: `${e.shiftBn} শিফট — ${e.nameBn}`,
      action: statusBadge(d, {
        label: e.statusBn,
        // `blocked` is not a STATUS key; the tone carries it, and the WORD
        // beside it is what a reader actually goes by.
        state: published ? 'active' : e.canPublish ? 'draft' : 'overdue',
      }),
    }, body);
  }
}
