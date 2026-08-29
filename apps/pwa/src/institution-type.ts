/**
 * What KIND of institution is this?  (R-7 completion)
 *
 * The four types the product supports — School, College, Madrasa, School &
 * College — are not a column. They are already implied by two columns that
 * have existed since migration 001:
 *
 *     tenants.stream   the medium: bangla_medium · english_version ·
 *                      english_medium · madrasah · technical
 *     tenants.level    primary · junior_secondary · secondary ·
 *                      higher_secondary · combined
 *
 * so this derives the type rather than storing it. A third column would be a
 * second source of truth for a fact the first two already carry, and the two
 * would disagree the first time somebody changed a level.
 *
 * ── The bug this exists to fix ─────────────────────────────────────────
 * The console labelled the STREAM field "প্রতিষ্ঠানের ধরন" — institution type
 * — and printed the stream in the list's ধরন column. But a stream is a
 * teaching medium, not a type. The consequence was on the screen the whole
 * time: মোহাম্মদপুর কলেজ, onboarded through the wizard, was stored as
 * `stream=madrasah, level=combined` and listed as **মাদ্রাসা**. A college
 * displayed as a madrasa, because the operator was asked for a type and
 * offered a list of mediums.
 *
 * An operator should not have to know that "College" is spelled
 * `level=higher_secondary`.
 */

export type InstitutionType = 'school' | 'college' | 'madrasa' | 'school_college';

export const INSTITUTION_TYPE_BN: Record<InstitutionType, string> = {
  school: 'বিদ্যালয়',
  college: 'কলেজ',
  madrasa: 'মাদ্রাসা',
  school_college: 'স্কুল ও কলেজ',
};

/**
 * The type a school already stored is, read back from what it stored.
 *
 * Order matters and is a product decision, not an arbitrary one: a madrasah
 * that teaches through class 12 is still a **madrasa**, because that is what
 * the institution calls itself and what its board is. The medium wins over the
 * level for that one stream and only that one.
 */
export function institutionTypeOf(stream: string, level: string): InstitutionType {
  if (stream === 'madrasah') return 'madrasa';
  if (level === 'combined') return 'school_college';
  if (level === 'higher_secondary') return 'college';
  return 'school';
}

/** The label the console shows, from the two columns the API returns. */
export function institutionTypeLabel(stream: string, level: string): string {
  return INSTITUTION_TYPE_BN[institutionTypeOf(stream, level)];
}

/**
 * Which levels a type may have, and which one to offer first.
 *
 * A College is `higher_secondary` and nothing else — classes 11 and 12 are
 * what makes it a college. A School may be primary, junior secondary or
 * secondary, and most Bangladeshi schools onboarded here are secondary. A
 * Madrasa spans the same range as a school plus the combined case, because
 * `stream=madrasah` is what makes it a madrasa and its level is a separate
 * question (ইবতেদায়ি through আলিম).
 */
export const LEVELS_FOR_TYPE: Record<InstitutionType, readonly string[]> = {
  school: ['primary', 'junior_secondary', 'secondary'],
  college: ['higher_secondary'],
  madrasa: ['primary', 'junior_secondary', 'secondary', 'higher_secondary', 'combined'],
  school_college: ['combined'],
};

/**
 * Which mediums a type may have.
 *
 * `madrasah` is a medium AND what defines the madrasa type, so it appears for
 * that type and for no other: offering "madrasah medium" under School would
 * let an operator build a school that this module would then read back as a
 * madrasa, which is exactly the confusion being removed.
 */
export const STREAMS_FOR_TYPE: Record<InstitutionType, readonly string[]> = {
  school: ['bangla_medium', 'english_version', 'english_medium', 'technical'],
  college: ['bangla_medium', 'english_version', 'english_medium', 'technical'],
  madrasa: ['madrasah'],
  school_college: ['bangla_medium', 'english_version', 'english_medium', 'technical'],
};

/**
 * What the wizard should store when an operator picks a type.
 *
 * `preferred` lets an in-progress draft keep a compatible choice rather than
 * being reset every time the type is touched — an operator who selected
 * "ইংরেজি মাধ্যম" and then corrected School to College should not lose it.
 */
export function defaultsForType(
  type: InstitutionType,
  preferred: { stream?: string; level?: string } = {},
): { stream: string; level: string } {
  const streams = STREAMS_FOR_TYPE[type];
  const levels = LEVELS_FOR_TYPE[type];
  return {
    stream: preferred.stream && streams.includes(preferred.stream)
      ? preferred.stream : streams[0],
    level: preferred.level && levels.includes(preferred.level)
      ? preferred.level : DEFAULT_LEVEL[type],
  };
}

/**
 * Where each type opens, which is not simply the first allowed level.
 *
 * A School and a Madrasa both span primary upwards, and both open at
 * **secondary** — মাধ্যমিক and দাখিল are the common cases in this market, and
 * an institution onboarded at প্রাথমিক / ইবতেদায়ি by default is a wrong class
 * range that then has to be noticed on screen 6.
 */
const DEFAULT_LEVEL: Record<InstitutionType, string> = {
  school: 'secondary',
  college: 'higher_secondary',
  madrasa: 'secondary',
  school_college: 'combined',
};

/**
 * Every (stream, level) pair the wizard can produce reads back as the type
 * that produced it. Exported so the suite can prove the round trip rather
 * than spot-checking it, and so a future enum value fails loudly here.
 */
export const ALL_TYPES: readonly InstitutionType[] =
  ['school', 'college', 'madrasa', 'school_college'];
