import type pg from 'pg';

export interface RoleSnapshot {
  primaryRole: string;
  roles: string[];
}

/** Highest-`rank` role is primary; ties broken by rank DESC ordering. */
export async function loadRoles(client: pg.PoolClient, tenantId: string, userId: string): Promise<RoleSnapshot> {
  const { rows } = await client.query<{ role_code: string }>(
    `SELECT ur.role_code
       FROM user_roles ur
       JOIN roles r ON r.code = ur.role_code
      WHERE ur.tenant_id = $1 AND ur.user_id = $2
        AND (ur.valid_until IS NULL OR ur.valid_until >= CURRENT_DATE)
      ORDER BY r.rank DESC`,
    [tenantId, userId],
  );
  if (rows.length === 0) return { primaryRole: '', roles: [] };
  return { primaryRole: rows[0].role_code, roles: rows.map((r) => r.role_code) };
}
