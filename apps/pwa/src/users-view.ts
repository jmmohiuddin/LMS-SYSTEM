/**
 * ব্যবহারকারী — user management for the IT admin  (R-3, Part B)
 *
 * ── There is no delete, and the screen says why ────────────────────────
 * A teacher who left in 2024 still marked attendance in 2024 and is still the
 * answer to "who taught this section". The control is নিষ্ক্রিয় — deactivate —
 * and the confirmation states that their record stays. Without that sentence a
 * school looking for a delete button assumes the product cannot do what it
 * needs and starts keeping a parallel list on paper.
 *
 * ── Creating an account does not create a credential ───────────────────
 * The account is created 'invited'. First login goes through F-202's
 * activation code, which is a separate, audited act. So this screen never
 * shows, sets, or emails a password — there is nothing here to leak.
 *
 * ── Search is exact on phone, loose on name ────────────────────────────
 * Deliberate, and enforced server-side: a prefix search over a phone column is
 * a way to enumerate a school's contact list one digit at a time. The
 * placeholder tells the user which is which so the behaviour does not read as
 * a bug.
 */
import type { Auth } from './auth.ts';
import {
  skeleton, errorState, emptyState, successNote, confirmDialog, bnNum,
} from './view-states.ts';

interface UserRow {
  id: string; nameBn: string; nameEn: string | null; phone: string | null;
  status: string; roles: string[];
  employeeCode: string | null; studentCode: string | null;
}

export interface UsersViewOptions {
  root: HTMLElement;
  doc: Document;
  auth: Auth;
  /** Whether this caller may create and deactivate. The server is the gate. */
  canManage: boolean;
}

const ROLE_BN: Record<string, string> = {
  school_owner: 'প্রতিষ্ঠান মালিক',
  principal: 'প্রধান শিক্ষক',
  academic_coordinator: 'একাডেমিক সমন্বয়কারী',
  dept_head: 'বিভাগীয় প্রধান',
  accountant: 'হিসাবরক্ষক',
  class_teacher: 'শ্রেণি শিক্ষক',
  subject_teacher: 'বিষয় শিক্ষক',
  librarian: 'গ্রন্থাগারিক',
  it_admin: 'আইটি অ্যাডমিন',
  student: 'শিক্ষার্থী',
  guardian: 'অভিভাবক',
};

const STATUS_BN: Record<string, string> = {
  active: 'সক্রিয়', invited: 'আমন্ত্রিত', suspended: 'স্থগিত',
  left: 'নিষ্ক্রিয়', deleted: 'মুছে ফেলা',
};

/** The roles an IT admin may hand out — mirrors the server's GRANTABLE set. */
const GRANTABLE = [
  'principal', 'academic_coordinator', 'dept_head', 'accountant',
  'class_teacher', 'subject_teacher', 'librarian', 'it_admin',
];

export class UsersView {
  private readonly o: UsersViewOptions;
  private users: UserRow[] = [];
  private truncated = false;
  private term = '';
  private roleFilter = '';
  private loading = true;
  private error = '';
  private notice = '';
  private busy = false;
  private creating = false;

  constructor(options: UsersViewOptions) {
    this.o = options;
    this.render();
    void this.load();
  }

  private async load(): Promise<void> {
    this.loading = true; this.error = ''; this.render();
    try {
      const qs = new URLSearchParams();
      if (this.term) qs.set('q', this.term);
      if (this.roleFilter) qs.set('role', this.roleFilter);
      const res = await this.o.auth.authedFetch(`/api/v1/ops/users?${qs}`);
      if (res.status === 403) { this.error = 'ব্যবহারকারী দেখার অনুমতি আপনার নেই।'; return; }
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { users: UserRow[]; truncated: boolean };
      this.users = body.users ?? [];
      this.truncated = body.truncated ?? false;
    } catch {
      this.error = 'তালিকা আনা যায়নি — সংযোগ পেলে আবার দেখা যাবে।';
    } finally {
      this.loading = false; this.render();
    }
  }

