/**
 * Notices — the one definition of who a notice is for.
 *
 * R-2 of docs/11-MASTER-PLAN.md. Same rule as R-1's branding contract (D4/D5
 * reasoning): the composer and the API validate against ONE module, because
 * two implementations of one schema drift, and the direction they drift is
 * always "the server accepted an audience the composer would have refused".
 *
 * ── Category is not audience ────────────────────────────────────────────
 * The two are separate fields and separate ideas, and conflating them is the
 * mistake this module exists to prevent.
 *
 *   category  — what KIND of news this is. Drives the icon, the grouping in
 *               the inbox, and whether SMS is on by default.
 *   audience  — WHO receives it. The only thing that decides delivery.
 *
 * A fee notice (`category: 'fee'`) addressed to `{type:'all'}` reaches
 * teachers too, and it should: a teacher with a child at the school is a
 * guardian. If category silently narrowed the audience, that parent would
 * never be told their own child's fees were due, and nothing would report it.
 *
 * ── Why the server resolves the audience, not the client ────────────────
 * The composer sends INTENT ({"type":"section","ids":[…]}). Membership —
 * which students are in that section, which guardians those students have —
 * is resolved by app.resolve_notice_audience() at publish time, inside the
 * tenant's RLS context. A client that sent a recipient list would be asking
 * the server to trust a roster the client assembled, which is the whole
 * confused-deputy problem R-1 removed from the branding endpoints.
 */

export const NOTICE_CATEGORIES = [
  'general', 'teacher', 'student', 'guardian', 'class',
  'section', 'exam', 'fee', 'attendance', 'emergency',
] as const;

export type NoticeCategory = (typeof NOTICE_CATEGORIES)[number];

export const AUDIENCE_TYPES = [
  'all', 'staff', 'students', 'guardians', 'guardians_payers',
  'class', 'section', 'users',
] as const;

export type AudienceType = (typeof AUDIENCE_TYPES)[number];

/** Audience types that address a set of named rows and therefore need ids. */
const NEEDS_IDS = new Set<AudienceType>(['class', 'section', 'users']);

export interface NoticeAudience {
  type: AudienceType;
  /** Present only for class / section / users. */
  ids?: string[];
}

export interface NoticeDraft {
  title: string;
  body: string;
  category: NoticeCategory;
  audience: NoticeAudience;
  sendSms: boolean;
}

export const NOTICE_LIMITS = Object.freeze({
  title: 200,
  body: 4000,
  /**
   * A single notice may not name more than this many classes, sections or
   * users. Not a performance limit — an author selecting 400 sections has
   * almost certainly meant "everyone", and the composer should say so rather
   * than fan out to a list nobody checked.
   */
  ids: 200,
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class NoticeError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.field = field;
  }
}

/** Bangla labels, so the composer and any server-side error agree on wording. */
export const CATEGORY_LABELS_BN: Record<NoticeCategory, string> = {
  general: 'সাধারণ',
  teacher: 'শিক্ষকদের জন্য',
  student: 'শিক্ষার্থীদের জন্য',
  guardian: 'অভিভাবকদের জন্য',
  class: 'শ্রেণি',
  section: 'শাখা',
  exam: 'পরীক্ষা',
  fee: 'বেতন ও ফি',
  attendance: 'হাজিরা',
  emergency: 'জরুরি',
};

export const AUDIENCE_LABELS_BN: Record<AudienceType, string> = {
  all: 'সবাই',
  staff: 'শুধু শিক্ষক ও কর্মকর্তা',
  students: 'সব শিক্ষার্থী',
  guardians: 'সব অভিভাবক',
  // System-raised fee notices only — a payment reminder to someone with no
  // authority to pay is noise that costs an SMS. Not offered in the composer.
  guardians_payers: 'ফি পরিশোধে অনুমোদিত অভিভাবক',
  class: 'নির্দিষ্ট শ্রেণি',
  section: 'নির্দিষ্ট শাখা',
  users: 'নির্দিষ্ট ব্যক্তি',
};

/**
 * Categories where SMS is ON by default in the composer.
 *
 * Advice, not enforcement: the author can always turn it off, and turn it on
 * for anything. The defaults exist because SMS is roughly 80% of the
 * infrastructure bill (docs/05 §5), so the question "does this need to reach
 * a phone?" should be answered deliberately rather than by whatever the
 * checkbox happened to be left at.
 */
