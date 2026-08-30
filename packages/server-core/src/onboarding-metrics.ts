/**
 * How long an onboarding actually took.  (R-8 §11)
 *
 * The master plan carries a target of "a new institution onboarded in under
 * an hour", and R-8's instruction is explicit: do not claim it until it has
 * been measured. This is the measurement.
 *
 * ── Derived, not recorded ───────────────────────────────────────────────
 * There is no `onboarding_started_at` column and there should not be. Every
 * console action already writes a row to `audit.platform_access` with a
 * timestamp — creating the tenant, setting branding, provisioning the
 * structure, creating the principal — so the duration is the distance between
 * the first and last of them. Adding a column would duplicate a source of
 * truth that exists, and worse, it would be a column somebody has to remember
 * to set: the first onboarding that crashed halfway would leave it wrong
 * forever, while the audit rows would still be exactly right.
 *
 * ── Why the wall clock is the honest number ─────────────────────────────
 * It includes the operator stopping to telephone the school for its logo, and
 * the ten minutes spent finding the head teacher's name. That is not noise to
 * be filtered out; it is what onboarding a school is actually like, and the
 * target is a claim about a person's afternoon, not about server time.
 *
 * A single-step onboarding — one row — has no duration, and this returns null
 * rather than zero. Zero would be a lie that averages beautifully.
 */
/**
 * What this module actually needs from a connection: send text and values,
 * get rows back.
 *
 * It was `Pick<PoolClient | Client, 'query'>`, which drags in pg's whole
 * overload set — including `query(config: QueryArrayConfig)` — so nothing
 * simpler than a real pg client could satisfy it and the tests could not
 * compile. Naming the narrow contract is both more honest about the
 * dependency and testable; a real `Client` still satisfies it, because one of
 * its overloads is exactly this shape.
 */
export interface Queryable {
  query<R = Record<string, unknown>>(
    text: string, values?: unknown[],
  ): Promise<{ rows: R[] }>;
}

export interface OnboardingMetrics {
  tenantId: string;
  /** First console action for this school. */
  startedAt: string | null;
  /** Last action of the onboarding run — see `SETUP_STATEMENTS`. */
  finishedAt: string | null;
  /** Wall clock, minutes. Null when there is only one action to measure. */
  minutes: number | null;
  /** How many console actions it took. High counts mean a screen is unclear. */
  steps: number;
  /** How many distinct operators touched it. >1 means somebody needed help. */
  operators: number;
  /** When a human first signed in — the moment onboarding became real. */
  firstLoginAt: string | null;
  /**
   * Minutes from the end of setup to that first login.
   *
   * **Signed, and negative is normal.** A principal who signs in while the
   * operator is still importing students produces a negative value, and that
   * is a good sign rather than a clock problem — it means the school started
   * using the thing before the setup was finished. Callers must render it as
   * "during setup" rather than as a negative duration; the console's first
   * version printed "-১৭ মিনিট পরে", which is how this came to be documented.
   */
  minutesToFirstLogin: number | null;
  /** The product's actual job, first performed. */
  firstAttendanceOn: string | null;
}

/**
 * The statements that constitute a setup run.
 *
 * Deliberately a prefix list rather than "everything in the audit log":
 * suspending a school two months later is a console action and is not part of
 * its onboarding, and including it would report an onboarding that took nine
 * weeks. Matching is on the statement's opening words because that is the
 * vocabulary platform-svc already writes.
 */
export const SETUP_STATEMENTS = [
  'create_tenant', 'set branding', 'provision_tenant',
  'created principal', 'created it_admin', 'granted principal', 'granted it_admin',
  'import', 'set_plan',
];

export async function onboardingMetrics(
  c: Queryable, tenantId: string,
): Promise<OnboardingMetrics> {
  const { rows } = await c.query<{
    started_at: string | null; finished_at: string | null;
    minutes: string | null; steps: string; operators: string;
  }>(
    `SELECT to_char(min(created_at), 'YYYY-MM-DD"T"HH24:MI:SSZ')          AS started_at,
            to_char(max(created_at), 'YYYY-MM-DD"T"HH24:MI:SSZ')          AS finished_at,
            CASE WHEN count(*) > 1
                 THEN round(EXTRACT(EPOCH FROM (max(created_at) - min(created_at))) / 60.0, 1)::text
            END                                                            AS minutes,
            count(*)::text                                                 AS steps,
            count(DISTINCT admin_id)::text                                 AS operators
       FROM audit.platform_access
      WHERE tenant_id = $1
        AND (${SETUP_STATEMENTS.map((_, i) => `statement LIKE $${i + 2}`).join(' OR ')})`,
    [tenantId, ...SETUP_STATEMENTS.map((s) => `${s}%`)],
  );

  // Sessions and attendance are tenant-scoped and RLS-protected; this runs
  // under whatever context the caller established, which for the console is
  // the tenant's own and for the CLI is the owner role.
  const { rows: login } = await c.query<{ first_login_at: string | null }>(
    `SELECT to_char(min(issued_at), 'YYYY-MM-DD"T"HH24:MI:SSZ') AS first_login_at
       FROM user_sessions WHERE tenant_id = $1`, [tenantId]);
  const { rows: att } = await c.query<{ first_attendance_on: string | null }>(
    `SELECT to_char(min(taken_on), 'YYYY-MM-DD') AS first_attendance_on
       FROM attendance_sessions WHERE tenant_id = $1`, [tenantId]);

  const finishedAt = rows[0]?.finished_at ?? null;
  const firstLoginAt = login[0]?.first_login_at ?? null;

  return {
    tenantId,
    startedAt: rows[0]?.started_at ?? null,
    finishedAt,
    minutes: rows[0]?.minutes === null || rows[0]?.minutes === undefined
      ? null : Number(rows[0].minutes),
    steps: Number(rows[0]?.steps ?? 0),
    operators: Number(rows[0]?.operators ?? 0),
    firstLoginAt,
    minutesToFirstLogin: finishedAt && firstLoginAt
      ? Math.round((Date.parse(firstLoginAt) - Date.parse(finishedAt)) / 60000)
      : null,
    firstAttendanceOn: att[0]?.first_attendance_on ?? null,
  };
}

/**
 * Is this a measurement of a real onboarding, or of a test fixture?
 *
 * A seeded tenant created by a script in 40 milliseconds would drag any
 * average toward a number nobody could reproduce with a human in the chair.
 * The caller decides what to do about it; this only refuses to be quiet.
 */
export function looksSynthetic(m: OnboardingMetrics): boolean {
  return m.minutes !== null && m.minutes < 1 && m.steps > 1;
}
