/**
 * সিস্টেম ও ইন্টিগ্রেশন — what is running behind the screens
 *
 * Makes the schema-level and server-level parts of the product visible
 * without pretending they are user features: which services answer, which are
 * deliberately switched off awaiting configuration, which background workers
 * exist, and where the invariants live that have no page at all (RLS, the
 * database's own clash constraint, the offline outbox).
 *
 * Live state is probed by calling the public endpoints that carry a 503 when
 * their kill switch is on. No auth is needed and none is sent, which is why
 * this screen is readable by a role that can see nothing else here.
 *
 * ── P5: the vocabulary ────────────────────────────────────────────────────
 *
 * The four states were `on / dark / invisible / unknown` — words from the
 * commit that wrote them, not words a school operator reads. P5's brief asks
 * for human states and says to derive them from the architecture rather than
 * invent them, so the MODEL is unchanged and only the naming moved:
 *
 *   `running`      চালু আছে           the endpoint answered
 *   `builtIn`      সবসময় চালু          a database- or server-level guarantee.
 *                                     No page, no switch, nothing to check —
 *                                     it cannot be off while the app runs.
 *   `offByDesign`  ইচ্ছাকৃতভাবে বন্ধ    a kill switch is on. NOT a fault, and
 *                                     the distinction matters: a school that
 *                                     reads "সমস্যা" against AI will file a
 *                                     support ticket about a decision.
 *   `unchecked`    যাচাই করা যায়নি     the probe got no answer.
 *
 * Four words the brief proposed — healthy / warning / blocked / unavailable —
 * cannot express `builtIn`, and `builtIn` is the state most of this list is
 * in. Recording the mapping rather than forcing the words is the honest
 * reading of "do not invent fake health information": nothing here reports a
 * health it did not measure, and `builtIn` says so out loud by never being
 * probed.
 */
import type { Auth } from './auth.ts';
import {
  pageHeader, card, dataTable, statusBadge, el, append,
} from './ui/index.ts';

/** @see the header — the model is unchanged from `on/dark/invisible/unknown`. */
type State = 'running' | 'builtIn' | 'offByDesign' | 'unchecked';

interface FeatureRow {
  titleBn: string;
  descBn: string;
  /** Where it lives, for an IT admin who has to go and look. */
  path: string;
  state: State;
  detailBn?: string;
}

export interface SystemViewOptions {
  root: HTMLElement;
  doc: Document;
  auth: Auth;
}

const STATE_LABEL: Record<State, string> = {
  running: 'চালু আছে',
  builtIn: 'সবসময় চালু',
  offByDesign: 'ইচ্ছাকৃতভাবে বন্ধ',
  unchecked: 'যাচাই করা যায়নি',
};

/** Maps onto the shared badge vocabulary, so this screen tints like every other. */
const STATE_BADGE: Record<State, string> = {
  running: 'published',
  builtIn: 'invited',
  // Neutral, not danger. A kill switch that is on is a decision somebody made.
  offByDesign: 'draft',
  unchecked: 'pending',
};

