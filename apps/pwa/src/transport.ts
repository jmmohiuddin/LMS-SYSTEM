/**
 * FetchTransport — bridges SyncEngine to the live POST /api/v1/sync/push
 * endpoint. Implements SyncTransport so the engine stays network-agnostic.
 *
 * Auth: a service API key in the Authorization header plus X-Tenant-ID /
 * X-User-ID / X-Role headers. These are replaced by a JWT in Phase 1 when
 * the identity service ships.
 */
import type { SyncTransport, PushRequest, PushResponse } from '../../../packages/offline/src/types.ts';

export interface TransportOptions {
  apiBase: string;
  tenantId: string;
  userId: string;
  role: string;
  apiKey: string;
}

export class FetchTransport implements SyncTransport {
  private readonly opts: TransportOptions;
  constructor(opts: TransportOptions) {
    this.opts = opts;
  }

  async push(req: PushRequest): Promise<PushResponse> {
    const { apiBase, tenantId, userId, role, apiKey } = this.opts;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey)    headers['Authorization'] = `Bearer ${apiKey}`;
    if (tenantId)  headers['X-Tenant-ID']   = tenantId;
    if (userId)    headers['X-User-ID']      = userId;
    headers['X-Role'] = role;

    const res = await fetch(`${apiBase}/api/v1/sync/push`, {
      method: 'POST',
      headers,
      body: JSON.stringify(req),
    });

    if (!res.ok) {
      const msg = await res.text().catch(() => res.statusText);
      throw new Error(`sync ${res.status}: ${msg}`);
    }
    return res.json() as Promise<PushResponse>;
  }
}
