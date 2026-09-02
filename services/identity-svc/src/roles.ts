import type pg from 'pg';

export interface RoleSnapshot {
  primaryRole: string;
  roles: string[];
}

/**
 * Highest-`rank` role is primary; ties broken by rank DESC ordering.
 *
 * ── The account must still be a live account  (M1) ──────────────────────
 * This JOINs `users` and requires a usable status, and that join is the
 * whole point of it being here rather than in each caller.
 *
 * The final audit proved, at runtime, that a deactivated principal could go
 * on refreshing indefinitely: `activate` and `otp-verify` both checked
 * `users.status` before calling this, and `refresh` did not. Because refresh
 * ROTATES the token, the session never aged out — a dismissed teacher with
 * the app installed kept full access for as long as they opened it.
 *
 * Three auth doors, two of which remembered. So the check moves to the one
 * function all three already call: the next door somebody adds cannot
 * forget it, which is the same argument P7 made for putting the tenant gate
 * inside `withTenant`.
 *
 * `invited` is allowed alongside `active` because that is exactly the rule
 * the two correct callers already applied — `otp-verify` lets an invited
 * user in without promoting them, and cutting that here would end their
 * session fifteen minutes after they logged in. What this refuses is
 * `suspended`, `left` and `deleted`, which are the states the defect was
 * about, plus a soft-deleted row that nothing was filtering here before.
 *
 * Callers still check status themselves. That is deliberate duplication:
 * they can say `account is left` where this can only say "no role", and a
 * refusal that names the reason is what stops somebody re-issuing a code to
 * an account that was deactivated on purpose.
 */
export async function loadRoles(client: pg.PoolClient, tenantId: string, userId: string): Promise<RoleSnapshot> {
  const { rows } = await client.query<{ role_code: string }>(
    `SELECT ur.role_code
       FROM user_roles ur
       JOIN roles r ON r.code = ur.role_code
       JOIN users u ON u.id = ur.user_id AND u.tenant_id = ur.tenant_id
      WHERE ur.tenant_id = $1 AND ur.user_id = $2
        AND (ur.valid_until IS NULL OR ur.valid_until >= app.today_dhaka())
        AND u.deleted_at IS NULL
        AND u.status IN ('active', 'invited')
      ORDER BY r.rank DESC`,
    [tenantId, userId],
  );
  if (rows.length === 0) return { primaryRole: '', roles: [] };
  return { primaryRole: rows[0].role_code, roles: rows.map((r) => r.role_code) };
}
