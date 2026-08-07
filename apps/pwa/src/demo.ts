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

      case '/api/v1/rms/routine': {
        if (url.searchParams.get('scope') === 'week') {
          const weekStart = url.searchParams.get('weekStart') ?? todayIso();
          return ok({ scope: 'week', weekStart, days: weekDays(weekStart) });
        }
        const date = url.searchParams.get('date') ?? todayIso();
        return ok({ scope: 'day', date, slots: daySlots(date) });
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
