/**
 * কার্যবিবরণী — the audit viewer  (R-3 completion pass, Part 5; F-1603)
 *
 * Migration 041 made `audit.activity_log` readable by management and R-3's
 * mutations began writing to it. Nothing displayed it, which meant the log
 * existed for a hypothetical future reader rather than for the school.
 *
 * ── Read-only, and structurally so ─────────────────────────────────────
 * There is no control on this screen that changes anything. That is not
 * restraint in the UI — 010 revokes UPDATE and DELETE from the application
 * role and 041 deliberately did not restore them, so there is no write path
 * to expose. A trail its subject can edit is decoration.
 *
 * ── What a person actually asks it ─────────────────────────────────────
 * Not "show me everything". They arrive with a question: who changed this
 * child's fee permission, who promoted the school, what did the new IT admin
 * do last week. So the filters lead — action, person, date range — and the
 * lists behind them are built from what THIS school has actually done rather
 * than from every action the code can emit. A dropdown of forty possible
 * actions in a school that has performed four is a worse screen.
 *
 * ── The diff is the answer, and it is masked ───────────────────────────
 * "can_pay_fees: true → false" is the whole point of an entry; a row that
 * says only "permissions changed" sends the reader back to the person they
 * were checking. The server redacts anything key-named like a phone, an
 * email or a credential before it leaves, so what renders here is already
 * safe — this screen does not re-decide that.
 */
import type { Auth } from './auth.ts';
import { skeleton, errorState, emptyState, bnNum, bnDate } from './view-states.ts';

interface Entry {
  id: string;
  at: string;
  actor: { id: string | null; nameBn: string; role: string | null };
  action: string;
  entityType: string | null;
  entityId: string | null;
  before: unknown;
  after: unknown;
}

interface Facets {
  actions: { value: string; count: number }[];
  entityTypes: { value: string; count: number }[];
  actors: { id: string; nameBn: string; count: number }[];
}

export interface AuditViewOptions {
  root: HTMLElement;
  doc: Document;
  auth: Auth;
}

/**
 * Bangla for each action. An audit line that reads
 * `academic.class_teacher.assign` is a log; one that reads
 * "শ্রেণি শিক্ষক নির্ধারণ" is a record a head teacher can use.
 */
const ACTION_BN: Record<string, string> = {
  'academic.class_teacher.assign':   'শ্রেণি শিক্ষক নির্ধারণ',
  'academic.subject_teacher.assign': 'বিষয় শিক্ষক নির্ধারণ',
  'academic.enrolment.move':         'শিক্ষার্থী স্থানান্তর',
  'academic.rollover.commit':        'বার্ষিক উন্নয়ন সম্পন্ন',
  'academic.year.create':            'শিক্ষাবর্ষ তৈরি',
  'academic.class.create':           'শ্রেণি তৈরি',
  'academic.section.create':         'সেকশন তৈরি',
  'exam.results.publish':            'ফলাফল প্রকাশ',
  'finance.invoices.generate':       'ইনভয়েস তৈরি',
  'ops.settings.update':             'সেটিংস পরিবর্তন',
  'ops.user.create':                 'ব্যবহারকারী তৈরি',
  'ops.user.deactivate':             'ব্যবহারকারী নিষ্ক্রিয়',
  'ops.user.reactivate':             'ব্যবহারকারী সক্রিয়',
  'ops.guardian.link':               'অভিভাবক যুক্ত',
  'ops.guardian.permissions':        'অভিভাবকের অনুমতি পরিবর্তন',
};

const ENTITY_BN: Record<string, string> = {
  section: 'সেকশন', class: 'শ্রেণি', academic_year: 'শিক্ষাবর্ষ',
  user: 'ব্যবহারকারী', guardianship: 'অভিভাবক সংযোগ',
  tenant: 'প্রতিষ্ঠান', year_rollover: 'বার্ষিক উন্নয়ন',
};

const ROLE_BN: Record<string, string> = {
  principal: 'প্রধান শিক্ষক', school_owner: 'প্রতিষ্ঠান মালিক',
  it_admin: 'আইটি অ্যাডমিন', academic_coordinator: 'একাডেমিক সমন্বয়কারী',
  accountant: 'হিসাবরক্ষক', class_teacher: 'শ্রেণি শিক্ষক',
  subject_teacher: 'বিষয় শিক্ষক',
};

/** Keys worth naming in a diff; anything else is shown by its raw key. */
const FIELD_BN: Record<string, string> = {
  canPayFees: 'ফি পরিশোধের অনুমতি', receivesSms: 'এসএমএস', isPrimary: 'প্রধান অভিভাবক',
  relation: 'সম্পর্ক', noticeMaxChars: 'এসএমএসের দৈর্ঘ্য', status: 'অবস্থা',
  nameBn: 'নাম', roleCode: 'ভূমিকা', teacherId: 'শিক্ষক', count: 'সংখ্যা',
  moved: 'স্থানান্তরিত', promoted: 'উন্নীত', repeated: 'পুনরাবৃত্তি', graduated: 'উত্তীর্ণ',
  capacity: 'ধারণক্ষমতা', name: 'নাম', label: 'নাম', levelNo: 'শ্রেণি', group: 'বিভাগ',
};

