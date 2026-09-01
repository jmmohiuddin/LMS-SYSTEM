/**
 * ফলাফল প্রকাশ — the result-publishing workflow  (R-3, Part H)
 *
 * `POST /api/v1/academics/publish` has existed since the assessment phase and
 * had **no caller anywhere in the app**. D13's audit found it: `results-view`
 * reads published results, and nothing in the product published them. Which
 * also meant R-2's results auto-notice could only fire from an API client.
 * This is the missing screen.
 *
 * ── Publishing is not a button, it is a review ─────────────────────────
 *     পরীক্ষা → ফলাফল → যাচাই → প্রকাশ → নিশ্চিতকরণ
 *
 * Because publication is irreversible in a way most mutations are not: the
 * `block_published_mark_update` trigger makes every mark immutable afterwards,
 * and corrections then require an approved `mark_corrections` row. A school
 * that publishes with three subjects unmarked has not made a mistake it can
 * quietly fix.
 *
 * So the screen shows completeness BEFORE the button, per subject, and the
 * confirmation names what is missing rather than asking "are you sure?".
 *
 * ── It does not compute anything ───────────────────────────────────────
 * Grades, GPA, ranks and the guardian notice all happen inside the endpoint's
 * single transaction, using the board-rule functions from migration 005. This
 * view sends an exam id and reports what came back. Recomputing a GPA here to
 * show a preview would be a second implementation of the board's rules, and
 * the two would disagree on the child whose result was borderline.
 */
import type { Auth } from './auth.ts';
import {
  skeleton, errorState, emptyState, successNote, confirmDialog, bnNum,
} from './view-states.ts';
import {
  pageHeader, sectionHeading, card, button, buttonRow, dataTable, statusBadge,
  append,
} from './ui/index.ts';

interface ExamRow {
  examId: string;
  examNameBn: string;
  status: string;
  startsOn: string | null;
  endsOn: string | null;
  subjects: {
    examSubjectId: string; subjectBn: string; sectionName: string | null;
    enrolled: number; marked: number;
  }[];
}

export interface PublishViewOptions {
  root: HTMLElement;
  doc: Document;
  auth: Auth;
}

export class PublishView {
  private readonly o: PublishViewOptions;
  private exams: ExamRow[] = [];
  private loading = true;
  private error = '';
  private notice = '';
  private busy = '';
  private expanded = new Set<string>();

  constructor(options: PublishViewOptions) {
    this.o = options;
    this.render();
    void this.load();
  }

  private async load(): Promise<void> {
    this.loading = true; this.error = ''; this.render();
    try {
      // GET on the publish endpoint itself — publication readiness lives
      // with publication, not with the section-scoped marks-entry read.
      const res = await this.o.auth.authedFetch('/api/v1/academics/publish');
      if (res.status === 403) { this.error = 'ফলাফল প্রকাশের অনুমতি আপনার নেই।'; return; }
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { exams?: ExamRow[] };
      this.exams = body.exams ?? [];
    } catch {
      this.error = 'পরীক্ষার তালিকা আনা যায়নি — সংযোগ পেলে আবার দেখা যাবে।';
    } finally {
      this.loading = false; this.render();
    }
  }

