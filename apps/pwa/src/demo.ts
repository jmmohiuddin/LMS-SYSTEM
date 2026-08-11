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

function inDays(n: number): string {
  return new Date(Date.now() + n * 86400000).toISOString();
}

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

export class DemoAuth extends Auth {
  constructor() {
    super({ apiBase: '', deviceId: 'demo-device' });
  }

  override isLoggedIn(): boolean { return true; }
  override get tenantId(): string { return 'demo-tenant'; }
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
    };
    return label[this.role] ?? 'ডেমো (নমুনা তথ্য)';
  }

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

      case '/api/v1/academics/assignments': {
        const aid = url.searchParams.get('assignmentId');
        if (aid) return ok(demoAssignmentDetail(aid));
        return ok({ assignments: DEMO_ASSIGNMENTS });
      }

      case '/api/v1/academics/attendance':
        return ok({ studentId: 'demo-s1', months: 6, ...DEMO_ATTENDANCE });

      case '/api/v1/academics/subjects':
        return ok({ studentId: 'demo-s1', subjects: DEMO_SUBJECTS });

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

      default:
        return new Response(JSON.stringify({ error: 'not_found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
    }
  }
}
