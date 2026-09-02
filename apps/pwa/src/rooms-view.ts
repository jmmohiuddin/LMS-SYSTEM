/**
 * কক্ষ ব্যবস্থাপনা — the room register.  (P0)
 *
 * `rooms` has been read-only since migration 003: the solver reads it, the
 * routine grid joins it, the admit card prints it, and across 112 institutions
 * there were zero rows. This is the screen that fills it.
 *
 * ── Deactivate, never delete ────────────────────────────────────────────
 * There is no delete button and migration 065 gives no role the right.
 * `exam_halls.room_id` is ON DELETE RESTRICT and the timetable's is ON DELETE
 * SET NULL, so removing a room either fails on an exam hall or makes every
 * past routine forget where a class was held. A room a school stops using is
 * marked out of service, and the confirmation says what it is still carrying.
 *
 * ── Capabilities come from the server ───────────────────────────────────
 * The list of what a room can be is whatever the school's subjects actually
 * require. A hard-coded list here would drift the day a school adds a subject,
 * and would offer capabilities that could never match anything.
 */
import type { Auth } from './auth.ts';
import { skeleton, errorState, emptyState, successNote, bnNum } from './view-states.ts';
import { pageHeader } from './ui/page-header.ts';
import {
  el, append, button, buttonRow, field, dataTable, statusBadge,
  permissionState, permissionMessage, openDrawer, confirmOverlay,
  type OverlayHandle,
} from './ui/index.ts';

interface Room {
  id: string;
  code: string;
  nameBn: string | null;
  building: string | null;
  floorNo: number | null;
  capacity: number | null;
  capabilities: string[];
  isBookable: boolean;
  homeSections: number;
  slotCount: number;
  hallCount: number;
}

interface Body {
  canManage: boolean;
  capabilityOptions: string[];
  rooms: Room[];
}

export interface RoomsViewOptions {
  root: HTMLElement;
  doc: Document;
  auth: Auth;
}

/** What a capability means to somebody who is not a database. */
const CAPABILITY_BN: Record<string, string> = {
  physics_lab: 'পদার্থবিজ্ঞান ল্যাব',
  chemistry_lab: 'রসায়ন ল্যাব',
  biology_lab: 'জীববিজ্ঞান ল্যাব',
  computer: 'কম্পিউটার ল্যাব',
};
const capLabel = (c: string) => CAPABILITY_BN[c] ?? c;

export class RoomsView {
  private data: Body | null = null;
  private loading = true;
  private denied = false;
  private error = '';
  private notice = '';
  private busy = false;

  constructor(private readonly o: RoomsViewOptions) {
    this.render();
    void this.load();
  }

  private async load(): Promise<void> {
    this.loading = true;
    this.error = '';
    this.render();
    try {
      const res = await this.o.auth.authedFetch('/api/v1/rms/rooms');
      if (res.status === 403) { this.denied = true; return; }
      if (!res.ok) throw new Error(String(res.status));
      this.data = await res.json() as Body;
    } catch {
      this.error = 'কক্ষের তালিকা আনা যায়নি।';
    } finally {
      this.loading = false;
      this.render();
    }
  }