  private async create(form: {
    nameBn: string; nameEn: string; phone: string; roleCode: string; employeeCode: string;
  }): Promise<void> {
    this.busy = true; this.error = ''; this.render();
    try {
      const res = await this.o.auth.authedFetch('/api/v1/ops/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const body = await res.json() as { nameBn?: string; message?: string };
      if (!res.ok) { this.error = body.message ?? 'অ্যাকাউন্ট তৈরি করা যায়নি।'; return; }
      this.notice =
        `${body.nameBn} যুক্ত হয়েছেন। প্রথমবার প্রবেশের জন্য অ্যাক্টিভেশন কোড লাগবে।`;
      this.creating = false;
      await this.load();
    } catch {
      this.error = 'সংযোগ নেই — অ্যাকাউন্ট তৈরি করা যায়নি।';
    } finally {
      this.busy = false; this.render();
    }
  }

  private async setActive(u: UserRow, active: boolean): Promise<void> {
    this.busy = true; this.error = ''; this.render();
    try {
      const res = await this.o.auth.authedFetch('/api/v1/ops/users', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: u.id, active }),
      });
      const body = await res.json() as { message?: string };
      if (!res.ok) { this.error = body.message ?? 'পরিবর্তন করা যায়নি।'; return; }
      this.notice = active
        ? `${u.nameBn} আবার সক্রিয়।`
        : `${u.nameBn} নিষ্ক্রিয় — তাঁর আগের সব রেকর্ড অপরিবর্তিত আছে।`;
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

    const header = d.createElement('header');
    header.className = 'page-header';
    const h1 = d.createElement('h1');
    h1.textContent = 'ব্যবহারকারী';
    const sub = d.createElement('p');
    sub.className = 'page-sub';
    sub.textContent = 'শিক্ষক, কর্মী ও অ্যাকাউন্ট';
    header.append(h1, sub);
    root.append(header);

    if (this.notice) root.append(successNote(d, this.notice));
    if (this.error) {
      root.append(errorState(d, this.error,
        this.error.includes('অনুমতি') ? undefined : () => void this.load()));
    }

    root.append(this.searchBar());
    if (this.o.canManage) root.append(this.createToggle());
    if (this.creating) root.append(this.createForm());

    if (this.loading) { root.append(skeleton(d, 4)); return; }

    if (this.users.length === 0) {
      root.append(emptyState(d, {
        message: this.term
          ? 'এই নামে বা নম্বরে কাউকে পাওয়া যায়নি। মোবাইল নম্বর পুরোটা লিখতে হয়।'
          : 'এখনো কোনো ব্যবহারকারী নেই।',
        action: this.o.canManage
          ? { label: 'নতুন যোগ করুন', onClick: () => { this.creating = true; this.render(); } }
          : undefined,
      }));
      return;
    }

    const list = d.createElement('div');
    list.className = 'system-list';
    for (const u of this.users) list.append(this.userRow(u));
    root.append(list);

