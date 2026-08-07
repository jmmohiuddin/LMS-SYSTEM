/**
 * FetchTransport — bridges SyncEngine to the live POST /api/v1/sync/push
 * endpoint. Implements SyncTransport so the engine stays network-agnostic.
 *
 * Auth goes through Auth.authedFetch (see auth.ts), which attaches the
 * teacher's JWT and refreshes it ahead of expiry — sync/push derives
 * tenantId/userId/role from that token now (see
 * services/sync-svc/api/push.ts), so no separate headers are needed here.
 */
import type { SyncTransport, PushRequest, PushResponse } from '../../../packages/offline/src/types.ts';
import type { Auth } from './auth.ts';

export interface TransportOptions {
  auth: Auth;
}

export class FetchTransport implements SyncTransport {
  private readonly opts: TransportOptions;
  constructor(opts: TransportOptions) {
    this.opts = opts;
  }

  async push(req: PushRequest): Promise<PushResponse> {
    const res = await this.opts.auth.authedFetch('/api/v1/sync/push', {
      method: 'POST',
      body: JSON.stringify(req),
    });

    if (!res.ok) {
      const msg = await res.text().catch(() => res.statusText);
      throw new Error(`sync ${res.status}: ${msg}`);
    }
    return res.json() as Promise<PushResponse>;
  }
}