  private async send(method: 'POST' | 'PATCH', body: unknown, ok: string): Promise<boolean> {
    this.busy = true;
    this.error = '';
    this.notice = '';
    this.render();
    try {
      const res = await this.o.auth.authedFetch('/api/v1/rms/rooms', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const out = await res.json() as { message?: string; code?: string };
      if (!res.ok) {
        // The server's Bangla message names the field; showing it verbatim is
        // better than a generic failure the office cannot act on.
        this.error = out.message ?? 'কক্ষ সংরক্ষণ করা যায়নি।';
        return false;
      }
      this.notice = `${out.code ?? 'কক্ষ'} — ${ok}`;
      return true;
    } catch {
      this.error = 'কক্ষ সংরক্ষণ করা যায়নি।';
      return false;
    } finally {
      this.busy = false;
      await this.load();
    }
  }

  private render(): void {
    const d = this.o.doc;
    const root = this.o.root;
    root.textContent = '';

    root.append(pageHeader(d, {
      title: 'কক্ষ ব্যবস্থাপনা',
      subtitle: 'শ্রেণিকক্ষ ও ল্যাব — রুটিন ও পরীক্ষার আসন বিন্যাসে এগুলোই ব্যবহার হয়',
    }));

    if (this.denied) {
      root.append(permissionState(d, {
        message: permissionMessage('কক্ষ'),
        contact: 'প্রধান শিক্ষক, প্রতিষ্ঠান মালিক, একাডেমিক সমন্বয়কারী ও আইটি অ্যাডমিন',
      }));
      return;
    }

    if (this.notice) root.append(successNote(d, this.notice));
    if (this.error) root.append(errorState(d, this.error, () => void this.load()));

    if (this.loading) { root.append(skeleton(d, 4)); return; }
    const data = this.data;
    if (!data) return;

    if (data.canManage) {
      root.append(buttonRow(d, button(d, {
        label: 'নতুন কক্ষ',
        variant: 'primary',
        disabled: this.busy,
        onClick: () => this.openForm(null),
      })));
    }

    if (data.rooms.length === 0) {
      root.append(emptyState(d, {
        message: 'এখনো কোনো কক্ষ যোগ করা হয়নি। রুটিন তৈরি করতে অন্তত একটি কক্ষ দরকার।',
        action: data.canManage
          ? { label: 'প্রথম কক্ষ যোগ করুন', onClick: () => this.openForm(null) }
          : undefined,
      }));
      return;
    }

    root.append(dataTable(d, {
      caption: 'কক্ষের তালিকা',
      rows: data.rooms,
      rowKey: (r) => r.id,
      columns: [
        {
          key: 'code', header: 'কোড', mobile: 'title',
          cell: (r) => (r.nameBn ? `${r.nameBn} (${r.code})` : r.code),
          width: 'minmax(0, 2fr)',
        },
        {
          key: 'where', header: 'অবস্থান', mobile: 'subtitle',
          cell: (r) => [r.building, r.floorNo === null ? '' : `${bnNum(r.floorNo)} তলা`]
            .filter(Boolean).join(' · ') || '—',
        },
        {
          key: 'capacity', header: 'ধারণক্ষমতা', mobile: 'meta', numeric: true,
          cell: (r) => (r.capacity === null ? '—' : `${bnNum(r.capacity)} জন`),
        },
        {
          key: 'caps', header: 'সুবিধা', mobile: 'meta',
          cell: (r) => (r.capabilities.length ? r.capabilities.map(capLabel).join(' · ') : '—'),
        },
        {
          key: 'state', header: 'অবস্থা', mobile: 'status',
          cell: (r) => statusBadge(d, {
            state: r.isBookable ? 'published' : 'overdue',
            label: r.isBookable ? 'ব্যবহারযোগ্য' : 'বন্ধ',
          }),
        },
        ...(data.canManage ? [{
          key: 'actions', header: 'ব্যবস্থা',
          cell: (r: Room) => this.rowActions(r),
        }] : []),
      ],
    }));
  }

  private rowActions(r: Room): HTMLElement {
    const d = this.o.doc;
    return buttonRow(d,
      button(d, {
        label: 'সম্পাদনা', size: 'sm', disabled: this.busy,
        onClick: () => this.openForm(r),
      }),
      button(d, {
        label: r.isBookable ? 'বন্ধ করুন' : 'চালু করুন',
        size: 'sm',
        variant: r.isBookable ? 'danger' : 'secondary',
        disabled: this.busy,
        onClick: () => this.confirmToggle(r),
      }));
  }

  private confirmToggle(r: Room): void {
    if (!r.isBookable) {
      void this.send('PATCH', { id: r.id, isBookable: true }, 'আবার চালু করা হয়েছে।');
      return;
    }
    // Say what the room is carrying rather than asking blind. A room with a
    // section's home in it stays reachable through that home even when it is
    // out of service — the office should know that before deciding.
    const carrying = [
      r.homeSections > 0 ? `${bnNum(r.homeSections)}টি সেকশনের নিজস্ব কক্ষ` : '',
      r.slotCount > 0 ? `রুটিনে ${bnNum(r.slotCount)}টি ক্লাস` : '',
      r.hallCount > 0 ? `${bnNum(r.hallCount)}টি পরীক্ষার হল` : '',
    ].filter(Boolean);

    confirmOverlay(this.o.doc, {
      title: `${r.nameBn ?? r.code} বন্ধ করবেন?`,
      body: carrying.length
        ? `এই কক্ষে এখন ${carrying.join(', ')} আছে। বন্ধ করলে নতুন রুটিনে এটি আর বাছাই হবে না — পুরোনো রেকর্ড অপরিবর্তিত থাকবে।`
        : 'বন্ধ করলে নতুন রুটিনে এই কক্ষটি আর বাছাই হবে না। কিছুই মুছে যাবে না।',
      confirmLabel: 'বন্ধ করুন',
      danger: true,
      onConfirm: () => { void this.send('PATCH', { id: r.id, isBookable: false }, 'বন্ধ করা হয়েছে।'); },
    });
  }

  private openForm(existing: Room | null): void {
    const d = this.o.doc;
    const opts = this.data?.capabilityOptions ?? [];
    const form = el(d, 'div', { className: 'ui-fieldset' });

    const code = field(d, {
      label: 'কক্ষের কোড', name: 'code', required: true,
      value: existing?.code ?? '',
      helper: 'দরজায় যা লেখা আছে — ২০৪, ল্যাব-১',
      attrs: { maxlength: 20 },
    });
    const nameBn = field(d, {
      label: 'নাম', name: 'nameBn', value: existing?.nameBn ?? '',
      helper: 'ঐচ্ছিক — "পদার্থবিজ্ঞান ল্যাব"', attrs: { maxlength: 80 },
    });
    const building = field(d, {
      label: 'ভবন', name: 'building', value: existing?.building ?? '',
      helper: 'ঐচ্ছিক', attrs: { maxlength: 60 },
    });
    const floorNo = field(d, {
      label: 'তলা', name: 'floorNo', kind: 'number',
      value: existing?.floorNo === null || existing?.floorNo === undefined ? '' : String(existing.floorNo),
      helper: 'ঐচ্ছিক', attrs: { min: -2, max: 20, step: 1 },
    });
    const capacity = field(d, {
      label: 'ধারণক্ষমতা', name: 'capacity', kind: 'number', required: true,
      value: String(existing?.capacity ?? 60),
      helper: 'কতজন শিক্ষার্থী বসতে পারে — পরীক্ষার আসন বিন্যাস এই সংখ্যাটি ব্যবহার করে।',
      attrs: { min: 1, max: 1000, step: 1 },
    });

    append(form, code.root, nameBn.root, building.root, floorNo.root, capacity.root);

    // Capabilities as checkboxes: the set is small, server-supplied, and a
    // multi-select is a worse control on a phone.
    // Toggle buttons, not checkboxes: this design system has no checkbox field
    // kind, and the same control served the staff register in M6 — a filled
    // button reads as an answer rather than an open question, and it is a
    // thumb-sized target on a phone.
    const chosen = new Set(existing?.capabilities ?? []);
    if (opts.length) {
      const group = el(d, 'div', { className: 'ui-fieldset' });
      append(group, el(d, 'p', { className: 'ui-field-label', text: 'বিশেষ সুবিধা' }));
      const row = buttonRow(d);
      for (const cap of opts) {
        const btn = button(d, {
          label: capLabel(cap),
          variant: chosen.has(cap) ? 'primary' : 'secondary',
          onClick: () => {
            if (chosen.has(cap)) chosen.delete(cap); else chosen.add(cap);
            btn.className = btn.className.replace(
              chosen.has(cap) ? 'btn-secondary' : 'btn-primary',
              chosen.has(cap) ? 'btn-primary' : 'btn-secondary');
            btn.setAttribute('aria-pressed', chosen.has(cap) ? 'true' : 'false');
          },
        });
        btn.setAttribute('aria-pressed', chosen.has(cap) ? 'true' : 'false');
        append(row, btn);
      }
      append(group, row, el(d, 'p', {
        className: 'att-sub',
        text: 'যে বিষয়ের জন্য ল্যাব দরকার, রুটিন তৈরির সময় সেটি কেবল এই সুবিধাযুক্ত কক্ষেই বসবে।',
      }));
      append(form, group);
    }

    let handle: OverlayHandle;
    const cancel = button(d, {
      label: 'বাতিল', variant: 'secondary',
      onClick: () => handle.close(),
    });
    const save = button(d, {
      label: existing ? 'সংরক্ষণ করুন' : 'যোগ করুন',
      variant: 'primary',
      onClick: () => {
        const floorRaw = floorNo.input.value.trim();
        const payload: Record<string, unknown> = {
          code: code.input.value.trim(),
          nameBn: nameBn.input.value.trim(),
          building: building.input.value.trim(),
          floorNo: floorRaw === '' ? null : Number(floorRaw),
          capacity: Number(capacity.input.value),
          capabilities: [...chosen].sort(),
        };
        if (existing) payload.id = existing.id;
        handle.close();
        void this.send(existing ? 'PATCH' : 'POST', payload,
          existing ? 'সংরক্ষণ করা হয়েছে।' : 'যোগ করা হয়েছে।');
      },
    });
    handle = openDrawer(d, {
      title: existing ? `${existing.code} সম্পাদনা` : 'নতুন কক্ষ',
      body: form,
      actions: [cancel, save],
    });
  }
}
