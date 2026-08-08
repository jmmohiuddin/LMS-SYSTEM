/**
 * Demo mode — activated with ?demo=1 (see app.ts).
 *
 * Real login is currently disabled (LOGIN_DISABLED in login-view.ts, plus
 * the backend switch in services/identity-svc/api/otp-request.ts). This
 * exists so the app's screens can still be previewed: DemoAuth substitutes
 * for Auth everywhere, and its authedFetch() answers the read endpoints and
 * sync/push locally with the sample data below — no request ever leaves the
 * device, and nothing here can touch real tenant data.
 */
import { Auth } from './auth.ts';
import type { PushRequest, PushResponse } from '../../../packages/offline/src/types.ts';
import type { SectionSummary, RosterStudent } from './roster-view.ts';
import type { RoutineSlot } from './routine-view.ts';

const SECTIONS: SectionSummary[] = [
  { id: 'demo-9a', name: 'ক', shift: 'morning', studentCount: 12, className: { bn: 'নবম শ্রেণি', en: 'Class 9' }, levelNo: 9 },
  { id: 'demo-9b', name: 'খ', shift: 'morning', studentCount: 12, className: { bn: 'নবম শ্রেণি', en: 'Class 9' }, levelNo: 9 },
  { id: 'demo-10a', name: 'ক', shift: 'day', studentCount: 12, className: { bn: 'দশম শ্রেণি', en: 'Class 10' }, levelNo: 10 },
];

const NAMES: [string, string][] = [
  ['আরিফুল ইসলাম', 'Ariful Islam'],
  ['সুমাইয়া আক্তার', 'Sumaiya Akter'],
  ['মেহেদী হাসান', 'Mehedi Hasan'],
  ['নুসরাত জাহান', 'Nusrat Jahan'],
  ['তানভীর আহমেদ', 'Tanvir Ahmed'],
  ['ফারিয়া রহমান', 'Faria Rahman'],
  ['রাকিবুল হাসান', 'Rakibul Hasan'],
  ['সাদিয়া ইসলাম', 'Sadia Islam'],
  ['ইমরান হোসেন', 'Imran Hossain'],
  ['মিম আক্তার', 'Mim Akter'],
  ['জুবায়ের হোসেন', 'Jubayer Hossain'],
  ['তাসনিম ফেরদৌস', 'Tasnim Ferdous'],
];

function rosterFor(sectionId: string): RosterStudent[] {
  return NAMES.map(([bn, en], i) => ({
    rollNo: i + 1,
    studentId: `${sectionId}-s${i + 1}`,
    fullName: { bn, en },
    phone: null,
  }));
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

const DEMO_EXAMS = [
  {
    id: 'demo-exam-half',
    nameBn: 'অর্ধ-বার্ষিক পরীক্ষা ২০২৬',
    nameEn: 'Half-Yearly Exam 2026',
    examType: 'half_yearly',
    status: 'marking',
    academicYearId: 'demo-year',
    subjects: [
      {
        examSubjectId: 'demo-es-phy',
        subjectId: 'demo-sub-phy',
        subject: { bn: 'পদার্থবিজ্ঞান', en: 'Physics' },
        cqMax: 70, mcqMax: 30, practicalMax: 0, caMax: 0,
        cqPass: 23, mcqPass: 10,
        markingLocked: false,
      },
      {
        examSubjectId: 'demo-es-math',
        subjectId: 'demo-sub-math',
        subject: { bn: 'গণিত', en: 'Mathematics' },
        cqMax: 70, mcqMax: 30, practicalMax: 0, caMax: 0,
        cqPass: 23, mcqPass: 10,
        markingLocked: false,
      },
    ],
  },
];

function demoMarks() {
  return {
    academicYearId: 'demo-year',
    examStatus: 'marking',
    markingLocked: false,
    maxima: { cq: 70, mcq: 30, practical: 0, ca: 0 },
    marks: NAMES.map(([bn, en], i) => ({
      rollNo: i + 1,
      studentId: `demo-s${i + 1}`,
      fullName: { bn, en },
      cqMarks: i < 6 ? 40 + i * 4 : null,
      mcqMarks: i < 6 ? 18 + i : null,
      practicalMarks: null,
      caMarks: null,
      totalMarks: i < 6 ? 58 + i * 5 : null,
      isAbsent: i === 11,
      gradeLetter: null,
      rowVersion: i < 6 ? 1 : null,
    })),
  };
}

function daySlots(date: string): RoutineSlot[] {
  // Friday/Saturday are the school weekend in Bangladesh.
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  if (weekday === 5 || weekday === 6) return [];

  const slot = (
    periodNo: number, startsAt: string, endsAt: string,
    extra: Partial<RoutineSlot> & { subjectBn: string },
  ): RoutineSlot => ({
    slotId: `${date}-p${periodNo}`,
    periodNo,
    startsAt,
    endsAt,
    slotKind: 'teaching',
    sectionLabel: null,
    roomCode: null,
    isSubstitution: false,
    coveringForBn: null,
    studentCount: 12,
    attendanceTaken: false,
    deliveryLogged: false,
    ...extra,
  });

  return [
    slot(1, '10:00:00', '10:45:00', { subjectBn: 'বাংলা', sectionLabel: '৯-ক', roomCode: '১০১' }),
    slot(2, '10:50:00', '11:35:00', { subjectBn: 'ইংরেজি', sectionLabel: '৯-খ', roomCode: '১০২' }),
    slot(3, '11:40:00', '12:25:00', { subjectBn: 'গণিত', sectionLabel: '১০-ক', roomCode: '২০৪' }),
    slot(4, '12:25:00', '13:00:00', { subjectBn: 'টিফিন বিরতি', slotKind: 'break', studentCount: null }),
    slot(5, '13:00:00', '13:45:00', {
      subjectBn: 'পদার্থবিজ্ঞান', sectionLabel: '৯-ক', roomCode: '১০১',
      isSubstitution: true, coveringForBn: 'রহিম উদ্দিন',
    }),
    slot(6, '13:50:00', '14:35:00', { subjectBn: 'রসায়ন', sectionLabel: '১০-ক', roomCode: '২০৪', attendanceTaken: true }),
  ];
}

function weekDays(weekStart: string): { date: string; slots: RoutineSlot[] }[] {
  const start = new Date(`${weekStart}T00:00:00Z`);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    const date = d.toISOString().slice(0, 10);
    return { date, slots: daySlots(date) };
  });
}

