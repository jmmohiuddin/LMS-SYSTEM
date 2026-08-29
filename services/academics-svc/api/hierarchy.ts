/**
 * GET /api/v1/academics/hierarchy                — the whole tree, with counts
 * GET /api/v1/academics/hierarchy?sectionId=…    — one section, in full
 * GET /api/v1/academics/hierarchy?studentId=…    — one student, in full
 *
 * R-3 of docs/11-MASTER-PLAN.md, Parts C, L and M. The spine of the principal
 * and IT admin portals:
 *
 *     Academic year → Class 9 → Science → Section F → 40 students
 *
 * ── Why the tree is one request, not four ──────────────────────────────
 * A drill-down that fetches on every click is four round-trips to answer a
 * question the school asks fifty times a day, on a network where a round-trip
 * is measured in seconds. The whole structure of a school is small — a large
 * institution has perhaps 12 classes, 3 groups and 60 sections — so it fits in
 * one response and the drill-down becomes instant and works offline from cache.
 *
 * The rosters are NOT in it. Forty students × sixty sections is a different
 * order of magnitude, and it is also the part that carries names. The tree
 * carries counts; a roster is fetched when a person actually opens a section.
 *
 * ── `group` is a column on the class, not a level of its own ───────────
 * The owner's brief draws Class 9 → Science → F as three levels. The schema
 * has two: `classes` is UNIQUE (tenant, level_no, stream, group), so "Class 9
 * Science" and "Class 9 Arts" are two class rows that share a level_no. The
 * response therefore groups class rows by level_no and presents the groups
 * beneath — the tree the school pictures, over the schema that already exists.
 * No migration was needed for this, and inventing one would have created a
 * second way to say the same thing.
 *
 * ── Authorization is RLS, and this is not a way around it ──────────────
 * Every query runs in the caller's tenant context. A section id belonging to
 * another school returns 404 here for the same reason it returns zero rows
 * anywhere else: the row is not visible, so the section does not exist. There
 * is no tenant parameter to get wrong because there is no tenant parameter.
 *
 * The tree is readable by any staff member — a teacher looking up which
 * section a colleague has is not a privilege escalation, and `sections` is
 * already staff-readable. What R-3 gates is *writing*, in ops-svc/assign.ts.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sharedDb } from '../../../packages/server-core/src/db.ts';
import { corsHeaders, json, query, HttpError } from '../../../packages/server-core/src/http.ts';
import { authenticate, requireStaff } from '../../../packages/server-core/src/auth.ts';

interface ClassRow {
  class_id: string;
  level_no: number;
  name_bn: string;
  name_en: string;
  group: string;
  section_count: number;
  student_count: number;
}

interface SectionRow {
  section_id: string;
  class_id: string;
  name: string;
  shift: string;
  capacity: number;
  student_count: number;
  class_teacher_id: string | null;
  class_teacher_name: string | null;
  subject_teacher_count: number;
}

/** Bangla labels for the group enum — the tree is read in Bangla. */
const GROUP_BN: Record<string, string> = {
  none: 'সাধারণ',
  science: 'বিজ্ঞান',
  humanities: 'মানবিক',
  business_studies: 'ব্যবসায় শিক্ষা',
  vocational: 'ভোকেশনাল',
  general: 'সাধারণ',
};

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cors = corsHeaders([], 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  if (req.method !== 'GET') { json(res, 405, { error: 'method_not_allowed' }, cors); return; }

  try {
    const claims = await authenticate(req);
    // Structure is staff-wide reading. A student or guardian gets their own
    // views; handing them the institution's full org chart is a different
    // product and a small privacy leak (every teacher's name and posting).
    requireStaff(claims);

    const db = await sharedDb();
    const ctx = { tenantId: claims.tid, userId: claims.sub, role: claims.role };
    const q = query(req);
    const sectionId = q.get('sectionId');
    const studentId = q.get('studentId');

    if (sectionId) { json(res, 200, await sectionDetail(db, ctx, sectionId), cors); return; }
    if (studentId) { json(res, 200, await studentDetail(db, ctx, studentId), cors); return; }
    json(res, 200, await tree(db, ctx, q.get('yearId')), cors);
  } catch (err) {
    if (err instanceof HttpError) {
      json(res, err.status, { error: err.code, message: err.message }, cors);
      return;
    }
    json(res, 500, { error: 'internal_error' }, cors);
  }
}

