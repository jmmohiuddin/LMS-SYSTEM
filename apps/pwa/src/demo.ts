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
import { parseBranding } from '../../../packages/ui-core/src/branding.ts';
import { brandedDocumentSet, type BrandedSection } from '../../../packages/ui-core/src/branded-doc.ts';
import {
  documentBodyCss, buildFeeReceipt, buildReportCard, buildAdmitCard, buildIdCard,
  buildTransferCertificate, buildAttendanceSheet, ADMIT_INSTRUCTIONS_BN,
  type StudentRef,
} from '../../../packages/ui-core/src/documents.ts';

// `academicYearId` is required and was missing from all three. The rest of
// this file already answers 'demo-year' for it, so the demo was internally
// inconsistent in exactly the way R-7's real bug was: a section carrying no
// year, and attendance taken against it rejected on save. `tsc` had been
// saying so since that fix landed.
const SECTIONS: SectionSummary[] = [
  { id: 'demo-9a', name: 'ক', shift: 'morning', studentCount: 12, academicYearId: 'demo-year', className: { bn: 'নবম শ্রেণি', en: 'Class 9' }, levelNo: 9 },
  { id: 'demo-9b', name: 'খ', shift: 'morning', studentCount: 12, academicYearId: 'demo-year', className: { bn: 'নবম শ্রেণি', en: 'Class 9' }, levelNo: 9 },
  { id: 'demo-10a', name: 'ক', shift: 'day', studentCount: 12, academicYearId: 'demo-year', className: { bn: 'দশম শ্রেণি', en: 'Class 10' }, levelNo: 10 },
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

function inDays(n: number): string {
  return new Date(Date.now() + n * 86400000).toISOString();
}

const DEMO_PERF_CHOICES = [
  { examSubjectId: 'es-1', label: 'নবম-ক · পদার্থবিজ্ঞান · ১ম সাময়িক' },
  { examSubjectId: 'es-2', label: 'নবম-ক · গণিত · ১ম সাময়িক' },
];

const DEMO_ASSIGNMENTS = [
  {
    id: 'demo-a-1', titleBn: 'গতির সমীকরণ — অনুশীলনী ৫.২', dueAt: inDays(2),
    status: 'open', maxMarks: '10.00', subjectBn: 'পদার্থবিজ্ঞান', sectionName: 'ক',
    submissionCount: 24, ungradedCount: 6, mySubmission: null,
  },
  {
    id: 'demo-a-2', titleBn: 'উৎপাদক বিশ্লেষণ — ১০টি সমস্যা', dueAt: inDays(5),
    status: 'open', maxMarks: '20.00', subjectBn: 'গণিত', sectionName: 'ক',
    submissionCount: 11, ungradedCount: 0,
    mySubmission: { submittedAt: inDays(-1), marksAwarded: null, gradedAt: null },
  },
  {
    id: 'demo-a-3', titleBn: 'রচনা: বিজ্ঞান ও প্রযুক্তি', dueAt: inDays(-3),
    status: 'open', maxMarks: '15.00', subjectBn: 'বাংলা', sectionName: 'ক',
    submissionCount: 28, ungradedCount: 0,
    mySubmission: { submittedAt: inDays(-4), marksAwarded: '13.00', gradedAt: inDays(-2) },
  },
];

function demoAssignmentDetail(id: string) {
  const base = DEMO_ASSIGNMENTS.find((a) => a.id === id) ?? DEMO_ASSIGNMENTS[0];
  const graded = id === 'demo-a-3';
  return {
    assignment: {
      id: base.id, titleBn: base.titleBn,
      instructionsBn: 'পাঠ্যবইয়ের অনুশীলনী দেখে প্রতিটি ধাপ দেখিয়ে সমাধান করো। শুধু উত্তর লিখলে পূর্ণ নম্বর পাবে না।',
      maxMarks: base.maxMarks, dueAt: base.dueAt, allowsLate: true,
      status: 'open', subjectBn: base.subjectBn, sectionName: base.sectionName,
    },
    submissions: graded
      ? [{
          id: 'demo-sub-me', studentId: 'demo-user', fullNameBn: 'রাফি', rollNo: 7,
          bodyBn: 'বিজ্ঞান ও প্রযুক্তি আমাদের জীবনযাত্রাকে সহজ করেছে…',
          submittedAt: inDays(-4), isLate: false,
          marksAwarded: '13.00', feedbackBn: 'ভালো লিখেছ — উপসংহারটি আরও শক্ত হতে পারত।',
          gradedAt: inDays(-2),
        }]
      : [
          { id: 'demo-sub-1', studentId: 'demo-s1', fullNameBn: 'আয়শা সিদ্দিকা', rollNo: 1,
            bodyBn: 'a = (v − u)/t সূত্র ব্যবহার করে… ক) ৪ m/s²  খ) ২০ মিটার',
            submittedAt: inDays(-1), isLate: false, marksAwarded: null, feedbackBn: null, gradedAt: null },
          { id: 'demo-sub-2', studentId: 'demo-s2', fullNameBn: 'তানভীর হাসান', rollNo: 2,
            bodyBn: 'প্রথমে u = ১০, v = ৩০, t = ৫ ধরে…',
            submittedAt: inDays(-1), isLate: false, marksAwarded: null, feedbackBn: null, gradedAt: null },
          { id: 'demo-sub-3', studentId: 'demo-s3', fullNameBn: 'নুসরাত জাহান', rollNo: 3,
            bodyBn: 'সমাধান সংযুক্ত করা হলো।',
            submittedAt: inDays(0), isLate: true, marksAwarded: null, feedbackBn: null, gradedAt: null },
        ],
  };
}

const DEMO_NEXT = [
  {
    kind: 'assignment', titleBn: 'গতির সমীকরণ — অনুশীলনী ৫.২',
    whyBn: '২ দিনের মধ্যে জমা দিতে হবে', route: 'assignments',
    refId: 'demo-a-1', urgency: 'high',
  },
  {
    kind: 'redo_practice', titleBn: 'ত্বরণ',
    whyBn: '১টি প্রশ্ন এখনো ভুল আছে — আবার চেষ্টা করো', route: 'learn',
    refId: 'demo-l-3', urgency: 'medium',
  },
  {
    kind: 'continue_topic', titleBn: 'পড়ন্ত বস্তুর গতি',
    whyBn: 'অধ্যায় ৫: গতি অধ্যায়টি শেষ করো', route: 'learn',
    refId: 'demo-l-4', urgency: 'medium',
  },
];

const DEMO_PRACTICE = [
  {
    id: 'demo-q-1', questionNo: 1, kind: 'mcq',
    stemBn: 'একটি বস্তুর বেগ ৫ সেকেন্ডে ১০ m/s থেকে ৩০ m/s হলে ত্বরণ কত?',
    explanationBn: 'a = (v − u)/t = (৩০ − ১০)/৫ = ৪ m/s²। বেগের পরিবর্তনকে সময় দিয়ে ভাগ করলেই ত্বরণ পাওয়া যায়।',
    difficulty: 2, numericAnswer: null, numericTolerance: null,
    options: [
      { id: 'demo-o-1a', optionNo: 1, textBn: '২ m/s²', isCorrect: false },
      { id: 'demo-o-1b', optionNo: 2, textBn: '৪ m/s²', isCorrect: true },
      { id: 'demo-o-1c', optionNo: 3, textBn: '৬ m/s²', isCorrect: false },
      { id: 'demo-o-1d', optionNo: 4, textBn: '৮ m/s²', isCorrect: false },
    ],
    myProgress: { attempts: 0, solved: false, lastResponseMs: null },
  },
  {
    id: 'demo-q-2', questionNo: 2, kind: 'true_false',
    stemBn: 'ত্বরণ একটি স্কেলার রাশি।',
    explanationBn: 'ভুল — ত্বরণ ভেক্টর রাশি, কারণ এর মান ও দিক দুটোই আছে।',
    difficulty: 1, numericAnswer: null, numericTolerance: null,
    options: [
      { id: 'demo-o-2a', optionNo: 1, textBn: 'সত্য', isCorrect: false },
      { id: 'demo-o-2b', optionNo: 2, textBn: 'মিথ্যা', isCorrect: true },
    ],
    myProgress: { attempts: 1, solved: true, lastResponseMs: 8400 },
  },
  {
    id: 'demo-q-3', questionNo: 3, kind: 'numeric',
    stemBn: 'একটি বাস ৮ সেকেন্ডে ২৪ m/s থেকে থেমে গেলে তার মন্দন কত (m/s²)? ঋণাত্মক চিহ্ন ছাড়া লেখো।',
    explanationBn: 'a = (০ − ২৪)/৮ = −৩ m/s²। মান ৩, দিক বেগের বিপরীতে — তাই একে মন্দন বলে।',
    difficulty: 3, numericAnswer: '3', numericTolerance: '0.01',
    options: [],
    myProgress: { attempts: 0, solved: false, lastResponseMs: null },
  },
];

/**
 * F-805 demo data, built to wireframe §6.5's own example: a Class 9 Science
 * student with an optional 4th subject, so the mandatory footnote and the
 * ⁴ superscript both render. Three terms, so the trend row has something to
 * show.
 */
const DEMO_RESULTS = [
  {
    examId: 'demo-ex-3', examNameBn: 'বার্ষিক পরীক্ষা', examType: 'term',
    totalMarks: '742', totalMax: '900', percentage: '82.4', gpa: '4.72',
    letterGrade: 'A+', subjectsFailed: 0, isPass: true, rankInSection: 5,
    publishedAt: '2026-08-12T09:00:00Z',
    subjects: [
      { subjectBn: 'বাংলা', cqMarks: '52', mcqMarks: '23', practicalMarks: null, caMarks: null, totalMarks: '75', gradeLetter: 'A', gradePoint: '4.00', isAbsent: false, requirementType: 'compulsory' },
      { subjectBn: 'ইংরেজি', cqMarks: '55', mcqMarks: '22', practicalMarks: null, caMarks: null, totalMarks: '77', gradeLetter: 'A', gradePoint: '4.00', isAbsent: false, requirementType: 'compulsory' },
      { subjectBn: 'গণিত', cqMarks: '58', mcqMarks: '26', practicalMarks: null, caMarks: null, totalMarks: '84', gradeLetter: 'A+', gradePoint: '5.00', isAbsent: false, requirementType: 'compulsory' },
      { subjectBn: 'পদার্থবিজ্ঞান', cqMarks: '44', mcqMarks: '19', practicalMarks: '22', caMarks: null, totalMarks: '85', gradeLetter: 'A+', gradePoint: '5.00', isAbsent: false, requirementType: 'group_compulsory' },
      { subjectBn: 'রসায়ন', cqMarks: '41', mcqMarks: '18', practicalMarks: '21', caMarks: null, totalMarks: '80', gradeLetter: 'A+', gradePoint: '5.00', isAbsent: false, requirementType: 'group_compulsory' },
      { subjectBn: 'জীববিজ্ঞান', cqMarks: '38', mcqMarks: '17', practicalMarks: '20', caMarks: null, totalMarks: '75', gradeLetter: 'A', gradePoint: '4.00', isAbsent: false, requirementType: 'group_compulsory' },
      { subjectBn: 'ইসলাম ও নৈতিক শিক্ষা', cqMarks: '48', mcqMarks: '21', practicalMarks: null, caMarks: null, totalMarks: '69', gradeLetter: 'A-', gradePoint: '3.50', isAbsent: false, requirementType: 'religion_variant' },
      { subjectBn: 'উচ্চতর গণিত', cqMarks: '44', mcqMarks: '20', practicalMarks: null, caMarks: null, totalMarks: '64', gradeLetter: 'A-', gradePoint: '3.50', isAbsent: false, requirementType: 'optional' },
    ],
  },
  {
    examId: 'demo-ex-2', examNameBn: 'দ্বিতীয় সাময়িক', examType: 'term',
    totalMarks: '688', totalMax: '900', percentage: '76.4', gpa: '4.31',
    letterGrade: 'A', subjectsFailed: 0, isPass: true, rankInSection: 9,
    publishedAt: '2026-05-20T09:00:00Z',
    subjects: [
      { subjectBn: 'বাংলা', cqMarks: '46', mcqMarks: '20', practicalMarks: null, caMarks: null, totalMarks: '66', gradeLetter: 'A-', gradePoint: '3.50', isAbsent: false, requirementType: 'compulsory' },
      { subjectBn: 'গণিত', cqMarks: '50', mcqMarks: '24', practicalMarks: null, caMarks: null, totalMarks: '74', gradeLetter: 'A', gradePoint: '4.00', isAbsent: false, requirementType: 'compulsory' },
      { subjectBn: 'পদার্থবিজ্ঞান', cqMarks: '40', mcqMarks: '16', practicalMarks: '19', caMarks: null, totalMarks: '75', gradeLetter: 'A', gradePoint: '4.00', isAbsent: false, requirementType: 'group_compulsory' },
      { subjectBn: 'উচ্চতর গণিত', cqMarks: '39', mcqMarks: '18', practicalMarks: null, caMarks: null, totalMarks: '57', gradeLetter: 'B', gradePoint: '3.00', isAbsent: false, requirementType: 'optional' },
    ],
  },
  {
    examId: 'demo-ex-1', examNameBn: 'প্রথম সাময়িক', examType: 'term',
    totalMarks: '702', totalMax: '900', percentage: '78.0', gpa: '4.56',
    letterGrade: 'A', subjectsFailed: 0, isPass: true, rankInSection: 7,
    publishedAt: '2026-02-18T09:00:00Z',
    subjects: [
      { subjectBn: 'বাংলা', cqMarks: '48', mcqMarks: '22', practicalMarks: null, caMarks: null, totalMarks: '70', gradeLetter: 'A', gradePoint: '4.00', isAbsent: false, requirementType: 'compulsory' },
      { subjectBn: 'ইংরেজি', cqMarks: '52', mcqMarks: '20', practicalMarks: null, caMarks: null, totalMarks: '72', gradeLetter: 'A', gradePoint: '4.00', isAbsent: false, requirementType: 'compulsory' },
      { subjectBn: 'গণিত', cqMarks: '55', mcqMarks: '25', practicalMarks: null, caMarks: null, totalMarks: '80', gradeLetter: 'A+', gradePoint: '5.00', isAbsent: false, requirementType: 'compulsory' },
      { subjectBn: 'পদার্থবিজ্ঞান', cqMarks: '42', mcqMarks: '18', practicalMarks: '21', caMarks: null, totalMarks: '81', gradeLetter: 'A+', gradePoint: '5.00', isAbsent: false, requirementType: 'group_compulsory' },
      { subjectBn: 'উচ্চতর গণিত', cqMarks: '44', mcqMarks: '20', practicalMarks: null, caMarks: null, totalMarks: '64', gradeLetter: 'A-', gradePoint: '3.50', isAbsent: false, requirementType: 'optional' },
    ],
  },
];

const DEMO_CHAPTERS = [
  {
    id: 'demo-ch-1', chapterNo: 5,
    name: { bn: 'অধ্যায় ৫: গতি', en: 'Chapter 5: Motion' },
    summaryBn: 'সরণ, দ্রুতি, বেগ ও ত্বরণের ধারণা এবং নিউটনের সূত্র।',
    estMinutes: 90, isPublished: true,
    subject: { id: 'demo-sub-phy', bn: 'পদার্থবিজ্ঞান', en: 'Physics' },
    prerequisite: null, topicCount: 4, completedCount: 2,
  },
  {
    id: 'demo-ch-2', chapterNo: 6,
    name: { bn: 'অধ্যায় ৬: বল ও নিউটনের সূত্র', en: 'Chapter 6: Force' },
    summaryBn: 'বলের প্রকারভেদ, নিউটনের তিনটি সূত্র ও তাদের প্রয়োগ।',
    estMinutes: 120, isPublished: true,
    subject: { id: 'demo-sub-phy', bn: 'পদার্থবিজ্ঞান', en: 'Physics' },
    prerequisite: { id: 'demo-ch-1', nameBn: 'অধ্যায় ৫: গতি' },
    topicCount: 5, completedCount: 0,
  },
  {
    id: 'demo-ch-3', chapterNo: 3,
    name: { bn: 'অধ্যায় ৩: বীজগণিতিক রাশি', en: 'Chapter 3: Algebraic Expressions' },
    summaryBn: 'উৎপাদক বিশ্লেষণ ও দ্বিঘাত সমীকরণের সমাধান।',
    estMinutes: 100, isPublished: true,
    subject: { id: 'demo-sub-math', bn: 'গণিত', en: 'Mathematics' },
    prerequisite: null, topicCount: 4, completedCount: 4,
  },
];

const DEMO_TOPICS = [
  { id: 'demo-l-1', topicNo: 1, title: { bn: 'সরণ ও দূরত্ব', en: null }, estMinutes: 20, isPublished: true, progress: { state: 'completed', secondsSpent: 1180 } },
  { id: 'demo-l-2', topicNo: 2, title: { bn: 'দ্রুতি ও বেগ', en: null }, estMinutes: 25, isPublished: true, progress: { state: 'completed', secondsSpent: 1420 } },
  { id: 'demo-l-3', topicNo: 3, title: { bn: 'ত্বরণ', en: null }, estMinutes: 20, isPublished: true, progress: { state: 'started', secondsSpent: 310 } },
  { id: 'demo-l-4', topicNo: 4, title: { bn: 'গতির সমীকরণ', en: null }, estMinutes: 25, isPublished: true, progress: null },
];

function demoTopic(topicId: string) {
  return {
    topic: {
      id: topicId, topicNo: 3,
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

/**
 * F-802 demo data. A real Class 9 Science subject set: four compulsory,
 * three group-compulsory, one religion variant and one optional — the same
 * shape db/tests/subject_model.sql asserts, so the demo cannot drift into
 * showing a set the schema would not produce.
 */
const DEMO_SUBJECTS = [
  { subjectId: 'demo-sub-101', nameBn: 'বাংলা', nctbCode: '101', requirementType: 'compulsory',
    requirementLabelBn: 'আবশ্যিক', totalChapters: 14, completedChapters: 9, progressPercent: 64,
    nextChapter: { id: 'demo-ch-b10', chapterNo: 10, nameBn: 'অপরিচিতা' } },
  { subjectId: 'demo-sub-107', nameBn: 'ইংরেজি', nctbCode: '107', requirementType: 'compulsory',
    requirementLabelBn: 'আবশ্যিক', totalChapters: 12, completedChapters: 12, progressPercent: 100,
    nextChapter: null },
  { subjectId: 'demo-sub-109', nameBn: 'গণিত', nctbCode: '109', requirementType: 'compulsory',
    requirementLabelBn: 'আবশ্যিক', totalChapters: 17, completedChapters: 11, progressPercent: 65,
    nextChapter: { id: 'demo-ch-m12', chapterNo: 12, nameBn: 'দুই চলকবিশিষ্ট সরল সহসমীকরণ' } },
  { subjectId: 'demo-sub-150', nameBn: 'বাংলাদেশ ও বিশ্বপরিচয়', nctbCode: '150', requirementType: 'compulsory',
    requirementLabelBn: 'আবশ্যিক', totalChapters: 12, completedChapters: 5, progressPercent: 42,
    nextChapter: { id: 'demo-ch-g6', chapterNo: 6, nameBn: 'বাংলাদেশের অর্থনীতি' } },
  { subjectId: 'demo-sub-136', nameBn: 'পদার্থবিজ্ঞান', nctbCode: '136', requirementType: 'group_compulsory',
    requirementLabelBn: 'বিভাগ আবশ্যিক', totalChapters: 14, completedChapters: 8, progressPercent: 57,
    nextChapter: { id: 'demo-ch-p9', chapterNo: 9, nameBn: 'তরঙ্গ ও শব্দ' } },
  { subjectId: 'demo-sub-137', nameBn: 'রসায়ন', nctbCode: '137', requirementType: 'group_compulsory',
    requirementLabelBn: 'বিভাগ আবশ্যিক', totalChapters: 12, completedChapters: 6, progressPercent: 50,
    nextChapter: { id: 'demo-ch-c7', chapterNo: 7, nameBn: 'রাসায়নিক বিক্রিয়া' } },
  { subjectId: 'demo-sub-138', nameBn: 'জীববিজ্ঞান', nctbCode: '138', requirementType: 'group_compulsory',
    requirementLabelBn: 'বিভাগ আবশ্যিক', totalChapters: 14, completedChapters: 4, progressPercent: 29,
    nextChapter: { id: 'demo-ch-b5', chapterNo: 5, nameBn: 'অঙ্গ ও অঙ্গতন্ত্র' } },
  { subjectId: 'demo-sub-111', nameBn: 'ইসলাম ও নৈতিক শিক্ষা', nctbCode: '111', requirementType: 'religion_variant',
    requirementLabelBn: 'ধর্ম', totalChapters: 12, completedChapters: 7, progressPercent: 58,
    nextChapter: { id: 'demo-ch-i8', chapterNo: 8, nameBn: 'ইবাদত' } },
  { subjectId: 'demo-sub-126', nameBn: 'উচ্চতর গণিত', nctbCode: '126', requirementType: 'optional',
    requirementLabelBn: 'চতুর্থ বিষয়', totalChapters: 12, completedChapters: 4, progressPercent: 33,
    nextChapter: { id: 'demo-ch-h5', chapterNo: 5, nameBn: 'সমীকরণ ও অসমতা' } },
];

/**
 * F-806 demo data. Deliberately includes BOTH excused and unexcused
 * absences, because the one thing this screen has to get right is showing
 * them as different things.
 */
const DEMO_ATTENDANCE = {
  totals: { present: 96, late: 7, absent: 5, excused: 4, halfDay: 2,
            counted: 110, attendedPercent: 95 },
  byMonth: [
    { month: '2026-08', present: 6,  late: 1, absent: 0, excused: 0, halfDay: 0 },
    { month: '2026-07', present: 20, late: 2, absent: 1, excused: 1, halfDay: 0 },
    { month: '2026-06', present: 18, late: 1, absent: 3, excused: 2, halfDay: 1 },
    { month: '2026-05', present: 22, late: 2, absent: 0, excused: 0, halfDay: 0 },
    { month: '2026-04', present: 17, late: 1, absent: 1, excused: 1, halfDay: 1 },
    { month: '2026-03', present: 13, late: 0, absent: 0, excused: 0, halfDay: 0 },
  ],
  bySubject: [
    { subjectBn: 'রসায়ন',        present: 18, late: 2, absent: 3, excused: 1 },
    { subjectBn: 'পদার্থবিজ্ঞান',   present: 20, late: 1, absent: 1, excused: 1 },
    { subjectBn: 'গণিত',          present: 22, late: 2, absent: 1, excused: 0 },
    { subjectBn: 'বাংলা',         present: 21, late: 1, absent: 0, excused: 1 },
    { subjectBn: 'ইংরেজি',        present: 15, late: 1, absent: 0, excused: 1 },
  ],
  recent: [
    { takenOn: '2026-07-22', status: 'excused', minutesLate: null, remark: 'ডাক্তারি ছুটি', subjectBn: null },
    { takenOn: '2026-07-14', status: 'late',    minutesLate: 18,   remark: null, subjectBn: 'গণিত' },
    { takenOn: '2026-06-30', status: 'absent',  minutesLate: null, remark: null, subjectBn: 'রসায়ন' },
    { takenOn: '2026-06-19', status: 'excused', minutesLate: null, remark: 'পারিবারিক অনুষ্ঠান', subjectBn: null },
    { takenOn: '2026-06-11', status: 'absent',  minutesLate: null, remark: null, subjectBn: 'রসায়ন' },
    { takenOn: '2026-06-04', status: 'half_day',minutesLate: null, remark: 'অসুস্থ', subjectBn: null },
    { takenOn: '2026-05-27', status: 'late',    minutesLate: 25,   remark: null, subjectBn: 'পদার্থবিজ্ঞান' },
  ],
};

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Two demo institutions — R-1's acceptance test, runnable in a browser
 * with no database.
 *
 * The requirement is that ONE deployment serves institutions with
 * completely different identities, and the only honest way to show that is
 * side by side: open ?demo=1&tenant=a and ?demo=1&tenant=b and compare the
 * login screen, the shell, the tab title and the printed letterhead.
 *
 * Deliberately unalike in every dimension the feature covers — Bangla and
 * English name, short name, logo, colour, address, contact, head teacher —
 * so a bug that leaks one tenant's value into the other shows up as an
 * obvious mismatch rather than something a reader has to hunt for.
 *
 * The logos are 24px discs generated as PNG (not SVG: the ui-core
 * validator refuses SVG, and a demo that used one would be demonstrating
 * something the product does not accept).
 */
export const DEMO_TENANTS: Record<string, { id: string; branding: Record<string, string> }> = {
  a: {
    id: 'demo-tenant-a',
    branding: {
      nameBn: 'শাহজালাল আদর্শ উচ্চ বিদ্যালয়',
      nameEn: 'Shahjalal Adarsha High School',
      shortName: 'শাহজালাল',
      logoUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAATUlEQVR4nGMQzbJnoCUmpOA/kZgsC4g1HK8l1DAYr0XUNhzDErpaQC3DUSyhleFwS0YtGLVg1AI6WkDzomJ4lKZ0qXDoUmXSrdKnCgYAp65CFhRKEgcAAAAASUVORK5CYII=',
      faviconUrl: '',
      primaryColor: '#156a3f',
      accentColor: '#4e7a94',
      address: 'জিন্দাবাজার, সিলেট ৩১০০',
      phone: '+8801711000001',
      email: 'office@shahjalal-high.example.edu.bd',
      website: 'https://shahjalal-high.example.edu.bd',
      watermarkUrl: '',
      headmasterName: 'মোঃ আব্দুল কাদের',
      signatureUrl: '',
    },
  },
  b: {
    id: 'demo-tenant-b',
    branding: {
      nameBn: 'নর্থ সিটি মহিলা কলেজ',
      nameEn: 'North City Women’s College',
      shortName: 'নর্থ সিটি',
      logoUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAATUlEQVR4nGOQtqtioCUmpOA/kZgsC4g1HK8l1DAYr0XUNhzDErpaQC3DUSyhleFwS0YtGLVg1AI6WkDzomJ4lKZ0qXDoUmXSrdKnCgYAK6dxVsAgk2IAAAAASUVORK5CYII=',
      faviconUrl: '',
      primaryColor: '#1b3e7a',
      accentColor: '#a76a47',
      address: 'উত্তরা সেক্টর ৭, ঢাকা ১২৩০',
      phone: '+8801711000002',
      email: 'info@northcity-college.example.edu.bd',
      website: 'https://northcity-college.example.edu.bd',
      watermarkUrl: '',
      headmasterName: 'অধ্যাপক সালমা বেগম',
      signatureUrl: '',
    },
  },
};

/**
 * Sample notices for the demo inbox, tagged with the roles that would hold a
 * receipt. The teacher-only notice is here specifically so a previewer can
 * switch to the student role and watch it disappear.
 */
const DEMO_NOTICES: {
  noticeId: string; title: string; body: string; category: string;
  deliveredAt: string; roles: string[];
  aboutStudent?: { id: string; nameBn: string };
}[] = [
  {
    noticeId: 'n-1', category: 'emergency',
    title: 'আগামীকাল বিদ্যালয় বন্ধ',
    body: 'আবহাওয়ার কারণে আগামীকাল সকল ক্লাস বন্ধ থাকবে। পরবর্তী নির্দেশনা এসএমএসে জানানো হবে।',
    deliveredAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
    roles: ['class_teacher', 'student', 'guardian', 'principal', 'accountant'],
  },
  {
    noticeId: 'n-2', category: 'teacher',
    title: 'শিক্ষক সভা — বৃহস্পতিবার ৩টা',
    body: 'সকল শিক্ষককে শিক্ষক মিলনায়তনে উপস্থিত থাকার জন্য অনুরোধ করা হলো।',
    deliveredAt: new Date(Date.now() - 26 * 3600_000).toISOString(),
    roles: ['class_teacher', 'principal'],
  },
  {
    noticeId: 'n-3', category: 'exam',
    title: 'অর্ধবার্ষিক পরীক্ষার সূচি প্রকাশিত',
    body: 'সূচি অ্যাপের পরীক্ষার রুটিন অংশে দেখা যাবে।',
    deliveredAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    roles: ['student', 'guardian', 'class_teacher', 'principal'],
  },
  {
    noticeId: 'n-4', category: 'fee',
    title: 'সেপ্টেম্বরের বেতন পরিশোধের শেষ তারিখ ১০ তারিখ',
    body: 'নির্ধারিত তারিখের পর বিলম্ব ফি যুক্ত হবে।',
    deliveredAt: new Date(Date.now() - 5 * 86_400_000).toISOString(),
    roles: ['guardian', 'accountant', 'principal'],
    aboutStudent: { id: 'demo-s1', nameBn: 'রাফির হাসান' },
  },
];

/** Read state for the demo inbox — per session, never persisted. */
const demoRead = new Set<string>();

/** The role this preview is showing, read the same way DemoAuth reads it. */
/**
 * R-3's demo institution, shaped like Part T's acceptance case: Class 9 with
 * three groups, Science carrying sections A–F, and F holding forty students
 * with a class teacher and five subject teachers.
 *
 * The demo answers R-3's endpoints locally like every other one, and it obeys
 * the same role rule the real product does — a student asking for the
 * institution dashboard is refused here too, so the preview cannot teach
 * anyone that the management screens are open to everybody.
 */
const DEMO_TEACHERS = [
  { id: 'demo-t1', nameBn: 'রহিম স্যার',  employeeCode: 'T-101', currentLoad: 4, expertiseSubjectIds: ['demo-sub1'] },
  { id: 'demo-t2', nameBn: 'করিম স্যার',  employeeCode: 'T-102', currentLoad: 3, expertiseSubjectIds: ['demo-sub1', 'demo-sub2'] },
  { id: 'demo-t3', nameBn: 'হাসান স্যার', employeeCode: 'T-103', currentLoad: 5, expertiseSubjectIds: ['demo-sub2'] },
  { id: 'demo-t4', nameBn: 'নাঈম স্যার',  employeeCode: 'T-104', currentLoad: 2, expertiseSubjectIds: ['demo-sub3'] },
  { id: 'demo-t5', nameBn: 'শুভ স্যার',   employeeCode: 'T-105', currentLoad: 6, expertiseSubjectIds: ['demo-sub4'] },
];

const R3_SUBJECTS = [
  { id: 'demo-sub1', nameBn: 'পদার্থবিজ্ঞান', nameEn: 'Physics' },
  { id: 'demo-sub2', nameBn: 'রসায়ন',        nameEn: 'Chemistry' },
  { id: 'demo-sub3', nameBn: 'জীববিজ্ঞান',    nameEn: 'Biology' },
  { id: 'demo-sub4', nameBn: 'গণিত',          nameEn: 'Mathematics' },
  { id: 'demo-sub5', nameBn: 'বাংলা',          nameEn: 'Bangla' },
];

/** Forty students, deterministic — a preview must look the same twice. */
const DEMO_SECTION_F_ROSTER = Array.from({ length: 40 }, (_, i) => ({
  studentId: `demo-s${i + 1}`,
  rollNo: i + 1,
  // Bangla numerals: the preview sits beside real Bangla counts, and a
  // Latin '12' in the roster is the kind of seam a school notices first.
  nameBn: `শিক্ষার্থী ${String(i + 1).replace(/\d/g, (c) => '০১২৩৪৫৬৭৮৯'[Number(c)])}`,
  studentCode: `2026-9F-${String(i + 1).padStart(3, '0')}`,
  status: 'active',
}));

const DEMO_SECTIONS_SCIENCE = ['A', 'B', 'C', 'D', 'E', 'F'].map((name, i) => ({
  id: `demo-sec-${name}`,
  name,
  shift: 'morning',
  capacity: 60,
  studentCount: name === 'F' ? 40 : 38 - i,
  classTeacher: name === 'F'
    ? { id: 'demo-t1', nameBn: 'রহিম স্যার' }
    : (i % 3 === 2 ? null : { id: `demo-t${(i % 5) + 1}`, nameBn: DEMO_TEACHERS[i % 5].nameBn }),
  subjectTeacherCount: name === 'F' ? 5 : 4,
}));


/**
 * R-3 role gates, mirroring the allowlists in the real handlers.
 *
 * The demo answers locally, so without these it answers EVERYTHING to
 * EVERYBODY — and a preview that shows a student the institution's user list
 * is teaching the opposite of what the product does. Found in the browser:
 * the student preview rendered the whole academic tree, the staff directory
 * and the result-publishing screen.
 *
 * Each set is a copy of a server allowlist, and copies drift. That is
 * acceptable here and nowhere else: this decides what a SAMPLE-DATA preview
 * draws, and the server still refuses the real request either way.
 */
const DEMO_GATES: Record<string, string[]> = {
  '/api/v1/ops/dashboard': ['principal', 'school_owner', 'academic_coordinator', 'it_admin'],
  '/api/v1/ops/assign':    ['principal', 'school_owner', 'academic_coordinator', 'it_admin'],
  '/api/v1/ops/enrol':     ['principal', 'school_owner', 'academic_coordinator', 'it_admin'],
  '/api/v1/ops/rollover':  ['principal', 'school_owner', 'academic_coordinator', 'it_admin'],
  '/api/v1/ops/users':     ['principal', 'school_owner', 'it_admin', 'academic_coordinator'],
  '/api/v1/academics/publish': ['principal', 'school_owner', 'academic_coordinator'],
  '/api/v1/ops/structure':  ['principal', 'school_owner', 'academic_coordinator', 'it_admin'],
  '/api/v1/ops/guardians':  ['principal', 'school_owner', 'it_admin', 'academic_coordinator',
                             'class_teacher', 'subject_teacher', 'dept_head', 'accountant'],
  // The narrowest gate in the product: the audit trail names every change
  // anybody made, so it is three roles and no others.
  '/api/v1/ops/audit':      ['principal', 'school_owner', 'it_admin'],
  // R-4's calendar is deliberately absent from this map: every role reads it.
  // Only its WRITES are gated, and the demo answers reads only.
  '/api/v1/finance/generate':  ['principal', 'school_owner', 'accountant'],
};

/** requireStaff: students and guardians are the blocklist, as in auth.ts. */
const DEMO_STAFF_ONLY = new Set(['/api/v1/academics/hierarchy']);

function demoForbidden(pathname: string): Response | null {
  const allowed = DEMO_GATES[pathname];
  if (allowed && !allowed.includes(demoRole())) {
    return new Response(JSON.stringify({ error: 'forbidden' }),
      { status: 403, headers: { 'Content-Type': 'application/json' } });
  }
  if (DEMO_STAFF_ONLY.has(pathname) && ['student', 'guardian'].includes(demoRole())) {
    return new Response(JSON.stringify({ error: 'forbidden' }),
      { status: 403, headers: { 'Content-Type': 'application/json' } });
  }
  return null;
}

/**
 * The audit fixture. Includes the redacted case — a phone number in a diff —
 * so the preview shows what the server's masking does rather than only
 * claiming it happens.
 */
const DEMO_AUDIT = [
  {
    id: '5', at: '2026-08-28T09:12:00Z',
    actor: { id: 'demo-p1', nameBn: 'প্রধান শিক্ষক', role: 'principal' },
    action: 'ops.guardian.permissions', entityType: 'guardianship', entityId: 'demo-link-1',
    before: { canPayFees: true, receivesSms: true, phone: '•••11' },
    after: { canPayFees: false, receivesSms: true, phone: '•••11' },
  },
  {
    id: '4', at: '2026-08-27T14:40:00Z',
    actor: { id: 'demo-p1', nameBn: 'প্রধান শিক্ষক', role: 'principal' },
    action: 'academic.class_teacher.assign', entityType: 'section', entityId: 'demo-sec-F',
    before: { teacherId: 'demo-t1', nameBn: 'রহিম স্যার' },
    after: { teacherId: 'demo-t2', nameBn: 'করিম স্যার', reason: 'বদলি হয়েছেন' },
  },
  {
    id: '3', at: '2026-08-26T11:05:00Z',
    actor: { id: 'demo-p1', nameBn: 'প্রধান শিক্ষক', role: 'principal' },
    action: 'academic.section.create', entityType: 'section', entityId: 'demo-sec-G',
    before: null,
    after: { name: 'G', capacity: 55, shift: 'morning' },
  },
  {
    id: '2', at: '2026-08-25T08:30:00Z',
    actor: { id: 'demo-p1', nameBn: 'প্রধান শিক্ষক', role: 'principal' },
    action: 'exam.results.publish', entityType: 'exam', entityId: 'demo-exam0',
    before: null, after: { resultsPublished: 236, notified: 472 },
  },
  {
    // The masked case: a phone number that CHANGED, so the redaction is
    // visible rather than merely claimed. The server masks to the last two
    // digits — enough to recognise a number, not enough to dial it.
    id: '1b', at: '2026-08-24T17:10:00Z',
    actor: { id: 'demo-p1', nameBn: 'প্রধান শিক্ষক', role: 'principal' },
    action: 'ops.user.create', entityType: 'user', entityId: 'demo-new-user',
    before: null, after: { nameBn: 'নতুন শিক্ষক', roleCode: 'subject_teacher', phone: '•••47' },
  },
  {
    id: '1', at: '2026-08-24T16:00:00Z',
    actor: { id: 'demo-p1', nameBn: 'প্রধান শিক্ষক', role: 'principal' },
    action: 'ops.settings.update', entityType: 'tenant', entityId: 'demo-tenant',
    before: { noticeMaxChars: 180 }, after: { noticeMaxChars: 240 },
  },
];

/** Mutable so the preview's fee-permission toggle actually holds. */
let demoGuardianPays = true;

/**
 * R-4's calendar fixture.
 *
 * Two tenants with DIFFERENT weekends, because that is the property the
 * feature exists to have: tenant A runs Fri+Sat, tenant B (a Madrasah) runs
 * Friday only, and the grid must shade whatever it is told rather than a
 * hardcoded pair of days.
 */
const DEMO_CALENDAR: Record<'a' | 'b', {
  weekendDays: number[];
  entries: {
    id: string; day: string; kind: string; titleBn: string;
    descriptionBn: string | null; appliesToShifts: string[] | null;
    source: string; editable: boolean; createdByNameBn?: string | null;
  }[];
}> = {
  a: {
    weekendDays: [5, 6],
    entries: [
      { id: 'demo-cal-1', day: '2026-10-10', kind: 'holiday', titleBn: 'বিদ্যালয় ছুটি',
        descriptionBn: 'দুর্গাপূজা উপলক্ষে বিদ্যালয় বন্ধ থাকবে।', appliesToShifts: null,
        source: 'calendar', editable: true, createdByNameBn: 'প্রধান শিক্ষক' },
      { id: 'demo-cal-2', day: '2026-10-15', kind: 'event', titleBn: 'ক্রীড়া দিবস',
        descriptionBn: 'সকাল ৯টায় মাঠে।', appliesToShifts: null,
        source: 'calendar', editable: true, createdByNameBn: 'প্রধান শিক্ষক' },
      // R-4.1. 2026-10-17 is a Saturday — inside tenant A's {5,6} weekend —
      // declared a working day. The one date the column says shut and the
      // school says open.
      { id: 'demo-cal-4', day: '2026-10-17', kind: 'working_weekend',
        titleBn: 'বন্যার ক্ষতি পুষিয়ে নিতে ক্লাস',
        descriptionBn: 'শনিবার স্বাভাবিক রুটিনে ক্লাস হবে।', appliesToShifts: null,
        source: 'calendar', editable: true, createdByNameBn: 'প্রধান শিক্ষক' },
      { id: 'demo-cal-3', day: '2026-10-15', kind: 'event', titleBn: 'অভিভাবক সভা',
        descriptionBn: null, appliesToShifts: ['morning'],
        source: 'calendar', editable: true, createdByNameBn: 'প্রধান শিক্ষক' },
      // Read from the exam tables, not stored here — hence editable: false.
      { id: 'exam:demo-exam1', day: '2026-10-20', kind: 'exam',
        titleBn: 'অর্ধবার্ষিক পরীক্ষা', descriptionBn: '2026-10-20 — 2026-10-28',
        appliesToShifts: null, source: 'exam', editable: false },
      { id: 'exam-subject:demo-es1', day: '2026-10-21', kind: 'exam',
        titleBn: 'অর্ধবার্ষিক পরীক্ষা — পদার্থবিজ্ঞান',
        descriptionBn: 'নবম শ্রেণি · সেকশন F', appliesToShifts: null,
        source: 'exam', editable: false },
    ],
  },
  b: {
    // Friday only. Different school, different week.
    weekendDays: [5],
    entries: [
      { id: 'demo-cal-b1', day: '2026-10-12', kind: 'holiday', titleBn: 'ঈদে মিলাদুন্নবী',
        descriptionBn: null, appliesToShifts: null,
        source: 'calendar', editable: true, createdByNameBn: 'অধ্যক্ষ' },
    ],
  },
};

/**
 * R-6's student directory, answered locally.
 *
 * Twelve children, four academic years, and one of them — রাফি হাসান,
 * STU-8F39A271 — is the master plan's own worked example, carried verbatim
 * so the acceptance walk in the R-6 log can be repeated by anyone with the
 * preview link. He moves class, section and roll every year and graduates,
 * which is the case that breaks a timeline built from the current enrolment.
 */
interface DemoStudent {
  id: string;
  nameBn: string;
  nameEn: string;
  code: string;
  status: string;
  /** The section this child sits in TODAY, used for the teacher scope. */
  sectionId: string;
  guardianPhone: string;
  phone: string;
  years: { year: string; classBn: string; group: string; section: string; roll: number }[];
}

const DEMO_CLASSES = ['সপ্তম শ্রেণি', 'অষ্টম শ্রেণি', 'নবম শ্রেণি', 'দশম শ্রেণি'];

const DEMO_STUDENTS: DemoStudent[] = NAMES.map(([bn, en], i) => {
  // Deterministic, so the same id always renders the same child and two
  // screenshots of "STU-8F39A271" are comparable.
  const code = i === 10 ? 'STU-8F39A271' : `STU-${(0x1000_0000 + i * 0x2F41B7).toString(16).toUpperCase().slice(0, 8)}`;
  // The worked example is carried verbatim — name AND code — so anyone can
  // repeat the acceptance walk from the master plan's own text.
  const isExample = i === 10;
  const graduated = isExample || i % 5 === 0;
  return {
    id: `demo-stu-${i + 1}`,
    nameBn: isExample ? 'রাফি হাসান' : bn,
    nameEn: isExample ? 'Rafi Hasan' : en,
    code,
    status: graduated ? 'graduated' : 'enrolled',
    sectionId: i % 2 === 0 ? 'demo-9a' : 'demo-9b',
    guardianPhone: `+88017${String(11000000 + i).padStart(8, '0')}`,
    phone: `+88018${String(11000000 + i).padStart(8, '0')}`,
    years: DEMO_CLASSES.map((classBn, y) => ({
      year: String(2024 + y),
      classBn,
      group: y >= 2 ? 'বিজ্ঞান' : 'সাধারণ',
      // The section and the roll MOVE. A fixture where they did not would
      // let a broken timeline look correct.
      section: ['ক', 'খ', 'গ', 'ঘ'][(i + y) % 4],
      roll: 1 + ((i * 7 + y * 13) % 40),
    })),
  };
});

/** The demo's own `app.can_see_student`, with the same four answers. */
function demoCanSee(s: DemoStudent): boolean {
  switch (demoRole()) {
    case 'student':  return s.id === 'demo-stu-11';       // the signed-in child
    case 'guardian': return s.id === 'demo-stu-11' || s.id === 'demo-stu-4';
    case 'class_teacher':
    case 'subject_teacher': return s.sectionId === 'demo-9a';
    default: return true;                                  // management
  }
}

function demoStudentSearch(q: URLSearchParams): Response {
  const text = (q.get('q') ?? '').trim();
  const status = (q.get('status') ?? '').trim();
  const offset = Math.max(Number(q.get('offset')) || 0, 0);
  const limit = 25;

  if (!text && !status) {
    return new Response(
      JSON.stringify({ error: 'query_too_short', message: 'অনুসন্ধানের জন্য অন্তত ২টি অক্ষর লিখুন।' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } });
  }
  if (text && text.length < 2) {
    return new Response(
      JSON.stringify({ error: 'query_too_short', message: 'অনুসন্ধানের জন্য অন্তত ২টি অক্ষর লিখুন।' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const needle = text.toLowerCase();
  const hits = DEMO_STUDENTS.filter((s) => {
    if (!demoCanSee(s)) return false;
    if (status && s.status !== status) return false;
    if (!text) return true;
    // The digits must be checked for emptiness first. `'সুমাইয়া'.replace(
    // /[^\d]/g,'')` is '', and `String.includes('')` is true for every
    // string — so the phone branch matched the whole school on any Bangla
    // query. Caught in the browser, and worth recording: the real endpoint
    // cannot have this bug because it classifies the query shape and only
    // ever runs ONE branch, which is the reason it does that.
    const digits = text.replace(/[^\d]/g, '');
    return s.code.toLowerCase().includes(needle)
      || s.nameBn.includes(text)
      || s.nameEn.toLowerCase().includes(needle)
      || (digits.length >= 4
          && (s.phone.includes(digits) || s.guardianPhone.includes(digits)));
  });

  const page = hits.slice(offset, offset + limit);
  return ok({
    total: hits.length, limit, offset,
    matchedOn: /^stu-/i.test(text) ? 'code' : 'name',
    students: page.map((s) => {
      const last = s.years[s.years.length - 1];
      return {
        id: s.id,
        name: { bn: s.nameBn, en: s.nameEn },
        studentCode: s.code,
        lifecycleStatus: s.status,
        latest: {
          yearLabel: last.year, classBn: last.classBn, groupBn: last.group,
          section: last.section, rollNo: last.roll,
          // A graduate has no current enrolment, which is what puts the year
          // in front of their row in the result list.
          isCurrent: s.status !== 'graduated',
        },
      };
    }),
  });
}

function demoStudentHistory(q: URLSearchParams): Response {
  const id = q.get('studentId') ?? '';
  const s = DEMO_STUDENTS.find((x) => x.id === id);
  // Invisible and absent give the same answer here too.
  if (!s || !demoCanSee(s)) {
    return new Response(
      JSON.stringify({ error: 'not_found', message: 'শিক্ষার্থী পাওয়া যায়নি' }),
      { status: 404, headers: { 'Content-Type': 'application/json' } });
  }

  const role = demoRole();
  const maySeeFees = ['principal', 'school_owner', 'accountant', 'guardian', 'student'].includes(role);
  const maySeeContact = ['principal', 'school_owner', 'academic_coordinator', 'it_admin',
                         'class_teacher', 'accountant', 'guardian', 'student'].includes(role);
  const printable = Object.entries(DOC_ACCESS)
    .filter(([k, roles]) => k !== 'attendance_sheet' && roles.includes(role))
    .map(([k]) => k);

  return ok({
    student: {
      id: s.id,
      name: { bn: s.nameBn, en: s.nameEn },
      studentCode: s.code,
      lifecycleStatus: s.status,
      admissionDate: '2024-01-05',
      graduatedOn: s.status === 'graduated' ? '2027-02-28' : null,
      bloodGroup: maySeeContact ? 'B+' : null,
      fatherNameBn: maySeeContact ? 'মোঃ আব্দুর রহিম' : null,
      motherNameBn: maySeeContact ? 'রোকসানা বেগম' : null,
      dateOfBirth: maySeeContact ? '2010-03-14' : null,
      phone: maySeeContact ? s.phone : null,
      boardRegistrationNo: maySeeContact ? 'BR-0000042' : null,
      boardRollNo: maySeeContact ? 'BRN-000042' : null,
    },
    enrolments: s.years.map((y, i) => ({
      yearLabel: y.year,
      classBn: y.classBn, classEn: `Class ${7 + i}`, levelNo: 7 + i,
      groupBn: y.group, section: y.section, shift: 'morning',
      rollNo: y.roll,
      status: i === s.years.length - 1 && s.status !== 'graduated' ? 'active' : 'promoted',
      enrolledOn: `${y.year}-01-05`,
      endedOn: i === s.years.length - 1 && s.status !== 'graduated' ? null : `${y.year}-12-20`,
      isCurrent: i === s.years.length - 1 && s.status !== 'graduated',
    })),
    attendance: s.years.map((y, i) => {
      const total = 200 - i * 3;
      const absent = 6 + i;
      const late = 3 + (i % 3);
      const excused = 2;
      const present = total - absent - late - excused;
      return {
        yearLabel: y.year, present, absent, late, excused, halfDay: 0, total,
        percent: Math.round(((present + late) / total) * 1000) / 10,
      };
    }),
    results: s.years.map((y) => ({
      yearLabel: y.year,
      examBn: 'বার্ষিক পরীক্ষা',
      totalMarks: String(380 + (y.roll % 90)),
      totalMax: '500',
      percentage: String(Math.round(((380 + (y.roll % 90)) / 5) * 100) / 100),
      gpa: (3 + (y.roll % 20) / 20).toFixed(2),
      letterGrade: 'A',
      isPass: true,
      rankInSection: y.roll,
    })),
    fees: maySeeFees ? {
      years: s.years.map((y) => ({
        yearLabel: y.year, invoices: 12,
        billed: '14400.00', paid: y.year === '2027' ? '13200.00' : '14400.00',
        due: y.year === '2027' ? '1200.00' : '0.00',
      })),
      receipts: [
        { id: 'demo-rcp-1', receiptNo: 'RCP-2026-00042', issuedAt: '2026-05-12T09:15:00Z',
          amount: '1300.00', method: 'bkash', invoiceNo: 'INV-2026-05-00042' },
        { id: 'demo-rcp-2', receiptNo: 'RCP-2026-00031', issuedAt: '2026-04-11T10:02:00Z',
          amount: '1200.00', method: 'cash', invoiceNo: 'INV-2026-04-00031' },
      ],
    } : null,
    documents: printable.filter((t) => t !== 'transfer_certificate'),
    certificates: printable.filter((t) => t === 'transfer_certificate'),
    permissions: { fees: maySeeFees, contact: maySeeContact },
  });
}

/**
 * R-5's document endpoint, answered locally.
 *
 * `DOC_ACCESS` mirrors `services/ops-svc/api/document.ts` deliberately: a
 * demo that let a guardian print a transfer certificate would teach the
 * wrong thing about the product. The two lists are duplicated rather than
 * shared because the server's copy must not be reachable from the browser
 * bundle; if they drift, the browser acceptance in the R-5 log is what
 * catches it.
 */
const DOC_ACCESS: Record<string, string[]> = {
  fee_receipt: ['principal', 'school_owner', 'accountant', 'student', 'guardian'],
  report_card: ['principal', 'school_owner', 'academic_coordinator', 'dept_head',
                'class_teacher', 'subject_teacher', 'student', 'guardian'],
  admit_card: ['principal', 'school_owner', 'academic_coordinator', 'dept_head',
               'class_teacher', 'subject_teacher', 'student', 'guardian'],
  id_card: ['principal', 'school_owner', 'academic_coordinator', 'it_admin', 'class_teacher'],
  transfer_certificate: ['principal', 'school_owner'],
  attendance_sheet: ['principal', 'school_owner', 'academic_coordinator',
                     'dept_head', 'class_teacher', 'subject_teacher'],
};

function demoStudentRef(studentId: string): StudentRef {
  // Ids look like `demo-9a-s7`; the trailing number picks a name so the same
  // id always renders the same child, which matters when someone prints a
  // card twice and compares them.
  const n = Number(studentId.match(/-s(\d+)$/)?.[1] ?? '1');
  const [bn, en] = NAMES[(n - 1) % NAMES.length];
  const sec = studentId.startsWith('demo-10a') ? 'ক' : studentId.includes('-9b-') ? 'খ' : 'ক';
  return {
    nameBn: bn, nameEn: en,
    studentCode: `2024-${String(1000 + n).slice(1)}`,
    classBn: studentId.startsWith('demo-10a') ? 'দশম শ্রেণি' : 'নবম শ্রেণি',
    groupBn: 'বিজ্ঞান',
    section: sec,
    rollNo: n,
    fatherNameBn: 'মোঃ আব্দুর রহিম',
    motherNameBn: 'রোকসানা বেগম',
    dateOfBirth: '2010-03-14',
    admissionDate: '2024-01-05',
    bloodGroup: ['A+', 'B+', 'O+', 'AB+'][n % 4],
  };
}

function demoDocument(q: URLSearchParams): Response {
  const type = q.get('type') ?? '';
  const allowed = DOC_ACCESS[type];
  if (!allowed) {
    return new Response(JSON.stringify({ error: 'bad_type', message: 'অজানা নথি' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } });
  }
  if (!allowed.includes(demoRole())) {
    return new Response(
      JSON.stringify({ error: 'forbidden', message: 'এই নথি তৈরির অনুমতি আপনার নেই' }),
      { status: 403, headers: { 'Content-Type': 'application/json' } });
  }

  const explicit = (q.get('studentIds') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const one = (q.get('studentId') ?? '').trim();
  const sectionId = (q.get('sectionId') ?? '').trim();
  const ids = explicit.length ? explicit
    : one ? [one]
    : sectionId ? NAMES.map((_, i) => `${sectionId}-s${i + 1}`)
    : [];

  const locale: 'bn' | 'en' = q.get('locale') === 'en' ? 'en' : 'bn';
  const branding = parseBranding(DEMO_TENANTS[demoTenantKey()].branding);
  const sections = demoSectionsFor(type, ids, sectionId, locale);
  if (sections.length === 0) {
    return new Response(
      JSON.stringify({ error: 'no_data', message: 'নথির জন্য কোনো তথ্য পাওয়া যায়নি' }),
      { status: 404, headers: { 'Content-Type': 'application/json' } });
  }

  const html = brandedDocumentSet({
    branding, sections, locale, extraCss: documentBodyCss(),
  });
  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, private' },
  });
}

function demoSectionsFor(
  type: string, ids: string[], sectionId: string, locale: 'bn' | 'en',
): BrandedSection[] {
  const students = ids.map(demoStudentRef);
  switch (type) {
    case 'fee_receipt': {
      const s = students[0] ?? demoStudentRef('demo-9a-s1');
      return [buildFeeReceipt({
        student: s,
        receiptNo: 'RCP-2026-00042',
        issuedAt: '2026-05-12T09:15:00Z',
        amount: '1300.00', method: 'bkash',
        invoiceNo: 'INV-2026-05-00042', billingPeriod: '2026-05',
        lines: [
          { descriptionBn: 'মাসিক বেতন', amount: '1200.00', waiver: '200.00' },
          { descriptionBn: 'পরীক্ষার ফি', amount: '300.00', waiver: '0.00' },
        ],
        invoiceTotal: '1300.00', paidToDate: '1300.00', balance: '0.00',
      }, locale)];
    }
    case 'report_card':
      return students.map((s) => buildReportCard({
        student: s,
        examNameBn: 'অর্ধবার্ষিক পরীক্ষা', yearLabel: '২০২৬',
        subjects: [
          { nameBn: 'বাংলা', obtained: '72', max: '100', grade: 'A-', gradePoint: '3.50', isAbsent: false },
          { nameBn: 'ইংরেজি', obtained: '68', max: '100', grade: 'B', gradePoint: '3.00', isAbsent: false },
          { nameBn: 'গণিত', obtained: '81', max: '100', grade: 'A', gradePoint: '4.00', isAbsent: false },
          { nameBn: 'পদার্থবিজ্ঞান', obtained: null, max: '100', grade: null, gradePoint: null, isAbsent: true },
        ],
        totalMarks: '221', totalMax: '400', percentage: '55.25', gpa: '3.50',
        letterGrade: 'A-', isPass: true, rankInSection: s.rollNo ?? null,
        attendancePercent: '94.50',
      }, locale));
    case 'admit_card':
      return students.map((s) => buildAdmitCard({
        student: s,
        examNameBn: 'বার্ষিক পরীক্ষা', yearLabel: '২০২৬',
        papers: [
          { subjectBn: 'বাংলা', examDate: '2026-11-02', startTime: '10:00', hallBn: 'হল ১', seat: 'সারি ২, আসন ৪' },
          { subjectBn: 'ইংরেজি', examDate: '2026-11-04', startTime: '10:00', hallBn: 'হল ১', seat: 'সারি ২, আসন ৪' },
          { subjectBn: 'গণিত', examDate: '2026-11-06', startTime: '10:00', hallBn: null, seat: null },
        ],
        instructionsBn: ADMIT_INSTRUCTIONS_BN,
      }, locale));
    case 'id_card':
      return students.map((s) => buildIdCard({
        student: s, yearLabel: '২০২৬', validUntil: '2026-12-31',
        guardianPhone: '+8801711000010',
      }, locale));
    case 'transfer_certificate': {
      const s = students[0] ?? demoStudentRef('demo-9a-s1');
      return [buildTransferCertificate({
        student: s,
        certificateNo: `TC-2026-${s.studentCode ?? '0001'}`,
        issuedOn: '2026-07-01',
        lastClassBn: s.classBn ?? 'নবম শ্রেণি', lastYearLabel: '২০২৬',
        admissionDate: s.admissionDate ?? null, leftOn: '2026-06-30',
        conductBn: 'সন্তোষজনক',
        reasonBn: 'অভিভাবকের বদলিজনিত কারণে।',
        duesCleared: true,
      }, locale)];
    }
    case 'attendance_sheet':
      return [buildAttendanceSheet({
        classBn: sectionId.startsWith('demo-10a') ? 'দশম শ্রেণি' : 'নবম শ্রেণি',
        groupBn: 'বিজ্ঞান',
        section: sectionId.includes('-9b') ? 'খ' : 'ক',
        yearLabel: '২০২৬',
        monthBn: 'মে ২০২৬',
        students: NAMES.map(([bn], i) => ({ rollNo: i + 1, nameBn: bn })),
        dayColumns: 31,
      }, locale)];
    default:
      return [];
  }
}

function demoRole(): string {
  const fromUrl = new URLSearchParams(location.search).get('role');
  if (fromUrl) return fromUrl;
  try { return localStorage.getItem('shikhon_demo_role') || 'class_teacher'; }
  catch { return 'class_teacher'; }
}

/** Which demo institution this preview is showing. Defaults to A. */
export function demoTenantKey(search = location.search): 'a' | 'b' {
  const t = new URLSearchParams(search).get('tenant');
  if (t === 'b') return 'b';
  if (t === 'a') return 'a';
  try {
    return localStorage.getItem('shikhon_demo_tenant') === 'b' ? 'b' : 'a';
  } catch {
    return 'a';
  }
}

export class DemoAuth extends Auth {
  constructor() {
    super({ apiBase: '', deviceId: 'demo-device' });
    // Remembered so a reload (the role switcher does a full reload) stays
    // on the same institution instead of snapping back to A.
    try { localStorage.setItem('shikhon_demo_tenant', demoTenantKey()); } catch { /* ignore */ }
  }

  override isLoggedIn(): boolean { return true; }
  override get tenantId(): string { return DEMO_TENANTS[demoTenantKey()].id; }
  // Student-role demo must match the submission rows below, so the
  // "my answer" pre-fill and graded-state branches actually exercise.
  override get userId(): string { return this.role === 'student' ? 'demo-user' : 'demo-teacher'; }
  /**
   * Demo role, switchable via ?role= or the picker in the top bar. The
   * home dashboard is role-aware (app.ts dashboardFor), so without a way
   * to change roles the student and guardian surfaces would be
   * unreachable in a preview — which is exactly the audience most likely
   * to be looking at a demo.
   */
  override get role(): string {
    const fromUrl = new URLSearchParams(location.search).get('role');
    if (fromUrl) {
      try { localStorage.setItem('shikhon_demo_role', fromUrl); } catch { /* ignore */ }
      return fromUrl;
    }
    try { return localStorage.getItem('shikhon_demo_role') || 'class_teacher'; }
    catch { return 'class_teacher'; }
  }
  override get roles(): string[] { return [this.role]; }
  override get displayName(): string {
    const label: Record<string, string> = {
      student: 'রাফি (শিক্ষার্থী)',
      guardian: 'অভিভাবক — রাফির',
      class_teacher: 'ডেমো (শ্রেণি শিক্ষক)',
      principal: 'ডেমো (অধ্যক্ষ)',
      accountant: 'ডেমো (হিসাবরক্ষক)',
      // P1 added it_admin to the demo role picker so the IT-admin sidebar —
      // the one navigation set with no teaching rows in it — is previewable.
      it_admin: 'ডেমো (আইটি অ্যাডমিন)',
    };
    return label[this.role] ?? 'ডেমো (নমুনা তথ্য)';
  }

  override async logout(): Promise<void> {
    // No session to revoke — app.ts falls back to the login view, which
    // shows the login-disabled notice.
  }

  override async authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const url = new URL(path, 'http://demo.internal');

    const refused = demoForbidden(url.pathname);
    if (refused) return refused;

    switch (url.pathname) {
      // R-1. Answered locally like every other demo endpoint, and answered
      // for THIS demo institution only — a demo that could hand back the
      // other tenant's branding would be demonstrating the bug the feature
      // exists to prevent.
      case '/api/v1/ops/branding':
      case '/api/v1/ops/brand':
        return ok({ branding: DEMO_TENANTS[demoTenantKey()].branding });

      // ── R-3 ────────────────────────────────────────────────────────
      // The role gate is reproduced, not skipped: a student who navigates
      // to #/institution in the preview gets the same 403 the server would
      // give them. A demo that showed the dashboard to everybody would be
      // teaching that the management screens are open.
      case '/api/v1/ops/dashboard': {
        const showFinance = ['principal', 'school_owner'].includes(demoRole());
        return ok({
          year: { id: 'demo-year', label: '২০২৬' },
          needsSetup: false,
          counts: { students: 1240, teachers: 48, sections: 26, classes: 6 },
          attendanceToday: {
            present: 1102, marked: 1180, percent: 93,
            sessionsTaken: 22, sectionsExpected: 26,
          },
          absentToday: {
            total: 78,
            shown: DEMO_SECTION_F_ROSTER.slice(0, 6).map((s) => ({
              studentId: s.studentId, nameBn: s.nameBn, rollNo: s.rollNo,
              section: 'F', classBn: 'নবম শ্রেণি',
            })),
          },
          upcomingExams: [
            { id: 'demo-exam1', nameBn: 'অর্ধবার্ষিক পরীক্ষা', startsOn: '2026-06-10', status: 'marking' },
          ],
          recentNotices: [
            { id: 'demo-n1', title: 'অভিভাবক সভা', category: 'guardian', publishedAt: '2026-05-02', recipientCount: 860 },
          ],
          pending: {
            sectionsWithoutClassTeacher: 2,
            subjectsWithoutTeacher: 3,
            examsAwaitingPublication: 1,
            studentsWithoutSection: 0,
          },
          finance: showFinance
            ? { invoiced: '1240000.00', collected: '985000.00', outstanding: '255000.00', unpaidCount: 212 }
            : null,
        });
      }

      case '/api/v1/academics/hierarchy': {
        const sectionId = url.searchParams.get('sectionId');
        const studentId = url.searchParams.get('studentId');

        if (studentId) {
          const st = DEMO_SECTION_F_ROSTER.find((r) => r.studentId === studentId)
            ?? DEMO_SECTION_F_ROSTER[0];
          return ok({
            student: {
              id: st.studentId, nameBn: st.nameBn, nameEn: null,
              studentCode: st.studentCode, admissionDate: '2024-01-05',
              lifecycleStatus: 'enrolled', bloodGroup: 'B+', status: 'active',
            },
            current: {
              yearLabel: '২০২৬', levelNo: 9, classBn: 'নবম শ্রেণি',
              groupBn: 'বিজ্ঞান', section: 'F', rollNo: st.rollNo, status: 'active',
            },
            history: [
              { yearLabel: '২০২৬', levelNo: 9, classBn: 'নবম শ্রেণি', groupBn: 'বিজ্ঞান',
                section: 'F', rollNo: st.rollNo, status: 'active', enrolledOn: '2026-01-05', endedOn: null },
              { yearLabel: '২০২৫', levelNo: 8, classBn: 'অষ্টম শ্রেণি', groupBn: 'সাধারণ',
                section: 'খ', rollNo: 12, status: 'promoted', enrolledOn: '2025-01-05', endedOn: '2025-12-20' },
            ],
            guardians: [
              { nameBn: 'মোঃ আব্দুল করিম', relation: 'father', isPrimary: true, canPayFees: true },
              { nameBn: 'রোকসানা বেগম', relation: 'mother', isPrimary: false, canPayFees: false },
            ],
            attendance90d: { present: 74, total: 80 },
          });
        }

        if (sectionId) {
          const sec = DEMO_SECTIONS_SCIENCE.find((x) => x.id === sectionId) ?? DEMO_SECTIONS_SCIENCE[5];
          const isF = sec.name === 'F';
          return ok({
            section: {
              id: sec.id, name: sec.name, shift: sec.shift, capacity: sec.capacity,
              studentCount: sec.studentCount, classId: 'demo-cls-9sci', levelNo: 9,
              classNameBn: 'নবম শ্রেণি', groupBn: 'বিজ্ঞান',
              yearId: 'demo-year', yearLabel: '২০২৬',
            },
            classTeacher: sec.classTeacher
              ? { ...sec.classTeacher, since: '2026-01-05' }
              : null,
            subjectTeachers: (isF ? R3_SUBJECTS : R3_SUBJECTS.slice(0, 4)).map((sub, i) => ({
              assignmentId: `demo-a-${sec.name}-${i}`,
              subject: sub,
              teacher: { id: DEMO_TEACHERS[i % 5].id, nameBn: DEMO_TEACHERS[i % 5].nameBn },
              startedOn: '2026-01-05',
            })),
            unassignedSubjects: isF ? [] : [R3_SUBJECTS[4]],
            roster: isF ? DEMO_SECTION_F_ROSTER : DEMO_SECTION_F_ROSTER.slice(0, sec.studentCount),
            // A replacement that already happened, so the preview shows what
            // migration 041 preserves rather than only describing it.
            history: isF
              ? [{ kind: 'subject_teacher', subjectBn: 'পদার্থবিজ্ঞান', teacherBn: 'জামাল স্যার',
                   startedOn: '2026-01-05', endedOn: '2026-03-15', endReason: 'বদলি হয়েছেন' }]
              : [],
          });
        }

        return ok({
          years: [
            { id: 'demo-year', label: '২০২৬', isCurrent: true },
            { id: 'demo-year-prev', label: '২০২৫', isCurrent: false },
          ],
          year: { id: 'demo-year', label: '২০২৬' },
          classes: [
            {
              levelNo: 9, nameBn: 'নবম শ্রেণি', nameEn: 'Class Nine',
              sectionCount: 8, studentCount: 289,
              groups: [
                { classId: 'demo-cls-9sci', group: 'science', groupBn: 'বিজ্ঞান',
                  sectionCount: 6, studentCount: 226, sections: DEMO_SECTIONS_SCIENCE },
                { classId: 'demo-cls-9hum', group: 'humanities', groupBn: 'মানবিক',
                  sectionCount: 1, studentCount: 34,
                  sections: [{ id: 'demo-sec-hum', name: 'ক', shift: 'morning', capacity: 60,
                               studentCount: 34, classTeacher: { id: 'demo-t3', nameBn: 'হাসান স্যার' },
                               subjectTeacherCount: 4 }] },
                { classId: 'demo-cls-9bus', group: 'business_studies', groupBn: 'ব্যবসায় শিক্ষা',
                  sectionCount: 1, studentCount: 29,
                  sections: [{ id: 'demo-sec-bus', name: 'ক', shift: 'morning', capacity: 60,
                               studentCount: 29, classTeacher: null, subjectTeacherCount: 3 }] },
              ],
            },
            {
              levelNo: 10, nameBn: 'দশম শ্রেণি', nameEn: 'Class Ten',
              sectionCount: 2, studentCount: 71,
              groups: [
                { classId: 'demo-cls-10sci', group: 'science', groupBn: 'বিজ্ঞান',
                  sectionCount: 2, studentCount: 71,
                  sections: [
                    { id: 'demo-sec-10a', name: 'ক', shift: 'morning', capacity: 60, studentCount: 36,
                      classTeacher: { id: 'demo-t4', nameBn: 'নাঈম স্যার' }, subjectTeacherCount: 5 },
                    { id: 'demo-sec-10b', name: 'খ', shift: 'morning', capacity: 60, studentCount: 35,
                      classTeacher: { id: 'demo-t5', nameBn: 'শুভ স্যার' }, subjectTeacherCount: 5 },
                  ] },
              ],
            },
          ],
        });
      }

      case '/api/v1/ops/assign': {
        if (init.method === 'POST') {
          const req = JSON.parse(String(init.body ?? '{}')) as
            { teacherId?: string; reason?: string; effectiveDate?: string };
          const t = DEMO_TEACHERS.find((x) => x.id === req.teacherId) ?? DEMO_TEACHERS[0];
          return ok({
            assignmentId: 'demo-new-assignment',
            replaced: req.reason ? { teacherId: 'demo-t1', nameBn: 'রহিম স্যার' } : null,
            unchanged: false,
            teacher: { id: t.id, nameBn: t.nameBn },
            effectiveDate: req.effectiveDate ?? '2026-05-01',
          });
        }
        return ok({
          subjects: R3_SUBJECTS.map((sub, i) => ({
            id: sub.id, nameBn: sub.nameBn,
            assigned: { id: DEMO_TEACHERS[i % 5].id, nameBn: DEMO_TEACHERS[i % 5].nameBn },
          })),
          teachers: DEMO_TEACHERS,
        });
      }

      case '/api/v1/ops/enrol': {
        const req = JSON.parse(String(init.body ?? '{}')) as
          { studentIds?: string[]; dryRun?: boolean };
        const ids = req.studentIds ?? [];
        return ok({
          section: { id: 'demo-sec-A', name: 'A', classBn: 'নবম শ্রেণি', group: 'science',
                     yearLabel: '২০২৬', capacity: 60, currentCount: 38,
                     countAfter: 38 + ids.length },
          moving: ids.map((id, i) => ({
            studentId: id,
            nameBn: DEMO_SECTION_F_ROSTER.find((r) => r.studentId === id)?.nameBn ?? id,
            from: { sectionId: 'demo-sec-F', section: 'F', classBn: 'নবম শ্রেণি', rollNo: i + 1 },
            toRollNo: 39 + i,
            isNewEnrolment: false,
          })),
          alreadyInSection: [], notFound: [],
          overCapacity: 38 + ids.length > 60,
          committed: req.dryRun === false,
        });
      }

      case '/api/v1/ops/rollover': {
        if (init.method === 'POST') {
          const req = JSON.parse(String(init.body ?? '{}')) as { rolloverId?: string };
          if (req.rolloverId) return ok({ committed: true, promoted: 168, repeated: 5, graduated: 4 });
          return ok({ rolloverId: 'demo-rollover', status: 'planned',
                      summary: { considered: 180, promote: 168, repeat: 5, graduate: 4, blocked: 3 } });
        }
        return ok({
          years: [
            { id: 'demo-year-next', label: '২০২৭', isCurrent: false },
            { id: 'demo-year', label: '২০২৬', isCurrent: true },
          ],
          needsTargetYear: false,
          fromYear: { id: 'demo-year', label: '২০২৬' },
          toYear: { id: 'demo-year-next', label: '২০২৭' },
          summary: { considered: 180, promote: 168, repeat: 5, graduate: 4, blocked: 3 },
          students: [
            ...DEMO_SECTION_F_ROSTER.slice(0, 8).map((r, i) => ({
              studentId: r.studentId, nameBn: r.nameBn, fromLevel: 9, fromSection: 'F',
              fromRoll: r.rollNo, action: 'promote', toLevel: 10, toSectionId: 'demo-sec-10a',
              toSection: 'ক', toRoll: i + 1, blockerBn: null,
            })),
            // The blocked case, by name and with a reason — the thing that
            // stops the commit and the thing a head teacher must resolve.
            { studentId: 'demo-s90', nameBn: 'শিক্ষার্থী ৯০', fromLevel: 9, fromSection: 'F',
              fromRoll: 41, action: 'blocked', toLevel: null, toSectionId: null,
              toSection: null, toRoll: null, blockerBn: 'দশম শ্রেণিতে কোনো সেকশন তৈরি হয়নি' },
          ],
          existing: null,
        });
      }

      case '/api/v1/ops/settings': {
        if (init.method === 'PUT') {
          const req = JSON.parse(String(init.body ?? '{}')) as
            { sms?: { noticeMaxChars?: number } };
          return ok({ sms: { noticeMaxChars: req.sms?.noticeMaxChars ?? 180,
                             default: 180, min: 70, max: 480, charsPerSegment: 70 } });
        }
        return ok({ sms: { noticeMaxChars: 180, default: 180, min: 70, max: 480, charsPerSegment: 70 } });
      }

      case '/api/v1/ops/users': {
        if (init.method === 'POST') {
          const req = JSON.parse(String(init.body ?? '{}')) as { nameBn?: string; roleCode?: string };
          return ok({ id: 'demo-new-user', nameBn: req.nameBn ?? 'নতুন', roleCode: req.roleCode, status: 'invited' });
        }
        if (init.method === 'PATCH') {
          const req = JSON.parse(String(init.body ?? '{}')) as { active?: boolean };
          return ok({ id: 'demo-t1', nameBn: 'রহিম স্যার', status: req.active ? 'active' : 'left' });
        }
        return ok({
          users: [
            ...DEMO_TEACHERS.map((t, i) => ({
              id: t.id, nameBn: t.nameBn, nameEn: null, phone: `+88017000000${i + 1}`,
              status: i === 4 ? 'left' : 'active',
              roles: [i === 0 ? 'class_teacher' : 'subject_teacher'],
              employeeCode: t.employeeCode, studentCode: null,
            })),
            { id: 'demo-it', nameBn: 'আইটি অ্যাডমিন', nameEn: null, phone: '+8801700000099',
              status: 'active', roles: ['it_admin'], employeeCode: 'T-001', studentCode: null },
          ],
          truncated: false, limit: 50,
        });
      }

      case '/api/v1/academics/publish': {
        if (init.method === 'POST') {
          return ok({ ok: true, examId: 'demo-exam1', marksGraded: 1180,
                      resultsPublished: 236, notified: 472 });
        }
        return ok({
          exams: [
            {
              examId: 'demo-exam1', examNameBn: 'অর্ধবার্ষিক পরীক্ষা', status: 'marking',
              startsOn: '2026-06-10', endsOn: '2026-06-20',
              subjects: R3_SUBJECTS.map((sub, i) => ({
                examSubjectId: `demo-es${i}`, subjectBn: sub.nameBn, sectionName: 'F',
                enrolled: 40, marked: i === 4 ? 31 : 40,
              })),
            },
            {
              examId: 'demo-exam0', examNameBn: 'প্রথম সাময়িক পরীক্ষা', status: 'published',
              startsOn: '2026-03-02', endsOn: '2026-03-12',
              subjects: R3_SUBJECTS.slice(0, 3).map((sub, i) => ({
                examSubjectId: `demo-es0${i}`, subjectBn: sub.nameBn, sectionName: 'F',
                enrolled: 40, marked: 40,
              })),
            },
          ],
        });
      }

      case '/api/v1/finance/generate':
        return ok({ ok: true, billingPeriod: '2026-05', invoiceCount: 236, notified: 198 });

      // ── R-4 ────────────────────────────────────────────────────────
      case '/api/v1/ops/calendar': {
        const tenant = DEMO_CALENDAR[demoTenantKey()];
        if (init.method === 'POST' || init.method === 'PATCH') {
          const req = JSON.parse(String(init.body ?? '{}')) as
            { titleBn?: string; notify?: boolean };
          return ok({ id: 'demo-cal-new', titleBn: req.titleBn,
                      notified: req.notify ? 1240 : 0 });
        }
        if (init.method === 'DELETE') return ok({ id: 'demo-cal-1', deleted: true });

        const from = url.searchParams.get('from') ?? '';
        const to = url.searchParams.get('to') ?? '';
        const kind = url.searchParams.get('kind') ?? '';
        const entries = tenant.entries
          .filter((e) => (!from || e.day >= from) && (!to || e.day <= to))
          .filter((e) => !kind || e.kind === kind);
        return ok({
          range: { from, to },
          weekendDays: tenant.weekendDays,
          shifts: demoTenantKey() === 'a' ? ['morning', 'day'] : ['single'],
          years: [
            { id: 'demo-year', label: '২০২৬', isCurrent: true,
              startsOn: '2026-01-01', endsOn: '2026-12-31' },
          ],
          currentYearId: 'demo-year',
          entries,
        });
      }

      // ── R-3 completion pass ────────────────────────────────────────
      case '/api/v1/ops/structure': {
        if (init.method === 'POST') {
          const req = JSON.parse(String(init.body ?? '{}')) as {
            kind?: string; label?: string; nameBn?: string; name?: string;
          };
          if (req.kind === 'year')  return ok({ id: 'demo-new-year', kind: 'year', label: req.label });
          if (req.kind === 'class') return ok({ id: 'demo-new-class', kind: 'class', nameBn: req.nameBn });
          return ok({ id: 'demo-new-section', kind: 'section', name: req.name,
                      classNameBn: 'নবম শ্রেণি', group: 'science' });
        }
        return ok({
          defaultStream: 'bangla_medium',
          years: [
            { id: 'demo-year', label: '২০২৬', isCurrent: true },
            { id: 'demo-year-prev', label: '২০২৫', isCurrent: false },
          ],
          classes: [
            { id: 'demo-cls-9sci', levelNo: 9, nameBn: 'নবম শ্রেণি', group: 'science' },
            { id: 'demo-cls-9hum', levelNo: 9, nameBn: 'নবম শ্রেণি', group: 'humanities' },
            { id: 'demo-cls-10sci', levelNo: 10, nameBn: 'দশম শ্রেণি', group: 'science' },
          ],
          streams: ['bangla_medium', 'english_version', 'english_medium', 'madrasah', 'technical'],
          groups: ['none', 'science', 'humanities', 'business_studies', 'vocational', 'general'],
          shifts: ['morning', 'day', 'evening', 'single'],
        });
      }

      case '/api/v1/ops/guardians': {
        if (init.method === 'POST') {
          const req = JSON.parse(String(init.body ?? '{}')) as { guardianId?: string; phone?: string };
          // The duplicate-guardian case, reproduced: this number is already
          // in the demo school, so a "create" links the existing person.
          const reused = !req.guardianId && (req.phone ?? '').includes('01700000011');
          return ok({ linkId: 'demo-link-new', guardianId: req.guardianId ?? 'demo-g1',
                      created: !req.guardianId && !reused, reusedExisting: reused });
        }
        if (init.method === 'PATCH') {
          const req = JSON.parse(String(init.body ?? '{}')) as { canPayFees?: boolean };
          demoGuardianPays = req.canPayFees ?? demoGuardianPays;
          return ok({ linkId: 'demo-link-1', guardianId: 'demo-g1', nameBn: 'মোঃ আব্দুল করিম',
                      relation: 'father', isPrimary: true, receivesSms: true,
                      canPayFees: demoGuardianPays,
                      feeNoticesChanged: req.canPayFees !== undefined });
        }
        if (url.searchParams.get('q')) {
          return ok({ candidates: [
            { id: 'demo-g1', nameBn: 'মোঃ আব্দুল করিম', phone: '+8801700000011', wardCount: 2 },
            { id: 'demo-g3', nameBn: 'করিমা বেগম', phone: '+8801700000013', wardCount: 0 },
          ] });
        }
        // The server withholds the phone from anyone who may not edit it;
        // the demo must not be the one place a teacher sees the school's
        // contact list.
        const mayEdit = ['principal', 'school_owner', 'it_admin'].includes(demoRole());
        return ok({
          student: { id: url.searchParams.get('studentId') ?? 'demo-s1', nameBn: 'শিক্ষার্থী ১' },
          guardians: [
            { linkId: 'demo-link-1', guardianId: 'demo-g1', nameBn: 'মোঃ আব্দুল করিম',
              phone: mayEdit ? '+8801700000011' : null, relation: 'father', isPrimary: true,
              receivesSms: true, canPayFees: demoGuardianPays, otherWards: 2 },
            { linkId: 'demo-link-2', guardianId: 'demo-g2', nameBn: 'রোকসানা বেগম',
              phone: mayEdit ? '+8801700000012' : null, relation: 'mother', isPrimary: false,
              receivesSms: true, canPayFees: false, otherWards: 0 },
          ],
        });
      }

      case '/api/v1/ops/audit': {
        const all = DEMO_AUDIT;
        const action = url.searchParams.get('action') ?? '';
        const entries = action ? all.filter((a) => a.action === action) : all;
        return ok({
          entries,
          hasMore: false,
          offset: 0,
          pageSize: 50,
          facets: {
            actions: [...new Set(all.map((a) => a.action))].map((v) => ({
              value: v, count: all.filter((a) => a.action === v).length,
            })),
            entityTypes: [...new Set(all.map((a) => a.entityType))].map((v) => ({
              value: v as string, count: all.filter((a) => a.entityType === v).length,
            })),
            actors: [{ id: 'demo-p1', nameBn: 'প্রধান শিক্ষক', count: all.length }],
          },
        });
      }

      // R-2. The inbox differs by ROLE, because that is the whole point: a
      // student must not see the staff-only notice. In the real product the
      // difference comes from which receipts exist; here it is filtered by
      // the same rule so the demo does not teach a falsehood.
      case '/api/v1/ops/inbox': {
        const mine = DEMO_NOTICES.filter((n) => n.roles.includes(demoRole()));
        if (url.searchParams.get('limit') === '1') {
          return ok({ unread: mine.filter((n) => !demoRead.has(n.noticeId)).length, notices: [] });
        }
        return ok({
          unread: mine.filter((n) => !demoRead.has(n.noticeId)).length,
          notices: mine.map((n) => ({
            receiptId: `r-${n.noticeId}`,
            noticeId: n.noticeId,
            title: n.title,
            body: n.body,
            category: n.category,
            deliveredAt: n.deliveredAt,
            readAt: demoRead.has(n.noticeId) ? new Date().toISOString() : null,
            aboutStudent: n.aboutStudent ?? null,
          })),
        });
      }

      case '/api/v1/ops/notices':
        // Publishing in demo mode reports a plausible reach and changes
        // nothing — no request leaves the device, so nothing can.
        return ok({ noticeId: 'demo-new', status: 'published', recipients: 42, smsQueued: false });

      case '/api/v1/academics/sections':
        return ok({ sections: SECTIONS });

      case '/api/v1/academics/roster':
        return ok({ roster: rosterFor(url.searchParams.get('sectionId') ?? 'demo') });

      case '/api/v1/academics/exams':
        return ok({ exams: DEMO_EXAMS });

      case '/api/v1/academics/marks':
        return ok(demoMarks());

      case '/api/v1/academics/assignments': {
        const aid = url.searchParams.get('assignmentId');
        if (aid) return ok(demoAssignmentDetail(aid));
        return ok({ assignments: DEMO_ASSIGNMENTS });
      }

      case '/api/v1/academics/attendance':
        return ok({ studentId: 'demo-s1', months: 6, ...DEMO_ATTENDANCE });

      case '/api/v1/academics/subjects':
        return ok({ studentId: 'demo-s1', subjects: R3_SUBJECTS });

      case '/api/v1/academics/next':
        return ok({ suggestions: DEMO_NEXT });

      case '/api/v1/academics/practice':
        return ok({ topicId: url.searchParams.get('topicId') ?? 'demo-l-3', questions: DEMO_PRACTICE });

      case '/api/v1/academics/results':
        return ok({ studentId: 'demo-s1', results: DEMO_RESULTS });

      case '/api/v1/academics/ward': {
        // §9.1's guardian home. The real endpoint bundles everything the
        // wireframe draws in one round trip, so the demo stub does too —
        // splitting the ward list from the per-student payload would let
        // a bug live where the two responses disagree and only prod
        // finds it. The switcher is offered even when there is only one
        // ward, deliberately: §9.1 calls the switcher "the single most-
        // used control", and a guardian with two children is who this
        // screen is really for.
        const WARDS = [
          { studentId: 'demo-s1', enrolmentId: 'demo-e1',
            nameBn: 'রাফির হাসান', sectionLabel: 'নবম–ক',
            rollNo: 7, relationBn: 'পিতা' },
          { studentId: 'demo-s2', enrolmentId: 'demo-e2',
            nameBn: 'তাহিয়া হাসান', sectionLabel: 'পঞ্চম–খ',
            rollNo: 3, relationBn: 'পিতা' },
        ];
        const wanted = url.searchParams.get('studentId');
        if (!wanted) return ok({ wards: WARDS, student: null });
        const ward = WARDS.find((w) => w.studentId === wanted);
        if (!ward) return new Response(
          JSON.stringify({ error: 'student_not_found' }),
          { status: 404, headers: { 'content-type': 'application/json' } });
        const HOMES: Record<string, {
          attendance: { todayStatus: string | null; monthPercent: number | null;
                        present: number; absent: number; late: number;
                        halfDay: number; excused: number };
          fees: { outstanding: number; earliestDue: string | null; overdueCount: number };
          result: { examNameBn: string; gpa: number | null;
                    rankInSection: number | null; sectionSize: number | null } | null;
        }> = {
          'demo-s1': {
            attendance: { todayStatus: 'present', monthPercent: 92,
                          present: 18, absent: 1, late: 1, halfDay: 0, excused: 0 },
            fees: { outstanding: 1500, earliestDue: '2026-08-25', overdueCount: 0 },
            result: { examNameBn: 'দ্বিতীয় সাময়িক', gpa: 4.42,
                      rankInSection: 7, sectionSize: 52 },
          },
          'demo-s2': {
            // Deliberately a second child in a very different state —
            // an absence today, a bill overdue, no result yet — so the
            // ward-switch actually changes the screen.
            attendance: { todayStatus: 'absent', monthPercent: 78,
                          present: 14, absent: 3, late: 2, halfDay: 1, excused: 0 },
            fees: { outstanding: 2750, earliestDue: '2026-08-05', overdueCount: 1 },
            result: null,
          },
        };
        return ok({ wards: WARDS, student: { ...ward, ...HOMES[wanted] } });
      }

      case '/api/v1/academics/chapters':
        return ok({ chapters: DEMO_CHAPTERS });

      case '/api/v1/academics/topics': {
        const topicId = url.searchParams.get('topicId');
        if (topicId) return ok(demoTopic(topicId));
        return ok({
          chapterId: url.searchParams.get('chapterId') ?? 'demo-ch-1',
          topics: DEMO_TOPICS,
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

      case '/api/v1/academics/classperf': {
        // §7.5. Shaped to exercise every branch the screen has: a component
        // under 50 so the low tone renders, two weak questions in one chapter
        // so the re-teach hint fires, and an attention list where one student
        // carries a single signal and another carries two — the case where a
        // severity ranking would be most tempting and is most wrong.
        if (!url.searchParams.get('examSubjectId')) {
          return ok({ choices: DEMO_PERF_CHOICES, analysis: null });
        }
        return ok({
          choices: DEMO_PERF_CHOICES,
          analysis: {
            header: { examSubjectId: 'es-1', label: 'নবম-ক · পদার্থবিজ্ঞান · ১ম সাময়িক' },
            coverage: { marked: 32, enrolled: 35, absent: 2 },
            components: [
              { key: 'mcq', labelBn: 'বহুনির্বাচনি', max: 25, average: 11.2, percent: 45 },
              { key: 'cq', labelBn: 'সৃজনশীল', max: 50, average: 33.5, percent: 67 },
              { key: 'practical', labelBn: 'ব্যবহারিক', max: 25, average: 19.0, percent: 76 },
            ],
            practice: {
              source: 'practice',
              questions: [
                { questionNo: 7, kind: 'mcq', stemBn: 'শব্দের বেগ কোন মাধ্যমে সবচেয়ে বেশি?',
                  chapterBn: 'অধ্যায় ৯: তরঙ্গ ও শব্দ', attempts: 28, wrongPercent: 72 },
                { questionNo: 12, kind: 'mcq', stemBn: 'তরঙ্গদৈর্ঘ্য ও কম্পাঙ্কের সম্পর্ক কী?',
                  chapterBn: 'অধ্যায় ৯: তরঙ্গ ও শব্দ', attempts: 26, wrongPercent: 58 },
                { questionNo: 4, kind: 'numeric', stemBn: '১২ মি/সে বেগে চলা বস্তুর গতিশক্তি নির্ণয় করো।',
                  chapterBn: 'অধ্যায় ৫: কাজ ও শক্তি', attempts: 24, wrongPercent: 51 },
              ],
              reteach: { chapterBn: 'অধ্যায় ৯: তরঙ্গ ও শব্দ', questionCount: 2 },
            },
            attention: [
              { studentId: 'demo-s4', nameBn: 'আনিকা রহমান', rollNo: 4,
                signals: ['গত ৩০ দিনে হাজিরা ৭২%', 'গত পরীক্ষার চেয়ে নম্বর ১৮% কম'] },
              { studentId: 'demo-s9', nameBn: 'তানভীর হোসেন', rollNo: 9,
                signals: ['টানা ৪ দিন অনুপস্থিত'] },
            ],
            thresholds: { attendanceFloorPercent: 80, streakDays: 3, markDropPoints: 15, windowDays: 30 },
          },
        });
      }

      case '/api/v1/academics/subjectchoice': {
        // §10.3. The demo student holds the science-group compulsories and
        // has already chosen Islam + higher maths, so the screen opens on a
        // real state rather than a blank one, and changing either choice
        // exercises the mandatory regeneration warning.
        if (init.method === 'POST') {
          const req = JSON.parse(String(init.body ?? '{}')) as { optionalSubjectId?: string | null };
          return ok({ ok: true, subjectCount: req.optionalSubjectId ? 9 : 8, invalidated: ['routine', 'content'] });
        }
        return ok({
          student: {
            // Roll 1, matching the demo roster's first student: the picker and
            // the header have to describe the same child or the demo teaches a
            // contradiction on its very first screen.
            id: 'demo-s1', nameBn: 'আরিফুল ইসলাম', rollNo: 1,
            classBn: 'নবম শ্রেণি', sectionName: 'ক', groupCode: 'science',
          },
          hasTemplate: true,
          derived: [
            { subjectId: 'sub-bn', nameBn: 'বাংলা', requirementType: 'compulsory' },
            { subjectId: 'sub-en', nameBn: 'ইংরেজি', requirementType: 'compulsory' },
            { subjectId: 'sub-ma', nameBn: 'গণিত', requirementType: 'compulsory' },
            { subjectId: 'sub-ph', nameBn: 'পদার্থবিজ্ঞান', requirementType: 'group_compulsory' },
            { subjectId: 'sub-ch', nameBn: 'রসায়ন', requirementType: 'group_compulsory' },
            { subjectId: 'sub-bi', nameBn: 'জীববিজ্ঞান', requirementType: 'group_compulsory' },
          ],
          religionOptions: [
            { subjectId: 'sub-isl', nameBn: 'ইসলাম ও নৈতিক শিক্ষা', variant: 'islam' },
            { subjectId: 'sub-hin', nameBn: 'হিন্দুধর্ম ও নৈতিক শিক্ষা', variant: 'hindu' },
            { subjectId: 'sub-bud', nameBn: 'বৌদ্ধধর্ম ও নৈতিক শিক্ষা', variant: 'buddhist' },
            { subjectId: 'sub-chr', nameBn: 'খ্রিস্টধর্ম ও নৈতিক শিক্ষা', variant: 'christian' },
          ],
          optionalOptions: [
            { subjectId: 'sub-hma', nameBn: 'উচ্চতর গণিত' },
            { subjectId: 'sub-agr', nameBn: 'কৃষিশিক্ষা' },
            { subjectId: 'sub-hom', nameBn: 'গার্হস্থ্য বিজ্ঞান' },
          ],
          current: {
            religionVariant: 'islam',
            religionSubjectId: 'sub-isl',
            optionalSubjectId: 'sub-hma',
          },
        });
      }

      case '/api/v1/rms/editor': {
        // §8.1's grid. The demo carries a deliberate mix: an unfilled cell, a
        // parallel religion block, a double practical, and a pinned slot —
        // the four states the editor has to render differently. Moves are
        // answered by the same conflict shape the real endpoint returns, so
        // the refusal path is demonstrable without a database.
        if (init.method === 'POST') {
          const req = JSON.parse(String(init.body ?? '{}')) as { action?: string; periodNo?: number };
          if (req.action === 'publish') return ok({ ok: true, unfilled: 1 });
          // Period 2 is where the demo's Rafiq is already teaching 9-খ, so
          // moving onto it shows the named refusal rather than a shrug.
          if (req.periodNo === 2) {
            return new Response(JSON.stringify({
              error: 'teacher_busy',
              message: 'রফিক ইসলাম তখন নবম-খ-তে গণিত পড়াচ্ছেন।',
              conflict: { subjectBn: 'গণিত', teacherName: 'রফিক ইসলাম', sectionLabel: 'নবম-খ' },
            }), { status: 409, headers: { 'content-type': 'application/json' } });
          }
          return ok({ ok: true, slotId: 'demo-slot-1' });
        }
        const mk = (id: string, dow: number, periodNo: number, subject: string,
                    teacher: string | null, room: string | null,
                    extra: Record<string, unknown> = {}) => ({
          id, dayOfWeek: dow, periodNo, subjectBn: subject, teacherName: teacher,
          roomName: room, isDouble: false, doubleGroupId: null, parallelPool: null,
          isPinned: false, rowVersion: 1, ...extra,
        });
        return ok({
          sectionId: 'demo-sec-1',
          routine: {
            id: 'demo-routine-1', nameBn: 'নিয়মিত রুটিন', shift: 'morning',
            status: 'draft', version: 2, publishedAt: null, editable: true,
            sectionLabel: 'নবম-ক',
          },
          periods: [
            { periodNo: 1, labelBn: 'পিরিয়ড ১', startsAt: '09:00', endsAt: '09:40', kind: 'teaching' },
            { periodNo: 2, labelBn: 'পিরিয়ড ২', startsAt: '09:45', endsAt: '10:25', kind: 'teaching' },
            { periodNo: 3, labelBn: 'বিরতি', startsAt: '10:25', endsAt: '10:50', kind: 'break' },
            { periodNo: 4, labelBn: 'পিরিয়ড ৩', startsAt: '10:50', endsAt: '11:30', kind: 'teaching' },
            { periodNo: 5, labelBn: 'পিরিয়ড ৪', startsAt: '11:35', endsAt: '12:15', kind: 'teaching' },
          ],
          slots: [
            mk('demo-slot-1', 0, 1, 'গণিত', 'রফিক ইসলাম', '১০৩'),
            mk('demo-slot-2', 1, 1, 'বাংলা', 'সালমা খাতুন', '১০৩'),
            mk('demo-slot-3', 2, 1, 'গণিত', 'রফিক ইসলাম', '১০৩'),
            mk('demo-slot-4', 3, 1, 'ইংরেজি', 'করিম উদ্দিন', '১০৩'),
            mk('demo-slot-5', 4, 1, 'পদার্থবিজ্ঞান', 'নাসরিন আক্তার', '১০৩'),
            mk('demo-slot-6', 0, 2, 'ধর্ম শিক্ষা', 'একাধিক', '৩টি কক্ষ', { parallelPool: 'religion' }),
            mk('demo-slot-7', 1, 2, 'রসায়ন', 'আমিনুল হক', '২০১'),
            mk('demo-slot-8', 2, 2, 'জীববিজ্ঞান', 'শিরিন আক্তার', '১০৩', { isPinned: true }),
            mk('demo-slot-9', 0, 4, 'পদার্থ ব্যবহারিক', 'নাসরিন আক্তার', 'ল্যাব ১',
               { isDouble: true, doubleGroupId: 'demo-dbl-1' }),
            mk('demo-slot-10', 1, 4, 'ইংরেজি', 'করিম উদ্দিন', '১০৩'),
            mk('demo-slot-11', 3, 4, 'রসায়ন', null, 'ল্যাব ২'),
            mk('demo-slot-12', 0, 5, 'বাংলা', 'সালমা খাতুন', '১০৩'),
          ],
        });
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
        const req = JSON.parse(String(init.body ?? '{}')) as { message?: string; classLevel?: number };
        // Demo alternates the two answer states on purpose. F-1302's whole
        // point is that a student can tell a textbook-grounded answer from
        // general knowledge, and a demo that only ever shows one of them
        // demonstrates neither. Question marks read as a curriculum lookup;
        // anything else falls through to the ungrounded state.
        const grounded = (req.message ?? '').includes('?') || (req.message ?? '').includes('？');
        return ok({
          ok: true,
          grounded,
          sources: grounded ? ['পদার্থবিজ্ঞান ৯ম-১০ম / অধ্যায় ৯ — তরঙ্গ ও শব্দ'] : [],
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

      // ── R-6 ────────────────────────────────────────────────────────
      // The role scoping is reproduced, not skipped. A demo where a
      // guardian's search returned the whole school would be teaching the
      // opposite of what the endpoint does, and §18's browser walk checks
      // exactly this: teacher → own sections, guardian → own children,
      // student → self.
      case '/api/v1/academics/students/search':
        return demoStudentSearch(url.searchParams);
      case '/api/v1/academics/students/history':
        return demoStudentHistory(url.searchParams);

      // ── R-5 ────────────────────────────────────────────────────────
      // The one demo endpoint that answers HTML rather than JSON, because
      // that is what the real one answers.
      //
      // It renders through the SAME builders and the SAME brandedDocumentSet
      // the server uses — a demo that mocked up a receipt with its own markup
      // would be showing a document the product cannot actually produce, and
      // would go stale the first time a template changed. What is faked here
      // is the data, not the renderer.
      //
      // Switching demo tenants (?tenant=b) switches the letterhead, the
      // colour and the head teacher's name, which is the whole feature made
      // visible without two servers. Both demo tenants leave watermarkUrl
      // and signatureUrl empty, so this preview also exercises the
      // degrade-don't-break path every day.
      case '/api/v1/ops/document':
        return demoDocument(url.searchParams);

      default:
        return new Response(JSON.stringify({ error: 'not_found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
    }
  }
}
