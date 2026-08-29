/**
 * বার্ষিক উন্নয়ন — the year-end promotion  (R-3, Part G)
 *
 * The single most consequential button in the product: it moves every child in
 * the school into next year, once, and there is no undo.
 *
 *     ২০২৬ → ২০২৭ প্রস্তুত → পূর্বরূপ → পর্যালোচনা → নিশ্চিতকরণ
 *
 * ── Three steps, and the middle one exists for a reason ────────────────
 * Preview is read-only and can be run all day. "Plan" freezes the counts into
 * `year_rollovers`, and only then is the commit button offered. That is so the
 * numbers on the confirmation are the numbers the DATABASE agreed to a moment
 * ago, not numbers this browser remembered from a request made before somebody
 * else enrolled three students.
 *
 * ── Blocked students stop everything, by design ────────────────────────
 * `app.commit_rollover` refuses while any student is blocked rather than
 * skipping them, because a rollover that quietly left thirty children behind
 * is discovered in March by a teacher whose register is short. This screen
 * shows them by name, with the blocker, ABOVE the button — so the refusal is
 * something a head teacher resolves rather than something they hit.
 *
 * ── Nothing here is destructive to history ─────────────────────────────
 * The old enrolment row is closed ('promoted', with an end date), never
 * deleted. Last year's roll numbers, sections and results stay exactly where
 * they are, which is what makes the ten-year student history possible. The
 * screen says this, because "promote every student" sounds like it overwrites.
 */
import type { Auth } from './auth.ts';
import {
  skeleton, errorState, emptyState, successNote, confirmDialog, bnNum,
} from './view-states.ts';

interface Preview {
  years: { id: string; label: string; isCurrent: boolean }[];
  needsTargetYear: boolean;
  fromYear?: { id: string; label: string } | null;
  toYear?: { id: string; label: string } | null;
  summary: { considered: number; promote: number; repeat: number; graduate: number; blocked: number } | null;
  students: {
    studentId: string; nameBn: string; fromLevel: number; fromSection: string;
    fromRoll: number; action: string; toLevel: number | null;
    toSection: string | null; toRoll: number | null; blockerBn: string | null;
  }[];
  existing: {
    id: string; status: string;
    planned: { considered: number; promote: number; repeat: number; graduate: number; blocked: number };
    actual: { promoted: number; repeated: number; graduated: number; committedAt: string | null } | null;
  } | null;
}

export interface RolloverViewOptions {
  root: HTMLElement;
  doc: Document;
  auth: Auth;
  /** Only principal/school_owner may plan or commit. Advisory; RLS is the gate. */
  canCommit: boolean;
}

const ACTION_BN: Record<string, string> = {
  promote: 'উন্নীত',
  repeat: 'একই শ্রেণিতে',
  graduate: 'উত্তীর্ণ (বিদায়)',
  blocked: 'আটকে আছে',
};

export class RolloverView {
  private readonly o: RolloverViewOptions;
  private data: Preview | null = null;
  private from = '';
  private to = '';
  private loading = true;
  private error = '';
  private notice = '';
  private busy = false;
  private showList = false;

  constructor(options: RolloverViewOptions) {
    this.o = options;
    this.render();
    void this.load();
  }

  private async load(): Promise<void> {
    this.loading = true; this.error = ''; this.render();
    try {
      const qs = this.from && this.to
        ? `?from=${encodeURIComponent(this.from)}&to=${encodeURIComponent(this.to)}`
        : '';
      const res = await this.o.auth.authedFetch(`/api/v1/ops/rollover${qs}`);
      if (res.status === 403) { this.error = 'বার্ষিক উন্নয়নের অনুমতি আপনার নেই।'; return; }
      if (!res.ok) throw new Error(String(res.status));
      this.data = (await res.json()) as Preview;
      // Default the two years sensibly: current → the next one after it.
      if (!this.from && this.data.years.length >= 2) {
        const cur = this.data.years.find((y) => y.isCurrent) ?? this.data.years[0];
        const idx = this.data.years.findIndex((y) => y.id === cur.id);
        // years arrive newest-first, so "next year" is the entry before it.
        const next = this.data.years[idx - 1];
        if (next) { this.from = cur.id; this.to = next.id; await this.load(); return; }
      }
    } catch {
      this.error = 'তথ্য আনা যায়নি — সংযোগ পেলে আবার দেখা যাবে।';
    } finally {
      this.loading = false; this.render();
    }
  }