// ── The tree ────────────────────────────────────────────────────────────

type Db = Awaited<ReturnType<typeof sharedDb>>;
type Ctx = { tenantId: string; userId: string; role: string };

async function tree(db: Db, ctx: Ctx, yearId: string | null) {
  return db.withTenant(ctx, async (c) => {
    const { rows: years } = await c.query<{ id: string; label: string; is_current: boolean }>(
      `SELECT id, label, is_current FROM academic_years ORDER BY starts_on DESC`,
    );
    // No academic year is the true day-one state of a tenant, not an error.
    // The screen says "set up a year first"; it does not show a spinner
    // forever or an exception.
    if (years.length === 0) return { years: [], year: null, classes: [] };

    const year = years.find((y) => y.id === yearId)
      ?? years.find((y) => y.is_current)
      ?? years[0];

    // Counts come from sections.student_count, which the enrolment trigger
    // (003) keeps honest — not from COUNT(*) over enrolments, which would be
    // a roster-sized scan to render a tree.
    const { rows: classes } = await c.query<ClassRow>(
      `SELECT cl.id                                    AS class_id,
              cl.level_no,
              cl.name_bn,
              cl.name_en,
              cl."group"::text                         AS "group",
              count(s.id)::int                         AS section_count,
              COALESCE(sum(s.student_count), 0)::int   AS student_count
         FROM classes cl
         LEFT JOIN sections s
                ON s.class_id = cl.id AND s.academic_year_id = $1
        GROUP BY cl.id, cl.level_no, cl.name_bn, cl.name_en, cl."group", cl.display_order
        ORDER BY cl.level_no, cl.display_order, cl."group"`,
      [year.id],
    );

    const { rows: sections } = await c.query<SectionRow>(
      `SELECT s.id                    AS section_id,
              s.class_id,
              s.name,
              s.shift::text           AS shift,
              s.capacity,
              s.student_count,
              s.class_teacher_id,
              ct.full_name_bn         AS class_teacher_name,
              (SELECT count(*)::int
                 FROM section_subject_teachers sst
                WHERE sst.section_id = s.id
                  AND sst.ended_on IS NULL) AS subject_teacher_count
         FROM sections s
         LEFT JOIN users ct ON ct.id = s.class_teacher_id
        WHERE s.academic_year_id = $1
        ORDER BY s.name`,
      [year.id],
    );

    // Fold the flat class rows into the level → group shape the school draws.
    const byLevel = new Map<number, {
      levelNo: number; nameBn: string; nameEn: string;
      sectionCount: number; studentCount: number;
      groups: {
        classId: string; group: string; groupBn: string;
        sectionCount: number; studentCount: number;
        sections: {
          id: string; name: string; shift: string; capacity: number;
          studentCount: number;
          classTeacher: { id: string; nameBn: string } | null;
          subjectTeacherCount: number;
        }[];
      }[];
    }>();

    for (const cl of classes) {
      const level = byLevel.get(cl.level_no) ?? {
        levelNo: cl.level_no,
        nameBn: cl.name_bn,
        nameEn: cl.name_en,
        sectionCount: 0,
        studentCount: 0,
        groups: [],
      };
      level.sectionCount += cl.section_count;
      level.studentCount += cl.student_count;
      level.groups.push({
        classId: cl.class_id,
        group: cl.group,
        groupBn: GROUP_BN[cl.group] ?? cl.group,
        sectionCount: cl.section_count,
        studentCount: cl.student_count,
        sections: sections
          .filter((s) => s.class_id === cl.class_id)
          .map((s) => ({
            id: s.section_id,
            name: s.name,
            shift: s.shift,
            capacity: s.capacity,
            studentCount: s.student_count,
            classTeacher: s.class_teacher_id
              ? { id: s.class_teacher_id, nameBn: s.class_teacher_name ?? '' }
              : null,
            subjectTeacherCount: s.subject_teacher_count,
          })),
      });
      byLevel.set(cl.level_no, level);
    }

    return {
      years: years.map((y) => ({ id: y.id, label: y.label, isCurrent: y.is_current })),
      year: { id: year.id, label: year.label, isCurrent: year.is_current },
      classes: [...byLevel.values()].sort((a, b) => a.levelNo - b.levelNo),
    };
  });
}