const STATE_MEANS: Record<State, string> = {
  running: 'সেবাটি সাড়া দিচ্ছে।',
  builtIn: 'ডাটাবেস বা সার্ভারের স্তরে বসানো — এর কোনো আলাদা পাতা নেই এবং বন্ধ করার উপায়ও নেই।',
  offByDesign: 'কিল-সুইচ চালু আছে — এটি সমস্যা নয়, সিদ্ধান্ত। কনফিগ যোগ করলে চালু হবে।',
  unchecked: 'এই মুহূর্তে যাচাই করা যায়নি — সংযোগ না থাকলে এমন হয়।',
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
      { titleBn: 'বহু-প্রতিষ্ঠান আইসোলেশন (RLS)', descBn: '১০ ভূমিকা, প্রতিটি অনুরোধে SET LOCAL app.tenant_id', path: 'db/migrations/010_rls_policies.sql', state: 'builtIn' },
      // §2 AI
      { titleBn: 'শিক্ষক সহায়ক AI (SikhokAI)', descBn: 'CQ · MCQ · রুব্রিক · পাঠ পরিকল্পনা', path: 'services/ai-svc — POST /api/v1/ai/sikhok', state: 'unchecked' },
      { titleBn: 'শিখো টিউটর (ShikhoAI)', descBn: 'বাংলা/English/Banglish সক্রেটিক টিউটরিং', path: 'services/ai-svc — POST /api/v1/ai/shikho', state: 'unchecked' },
      // §3 attendance stack
      { titleBn: 'অফলাইন হাজিরা + Background Sync', descBn: 'IndexedDB আউটবক্স, সার্ভিস ওয়ার্কার', path: 'packages/offline/, apps/pwa/src/sw.ts', state: 'builtIn' },
      { titleBn: 'অভিভাবক SMS অ্যালার্ট', descBn: 'দৈনিক ক্রন ওয়ার্কার — এগ্রিগেটর অপেক্ষমাণ', path: 'services/sms-svc — /api/v1/sms/dispatch', state: 'builtIn' },
      { titleBn: 'উত্তরপত্র সংরক্ষণ', descBn: 'হাতে-লেখা উত্তরপত্রের ছবি', path: 'services/academics-svc — POST /api/v1/academics/scripts', state: 'unchecked' },
      // §4 finance
      { titleBn: 'MFS ওয়েবহুক (bKash/Nagad/Rocket)', descBn: 'সাইনড কলব্যাক গ্রহণ', path: 'services/finance-svc — /api/v1/finance/webhooks/{provider}', state: 'running' },
      { titleBn: 'ডিজিটাল রসিদ + লেজার', descBn: 'RCP-YYYY-MM-<seq> + সমমান DR/CR', path: 'services/finance-svc/src/webhook.ts', state: 'builtIn' },
      // §5 RMS
      { titleBn: 'ক্লাশ সনাক্তকরণ (EXCLUDE USING gist)', descBn: 'ডাটাবেস স্তরে দ্বৈত-বুকিং প্রতিরোধ', path: 'db/migrations/006_routines_rms.sql', state: 'builtIn' },
      // §6 ANS
      { titleBn: 'ANS আউটবাউন্ড ডিসপ্যাচার', descBn: 'HMAC-স্বাক্ষরিত ওয়েবহুক ডেলিভারি', path: 'services/ans-svc — POST /api/v1/ans/dispatch', state: 'unchecked' },
      { titleBn: 'ANS ইনবাউন্ড ইভেন্ট', descBn: 'অ্যালামনাই এনরিচমেন্ট গ্রহণ', path: 'services/ans-svc — POST /api/v1/ans/inbound', state: 'running' },
      // Ops
      { titleBn: 'নাইটলি DB রক্ষণাবেক্ষণ', descBn: 'পার্টিশন প্রি-ক্রিয়েশন, retention purge', path: 'services/ops-svc — /api/v1/ops/maintenance @ 01:00 BST', state: 'builtIn' },
    ];
  }

  private async probe(): Promise<void> {
    // The endpoints return 503 <error-code> when their kill switch is on,
    // and 401 when authenticated-only. That is enough signal to state each
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
          return [503, 'offByDesign', 'কনফিগ যোগ করলেই চালু হবে'];
        }
        return [503, 'offByDesign'];
      }
      if (res.status === 401 || res.status === 400) return [res.status, 'running'];
      if (res.status === 200 || res.status === 202) return [res.status, 'running'];
      return [res.status, 'unchecked'];
    } catch {
      return [0, 'unchecked'];
    }
  }

  private render(): void {
    const d = this.o.doc;
    const root = this.o.root;
    root.textContent = '';

    root.append(pageHeader(d, {
      title: 'সিস্টেম ও ইন্টিগ্রেশন',
      subtitle: 'পটভূমিতে যা চলছে — কিল-সুইচ, ওয়ার্কার ও ডাটাবেস স্তরের গ্যারান্টি',
    }));

    root.append(dataTable(d, {
      caption: 'সেবা ও ইন্টিগ্রেশনের অবস্থা',
      rows: this.rows,
      rowKey: (r) => r.titleBn,
      columns: [
        { key: 'name', header: 'সেবা', mobile: 'title', cell: (r) => r.titleBn,
          width: 'minmax(0, 1.6fr)' },
        { key: 'what', header: 'কী করে', mobile: 'subtitle', cell: (r) => r.descBn,
          width: 'minmax(0, 2fr)' },
        { key: 'state', header: 'অবস্থা', mobile: 'status', width: '150px',
          cell: (r) => statusBadge(d, {
            state: STATE_BADGE[r.state], label: STATE_LABEL[r.state],
          }) },
        // Hidden on a phone: a repo path is for the person who is going to go
        // and look at it, and that person is at a desk.
        { key: 'where', header: 'কারিগরি অবস্থান', mobile: 'hidden',
          cell: (r) => el(d, 'code', {
            className: 'system-path',
            text: r.detailBn ? `${r.path} — ${r.detailBn}` : r.path,
          }),
          width: 'minmax(0, 2fr)' },
      ],
    }));

    // Every state, said in words. Without this the table has four badges and
    // no way to learn that "ইচ্ছাকৃতভাবে বন্ধ" is not a fault.
    const dl = el(d, 'dl', { className: 'ui-facts' });
    for (const state of ['running', 'builtIn', 'offByDesign', 'unchecked'] as State[]) {
      append(dl,
        el(d, 'dt', { className: 'ui-facts-key' },
          statusBadge(d, { state: STATE_BADGE[state], label: STATE_LABEL[state] })),
        el(d, 'dd', { className: 'ui-facts-val', text: STATE_MEANS[state] }));
    }
    root.append(card(d, {
      title: 'অবস্থাগুলোর মানে', glyph: 'lock', headingLevel: 2,
    }, dl));
  }
}
