/**
 * Correcting a class or section name.  (B-6)
 *
 * A section typed "কক" instead of "ক" could only be fixed with SQL until now.
 * The database has allowed the write since R-3 (migration 042 gives `classes`
 * and `sections` an UPDATE scope for four roles); what was missing was the
 * distance between that policy and a person, and the pilot runbook calls that
 * a blocker.
 *
 * ── Why a drawer and not an inline form ────────────────────────────────────
 * The create forms on this screen are inline, and correctly: creating is the
 * expected next action after looking at an empty list. Correcting is not — it
 * is rare, it is done to one named thing, and it needs that thing's current
 * value in front of you. A drawer titled with the name being changed puts the
 * before and the after in the same glance, and leaves the tree undisturbed
 * behind it.
 *
 * ── What it does not offer ─────────────────────────────────────────────────
 * No class, no year, no level, no stream, no group. The endpoint refuses all
 * of them and the form does not draw them, so the UI cannot suggest a change
 * the server will silently drop. Moving a section between classes moves every
 * child in it without one enrolment row changing; that is the rollover tool's
 * job, where it is explicit and audited per student.
 */
import {
  el, append, field, button, buttonRow, openDrawer, humanError, announce,
  type Field,
} from './ui/index.ts';
import type { Auth } from './auth.ts';
import { formatCount } from '../../../packages/ui-core/src/format.ts';

export interface RenameTarget {
  kind: 'class' | 'section';
  id: string;
  /** What it is called now. Pre-filled, because this is a correction. */
  nameBn: string;
  /** `class` only: the Latin name, which is NOT NULL in the schema. */
  nameEn?: string;
  /** `section` only. */
  capacity?: number;
  /** `section` only — shown, never edited, so a low cap is not set blind. */
  studentCount?: number;
}

export interface RenameOptions {
  doc: Document;
  auth: Auth;
  target: RenameTarget;
  /** Called after a successful save, with the new name. */
  onSaved: (nameBn: string) => void;
}

/** Open the rename drawer. Returns nothing: the drawer owns its own lifetime. */
export function openRename(o: RenameOptions): void {
  const d = o.doc;
  const t = o.target;
  const isClass = t.kind === 'class';

  const errLine = el(d, 'p', {
    className: 'ui-field-error',
    attrs: { role: 'alert', hidden: 'hidden' },
  });

  const nameField: Field = field(d, {
    label: isClass ? 'শ্রেণির নাম (বাংলা)' : 'সেকশনের নাম',
    name: 'nameBn',
    value: t.nameBn,
    required: true,
    attrs: { maxlength: isClass ? 60 : 20 },
    helper: isClass
      ? undefined
      : 'শুধু নাম বদলায় — শিক্ষার্থী, হাজিরা বা ফলাফলের কিছুই বদলায় না।',
  });

  const enField = isClass
    ? field(d, {
        label: 'ইংরেজি নাম',
        name: 'nameEn',
        value: t.nameEn ?? '',
        helper: 'সনদ ও রিপোর্টে ছাপা হয়। খালি রাখলে বাংলা নামই ব্যবহার হবে।',
        attrs: { maxlength: 60 },
      })
    : null;

  const capField = !isClass
    ? field(d, {
        label: 'ধারণক্ষমতা',
        name: 'capacity',
        kind: 'number',
        value: String(t.capacity ?? ''),
        // The number the office needs before it can choose one. Without it a
        // capacity below the enrolled count is a guess the server refuses,
        // which reads as the form being broken.
        helper: t.studentCount !== undefined
          // A COUNT, so Bangla digits — unlike a roll number, which stays
          // Latin because it is an identifier read down a phone line.
          ? `এই শাখায় এখন ${formatCount(t.studentCount, 'bn')} জন শিক্ষার্থী আছে — এর কম দেওয়া যাবে না।`
          : undefined,
        attrs: { min: 1, max: 300 },
      })
    : null;

  const save = button(d, { label: 'সংরক্ষণ করুন', variant: 'primary' });
  const cancel = button(d, { label: 'বাতিল', variant: 'secondary' });

  const handle = openDrawer(d, {
    // The current name in the title: the drawer says which of forty sections
    // is being changed, without the form having to repeat it.
    title: isClass ? `“${t.nameBn}” শ্রেণির নাম সংশোধন` : `“${t.nameBn}” সেকশনের নাম সংশোধন`,
    body: el(d, 'div', { className: 'ui-form' },
      nameField.root, enField?.root ?? null, capField?.root ?? null, errLine),
    actions: [buttonRow(d, cancel, save)],
  });

  cancel.addEventListener('click', () => handle.close());

  const fail = (msg: string): void => {
    errLine.textContent = msg;
    errLine.removeAttribute('hidden');
    // Announced as well as shown: the drawer's focus may be on the button the
    // person just pressed, and a message that only appears is a message a
    // screen-reader user does not get.
    announce(d, msg, true);   // assertive: the drawer's focus is on the button just pressed
    save.removeAttribute('disabled');
    save.removeAttribute('aria-busy');
  };

  save.addEventListener('click', () => {
    const nameBn = nameField.value().trim();
    if (!nameBn) { fail('নাম লিখুন।'); return; }

    errLine.setAttribute('hidden', 'hidden');
    save.setAttribute('disabled', 'true');
    save.setAttribute('aria-busy', 'true');

    const body: Record<string, unknown> = { kind: t.kind, id: t.id };
    if (isClass) { body.nameBn = nameBn; body.nameEn = enField?.value().trim() || nameBn; }
    else {
      body.name = nameBn;
      const cap = capField?.value().trim();
      if (cap) body.capacity = Number(cap);
    }

    void (async () => {
      try {
        const res = await o.auth.authedFetch('/api/v1/ops/structure', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          // The server's own sentence when it has one — it knows things the
          // client does not, like how many children are enrolled. Otherwise
          // the canonical message for the status.
          const err = (await res.json().catch(() => ({}))) as
            { message?: string; error?: string };
          fail(err.message || humanError(err.error ?? null, res.status));
          return;
        }
        handle.close();
        announce(d, `নাম বদলে “${nameBn}” করা হয়েছে।`);
        o.onSaved(nameBn);
      } catch {
        fail(humanError(navigator.onLine ? null : 'offline'));
      }
    })();
  });
}