function bnBool(v: unknown): string {
  if (v === true) return 'হ্যাঁ';
  if (v === false) return 'না';
  return String(v);
}

export class AuditView {
  private readonly o: AuditViewOptions;
  private entries: Entry[] = [];
  private facets: Facets = { actions: [], entityTypes: [], actors: [] };
  private hasMore = false;
  private offset = 0;
  private loading = true;
  private error = '';
  private expanded = new Set<string>();

  private f = { action: '', entityType: '', actorId: '', from: '', to: '' };

  constructor(options: AuditViewOptions) {
    this.o = options;
    this.render();
    void this.load();
  }

  private async load(): Promise<void> {
    this.loading = true; this.error = ''; this.render();
    try {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(this.f)) if (v) qs.set(k, v);
      if (this.offset) qs.set('offset', String(this.offset));
      const res = await this.o.auth.authedFetch(`/api/v1/ops/audit?${qs}`);
      if (res.status === 403) {
        // The one screen where a refusal is the correct outcome for most of
        // the school, so it says who it is for rather than only "no".
        this.error = 'কার্যবিবরণী কেবল প্রধান শিক্ষক, প্রতিষ্ঠান মালিক ও আইটি অ্যাডমিন দেখতে পারেন।';
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as {
        entries: Entry[]; facets: Facets; hasMore: boolean;
      };
      this.entries = body.entries ?? [];
      this.facets = body.facets ?? this.facets;
      this.hasMore = body.hasMore ?? false;
    } catch {
      this.error = 'কার্যবিবরণী আনা যায়নি — সংযোগ পেলে আবার দেখা যাবে।';
    } finally {
      this.loading = false; this.render();
    }
  }

  private render(): void {
    const d = this.o.doc;
    const root = this.o.root;
    root.textContent = '';

    const header = d.createElement('header');
    header.className = 'page-header';
    const h1 = d.createElement('h1');
    h1.textContent = 'কার্যবিবরণী';
    const sub = d.createElement('p');
    sub.className = 'page-sub';
    sub.textContent = 'কে কখন কী পরিবর্তন করেছেন — শুধু পড়ার জন্য';
    header.append(h1, sub);
    root.append(header);

    if (this.error) {
      root.append(errorState(d, this.error,
        this.error.includes('অনুমতি') || this.error.includes('কেবল')
          ? undefined : () => void this.load()));
      // A refusal is the whole answer; an empty list underneath it would say
      // "there is nothing here", which is a different and untrue claim.
      if (this.error.includes('কেবল')) return;
    }

    root.append(this.filters());

    if (this.loading) { root.append(skeleton(d, 5)); return; }

    if (this.entries.length === 0) {
      const filtered = Object.values(this.f).some(Boolean);
      root.append(emptyState(d, {
        message: filtered
          ? 'এই শর্তে কোনো কাজ পাওয়া যায়নি — ফিল্টার বদলে দেখুন।'
          : 'এখনো কোনো পরিবর্তন রেকর্ড হয়নি। শিক্ষক নির্ধারণ, ফলাফল প্রকাশ বা ' +
            'অভিভাবকের অনুমতি পরিবর্তন করলে এখানে দেখা যাবে।',
        action: filtered
          ? { label: 'ফিল্টার মুছুন', onClick: () => {
              this.f = { action: '', entityType: '', actorId: '', from: '', to: '' };
              this.offset = 0; void this.load();
            } }
          : undefined,
      }));
      return;
    }

    const list = d.createElement('div');
    list.className = 'system-list';
    for (const e of this.entries) list.append(this.entryRow(e));
    root.append(list);

    if (this.hasMore || this.offset > 0) root.append(this.pager());
  }

  private filters(): HTMLElement {
    const d = this.o.doc;
    const card = d.createElement('form');
    card.className = 'card card-form';
    card.style.margin = '0 var(--s-4) var(--s-3)';

    const sel = (
      labelBn: string, key: 'action' | 'entityType' | 'actorId',
      items: { value: string; label: string; count: number }[],
    ): void => {
      const f = d.createElement('label');
      f.className = 'field';
      f.textContent = labelBn;
      const s = d.createElement('select');
      s.className = 'field-input';
      const any = d.createElement('option');
      any.value = ''; any.textContent = 'সব';
      s.append(any);
      for (const it of items) {
        const opt = d.createElement('option');
        opt.value = it.value;
        opt.textContent = `${it.label} (${bnNum(it.count)})`;
        opt.selected = this.f[key] === it.value;
        s.append(opt);
      }
      s.addEventListener('change', () => {
        this.f[key] = s.value; this.offset = 0; void this.load();
      });
      f.append(s);
      card.append(f);
    };

    sel('কাজ', 'action', this.facets.actions.map((a) => ({
      value: a.value, label: ACTION_BN[a.value] ?? a.value, count: a.count,
    })));
    sel('বিষয়', 'entityType', this.facets.entityTypes.map((e) => ({
      value: e.value, label: ENTITY_BN[e.value] ?? e.value, count: e.count,
    })));
    sel('কে', 'actorId', this.facets.actors.map((a) => ({
      value: a.id, label: a.nameBn, count: a.count,
    })));

    const dates = d.createElement('div');
    dates.className = 'brand-color-inputs';
    for (const [labelBn, key] of [['থেকে', 'from'], ['পর্যন্ত', 'to']] as const) {
      const f = d.createElement('label');
      f.className = 'field';
      f.textContent = labelBn;
      const i = d.createElement('input');
      i.type = 'date';
      i.className = 'field-input';
      i.value = this.f[key];
      i.addEventListener('change', () => {
        this.f[key] = i.value; this.offset = 0; void this.load();
      });
      f.append(i);
      dates.append(f);
    }
    card.append(dates);

    if (Object.values(this.f).some(Boolean)) {
      const clear = d.createElement('button');
      clear.type = 'button';
      clear.className = 'btn-ghost btn-small';
      clear.textContent = 'ফিল্টার মুছুন';
      clear.addEventListener('click', () => {
        this.f = { action: '', entityType: '', actorId: '', from: '', to: '' };
        this.offset = 0; void this.load();
      });
      card.append(clear);
    }
    card.addEventListener('submit', (e) => e.preventDefault());
    return card;
  }