  private async plan(): Promise<void> {
    this.busy = true; this.error = ''; this.render();
    try {
      const res = await this.o.auth.authedFetch('/api/v1/ops/rollover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fromYearId: this.from, toYearId: this.to }),
      });
      const body = await res.json() as { message?: string };
      if (!res.ok) { this.error = body.message ?? 'পরিকল্পনা সংরক্ষণ করা যায়নি।'; return; }
      this.notice = 'পরিকল্পনা সংরক্ষিত হয়েছে। এবার নিশ্চিত করুন।';
      await this.load();
    } catch {
      this.error = 'সংযোগ নেই — পরিকল্পনা সংরক্ষণ করা যায়নি।';
    } finally {
      this.busy = false; this.render();
    }
  }

  private async commit(rolloverId: string): Promise<void> {
    this.busy = true; this.error = ''; this.render();
    try {
      const res = await this.o.auth.authedFetch('/api/v1/ops/rollover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rolloverId }),
      });
      const body = await res.json() as {
        promoted?: number; repeated?: number; graduated?: number;
        message?: string; hint?: string;
      };
      if (!res.ok) {
        // The database's own refusal message is more useful than anything
        // this screen could invent — it names the blocked students.
        this.error = body.message ?? 'উন্নয়ন সম্পন্ন করা যায়নি।';
        return;
      }
      this.notice =
        `সম্পন্ন — ${bnNum(body.promoted ?? 0)} জন উন্নীত, ` +
        `${bnNum(body.repeated ?? 0)} জন একই শ্রেণিতে, ` +
        `${bnNum(body.graduated ?? 0)} জন উত্তীর্ণ। আগের বছরের রেকর্ড অপরিবর্তিত।`;
      await this.load();
    } catch {
      this.error = 'সংযোগ নেই — উন্নয়ন সম্পন্ন করা যায়নি।';
    } finally {
      this.busy = false; this.render();
    }
  }

  private render(): void {
    const d = this.o.doc;
    const root = this.o.root;
    root.textContent = '';

    const header = d.createElement('header');
    header.className = 'page-header';
    const h1 = d.createElement('h1');
    h1.textContent = 'বার্ষিক উন্নয়ন';
    const sub = d.createElement('p');
    sub.className = 'page-sub';
    sub.textContent = 'আগের বছরের রেকর্ড মুছে যায় না।';
    header.append(h1, sub);
    root.append(header);

    if (this.notice) root.append(successNote(d, this.notice));
    if (this.error) {
      root.append(errorState(d, this.error,
        this.error.includes('অনুমতি') ? undefined : () => void this.load()));
    }
    if (this.loading) { root.append(skeleton(d, 4)); return; }
    if (!this.data) return;

    if (this.data.needsTargetYear) {
      root.append(emptyState(d, {
        message: 'উন্নয়নের জন্য দুইটি শিক্ষাবর্ষ দরকার — বর্তমান এবং পরবর্তী। ' +
                 'পরের বছরের শিক্ষাবর্ষ ও সেকশন তৈরি হলে এখানে পূর্বরূপ দেখা যাবে।',
      }));
      return;
    }

    root.append(this.stepper());
    root.append(this.yearPicker());

    const s = this.data.summary;
    if (!s) return;

    if (s.considered === 0) {
      root.append(emptyState(d, {
        message: 'উন্নয়নের জন্য কোনো সক্রিয় শিক্ষার্থী পাওয়া যায়নি।',
      }));
      return;
    }

    root.append(this.summaryCard(s));

    // Blocked students first and by name — they are the thing that has to be
    // resolved, and burying them under a summary is how they get missed.
    const blocked = this.data.students.filter((st) => st.action === 'blocked');
    if (blocked.length > 0) root.append(this.blockedCard(blocked));

    root.append(this.listToggle());
    if (this.showList) root.append(this.studentTable());

    root.append(this.actions());
  }

  private stepper(): HTMLElement {
    const d = this.o.doc;
    const committed = this.data?.existing?.status === 'committed';
    const planned = this.data?.existing?.status === 'planned';
    const ol = d.createElement('ol');
    ol.className = 'stepper';
    const steps: [string, 'done' | 'current' | ''][] = [
      ['পূর্বরূপ', committed || planned ? 'done' : 'current'],
      ['পরিকল্পনা', committed ? 'done' : planned ? 'current' : ''],
      ['নিশ্চিতকরণ', committed ? 'done' : ''],
    ];
    steps.forEach(([label, state], i) => {
      const li = d.createElement('li');
      li.className = 'stepper-step';
      if (state) li.setAttribute('data-state', state);
      const n = d.createElement('span');
      n.className = 'stepper-num';
      n.textContent = bnNum(i + 1);
      const l = d.createElement('span');
      l.className = 'stepper-label';
      l.textContent = label;
      li.append(n, l);
      ol.append(li);
    });
    return ol;
  }

  private yearPicker(): HTMLElement {
    const d = this.o.doc;
    const wrap = d.createElement('div');
    wrap.className = 'card card-form';
    wrap.style.margin = '0 var(--s-4) var(--s-3)';

    for (const [labelBn, which] of [['যে বছর থেকে', 'from'], ['যে বছরে', 'to']] as const) {
      const field = d.createElement('label');
      field.className = 'field';
      field.textContent = labelBn;
      const select = d.createElement('select');
      select.className = 'field-input';
      for (const y of this.data?.years ?? []) {
        const opt = d.createElement('option');
        opt.value = y.id;
        opt.textContent = y.label + (y.isCurrent ? ' (চলতি)' : '');
        opt.selected = (which === 'from' ? this.from : this.to) === y.id;
        select.append(opt);
      }
      select.addEventListener('change', () => {
        if (which === 'from') this.from = select.value; else this.to = select.value;
        this.notice = '';
        void this.load();
      });
      field.append(select);
      wrap.append(field);
    }
    return wrap;
  }

  private summaryCard(s: NonNullable<Preview['summary']>): HTMLElement {
    const d = this.o.doc;
    const card = d.createElement('div');
    card.className = 'card';
    card.style.margin = '0 var(--s-4) var(--s-3)';

    const total = d.createElement('p');
    total.className = 'result-gpa';
    total.textContent = `${bnNum(s.considered)} জন`;
    card.append(total);

    for (const [labelBn, n, key] of [
      ['উন্নীত হবে', s.promote, 'promote'],
      ['একই শ্রেণিতে থাকবে', s.repeat, 'repeat'],
      ['উত্তীর্ণ হয়ে বিদায় নেবে', s.graduate, 'graduate'],
      ['আটকে আছে', s.blocked, 'blocked'],
    ] as [string, number, string][]) {
      const row = d.createElement('p');
      row.className = 'system-row';
      row.textContent = `${labelBn}: ${bnNum(n)}`;
      if (key === 'blocked' && n > 0) row.classList.add('login-error');
      card.append(row);
    }

    const committed = this.data?.existing?.actual;
    if (committed) {
      const done = d.createElement('p');
      done.className = 'status-chip';
      done.setAttribute('data-state', 'success');
      done.textContent =
        `সম্পন্ন — ${bnNum(committed.promoted)} উন্নীত · ` +
        `${bnNum(committed.repeated)} পুনরাবৃত্তি · ${bnNum(committed.graduated)} উত্তীর্ণ`;
      card.append(done);
    }
    return card;
  }

  private blockedCard(blocked: Preview['students']): HTMLElement {
    const d = this.o.doc;
    const card = d.createElement('div');
    card.className = 'card';
    card.style.margin = '0 var(--s-4) var(--s-3)';
    const h = d.createElement('p');
    h.className = 'notice-confirm-label';
    h.textContent = `${bnNum(blocked.length)} জন শিক্ষার্থী আটকে আছে`;
    const why = d.createElement('p');
    why.className = 'att-sub';
    why.textContent = 'এদের সমাধান না হওয়া পর্যন্ত উন্নয়ন শুরু করা যাবে না — কাউকে বাদ দিয়ে করা হয় না।';
    card.append(h, why);

    const list = d.createElement('div');
    list.className = 'system-list';
    for (const st of blocked) {
      const row = d.createElement('div');
      row.className = 'system-row';
      const t = d.createElement('span');
      t.className = 'system-title';
      t.textContent = `${st.nameBn} · ${bnNum(st.fromLevel)} ${st.fromSection} · রোল ${bnNum(st.fromRoll)}`;
      const desc = d.createElement('span');
      desc.className = 'system-desc';
      desc.textContent = st.blockerBn ?? 'কারণ জানা যায়নি';
      row.append(t, desc);
      list.append(row);
    }
    card.append(list);
    return card;
  }

  private listToggle(): HTMLElement {
    const d = this.o.doc;
    const btn = d.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-ghost btn-small';
    btn.style.margin = '0 var(--s-4)';
    btn.setAttribute('aria-expanded', String(this.showList));
    btn.textContent = this.showList ? 'তালিকা লুকান' : 'শিক্ষার্থীভিত্তিক তালিকা দেখুন';
    btn.addEventListener('click', () => { this.showList = !this.showList; this.render(); });
    return btn;
  }

  /**
   * The named list. F-1605 calls the rollover "guided" precisely so a head
   * teacher can read down it rather than trust a count — and print it.
   */
  private studentTable(): HTMLElement {
    const d = this.o.doc;
    const scroll = d.createElement('div');
    scroll.className = 'table-scroll';
    const table = d.createElement('table');
    table.className = 'data-table';

    const thead = d.createElement('thead');
    const hr = d.createElement('tr');
    for (const h of ['নাম', 'বর্তমান', 'সিদ্ধান্ত', 'নতুন']) {
      const th = d.createElement('th');
      th.scope = 'col';
      th.textContent = h;
      hr.append(th);
    }
    thead.append(hr);
    table.append(thead);

    const tbody = d.createElement('tbody');
    for (const st of this.data?.students ?? []) {
      const tr = d.createElement('tr');
      const name = d.createElement('th');
      name.scope = 'row';
      name.textContent = st.nameBn;
      const from = d.createElement('td');
      from.textContent = `${bnNum(st.fromLevel)} ${st.fromSection} · ${bnNum(st.fromRoll)}`;
      const act = d.createElement('td');
      act.textContent = ACTION_BN[st.action] ?? st.action;
      const to = d.createElement('td');
      to.textContent = st.toSection
        ? `${bnNum(st.toLevel ?? '')} ${st.toSection} · ${bnNum(st.toRoll ?? '')}`
        : st.blockerBn ?? '—';
      tr.append(name, from, act, to);
      tbody.append(tr);
    }
    table.append(tbody);
    scroll.append(table);
    return scroll;
  }

  private actions(): HTMLElement {
    const d = this.o.doc;
    const wrap = d.createElement('div');
    wrap.className = 'action-row';
    wrap.style.padding = 'var(--s-3) var(--s-4)';

    const s = this.data?.summary;
    const existing = this.data?.existing;

    if (!this.o.canCommit) {
      const note = d.createElement('p');
      note.className = 'att-sub';
      note.textContent = 'উন্নয়ন সম্পন্ন করার অনুমতি কেবল প্রধান শিক্ষক ও প্রতিষ্ঠান মালিকের।';
      wrap.append(note);
      return wrap;
    }

    if (existing?.status === 'committed') {
      const note = d.createElement('p');
      note.className = 'att-sub';
      note.textContent = 'এই দুই বছরের উন্নয়ন ইতিমধ্যে সম্পন্ন হয়েছে।';
      wrap.append(note);
      return wrap;
    }

    const blockedCount = s?.blocked ?? 0;

    if (existing?.status === 'planned') {
      const btn = d.createElement('button');
      btn.type = 'button';
      btn.className = 'btn-primary';
      btn.disabled = this.busy || blockedCount > 0;
      btn.textContent = this.busy ? 'চলছে…' : 'উন্নয়ন সম্পন্ন করুন';
      btn.addEventListener('click', () => {
        wrap.append(confirmDialog({
          doc: d,
          title: 'বার্ষিক উন্নয়ন নিশ্চিত করুন',
          body:
            `${bnNum(s?.considered ?? 0)} জন শিক্ষার্থীর মধ্যে ` +
            `${bnNum(s?.promote ?? 0)} জন উন্নীত হবে, ${bnNum(s?.repeat ?? 0)} জন একই শ্রেণিতে থাকবে, ` +
            `${bnNum(s?.graduate ?? 0)} জন উত্তীর্ণ হয়ে বিদায় নেবে। ` +
            'এটি একবারই করা যায়। আগের বছরের ভর্তি, রোল ও ফলাফলের রেকর্ড অপরিবর্তিত থাকবে।',
          confirmLabel: 'সম্পন্ন করুন',
          danger: true,
          onConfirm: () => void this.commit(existing.id),
        }));
      });
      wrap.append(btn);
      if (blockedCount > 0) {
        const why = d.createElement('p');
        why.className = 'att-sub';
        why.textContent = 'আটকে থাকা শিক্ষার্থীদের সমাধান না হওয়া পর্যন্ত এটি করা যাবে না।';
        wrap.append(why);
      }
      return wrap;
    }

    const btn = d.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-secondary';
    btn.disabled = this.busy || (s?.considered ?? 0) === 0;
    btn.textContent = this.busy ? 'অপেক্ষা করুন…' : 'পরিকল্পনা সংরক্ষণ করুন';
    btn.addEventListener('click', () => void this.plan());
    wrap.append(btn);
    return wrap;
  }
}
