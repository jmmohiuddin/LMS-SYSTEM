/**
 * অভিভাবক ব্যবস্থাপনা — linking guardians and setting their permissions
 * (R-3 completion pass, Parts 3–4)
 *
 * R-3's student drawer listed guardians and could change nothing. Linking a
 * guardian, or correcting who may pay a child's fees, meant SQL.
 *
 * ── Search first, create second ────────────────────────────────────────
 * The panel opens on a search box, not a create form, because the default
 * failure here is a school accumulating three rows for one father — one per
 * child. Each duplicate is a separate SMS for the same notice on the channel
 * that is 80% of the bill, and a separate login that sees one child instead
 * of three. The candidate list shows how many children each person already
 * has, which is usually enough for the office to recognise them.
 *
 * The server enforces the same thing independently: a "create" whose phone
 * number already exists in the school links the existing person and says so.
 *
 * ── The two permissions are not the same permission ────────────────────
 * `receives_sms` is who is TOLD. `can_pay_fees` is who is ASKED FOR MONEY —
 * it is the column R-2's `guardians_payers` audience resolves through, so
 * changing it changes who gets the invoice notice on the next billing run.
 * The screen says that in words, because a permission toggle whose effect is
 * invisible is one nobody trusts and everybody works around.
 */
import type { Auth } from './auth.ts';
import { skeleton, errorState, emptyState, successNote, confirmDialog, bnNum } from './view-states.ts';

export interface GuardianLink {
  linkId: string;
  guardianId: string;
  nameBn: string;
  phone: string | null;
  relation: string;
  isPrimary: boolean;
  receivesSms: boolean;
  canPayFees: boolean;
  otherWards: number;
}

/** A person already in the school who could be linked as a guardian. */
export interface GuardianCandidate {
  id: string;
  nameBn: string;
  phone: string | null;
  wardCount: number;
}

export interface GuardianPanelOptions {
  root: HTMLElement;
  doc: Document;
  auth: Auth;
  studentId: string;
  studentNameBn: string;
  /** Advisory; the server and RLS are the gate. */
  canManage: boolean;
}

export const RELATION_BN: Record<string, string> = {
  father: 'বাবা', mother: 'মা', brother: 'ভাই', sister: 'বোন',
  uncle: 'চাচা/মামা', aunt: 'চাচি/খালা', grandparent: 'দাদা/দাদি',
  legal_guardian: 'আইনি অভিভাবক', other: 'অন্যান্য',
};

export class GuardianPanel {
  private readonly o: GuardianPanelOptions;
  private links: GuardianLink[] = [];
  private candidates: GuardianCandidate[] = [];
  private loading = true;
  private error = '';
  private notice = '';
  private busy = false;
  private mode: 'list' | 'add' = 'list';
  private searched = false;

  constructor(options: GuardianPanelOptions) {
    this.o = options;
    this.render();
    void this.load();
  }

  private async load(): Promise<void> {
    this.loading = true; this.error = ''; this.render();
    try {
      const res = await this.o.auth.authedFetch(
        `/api/v1/ops/guardians?studentId=${encodeURIComponent(this.o.studentId)}`);
      if (res.status === 403) { this.error = 'অভিভাবকের তথ্য দেখার অনুমতি নেই।'; return; }
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { guardians: GuardianLink[] };
      this.links = body.guardians ?? [];
    } catch {
      this.error = 'অভিভাবকের তালিকা আনা যায়নি।';
    } finally {
      this.loading = false; this.render();
    }
  }

  private async search(term: string): Promise<void> {
    this.busy = true; this.render();
    try {
      const res = await this.o.auth.authedFetch(
        `/api/v1/ops/guardians?q=${encodeURIComponent(term)}`);
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { candidates: GuardianCandidate[] };
      this.candidates = body.candidates ?? [];
      this.searched = true;
    } catch {
      this.error = 'খোঁজা যায়নি — সংযোগ দেখুন।';
    } finally {
      this.busy = false; this.render();
    }
  }