// ── One section, in full ────────────────────────────────────────────────

async function sectionDetail(db: Db, ctx: Ctx, sectionId: string) {
  return db.withTenant(ctx, async (c) => {
    const { rows: head } = await c.query<{
      id: string; name: string; shift: string; capacity: number;
      student_count: number; class_id: string; level_no: number;
      class_name_bn: string; group: string; year_id: string; year_label: string;
      class_teacher_id: string | null; class_teacher_name: string | null;
      class_teacher_since: string | null;
    }>(
      `SELECT s.id, s.name, s.shift::text AS shift, s.capacity, s.student_count,
              cl.id AS class_id, cl.level_no, cl.name_bn AS class_name_bn,
              cl."group"::text AS "group",
              ay.id AS year_id, ay.label AS year_label,
              s.class_teacher_id, ct.full_name_bn AS class_teacher_name,
              cta.started_on::text AS class_teacher_since
         FROM sections s
         JOIN classes cl        ON cl.id = s.class_id
         JOIN academic_years ay ON ay.id = s.academic_year_id
         LEFT JOIN users ct     ON ct.id = s.class_teacher_id
         LEFT JOIN class_teacher_assignments cta
                ON cta.section_id = s.id AND cta.ended_on IS NULL
        WHERE s.id = $1`,
      [sectionId],
    );
    // Invisible and absent are the same answer, deliberately: a section id
    // from another school must not be distinguishable from a typo.
    if (head.length === 0) throw new HttpError(404, 'section not found', 'not_found');
    const s = head[0];

    const { rows: subjectTeachers } = await c.query<{
      assignment_id: string; subject_id: string; subject_bn: string;
      subject_en: string; teacher_id: string; teacher_bn: string;
      started_on: string;
    }>(
      `SELECT sst.id AS assignment_id, sub.id AS subject_id,
              sub.name_bn AS subject_bn, sub.name_en AS subject_en,
              t.id AS teacher_id, t.full_name_bn AS teacher_bn,
              sst.started_on::text AS started_on
         FROM section_subject_teachers sst
         JOIN subjects sub ON sub.id = sst.subject_id
         JOIN users    t   ON t.id   = sst.teacher_id
        WHERE sst.section_id = $1 AND sst.ended_on IS NULL
        ORDER BY sub.name_bn`,
      [sectionId],
    );

    // Subjects the class studies that nobody is assigned to teach. This is
    // the single most useful thing this screen can tell a principal in
    // January, and it is invisible in a list of who IS assigned.
    const { rows: unassigned } = await c.query<{ subject_id: string; subject_bn: string }>(
      `SELECT sub.id AS subject_id, sub.name_bn AS subject_bn
         FROM class_subjects cs
         JOIN subjects sub ON sub.id = cs.subject_id
        WHERE cs.class_id = $1
          AND cs.academic_year_id = $2
          AND NOT EXISTS (
                SELECT 1 FROM section_subject_teachers sst
                 WHERE sst.section_id = $3
                   AND sst.subject_id = cs.subject_id
                   AND sst.ended_on IS NULL)
        ORDER BY sub.name_bn`,
      [s.class_id, s.year_id, sectionId],
    );

    const { rows: roster } = await c.query<{
      student_id: string; roll_no: number; name_bn: string;
      student_code: string; status: string;
    }>(
      `SELECT e.student_id, e.roll_no, u.full_name_bn AS name_bn,
              sp.student_code, e.status
         FROM enrolments e
         JOIN users u             ON u.id = e.student_id
         LEFT JOIN student_profiles sp ON sp.user_id = e.student_id
        WHERE e.section_id = $1 AND e.status = 'active'
        ORDER BY e.roll_no`,
      [sectionId],
    );

    // The replacement record. Closed rows only — the open ones are above.
    const { rows: history } = await c.query<{
      kind: string; subject_bn: string | null; teacher_bn: string;
      started_on: string; ended_on: string; end_reason: string;
    }>(
      `SELECT 'class_teacher' AS kind, NULL::text AS subject_bn,
              u.full_name_bn AS teacher_bn,
              cta.started_on::text, cta.ended_on::text, cta.end_reason
         FROM class_teacher_assignments cta
         JOIN users u ON u.id = cta.teacher_id
        WHERE cta.section_id = $1 AND cta.ended_on IS NOT NULL
        UNION ALL
       SELECT 'subject_teacher', sub.name_bn, u.full_name_bn,
              sst.started_on::text, sst.ended_on::text, sst.end_reason
         FROM section_subject_teachers sst
         JOIN users u      ON u.id   = sst.teacher_id
         JOIN subjects sub ON sub.id = sst.subject_id
        WHERE sst.section_id = $1 AND sst.ended_on IS NOT NULL
        ORDER BY ended_on DESC
        LIMIT 50`,
      [sectionId],
    );

    return {
      section: {
        id: s.id,
        name: s.name,
        shift: s.shift,
        capacity: s.capacity,
        studentCount: s.student_count,
        classId: s.class_id,
        levelNo: s.level_no,
        classNameBn: s.class_name_bn,
        group: s.group,
        groupBn: GROUP_BN[s.group] ?? s.group,
        yearId: s.year_id,
        yearLabel: s.year_label,
      },
      classTeacher: s.class_teacher_id
        ? { id: s.class_teacher_id, nameBn: s.class_teacher_name ?? '', since: s.class_teacher_since }
        : null,
      subjectTeachers: subjectTeachers.map((r) => ({
        assignmentId: r.assignment_id,
        subject: { id: r.subject_id, nameBn: r.subject_bn, nameEn: r.subject_en },
        teacher: { id: r.teacher_id, nameBn: r.teacher_bn },
        startedOn: r.started_on,
      })),
      unassignedSubjects: unassigned.map((r) => ({ id: r.subject_id, nameBn: r.subject_bn })),
      roster: roster.map((r) => ({
        studentId: r.student_id,
        rollNo: r.roll_no,
        nameBn: r.name_bn,
        studentCode: r.student_code,
        status: r.status,
      })),
      history: history.map((h) => ({
        kind: h.kind,
        subjectBn: h.subject_bn,
        teacherBn: h.teacher_bn,
        startedOn: h.started_on,
        endedOn: h.ended_on,
        endReason: h.end_reason,
      })),
    };
  });
}