const DEMO_CHAPTERS = [
  {
    id: 'demo-ch-1', chapterNo: 5,
    name: { bn: 'অধ্যায় ৫: গতি', en: 'Chapter 5: Motion' },
    summaryBn: 'সরণ, দ্রুতি, বেগ ও ত্বরণের ধারণা এবং নিউটনের সূত্র।',
    estMinutes: 90, isPublished: true,
    subject: { id: 'demo-sub-phy', bn: 'পদার্থবিজ্ঞান', en: 'Physics' },
    prerequisite: null, lessonCount: 4, completedCount: 2,
  },
  {
    id: 'demo-ch-2', chapterNo: 6,
    name: { bn: 'অধ্যায় ৬: বল ও নিউটনের সূত্র', en: 'Chapter 6: Force' },
    summaryBn: 'বলের প্রকারভেদ, নিউটনের তিনটি সূত্র ও তাদের প্রয়োগ।',
    estMinutes: 120, isPublished: true,
    subject: { id: 'demo-sub-phy', bn: 'পদার্থবিজ্ঞান', en: 'Physics' },
    prerequisite: { id: 'demo-ch-1', nameBn: 'অধ্যায় ৫: গতি' },
    lessonCount: 5, completedCount: 0,
  },
  {
    id: 'demo-ch-3', chapterNo: 3,
    name: { bn: 'অধ্যায় ৩: বীজগণিতিক রাশি', en: 'Chapter 3: Algebraic Expressions' },
    summaryBn: 'উৎপাদক বিশ্লেষণ ও দ্বিঘাত সমীকরণের সমাধান।',
    estMinutes: 100, isPublished: true,
    subject: { id: 'demo-sub-math', bn: 'গণিত', en: 'Mathematics' },
    prerequisite: null, lessonCount: 4, completedCount: 4,
  },
];

const DEMO_LESSONS = [
  { id: 'demo-l-1', lessonNo: 1, title: { bn: 'সরণ ও দূরত্ব', en: null }, estMinutes: 20, isPublished: true, progress: { state: 'completed', secondsSpent: 1180 } },
  { id: 'demo-l-2', lessonNo: 2, title: { bn: 'দ্রুতি ও বেগ', en: null }, estMinutes: 25, isPublished: true, progress: { state: 'completed', secondsSpent: 1420 } },
  { id: 'demo-l-3', lessonNo: 3, title: { bn: 'ত্বরণ', en: null }, estMinutes: 20, isPublished: true, progress: { state: 'started', secondsSpent: 310 } },
  { id: 'demo-l-4', lessonNo: 4, title: { bn: 'গতির সমীকরণ', en: null }, estMinutes: 25, isPublished: true, progress: null },
];