  private entryRow(e: Entry): HTMLElement {
    const d = this.o.doc;
    const row = d.createElement('article');
    row.className = 'notice-card';

    const head = d.createElement('button');
    head.type = 'button';
    head.className = 'notice-head';
    const open = this.expanded.has(e.id);
    head.setAttribute('aria-expanded', String(open));

    const main = d.createElement('span');
    main.className = 'notice-main';
    const title = d.createElement('span');
    title.className = 'notice-title';
    title.textContent = ACTION_BN[e.action] ?? e.action;
    const meta = d.createElement('span');
    meta.className = 'notice-meta';
    meta.textContent =
      `${e.actor.nameBn}` +
      (e.actor.role ? ` (${ROLE_BN[e.actor.role] ?? e.actor.role})` : '') +
      ` · ${bnDate(e.at)}` +
      (e.entityType ? ` · ${ENTITY_BN[e.entityType] ?? e.entityType}` : '');
    main.append(title, meta);
    head.append(main);

    head.addEventListener('click', () => {
      if (open) this.expanded.delete(e.id); else this.expanded.add(e.id);
      this.render();
    });
    row.append(head);

    if (open) row.append(this.diff(e));
    return row;
  }

  /**
   * before → after, field by field. Only the fields that CHANGED, because a
   * list of twelve identical values with one difference buried in it is how a
   * reader misses the difference.
   */
  private diff(e: Entry): HTMLElement {
    const d = this.o.doc;
    const wrap = d.createElement('div');
    wrap.style.padding = '0 var(--s-4) var(--s-3)';

    const before = (e.before ?? {}) as Record<string, unknown>;
    const after = (e.after ?? {}) as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
    const changed = keys.filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));

    if (changed.length === 0) {
      const p = d.createElement('p');
      p.className = 'att-sub';
      // A create has no before-state; saying "no change" would be wrong.
      p.textContent = e.before == null && e.after != null
        ? 'নতুন তৈরি — আগের কোনো অবস্থা নেই।'
        : 'কোনো মান পরিবর্তিত হয়নি।';
      wrap.append(p);
    } else {
      const table = d.createElement('table');
      table.className = 'data-table';
      const tb = d.createElement('tbody');
      for (const k of changed) {
        const tr = d.createElement('tr');
        const th = d.createElement('th');
        th.scope = 'row';
        th.textContent = FIELD_BN[k] ?? k;
        const td = d.createElement('td');
        const b = k in before ? bnBool(before[k]) : '—';
        const a = k in after ? bnBool(after[k]) : '—';
        td.textContent = `${b} → ${a}`;
        tr.append(th, td);
        tb.append(tr);
      }
      table.append(tb);
      const scroll = d.createElement('div');
      scroll.className = 'table-scroll';
      scroll.append(table);
      wrap.append(scroll);
    }

    if (e.entityId) {
      const id = d.createElement('p');
      id.className = 'att-sub';
      id.textContent = `শনাক্তকারী: ${e.entityId}`;
      wrap.append(id);
    }
    return wrap;
  }

  private pager(): HTMLElement {
    const d = this.o.doc;
    const row = d.createElement('div');
    row.className = 'action-row';
    row.style.padding = 'var(--s-2) var(--s-4) var(--s-4)';

    if (this.offset > 0) {
      const prev = d.createElement('button');
      prev.type = 'button';
      prev.className = 'btn-secondary';
      prev.textContent = 'আগের';
      prev.addEventListener('click', () => {
        this.offset = Math.max(0, this.offset - 50); void this.load();
      });
      row.append(prev);
    }
    if (this.hasMore) {
      const next = d.createElement('button');
      next.type = 'button';
      next.className = 'btn-secondary';
      next.textContent = 'পরের';
      next.addEventListener('click', () => { this.offset += 50; void this.load(); });
      row.append(next);
    }
    return row;
  }
}