  private async link(payload: Record<string, unknown>): Promise<void> {
    this.busy = true; this.error = ''; this.render();
    try {
      const res = await this.o.auth.authedFetch('/api/v1/ops/guardians', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, studentId: this.o.studentId }),
      });
      const body = await res.json() as { reusedExisting?: boolean; created?: boolean; message?: string };
      if (!res.ok) { this.error = body.message ?? 'যুক্ত করা যায়নি।'; return; }
      // The office typed a new person and got an existing one. Say so, or the
      // name on screen will not be the name they typed and they will not know
      // why.
      this.notice = body.reusedExisting
        ? 'এই নম্বরটি প্রতিষ্ঠানে আগে থেকেই আছে — সেই ব্যক্তিকেই যুক্ত করা হয়েছে, নতুন কেউ তৈরি হয়নি।'
        : body.created
          ? 'নতুন অভিভাবক তৈরি করে যুক্ত করা হয়েছে।'
          : 'অভিভাবক যুক্ত হয়েছে।';
      this.mode = 'list';
      this.candidates = []; this.searched = false;
      await this.load();
    } catch {
      this.error = 'সংযোগ নেই — যুক্ত করা যায়নি।';
    } finally {
      this.busy = false; this.render();
    }
  }

  private async patch(g: GuardianLink, change: Record<string, unknown>): Promise<void> {
    this.busy = true; this.error = ''; this.render();
    try {
      const res = await this.o.auth.authedFetch('/api/v1/ops/guardians', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          studentId: this.o.studentId, guardianId: g.guardianId, ...change,
        }),
      });
      const body = await res.json() as { feeNoticesChanged?: boolean; message?: string };
      if (!res.ok) { this.error = body.message ?? 'পরিবর্তন করা যায়নি।'; return; }
      // Naming the consequence is the point of the setting.
      this.notice = body.feeNoticesChanged
        ? `সংরক্ষিত — ${g.nameBn} এখন থেকে ফি ও ইনভয়েসের বার্তা ` +
          `${change.canPayFees ? 'পাবেন' : 'পাবেন না'}।`
        : 'সংরক্ষিত।';
      await this.load();
    } catch {
      this.error = 'সংযোগ নেই — পরিবর্তন করা যায়নি।';
    } finally {
      this.busy = false; this.render();
    }
  }

  private render(): void {
    const d = this.o.doc;
    const root = this.o.root;
    root.textContent = '';

    const h = d.createElement('h2');
    h.className = 'section-heading';
    h.textContent = 'অভিভাবক';
    root.append(h);

    if (this.notice) root.append(successNote(d, this.notice));
    if (this.error) {
      root.append(errorState(d, this.error,
        this.error.includes('অনুমতি') ? undefined : () => void this.load()));
      if (this.error.includes('অনুমতি')) return;
    }
    if (this.loading) { root.append(skeleton(d, 2)); return; }

    if (this.mode === 'add') { root.append(this.addPanel()); return; }

    if (this.links.length === 0) {
      root.append(emptyState(d, {
        message: `${this.o.studentNameBn}-এর সাথে কোনো অভিভাবক যুক্ত নেই। ` +
                 'অভিভাবক যুক্ত না থাকলে হাজিরা ও ফির এসএমএস কারও কাছে যাবে না।',
        action: this.o.canManage
          ? { label: 'অভিভাবক যুক্ত করুন', onClick: () => { this.mode = 'add'; this.render(); } }
          : undefined,
      }));
      return;
    }

    for (const g of this.links) root.append(this.linkCard(g));

    if (this.o.canManage) {
      const add = d.createElement('button');
      add.type = 'button';
      add.className = 'btn-secondary btn-small';
      add.style.margin = '0 var(--s-4) var(--s-3)';
      add.textContent = 'আরেকজন অভিভাবক যুক্ত করুন';
      add.addEventListener('click', () => { this.mode = 'add'; this.render(); });
      root.append(add);
    }
  }

  private linkCard(g: GuardianLink): HTMLElement {
    const d = this.o.doc;
    const card = d.createElement('div');
    card.className = 'card';
    card.style.margin = '0 var(--s-4) var(--s-3)';

    const head = d.createElement('div');
    head.className = 'page-header-row';
    const name = d.createElement('p');
    name.className = 'system-title';
    name.textContent = g.nameBn;
    head.append(name);
    if (g.isPrimary) {
      const chip = d.createElement('span');
      chip.className = 'status-chip';
      chip.setAttribute('data-state', 'success');
      chip.textContent = 'প্রধান';
      head.append(chip);
    }
    card.append(head);

    const meta = d.createElement('p');
    meta.className = 'att-sub';
    meta.textContent =
      `${RELATION_BN[g.relation] ?? g.relation}` +
      (g.phone ? ` · ${g.phone}` : '') +
      (g.otherWards > 0 ? ` · এই প্রতিষ্ঠানে আরও ${bnNum(g.otherWards)} জন সন্তান` : '');
    card.append(meta);

    if (!this.o.canManage) {
      const ro = d.createElement('p');
      ro.className = 'att-sub';
      ro.textContent =
        (g.receivesSms ? 'এসএমএস পান' : 'এসএমএস পান না') + ' · ' +
        (g.canPayFees ? 'ফি পরিশোধ করতে পারেন' : 'ফি পরিশোধ করতে পারেন না');
      card.append(ro);
      return card;
    }

    card.append(this.toggle(
      'এসএমএস পাবেন', g.receivesSms,
      'হাজিরা, নোটিশ ও সাধারণ বার্তা এই নম্বরে যাবে।',
      (v) => void this.patch(g, { receivesSms: v })));

    card.append(this.toggle(
      'ফি পরিশোধ করতে পারবেন', g.canPayFees,
      'ইনভয়েস ও ফির নোটিশ কেবল এই অনুমতি থাকা অভিভাবকদের কাছে যায়।',
      (v) => void this.patch(g, { canPayFees: v })));

    if (!g.isPrimary) {
      const mk = d.createElement('button');
      mk.type = 'button';
      mk.className = 'btn-ghost btn-small';
      mk.disabled = this.busy;
      mk.textContent = 'প্রধান অভিভাবক করুন';
      mk.addEventListener('click', () => {
        const current = this.links.find((x) => x.isPrimary);
        card.append(confirmDialog({
          doc: d,
          title: 'প্রধান অভিভাবক পরিবর্তন',
          body: current
            ? `${current.nameBn}-এর পরিবর্তে ${g.nameBn} প্রধান অভিভাবক হবেন। ` +
              'জরুরি প্রয়োজনে প্রতিষ্ঠান প্রধান অভিভাবককেই আগে ফোন করে।'
            : `${g.nameBn} প্রধান অভিভাবক হবেন।`,
          confirmLabel: 'পরিবর্তন করুন',
          danger: true,
          onConfirm: () => void this.patch(g, { isPrimary: true }),
        }));
      });
      card.append(mk);
    }
    return card;
  }

  /**
   * A checkbox with its consequence written underneath it. The label alone
   * ("ফি পরিশোধ করতে পারবেন") does not tell an office that unticking it stops
   * the invoice SMS, which is the thing they will be asked about.
   */
  private toggle(
    labelBn: string, value: boolean, explainBn: string, onChange: (v: boolean) => void,
  ): HTMLElement {
    const d = this.o.doc;
    const wrap = d.createElement('div');
    wrap.style.margin = 'var(--s-2) 0';

    const l = d.createElement('label');
    l.className = 'sms-toggle';
    const cb = d.createElement('input');
    cb.type = 'checkbox';
    cb.checked = value;
    cb.disabled = this.busy;
    cb.addEventListener('change', () => onChange(cb.checked));
    l.append(cb, d.createTextNode(' ' + labelBn));

    const why = d.createElement('p');
    why.className = 'att-sub';
    why.textContent = explainBn;

    wrap.append(l, why);
    return wrap;
  }

  private addPanel(): HTMLElement {
    const d = this.o.doc;
    const wrap = d.createElement('div');

    const card = d.createElement('form');
    card.className = 'card card-form';
    card.style.margin = '0 var(--s-4) var(--s-3)';

    const h = d.createElement('p');
    h.className = 'notice-confirm-label';
    h.textContent = 'অভিভাবক যুক্ত করুন';
    card.append(h);

    const hint = d.createElement('p');
    hint.className = 'att-sub';
    hint.textContent =
      'আগে খুঁজে দেখুন — একই অভিভাবক প্রতিষ্ঠানে আগে থেকেই থাকতে পারেন। ' +
      'একই ব্যক্তির দুইটি অ্যাকাউন্ট হলে প্রতিটি নোটিশের এসএমএস দুইবার যাবে।';
    card.append(hint);

    const searchField = d.createElement('label');
    searchField.className = 'field';
    searchField.textContent = 'নাম বা পুরো মোবাইল নম্বর';
    const term = d.createElement('input');
    term.type = 'search';
    term.className = 'field-input';
    searchField.append(term);
    card.append(searchField);

    const go = d.createElement('button');
    go.type = 'submit';
    go.className = 'btn-secondary';
    go.disabled = this.busy;
    go.textContent = this.busy ? 'খোঁজা হচ্ছে…' : 'খুঁজুন';
    card.append(go);
    card.addEventListener('submit', (e) => {
      e.preventDefault();
      if (term.value.trim()) void this.search(term.value.trim());
    });

    wrap.append(card);

    if (this.searched) {
      if (this.candidates.length === 0) {
        wrap.append(emptyState(d, {
          message: 'এই নামে বা নম্বরে কাউকে পাওয়া যায়নি — নিচে নতুন অভিভাবক তৈরি করুন।',
        }));
      } else {
        const list = d.createElement('div');
        list.className = 'system-list';
        for (const c of this.candidates) {
          const row = d.createElement('button');
          row.type = 'button';
          row.className = 'system-row';
          const t = d.createElement('span');
          t.className = 'system-title';
          t.textContent = c.nameBn;
          const desc = d.createElement('span');
          desc.className = 'system-desc';
          desc.textContent = (c.phone ?? '') +
            (c.wardCount > 0 ? ` · ইতিমধ্যে ${bnNum(c.wardCount)} জন সন্তানের অভিভাবক` : '');
          row.append(t, desc);
          row.addEventListener('click', () => wrap.append(this.detailsForm(c.id, c.nameBn)));
          list.append(row);
        }
        wrap.append(list);
      }
    }

    wrap.append(this.detailsForm(null, null));

    const cancel = d.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn-ghost btn-small';
    cancel.style.margin = '0 var(--s-4) var(--s-4)';
    cancel.textContent = 'বাতিল';
    cancel.addEventListener('click', () => {
      this.mode = 'list'; this.candidates = []; this.searched = false; this.render();
    });
    wrap.append(cancel);

    return wrap;
  }

  /**
   * The relation-and-permissions form. Used twice: with a chosen existing
   * guardian, and to create a new one. One form, so the permissions cannot
   * be asked for in one path and defaulted in the other.
   */
  private detailsForm(guardianId: string | null, nameOfChosen: string | null): HTMLElement {
    const d = this.o.doc;
    const form = d.createElement('form');
    form.className = 'card card-form';
    form.style.margin = '0 var(--s-4) var(--s-3)';

    const h = d.createElement('p');
    h.className = 'notice-confirm-label';
    h.textContent = guardianId ? `${nameOfChosen} — সম্পর্ক ও অনুমতি` : 'নতুন অভিভাবক';
    form.append(h);

    let nameBn: HTMLInputElement | null = null;
    let phone: HTMLInputElement | null = null;
    if (!guardianId) {
      const nf = d.createElement('label');
      nf.className = 'field';
      nf.textContent = 'নাম';
      nameBn = d.createElement('input');
      nameBn.type = 'text';
      nameBn.className = 'field-input';
      nf.append(nameBn);

      const pf = d.createElement('label');
      pf.className = 'field';
      pf.textContent = 'মোবাইল';
      phone = d.createElement('input');
      phone.type = 'tel';
      phone.className = 'field-input';
      phone.placeholder = '01XXXXXXXXX';
      pf.append(phone);

      form.append(nf, pf);
    }

    const rf = d.createElement('label');
    rf.className = 'field';
    rf.textContent = 'সম্পর্ক';
    const relation = d.createElement('select');
    relation.className = 'field-input';
    for (const [k, v] of Object.entries(RELATION_BN)) {
      const opt = d.createElement('option');
      opt.value = k; opt.textContent = v;
      if (k === 'father') opt.selected = true;
      relation.append(opt);
    }
    rf.append(relation);
    form.append(rf);

    const mk = (labelBn: string, checked: boolean): HTMLInputElement => {
      const l = d.createElement('label');
      l.className = 'sms-toggle';
      const cb = d.createElement('input');
      cb.type = 'checkbox';
      cb.checked = checked;
      l.append(cb, d.createTextNode(' ' + labelBn));
      form.append(l);
      return cb;
    };
    const isPrimary = mk('প্রধান অভিভাবক', this.links.length === 0);
    const receivesSms = mk('এসএমএস পাবেন', true);
    const canPayFees = mk('ফি পরিশোধ করতে পারবেন', true);

    const err = d.createElement('p');
    err.className = 'login-error';
    err.setAttribute('role', 'alert');
    err.hidden = true;
    form.append(err);

    const save = d.createElement('button');
    save.type = 'submit';
    save.className = 'btn-primary';
    save.disabled = this.busy;
    save.textContent = this.busy ? 'যুক্ত হচ্ছে…' : 'যুক্ত করুন';
    form.append(save);

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      err.hidden = true;
      if (!guardianId) {
        if (!nameBn?.value.trim()) { err.textContent = 'নাম লিখুন'; err.hidden = false; return; }
        if (!phone?.value.trim()) { err.textContent = 'মোবাইল নম্বর লিখুন'; err.hidden = false; return; }
      }
      void this.link({
        guardianId: guardianId ?? undefined,
        nameBn: nameBn?.value.trim(),
        phone: phone?.value.trim(),
        relation: relation.value,
        isPrimary: isPrimary.checked,
        receivesSms: receivesSms.checked,
        canPayFees: canPayFees.checked,
      });
    });

    return form;
  }
}
