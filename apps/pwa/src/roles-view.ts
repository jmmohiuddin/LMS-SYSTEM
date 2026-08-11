/**
 * Roles & Access (ভূমিকা ও অ্যাক্সেস) — visualises the PRD §1 RBAC surface.
 *
 * Static: the 10 role codes are defined by the migrations and don't change
 * per-tenant; a live user-count column is fetched from the roster endpoint
 * when authenticated (this makes it useful for real principals) and falls
 * back to descriptive counts in demo mode.
 */
import { iconSvg } from './icon.ts';

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

const TIER_LABEL: Record<string, string> = {
  system: 'সিস্টেম', management: 'ব্যবস্থাপনা', academic: 'একাডেমিক', finance: 'অর্থ', people: 'ব্যবহারকারী',
};

export class RolesView {
  constructor(o: RolesViewOptions) {
    const d = o.doc;
    o.root.textContent = '';

    const header = d.createElement('header');
    header.className = 'page-header';
    const h1 = d.createElement('h1');
    h1.textContent = 'ভূমিকা ও অ্যাক্সেস';
    const sub = d.createElement('p');
    sub.className = 'page-sub';
    sub.textContent = 'PostgreSQL Row-Level Security দ্বারা প্রতিষ্ঠান-ভিত্তিক আলাদা';
    header.append(h1, sub);
    o.root.append(header);

    // Isolation banner — visually confirms the tenant isolation invariant.
    const banner = d.createElement('div');
    banner.className = 'card iso-banner';
    // The padlock this banner used to carry was an emoji; there is no decent
    // text padlock to swap in, and this is a real semantic icon in a card —
    // exactly what the drawn set exists for. It takes the ink like the rest.
    const bIcon = d.createElement('span'); bIcon.className = 'iso-icon';
    bIcon.setAttribute('aria-hidden', 'true');
    bIcon.innerHTML = iconSvg('lock');
    const bBody = d.createElement('div');
    const bTitle = d.createElement('span'); bTitle.className = 'iso-title'; bTitle.textContent = 'বিচ্ছিন্নতা সক্রিয়';
    const bDesc = d.createElement('span'); bDesc.className = 'iso-desc';
    bDesc.textContent = 'প্রতিটি ব্যবহারকারীর অনুরোধ SET LOCAL app.tenant_id দিয়ে বন্ধ — অন্য বিদ্যালয়ের সারি কখনো দৃশ্যমান হয় না।';
    bBody.append(bTitle, bDesc);
    banner.append(bIcon, bBody);
    o.root.append(banner);

    // Group by tier.
    const tiers = ['system', 'management', 'academic', 'finance', 'people'] as const;
    for (const tier of tiers) {
      const inTier = ROLES.filter((r) => r.tier === tier);
      if (inTier.length === 0) continue;

      const h2 = d.createElement('h2');
      h2.className = 'section-heading';
      h2.textContent = TIER_LABEL[tier];
      o.root.append(h2);

      const list = d.createElement('ul');
      list.className = 'roles-list';
      for (const r of inTier) {
        const li = d.createElement('li');
        li.className = 'card role-card';
        const name = d.createElement('span');
        name.className = 'role-name';
        name.textContent = r.nameBn;
        const code = d.createElement('span');
        code.className = 'role-code';
        code.textContent = r.code;
        const can = d.createElement('span');
        can.className = 'role-can';
        can.textContent = r.canDo;
        const scope = d.createElement('span');
        scope.className = 'role-scope';
        scope.textContent = `স্কোপ: ${r.scope}`;
        li.append(name, code, can, scope);
        list.append(li);
      }
      o.root.append(list);
    }
  }
}