  private async publish(exam: ExamRow): Promise<void> {
    this.busy = exam.examId; this.error = ''; this.render();
    try {
      const res = await this.o.auth.authedFetch('/api/v1/academics/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ examId: exam.examId }),
      });
      const body = await res.json() as {
        resultsPublished?: number; notified?: number; message?: string; error?: string;
      };
      if (!res.ok) {
        this.error = body.error === 'already_published'
          ? 'এই পরীক্ষার ফলাফল ইতিমধ্যে প্রকাশিত।'
          : body.message ?? 'ফলাফল প্রকাশ করা যায়নি।';
        return;
      }
      // Naming the notified count matters: it is the visible proof that R-2's
      // machinery ran, and it is the number a head teacher will be asked
      // about when a guardian says they were not told.
      this.notice =
        `${bnNum(body.resultsPublished ?? 0)} জনের ফলাফল প্রকাশিত হয়েছে` +
        (body.notified ? ` · ${bnNum(body.notified)} জনকে জানানো হয়েছে।` : '।');
      await this.load();
    } catch {
      this.error = 'সংযোগ নেই — ফলাফল প্রকাশ করা যায়নি।';
    } finally {
      this.busy = ''; this.render();
    }
  }

  private render(): void {
    const d = this.o.doc;
    const root = this.o.root;
    root.textContent = '';

    const header = pageHeader(d, {
      title: 'ফলাফল প্রকাশ',
      subtitle: 'প্রকাশের পর নম্বর আর পরিবর্তন করা যায় না।',
    });
    root.append(header);

    if (this.notice) root.append(successNote(d, this.notice));
    if (this.error) {
      root.append(errorState(d, this.error,
        this.error.includes('অনুমতি') ? undefined : () => void this.load()));
    }
    if (this.loading) { root.append(skeleton(d, 3)); return; }

    const pending = this.exams.filter((e) => e.status !== 'published');
    const published = this.exams.filter((e) => e.status === 'published');

    if (this.exams.length === 0) {
      root.append(emptyState(d, {
        message: 'এই শিক্ষাবর্ষে কোনো পরীক্ষা তৈরি হয়নি। পরীক্ষা ও নম্বর যোগ হলে এখানে প্রকাশ করা যাবে।',
      }));
      return;
    }

    if (pending.length === 0) {
      root.append(emptyState(d, { message: 'প্রকাশের অপেক্ষায় কোনো পরীক্ষা নেই।' }));
    }
    for (const e of pending) root.append(this.examCard(e));

    if (published.length > 0) {
      root.append(sectionHeading(d, { title: 'প্রকাশিত' }));
      for (const e of published) root.append(this.examCard(e));
    }
  }

  private examCard(exam: ExamRow): HTMLElement {
    const d = this.o.doc;
    const isPublished = exam.status === 'published';
    const totalEnrolled = exam.subjects.reduce((n, s) => n + s.enrolled, 0);
    const totalMarked = exam.subjects.reduce((n, s) => n + s.marked, 0);
    const incomplete = exam.subjects.filter((s) => s.marked < s.enrolled);
    const open = this.expanded.has(exam.examId);

    // The state as a badge in the card's own header row, so "৩ বিষয়ে নম্বর
    // বাকি" sits beside the exam it is about rather than under it.
    const state = isPublished
      ? statusBadge(d, { state: 'published', label: 'প্রকাশিত' })
      : incomplete.length > 0
        ? statusBadge(d, { state: 'partial', label: `${bnNum(incomplete.length)} বিষয়ে নম্বর বাকি` })
        : statusBadge(d, { state: 'pending', label: 'প্রকাশের জন্য প্রস্তুত' });

    const host = card(d, {
      title: exam.examNameBn,
      subtitle: `${bnNum(exam.subjects.length)} বিষয় · নম্বর দেওয়া হয়েছে ` +
                `${bnNum(totalMarked)} / ${bnNum(totalEnrolled)}`,
      glyph: 'award',
      tone: isPublished ? 'success' : incomplete.length > 0 ? 'warn' : 'primary',
      action: state,
      headingLevel: 3,
    });

    // Per-subject completeness. This is the "validate" step of the workflow,
    // and it has to be visible BEFORE the button, not reported after it.
    const toggle = button(d, {
      label: open ? 'বিষয়ভিত্তিক অবস্থা লুকান' : 'বিষয়ভিত্তিক অবস্থা দেখুন',
      variant: 'ghost', size: 'sm',
      attrs: { 'aria-expanded': String(open) },
      onClick: () => {
        if (open) this.expanded.delete(exam.examId); else this.expanded.add(exam.examId);
        this.render();
      },
    });
    append(host, toggle);

    if (open) {
      append(host, dataTable(d, {
        caption: `${exam.examNameBn} — বিষয়ভিত্তিক অবস্থা`,
        rows: exam.subjects,
        rowKey: (sub) => `${sub.subjectBn}-${sub.sectionName ?? ''}`,
        empty: { message: 'এই পরীক্ষায় কোনো বিষয় যুক্ত করা হয়নি।' },
        columns: [
          { key: 'subject', header: 'বিষয়', mobile: 'title',
            cell: (sub) => sub.subjectBn, width: 'minmax(0, 2fr)' },
          { key: 'section', header: 'সেকশন', mobile: 'subtitle',
            cell: (sub) => sub.sectionName || '—', width: 'minmax(0, 1fr)' },
          { key: 'done', header: 'নম্বর দেওয়া', mobile: 'meta', numeric: true,
            cell: (sub) => `${bnNum(sub.marked)} / ${bnNum(sub.enrolled)}`,
            width: 'minmax(0, 1.2fr)' },
          { key: 'state', header: 'অবস্থা', mobile: 'status', width: '130px',
            cell: (sub) => (sub.marked < sub.enrolled
              ? statusBadge(d, { state: 'partial', label: 'অসম্পূর্ণ' })
              : statusBadge(d, { state: 'published', label: 'সম্পূর্ণ' })) },
        ],
      }));
    }

    if (!isPublished) {
      append(host, buttonRow(d, button(d, {
        label: 'ফলাফল প্রকাশ করুন',
        variant: 'primary',
        busy: this.busy === exam.examId,
        onClick: () => {
          host.append(confirmDialog({
            doc: d,
            title: 'ফলাফল প্রকাশ নিশ্চিত করুন',
            // The consequence, in numbers, including the part that is wrong.
            body:
              `${exam.examNameBn} — ${bnNum(totalMarked)} টি নম্বর প্রকাশিত হবে। ` +
              (incomplete.length > 0
                ? `${bnNum(incomplete.length)} টি বিষয়ে এখনো নম্বর সম্পূর্ণ হয়নি। `
                : '') +
              'প্রকাশের পর নম্বর আর সম্পাদনা করা যাবে না, এবং শিক্ষার্থী ও অভিভাবকদের জানানো হবে।',
            confirmLabel: 'প্রকাশ করুন',
            danger: true,
            onConfirm: () => void this.publish(exam),
          }));
        },
      })));
    }

    return host;
  }
}