function demoLesson(lessonId: string) {
  return {
    lesson: {
      id: lessonId, lessonNo: 3,
      title: { bn: 'ত্বরণ', en: 'Acceleration' },
      estMinutes: 20,
      chapter: { id: 'demo-ch-1', nameBn: 'অধ্যায় ৫: গতি' },
      progress: { state: 'started', secondsSpent: 310, lastBlockNo: 2 },
    },
    blocks: [
      { id: 'b1', blockNo: 1, kind: 'text', bodyBn: 'কোনো বস্তুর বেগ যদি সময়ের সাথে পরিবর্তিত হয়, তবে সেই পরিবর্তনের হারকে ত্বরণ বলে। ত্বরণ একটি ভেক্টর রাশি — এর মান ও দিক উভয়ই আছে।', mediaKey: null, altTextBn: null, captionBn: null },
      { id: 'b2', blockNo: 2, kind: 'formula', bodyBn: 'a = (v − u) / t', mediaKey: null, altTextBn: null, captionBn: null },
      { id: 'b3', blockNo: 3, kind: 'key_point', bodyBn: 'ত্বরণের একক m/s² — বেগের একক (m/s) কে সময় (s) দিয়ে ভাগ করলে এটি পাওয়া যায়।', mediaKey: null, altTextBn: null, captionBn: null },
      { id: 'b4', blockNo: 4, kind: 'example', bodyBn: 'একটি গাড়ি ৫ সেকেন্ডে ১০ m/s থেকে ৩০ m/s বেগ অর্জন করলে, a = (৩০ − ১০) / ৫ = ৪ m/s²।', mediaKey: null, altTextBn: null, captionBn: null },
      { id: 'b5', blockNo: 5, kind: 'text', bodyBn: 'যদি বেগ কমতে থাকে, ত্বরণ ঋণাত্মক হয় — একে মন্দন (deceleration) বলা হয়।', mediaKey: null, altTextBn: null, captionBn: null },
      { id: 'b6', blockNo: 6, kind: 'practice_prompt', bodyBn: 'একটি বাস ৮ সেকেন্ডে ২৪ m/s থেকে থেমে গেলে তার মন্দন কত? (উত্তর নিজে বের করার চেষ্টা করো)', mediaKey: null, altTextBn: null, captionBn: null },
    ],
  };
}

const DEMO_INVOICES = [
  {
    id: 'demo-inv-1',
    invoiceNo: 'INV-2026-08-00001',
    billingPeriod: '2026-08',
    issuedOn: '2026-08-01',
    dueOn: '2026-08-10',
    totalAmount: '1250.00',
    paidAmount: '0.00',
    balanceAmount: '1250.00',
    status: 'issued',
    lines: [
      { descriptionBn: 'মাসিক বেতন', amount: '1000.00', waiverAmount: '0.00', netAmount: '1000.00' },
      { descriptionBn: 'পরিবহন ফি', amount: '250.00', waiverAmount: '0.00', netAmount: '250.00' },
    ],
  },
  {
    id: 'demo-inv-2',
    invoiceNo: 'INV-2026-07-00001',
    billingPeriod: '2026-07',
    issuedOn: '2026-07-01',
    dueOn: '2026-07-10',
    totalAmount: '1250.00',
    paidAmount: '1250.00',
    balanceAmount: '0.00',
    status: 'paid',
    lines: [
      { descriptionBn: 'মাসিক বেতন', amount: '1000.00', waiverAmount: '0.00', netAmount: '1000.00' },
      { descriptionBn: 'পরিবহন ফি', amount: '250.00', waiverAmount: '0.00', netAmount: '250.00' },
    ],
  },
  {
    id: 'demo-inv-3',
    invoiceNo: 'INV-2026-06-00001',
    billingPeriod: '2026-06',
    issuedOn: '2026-06-01',
    dueOn: '2026-06-10',
    totalAmount: '750.00',
    paidAmount: '750.00',
    balanceAmount: '0.00',
    status: 'paid',
    lines: [
      { descriptionBn: 'মাসিক বেতন', amount: '1000.00', waiverAmount: '250.00', netAmount: '750.00' },
    ],
  },
];

const DEMO_CQ = `উদ্দীপক: রফিক একটি ৫ কেজি ভরের বস্তুকে ১০ নিউটন বল প্রয়োগ করে মেঝেতে ঠেলছে।

ক) বল কাকে বলে? (জ্ঞান — ১ নম্বর)
খ) নিউটনের দ্বিতীয় সূত্রটি ব্যাখ্যা করো। (অনুধাবন — ২ নম্বর)
গ) উদ্দীপকের বস্তুটির ত্বরণ নির্ণয় করো। (প্রয়োগ — ৩ নম্বর)
ঘ) বল দ্বিগুণ ও ভর অর্ধেক করা হলে ত্বরণের কী পরিবর্তন হবে — গাণিতিকভাবে বিশ্লেষণ করো। (উচ্চতর দক্ষতা — ৪ নম্বর)

(ডেমো মোড — আসল SikhokAI চালু হলে NCTB পাঠ্যবই থেকে অধ্যায়-নির্দিষ্ট প্রশ্ন তৈরি হবে।)`;

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

export class DemoAuth extends Auth {
  constructor() {
    super({ apiBase: '', deviceId: 'demo-device' });
  }

