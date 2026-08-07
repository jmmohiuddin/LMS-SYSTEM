/**
 * PWA entry point.
 *
 * Configuration comes from URL search params so the app works without a
 * backend auth service (which ships in Phase 1). In production the JWT
 * replaces the ?tid=&uid=&key= params.
 *
 *   ?tid=<tenant-uuid>   tenant ID
 *   ?uid=<user-uuid>     teacher user ID
 *   ?sid=<section-uuid>  section ID
 *   ?date=YYYY-MM-DD     attendance date (default: today)
 *   ?key=<api-key>       service API key
 */
import { openDb, IndexedDbOutboxStore } from '../../../packages/offline/src/store.ts';
import { SyncEngine } from '../../../packages/offline/src/sync-engine.ts';
import { AttendanceView } from './attendance-view.ts';
import { FetchTransport } from './transport.ts';
import type { Student } from '../../../packages/ui-core/src/attendance-grid.ts';

const params   = new URLSearchParams(location.search);
const tenantId = params.get('tid')  ?? '';
const userId   = params.get('uid')  ?? deviceId('u');
const sectionId = params.get('sid') ?? 'demo-section';
const takenOn  = params.get('date') ?? todayIso();
const apiKey   = params.get('key')  ?? '';
const apiBase  = location.origin;

// 60 placeholder students rendered immediately so the screen is usable on
// first load. The real roster will come from GET /api/v1/academics/sections
// once the academics service ships.
const students: Student[] = Array.from({ length: 60 }, (_, i) => ({
  studentId: `demo-${i + 1}`,
  rollNo:    i + 1,
  nameBn:    `শিক্ষার্থী ${i + 1}`,
  nameEn:    `Student ${i + 1}`,
}));

async function main() {
  const idb       = await openDb(indexedDB);
  const store     = new IndexedDbOutboxStore(idb);
  const transport = new FetchTransport({ apiBase, tenantId, userId, role: 'teacher', apiKey });
  const engine    = new SyncEngine({
    deviceId: deviceId('d'),
    tenantId: tenantId || 'demo',
    actorId:  userId,
    store,
    transport,
  });

  // If the service worker sent an outbox-flush message, honour it.
  navigator.serviceWorker?.addEventListener('message', (e) => {
    if ((e.data as { type?: string })?.type === 'outbox-flush') void engine.flush();
  });

  const root = document.getElementById('root')!;
  new AttendanceView({
    root,
    doc:       document,
    students,
    section:   { id: sectionId, labelBn: '৯-ক', academicYearId: 'yr-2026' },
    takenOn,
    subjectBn: 'পদার্থবিজ্ঞান',
    outbox:    engine,
    newId:     () => crypto.randomUUID(),
  });
}

function deviceId(key: string): string {
  const k = `shikhon_${key}`;
  const existing = localStorage.getItem(k);
  if (existing) return existing;
  const id = crypto.randomUUID();
  localStorage.setItem(k, id);
  return id;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

main().catch((err) => {
  console.error('[app] startup failed:', err);
  const root = document.getElementById('root');
  if (root) {
    root.textContent = 'অ্যাপ চালু করা যায়নি। পেজ রিলোড করুন।';
  }
});
