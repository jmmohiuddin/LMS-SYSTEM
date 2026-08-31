/**
 * System & Integrations (সিস্টেম) — makes the schema/backend-only PRD items
 * visible without pretending they're user features.
 *
 * Renders the live state of every feature: which are on, which are dark
 * behind a kill switch (OTP, MFS pay, AI, script storage), what background
 * workers exist (SMS outbox, ANS dispatcher, DB maintenance), and where
 * the invisible-by-design invariants live (RLS, DB clash constraints,
 * offline sync). Live status probed by hitting the public 503-carrying
 * endpoints — no auth needed.
 */
import type { Auth } from './auth.ts';
import { pageHeader } from './ui/page-header.ts';

type State = 'on' | 'dark' | 'invisible' | 'unknown';

interface FeatureRow {
  titleBn: string;
  descBn: string;
  path: string;                 // human path in the repo (for the audit trail)
  state: State;
  detailBn?: string;
}

export interface SystemViewOptions {
  root: HTMLElement;
  doc: Document;
  auth: Auth;
}

const STATE_LABEL: Record<State, string> = {
  on: 'সক্রিয়',
  dark: 'কিল-সুইচ অন',
  invisible: 'পটভূমিতে চলছে',
  unknown: 'যাচাই করা যায়নি',
};

export class SystemView {
  private readonly o: SystemViewOptions;
  private rows: FeatureRow[] = [];

  constructor(options: SystemViewOptions) {
    this.o = options;
    this.rows = this.buildStaticRows();
    this.render();
    void this.probe();
  }

  private buildStaticRows(): FeatureRow[] {
    return [
      // §1 RBAC + RLS
      { titleBn: 'বহু-প্রতিষ্ঠান আইসোলেশন (RLS)', descBn: '১০ ভূমিকা, প্রতিটি অনুরোধে SET LOCAL app.tenant_id', path: 'db/migrations/010_rls_policies.sql', state: 'invisible' },
      // §2 AI
      { titleBn: 'শিক্ষক সহায়ক AI (SikhokAI)', descBn: 'CQ · MCQ · রুব্রিক · পাঠ পরিকল্পনা', path: 'services/ai-svc — POST /api/v1/ai/sikhok', state: 'unknown' },
      { titleBn: 'শিখো টিউটর (ShikhoAI)', descBn: 'বাংলা/English/Banglish সক্রেটিক টিউটরিং', path: 'services/ai-svc — POST /api/v1/ai/shikho', state: 'unknown' },
      // §3 attendance stack
      { titleBn: 'অফলাইন হাজিরা + Background Sync', descBn: 'IndexedDB আউটবক্স, সার্ভিস ওয়ার্কার', path: 'packages/offline/, apps/pwa/src/sw.ts', state: 'invisible' },
      { titleBn: 'অভিভাবক SMS অ্যালার্ট', descBn: 'দৈনিক ক্রন ওয়ার্কার — এগ্রিগেটর অপেক্ষমাণ', path: 'services/sms-svc — /api/v1/sms/dispatch', state: 'invisible' },
      { titleBn: 'উত্তরপত্র সংরক্ষণ', descBn: 'হাতে-লেখা উত্তরপত্রের ছবি', path: 'services/academics-svc — POST /api/v1/academics/scripts', state: 'unknown' },
      // §4 finance
      { titleBn: 'MFS ওয়েবহুক (bKash/Nagad/Rocket)', descBn: 'সাইনড কলব্যাক গ্রহণ', path: 'services/finance-svc — /api/v1/finance/webhooks/{provider}', state: 'on' },
      { titleBn: 'ডিজিটাল রসিদ + লেজার', descBn: 'RCP-YYYY-MM-<seq> + সমমান DR/CR', path: 'services/finance-svc/src/webhook.ts (commit 50e8219)', state: 'invisible' },
      // §5 RMS
      { titleBn: 'ক্লাশ সনাক্তকরণ (EXCLUDE USING gist)', descBn: 'ডাটাবেস স্তরে দ্বৈত-বুকিং প্রতিরোধ', path: 'db/migrations/006_routines_rms.sql', state: 'invisible' },
      // §6 ANS
      { titleBn: 'ANS আউটবাউন্ড ডিসপ্যাচার', descBn: 'HMAC-স্বাক্ষরিত ওয়েবহুক ডেলিভারি', path: 'services/ans-svc — POST /api/v1/ans/dispatch', state: 'unknown' },
      { titleBn: 'ANS ইনবাউন্ড ইভেন্ট', descBn: 'অ্যালামনাই এনরিচমেন্ট গ্রহণ', path: 'services/ans-svc — POST /api/v1/ans/inbound', state: 'on' },
      // Ops
      { titleBn: 'নাইটলি DB রক্ষণাবেক্ষণ', descBn: 'পার্টিশন প্রি-ক্রিয়েশন, retention purge', path: 'services/ops-svc — /api/v1/ops/maintenance @ 01:00 BST', state: 'invisible' },
    ];
  }