  override isLoggedIn(): boolean { return true; }
  override get tenantId(): string { return 'demo-tenant'; }
  override get userId(): string { return 'demo-teacher'; }
  override get role(): string { return 'teacher'; }
  override get roles(): string[] { return ['teacher']; }
  override get displayName(): string { return 'ডেমো (নমুনা তথ্য)'; }

  override async logout(): Promise<void> {
    // No session to revoke — app.ts falls back to the login view, which
    // shows the login-disabled notice.
  }

  override async authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const url = new URL(path, 'http://demo.internal');

    switch (url.pathname) {
      case '/api/v1/academics/sections':
        return ok({ sections: SECTIONS });

      case '/api/v1/academics/roster':
        return ok({ roster: rosterFor(url.searchParams.get('sectionId') ?? 'demo') });

      case '/api/v1/academics/exams':
        return ok({ exams: DEMO_EXAMS });

      case '/api/v1/academics/marks':
        return ok(demoMarks());

      case '/api/v1/academics/chapters':
        return ok({ chapters: DEMO_CHAPTERS });

      case '/api/v1/academics/lessons': {
        const lessonId = url.searchParams.get('lessonId');
        if (lessonId) return ok(demoLesson(lessonId));
        return ok({
          chapterId: url.searchParams.get('chapterId') ?? 'demo-ch-1',
          lessons: DEMO_LESSONS,
        });
      }

      case '/api/v1/finance/invoices':
        return ok({ invoices: DEMO_INVOICES });

      case '/api/v1/finance/receipts':
        return ok({
          receipts: url.searchParams.get('invoiceId') === 'demo-inv-2'
            ? [{ receiptNo: 'RCP-2026-07-00012', amount: '1250.00', method: 'bkash', issuedAt: '2026-07-08T10:12:00Z' }]
            : [],
        });

      case '/api/v1/rms/routine': {
        if (url.searchParams.get('scope') === 'week') {
          const weekStart = url.searchParams.get('weekStart') ?? todayIso();
          return ok({ scope: 'week', weekStart, days: weekDays(weekStart) });
        }
        const date = url.searchParams.get('date') ?? todayIso();
        return ok({ scope: 'day', date, slots: daySlots(date) });
      }

      case '/api/v1/rms/substitute': {
        const req = JSON.parse(String(init.body ?? '{}')) as { assign?: boolean };
        if (req.assign) return ok({ ok: true, substitutionId: 'demo-substitution-1' });
        return ok({
          ok: true,
          candidates: [
            { teacherId: 'demo-t1', fullName: { bn: 'রহিম উদ্দিন', en: 'Rahim Uddin' }, rank: 1, matchScore: 92, matchReasons: ['subject_expertise', 'load_today:2', 'subs_last_30d:0'] },
            { teacherId: 'demo-t2', fullName: { bn: 'সালমা খাতুন', en: 'Salma Khatun' }, rank: 2, matchScore: 71, matchReasons: ['no_subject_match', 'load_today:1', 'subs_last_30d:1'] },
            { teacherId: 'demo-t3', fullName: { bn: 'কামাল হোসেন', en: 'Kamal Hossain' }, rank: 3, matchScore: 55, matchReasons: ['no_subject_match', 'load_today:3', 'subs_last_30d:2'] },
          ],
        });
      }

      case '/api/v1/ai/sikhok':
        return ok({
          ok: true,
          taskType: 'generate_cq',
          grounded: false,
          content: DEMO_CQ,
          model: 'demo',
          usage: { inputTokens: 0, outputTokens: 0 },
        });

      case '/api/v1/ai/shikho': {
        const req = JSON.parse(String(init.body ?? '{}')) as { message?: string };
        return ok({
          ok: true,
          grounded: false,
          reply:
            `ভালো প্রশ্ন! "${(req.message ?? '').slice(0, 40)}" নিয়ে ভাবা যাক। ` +
            'সরাসরি উত্তর না বলে একটা প্রশ্ন করি: এই সমস্যায় প্রথম ধাপে কোন সূত্রটা কাজে লাগতে পারে বলে মনে হয়? ' +
            '(ডেমো মোড — আসল টিউটর চালু হলে ধাপে ধাপে শেখাবে।)',
          model: 'demo',
          usage: { inputTokens: 0, outputTokens: 0 },
        });
      }

      case '/api/v1/sync/push': {
        const req = JSON.parse(String(init.body ?? '{}')) as PushRequest;
        const res: PushResponse = {
          serverTime: new Date().toISOString(),
          results: (req.ops ?? []).map((op) => ({ opId: op.opId, status: 'applied', rowVersion: 1 })),
        };
        return ok(res);
      }

      default:
        return new Response(JSON.stringify({ error: 'not_found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
    }
  }
}