    if (this.truncated) {
      const note = d.createElement('p');
      note.className = 'att-sub';
      note.style.padding = '0 var(--s-4) var(--s-4)';
      // Never let a capped list read as a complete one.
      note.textContent = 'প্রথম ৫০ জন দেখানো হচ্ছে — খুঁজতে নাম বা নম্বর লিখুন।';
      root.append(note);
    }
  }

  private searchBar(): HTMLElement {
    const d = this.o.doc;
    const form = d.createElement('form');
    form.className = 'card card-form';
    form.style.margin = '0 var(--s-4) var(--s-3)';

    const field = d.createElement('label');
    field.className = 'field';
    field.textContent = 'খুঁজুন';
    const input = d.createElement('input');
    input.type = 'search';
    input.className = 'field-input';
    input.value = this.term;
    input.placeholder = 'নামের অংশ, অথবা পুরো মোবাইল নম্বর';
    field.append(input);

    const roleField = d.createElement('label');
    roleField.className = 'field';
    roleField.textContent = 'ভূমিকা';
    const select = d.createElement('select');
    select.className = 'field-input';
    const any = d.createElement('option');
    any.value = ''; any.textContent = 'সব';
    select.append(any);
    for (const r of [...GRANTABLE, 'student', 'guardian']) {
      const opt = d.createElement('option');
      opt.value = r; opt.textContent = ROLE_BN[r] ?? r;
      opt.selected = this.roleFilter === r;
      select.append(opt);
    }
    roleField.append(select);

    form.append(field, roleField);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      this.term = input.value.trim();
      this.roleFilter = select.value;
      void this.load();
    });
    select.addEventListener('change', () => {
      this.roleFilter = select.value;
      void this.load();
    });

    const btn = d.createElement('button');
    btn.type = 'submit';
    btn.className = 'btn-secondary';
    btn.textContent = 'খুঁজুন';
    form.append(btn);
    return form;
  }

  private createToggle(): HTMLElement {
    const d = this.o.doc;
    const btn = d.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-ghost btn-small';
    btn.style.margin = '0 var(--s-4) var(--s-2)';
    btn.textContent = this.creating ? 'বাতিল' : 'নতুন শিক্ষক / কর্মী যোগ করুন';
    btn.addEventListener('click', () => { this.creating = !this.creating; this.render(); });
    return btn;
  }

  private createForm(): HTMLElement {
    const d = this.o.doc;
    const form = d.createElement('form');
    form.className = 'card card-form';
    form.style.margin = '0 var(--s-4) var(--s-3)';

    const mk = (labelBn: string, type: string, required: boolean, placeholder = ''): HTMLInputElement => {
      const f = d.createElement('label');
      f.className = 'field';
      f.textContent = labelBn;
      const i = d.createElement('input');
      i.type = type;
      i.className = 'field-input';
      i.required = required;
      if (placeholder) i.placeholder = placeholder;
      f.append(i);
      form.append(f);
      return i;
    };

    const nameBn = mk('নাম (বাংলা)', 'text', true);
    const nameEn = mk('নাম (ইংরেজি)', 'text', false);
    const phone = mk('মোবাইল', 'tel', true, '01XXXXXXXXX');
    const employeeCode = mk('কর্মচারী আইডি', 'text', false);

    const roleField = d.createElement('label');
    roleField.className = 'field';
    roleField.textContent = 'ভূমিকা';
    const role = d.createElement('select');
    role.className = 'field-input';
    for (const r of GRANTABLE) {
      const opt = d.createElement('option');
      opt.value = r; opt.textContent = ROLE_BN[r] ?? r;
      opt.selected = r === 'subject_teacher';
      role.append(opt);
    }
    roleField.append(role);
    form.append(roleField);

    const note = d.createElement('p');
    note.className = 'att-sub';
    note.textContent =
      'অ্যাকাউন্ট তৈরি হবে "আমন্ত্রিত" অবস্থায়। প্রথমবার প্রবেশের জন্য অ্যাক্টিভেশন কোড দিতে হবে — ' +
      'এখানে কোনো পাসওয়ার্ড তৈরি বা দেখা যায় না।';
    form.append(note);

    const btn = d.createElement('button');
    btn.type = 'submit';
    btn.className = 'btn-primary';
    btn.disabled = this.busy;
    btn.textContent = this.busy ? 'যোগ হচ্ছে…' : 'যোগ করুন';
    form.append(btn);

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.create({
        nameBn: nameBn.value.trim(),
        nameEn: nameEn.value.trim(),
        phone: phone.value.trim(),
        roleCode: role.value,
        employeeCode: employeeCode.value.trim(),
      });
    });
    return form;
  }

  private userRow(u: UserRow): HTMLElement {
    const d = this.o.doc;
    const row = d.createElement('div');
    row.className = 'system-row';

    const t = d.createElement('span');
    t.className = 'system-title';
    t.textContent = u.nameBn;

    const desc = d.createElement('span');
    desc.className = 'system-desc';
    const roles = u.roles.map((r) => ROLE_BN[r] ?? r).join(' · ') || 'ভূমিকা নেই';
    const code = u.employeeCode ?? u.studentCode;
    desc.textContent = code ? `${roles} · ${code}` : roles;

    const chip = d.createElement('span');
    chip.className = 'status-chip';
    if (u.status === 'active') chip.setAttribute('data-state', 'success');
    else if (u.status === 'left' || u.status === 'suspended') chip.setAttribute('data-state', 'warning');
    chip.textContent = STATUS_BN[u.status] ?? u.status;

    row.append(t, desc, chip);

    if (this.o.canManage) {
      const btn = d.createElement('button');
      btn.type = 'button';
      btn.className = 'btn-ghost btn-small';
      const isActive = u.status === 'active' || u.status === 'invited';
      btn.textContent = isActive ? 'নিষ্ক্রিয় করুন' : 'আবার সক্রিয় করুন';
      btn.disabled = this.busy;
      btn.addEventListener('click', () => {
        if (!isActive) { void this.setActive(u, true); return; }
        row.append(confirmDialog({
          doc: d,
          title: 'নিষ্ক্রিয় করা নিশ্চিত করুন',
          body:
            `${u.nameBn} আর প্রবেশ করতে পারবেন না। তাঁর নেওয়া হাজিরা, দেওয়া নম্বর এবং ` +
            'দায়িত্বের রেকর্ড মুছে যাবে না — কে কখন কী করেছিলেন তা সংরক্ষিত থাকবে।',
          confirmLabel: 'নিষ্ক্রিয় করুন',
          danger: true,
          onConfirm: () => void this.setActive(u, false),
        }));
      });
      row.append(btn);
    }
    return row;
  }
}
