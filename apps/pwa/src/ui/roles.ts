/**
 * Role names in Bangla — the tenant app's one copy. (P1)
 *
 * There were three inside this app before the shell needed a fourth: the user
 * list, the audit log, and (differing on two labels) the platform console.
 * The audit log's was a seven-role subset, so a `dept_head` row rendered the
 * raw `dept_head` to a head teacher reading who changed what.
 *
 * The platform console keeps its own deliberately — it is a different surface
 * with a different audience, it calls `school_owner` "পরিচালক" where a school
 * says "প্রতিষ্ঠান মালিক", and D11 keeps the two vocabularies apart.
 */
export const ROLE_BN: Record<string, string> = {
  school_owner: 'প্রতিষ্ঠান মালিক',
  principal: 'প্রধান শিক্ষক',
  academic_coordinator: 'একাডেমিক সমন্বয়কারী',
  dept_head: 'বিভাগীয় প্রধান',
  accountant: 'হিসাবরক্ষক',
  class_teacher: 'শ্রেণি শিক্ষক',
  subject_teacher: 'বিষয় শিক্ষক',
  librarian: 'গ্রন্থাগারিক',
  it_admin: 'আইটি অ্যাডমিন',
  student: 'শিক্ষার্থী',
  guardian: 'অভিভাবক',
};

/**
 * A role's Bangla name, falling back to the raw code.
 *
 * The fallback is the code and not an empty string on purpose: an unknown
 * role in the profile menu should read as something a support call can
 * repeat, not as a blank where a job title belongs.
 */
export function roleLabel(code: string): string {
  return ROLE_BN[code] ?? code;
}