export function smsDefaultFor(category: NoticeCategory): boolean {
  return category === 'emergency' || category === 'attendance';
}

export function parseAudience(input: unknown): NoticeAudience {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new NoticeError('audience', 'audience must be an object');
  }
  const a = input as Record<string, unknown>;
  const type = a.type;
  if (typeof type !== 'string' || !(AUDIENCE_TYPES as readonly string[]).includes(type)) {
    throw new NoticeError('audience',
      `audience.type must be one of: ${AUDIENCE_TYPES.join(', ')}`);
  }
  const t = type as AudienceType;

  if (!NEEDS_IDS.has(t)) {
    // Ids on a broadcast audience mean the author changed their mind and the
    // UI did not clear the selection. Dropping them silently would publish to
    // everyone while the composer still showed three sections selected.
    if (a.ids !== undefined && Array.isArray(a.ids) && a.ids.length > 0) {
      throw new NoticeError('audience',
        `audience type "${t}" reaches everyone in that group and cannot also name ids`);
    }
    return { type: t };
  }

  if (!Array.isArray(a.ids) || a.ids.length === 0) {
    throw new NoticeError('audience',
      `audience type "${t}" needs at least one selection`);
  }
  if (a.ids.length > NOTICE_LIMITS.ids) {
    throw new NoticeError('audience',
      `at most ${NOTICE_LIMITS.ids} selections — did you mean everyone?`);
  }
  const ids: string[] = [];
  for (const raw of a.ids) {
    if (typeof raw !== 'string' || !UUID_RE.test(raw)) {
      throw new NoticeError('audience', 'every selection must be an id');
    }
    // De-duplicate: the same section named twice would resolve to the same
    // people anyway (uq_notice_receipt collapses it), but the recipient count
    // shown to the author should not double.
    if (!ids.includes(raw)) ids.push(raw);
  }
  return { type: t, ids };
}

/**
 * Validate and normalise a draft. Throws NoticeError — never returns a
 * half-valid notice, because a notice published to the wrong audience cannot
 * be recalled from the phones it reached.
 */
export function parseNotice(input: unknown): NoticeDraft {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new NoticeError('notice', 'notice must be an object');
  }
  const i = input as Record<string, unknown>;

  const text = (field: 'title' | 'body', max: number): string => {
    const v = i[field];
    if (typeof v !== 'string') throw new NoticeError(field, `${field} is required`);
    // Control characters would survive into an SMS body and a printed notice.
    const clean = v.replace(/[\u0000-\u001f\u007f]/g, '').trim();
    if (clean.length === 0) throw new NoticeError(field, `${field} cannot be empty`);
    if (clean.length > max) {
      throw new NoticeError(field, `${field} must be ${max} characters or fewer`);
    }
    return clean;
  };

  const category = i.category === undefined ? 'general' : i.category;
  if (typeof category !== 'string'
    || !(NOTICE_CATEGORIES as readonly string[]).includes(category)) {
    throw new NoticeError('category',
      `category must be one of: ${NOTICE_CATEGORIES.join(', ')}`);
  }

  return {
    title: text('title', NOTICE_LIMITS.title),
    body: text('body', NOTICE_LIMITS.body),
    category: category as NoticeCategory,
    audience: parseAudience(i.audience ?? { type: 'all' }),
    sendSms: i.sendSms === true,
  };
}

/**
 * How many SMS segments this notice's body would cost per recipient.
 *
 * Bangla forces UCS-2, which is 70 characters per segment rather than GSM-7's
 * 160 — the single most expensive detail in the product. The composer shows
 * this next to the SMS toggle so the cost of a long message is visible while
 * it is being written, not after it has been sent to 900 guardians.
 */
export function smsSegmentsFor(body: string): number {
  // Any character outside the GSM-7 basic set forces the whole message to
  // UCS-2 — one Bangla word in an English notice doubles its cost.
  const isUnicode = /[^\u0000-\u007f]/.test(body);
  const perSegment = isUnicode ? 70 : 160;
  return Math.max(1, Math.ceil(body.length / perSegment));
}

/** A one-line Bangla summary of the cost, for the composer. */
export function smsCostHintBn(body: string, recipients: number): string {
  const seg = smsSegmentsFor(body);
  const total = seg * Math.max(0, recipients);
  return `প্রতি জনে ${seg}টি এসএমএস · আনুমানিক মোট ${total}টি`;
}