// ── One student, in full ────────────────────────────────────────────────

async function studentDetail(db: Db, ctx: Ctx, studentId: string) {
  return db.withTenant(ctx, async (c) => {
    const { rows: head } = await c.query<{
      id: string; name_bn: string; name_en: string | null;
      student_code: string | null; admission_date: string | null;
      lifecycle_status: string | null; blood_group: string | null;
      status: string;
    }>(
      `SELECT u.id, u.full_name_bn AS name_bn, u.full_name_en AS name_en,
              sp.student_code, sp.admission_date::text AS admission_date,
              sp.lifecycle_status, sp.blood_group, u.status::text AS status
         FROM users u
         LEFT JOIN student_profiles sp ON sp.user_id = u.id
        WHERE u.id = $1`,
      [studentId],
    );
    if (head.length === 0) throw new HttpError(404, 'student not found', 'not_found');
    const u = head[0];

    // Every year the student has been enrolled, newest first. This is the
    // ten-year history the owner's brief asks for, and the reason enrolment
    // rows are never overwritten.
    const { rows: enrolments } = await c.query<{
      year_label: string; level_no: number; class_bn: string; group: string;
      section: string; roll_no: number; status: string;
      enrolled_on: string; ended_on: string | null;
    }>(
      `SELECT ay.label AS year_label, cl.level_no, cl.name_bn AS class_bn,
              cl."group"::text AS "group", s.name AS section, e.roll_no,
              e.status, e.enrolled_on::text, e.ended_on::text
         FROM enrolments e
         JOIN sections s        ON s.id  = e.section_id
         JOIN classes  cl       ON cl.id = s.class_id
         JOIN academic_years ay ON ay.id = e.academic_year_id
        WHERE e.student_id = $1
        ORDER BY ay.starts_on DESC`,
      [studentId],
    );

    // Guardians: name and relationship only. A section screen does not need
    // a parent's phone number on it, and putting it there would print it on
    // every teacher's device that ever opened the class.
    const { rows: guardians } = await c.query<{
      name_bn: string; relation: string; is_primary: boolean; can_pay: boolean;
    }>(
      `SELECT g.full_name_bn AS name_bn, gs.relation,
              gs.is_primary, gs.can_pay_fees AS can_pay
         FROM guardianships gs
         JOIN users g ON g.id = gs.guardian_id
        WHERE gs.student_id = $1
        ORDER BY gs.is_primary DESC`,
      [studentId],
    );

    const { rows: att } = await c.query<{ present: number; total: number }>(
      // 'late' and 'half_day' count as attended: a child who arrived is not
      // absent, and a 90-day figure that says otherwise would have a teacher
      // chasing a guardian about a child who was in the room.
      `SELECT count(*) FILTER (WHERE ar.status IN ('present','late','half_day'))::int AS present,
              count(*)::int AS total
         FROM attendance_records ar
        WHERE ar.student_id = $1
          AND ar.taken_on >= CURRENT_DATE - INTERVAL '90 days'`,
      [studentId],
    );

    return {
      student: {
        id: u.id,
        nameBn: u.name_bn,
        nameEn: u.name_en,
        studentCode: u.student_code,
        admissionDate: u.admission_date,
        lifecycleStatus: u.lifecycle_status,
        bloodGroup: u.blood_group,
        status: u.status,
      },
      current: enrolments[0]
        ? {
            yearLabel: enrolments[0].year_label,
            levelNo: enrolments[0].level_no,
            classBn: enrolments[0].class_bn,
            group: enrolments[0].group,
            groupBn: GROUP_BN[enrolments[0].group] ?? enrolments[0].group,
            section: enrolments[0].section,
            rollNo: enrolments[0].roll_no,
            status: enrolments[0].status,
          }
        : null,
      history: enrolments.map((e) => ({
        yearLabel: e.year_label,
        levelNo: e.level_no,
        classBn: e.class_bn,
        groupBn: GROUP_BN[e.group] ?? e.group,
        section: e.section,
        rollNo: e.roll_no,
        status: e.status,
        enrolledOn: e.enrolled_on,
        endedOn: e.ended_on,
      })),
      guardians: guardians.map((g) => ({
        nameBn: g.name_bn,
        relation: g.relation,
        isPrimary: g.is_primary,
        canPayFees: g.can_pay,
      })),
      attendance90d: {
        present: att[0]?.present ?? 0,
        total: att[0]?.total ?? 0,
      },
    };
  });
}
