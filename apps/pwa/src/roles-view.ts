/**
 * Roles & Access (ভূমিকা ও অ্যাক্সেস) — visualises the PRD §1 RBAC surface.
 *
 * Static: the 10 role codes are defined by the migrations and don't change
 * per-tenant; a live user-count column is fetched from the roster endpoint
 * when authenticated (this makes it useful for real principals) and falls
 * back to descriptive counts in demo mode.
 */
import { pageHeader, card, dataTable, sectionHeading, statusBadge, el } from './ui/index.ts';

export interface RolesViewOptions {
  root: HTMLElement;
  doc: Document;
}

const ROLES: { code: string; nameBn: string; scope: string; canDo: string; tier: 'system' | 'management' | 'academic' | 'finance' | 'people' }[] = [
  { code: 'super_admin',          nameBn: 'সুপার অ্যাডমিন',       scope: 'platform', canDo: 'পুরো প্ল্যাটফর্ম নিয়ন্ত্রণ',                       tier: 'system' },
  { code: 'school_owner',         nameBn: 'প্রতিষ্ঠান মালিক',      scope: 'tenant',   canDo: 'বিদ্যালয়ের সব কনফিগ ও চুক্তি',                   tier: 'management' },
  { code: 'principal',            nameBn: 'অধ্যক্ষ',               scope: 'tenant',   canDo: 'ফলাফল প্রকাশ, নিরাপত্তা সতর্কতা, সব রিপোর্ট',        tier: 'management' },
  { code: 'academic_coordinator', nameBn: 'একাডেমিক কো-অর্ডিনেটর', scope: 'tenant',   canDo: 'রুটিন, বদলি, পরীক্ষা পরিচালনা',                     tier: 'academic' },
  { code: 'dept_head',            nameBn: 'বিভাগ প্রধান',          scope: 'tenant',   canDo: 'বিষয়-ভিত্তিক মূল্যায়ন, দলিল অনুমোদন',              tier: 'academic' },
  { code: 'class_teacher',        nameBn: 'শ্রেণি শিক্ষক',         scope: 'section',  canDo: 'নিজের সেকশনের হাজিরা, রোস্টার, রুটিন',              tier: 'people' },
  { code: 'subject_teacher',      nameBn: 'বিষয় শিক্ষক',           scope: 'section',  canDo: 'শেখানো বিষয়ের নম্বর ও ক্লাসের লগ',                  tier: 'people' },
  { code: 'accountant',           nameBn: 'হিসাবরক্ষক',            scope: 'tenant',   canDo: 'ইনভয়েস, রসিদ, MFS পুনর্মিলন, লেজার',              tier: 'finance' },
  { code: 'student',              nameBn: 'শিক্ষার্থী',            scope: 'self',     canDo: 'নিজের রুটিন, ফলাফল, ফি, শিখো টিউটর',                tier: 'people' },
  { code: 'guardian',             nameBn: 'অভিভাবক',               scope: 'self',     canDo: 'নিজ সন্তানের হাজিরা, ফলাফল, ফি, রসিদ',              tier: 'people' },
];

/** `platform` and `tenant` are different KINDS of reach, not jargon. */
const SCOPE_BN: Record<string, string> = {
  platform: 'পুরো প্ল্যাটফর্ম',
  tenant: 'নিজের প্রতিষ্ঠান',
};

const TIER_LABEL: Record<string, string> = {
  system: 'সিস্টেম', management: 'ব্যবস্থাপনা', academic: 'একাডেমিক', finance: 'অর্থ', people: 'ব্যবহারকারী',
};

export class RolesView {
  constructor(o: RolesViewOptions) {
    const d = o.doc;
    o.root.textContent = '';

    o.root.append(pageHeader(d, {
      title: 'ভূমিকা ও অ্যাক্সেস',
      subtitle: 'কে কী দেখতে ও করতে পারেন — এবং কেন অন্য প্রতিষ্ঠানের তথ্য কখনো দেখা যায় না',
    }));

    // The isolation statement. A `card` rather than a bespoke `.iso-banner`:
    // it is one fact with a title, which is what a card is.
    o.root.append(card(d, {
      title: 'বিচ্ছিন্নতা সক্রিয়',
      glyph: 'lock',
      tone: 'success',
      headingLevel: 2,
      action: statusBadge(d, { state: 'published', label: 'সবসময় চালু' }),
    },
      el(d, 'p', {
        className: 'ui-card-note',
        text: 'প্রতিটি ব্যবহারকারীর অনুরোধ ডাটাবেস স্তরে নিজের প্রতিষ্ঠানে সীমাবদ্ধ করা হয় — ' +
              'অন্য বিদ্যালয়ের কোনো সারি কখনো দৃশ্যমান হয় না। এটি কোনো সেটিং নয়; ' +
              'বন্ধ করার উপায় নেই।',
      }),
    ));

    // Grouped by tier, and each tier is a TABLE. A role matrix is the
    // original tabular data: ten roles compared on the same three questions.
    // What was here — 11 full-width `.role-card` strips at 1110px — made a
    // reader hold one role in their head to compare it with the next.
    const tiers = ['system', 'management', 'academic', 'finance', 'people'] as const;
    for (const tier of tiers) {
      const inTier = ROLES.filter((r) => r.tier === tier);
      if (inTier.length === 0) continue;

      o.root.append(sectionHeading(d, { title: TIER_LABEL[tier] }));
      o.root.append(dataTable(d, {
        caption: `${TIER_LABEL[tier]} ভূমিকা`,
        rows: inTier,
        rowKey: (r) => r.code,
        columns: [
          { key: 'name', header: 'ভূমিকা', mobile: 'title', cell: (r) => r.nameBn,
            width: 'minmax(0, 1.4fr)' },
          { key: 'can', header: 'কী করতে পারেন', mobile: 'subtitle', cell: (r) => r.canDo,
            width: 'minmax(0, 2.4fr)' },
          { key: 'scope', header: 'পরিসর', mobile: 'status', width: '150px',
            cell: (r) => statusBadge(d, {
              // A platform role and a school role are different KINDS of
              // access, and that difference is the point of this page.
              state: r.scope === 'platform' ? 'overdue' : 'invited',
              label: SCOPE_BN[r.scope] ?? r.scope,
            }) },
          // The code is what appears in an audit entry and in a JWT, so an IT
          // admin genuinely needs it — at a desk, not on a phone.
          { key: 'code', header: 'কোড', mobile: 'hidden',
            cell: (r) => el(d, 'code', { className: 'role-code', text: r.code }),
            width: 'minmax(0, 1.4fr)' },
        ],
      }));
    }
  }
}