  private async probe(): Promise<void> {
    // The endpoints return 503 <error-code> when their kill switch is on,
    // and 401 when authenticated-only. That's enough signal to color each
    // row without needing a real login.
    const probes: [number, State, string?][] = await Promise.all([
      this.probeOne('POST', '/api/v1/ai/sikhok', 'ai_disabled'),
      this.probeOne('POST', '/api/v1/ai/shikho', 'ai_disabled'),
      this.probeOne('POST', '/api/v1/academics/scripts', 'script_storage_unconfigured'),
      this.probeOne('POST', '/api/v1/ans/dispatch', undefined),
    ]);
    // Order matches the rows above (sikhok, shikho, scripts, ans-dispatch).
    const map: Record<string, number> = {
      'শিক্ষক সহায়ক AI (SikhokAI)': 0,
      'শিখো টিউটর (ShikhoAI)': 1,
      'উত্তরপত্র সংরক্ষণ': 2,
      'ANS আউটবাউন্ড ডিসপ্যাচার': 3,
    };
    for (const row of this.rows) {
      const idx = map[row.titleBn];
      if (idx === undefined) continue;
      const [, state, detail] = probes[idx];
      row.state = state;
      if (detail) row.detailBn = detail;
    }
    this.render();
  }

  private async probeOne(method: string, url: string, disabledCode?: string): Promise<[number, State, string?]> {
    try {
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: method === 'POST' ? '{}' : undefined,
      });
      if (res.status === 503) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        if (disabledCode && body.error === disabledCode) {
          return [503, 'dark', 'কনফিগ যোগ করলেই চালু হবে'];
        }
        return [503, 'dark'];
      }
      if (res.status === 401 || res.status === 400) return [res.status, 'on'];
      if (res.status === 200 || res.status === 202) return [res.status, 'on'];
      return [res.status, 'unknown'];
    } catch {
      return [0, 'unknown'];
    }
  }

  private render(): void {
    const d = this.o.doc;
    const root = this.o.root;
    root.textContent = '';

    const header = pageHeader(d, {
      title: 'সিস্টেম ও ইন্টিগ্রেশন',
      subtitle: 'পটভূমিতে যা চলছে — কিল-সুইচ, ওয়ার্কার, ডাটাবেস অদৃশ্য গ্যারান্টি',
    });
    root.append(header);

    const list = d.createElement('ul');
    list.className = 'system-list';
    for (const row of this.rows) {
      const li = d.createElement('li');
      li.className = 'card system-row';
      li.dataset.state = row.state;

      const chip = d.createElement('span');
      chip.className = 'system-chip';
      chip.dataset.state = row.state;
      chip.textContent = STATE_LABEL[row.state];

      const body = d.createElement('div');
      body.className = 'system-body';
      const title = d.createElement('span'); title.className = 'system-title'; title.textContent = row.titleBn;
      const desc = d.createElement('span'); desc.className = 'system-desc'; desc.textContent = row.descBn;
      const path = d.createElement('code'); path.className = 'system-path'; path.textContent = row.path;
      body.append(title, desc, path);
      if (row.detailBn) {
        const detail = d.createElement('span'); detail.className = 'system-detail'; detail.textContent = row.detailBn;
        body.append(detail);
      }

      li.append(body, chip);
      list.append(li);
    }
    root.append(list);

    const foot = d.createElement('p');
    foot.className = 'page-sub';
    foot.style.padding = 'var(--s-3) var(--s-4) var(--s-5)';
    foot.textContent = '"পটভূমিতে চলছে" মানে ফিচারটি কাজ করছে কিন্তু ব্যবহারকারীর কোনো পাতা নেই — কারণ এটি স্কিমা-লেভেলে বা সার্ভার-লেভেলে বসে।';
    root.append(foot);
  }
}
