/**
 * A rejection that still knows its HTTP status, and what to do with a 403.
 * (B-30)
 *
 * ── The bug this exists to remove ──────────────────────────────────────────
 * Nine student-facing views were written the same way:
 *
 *     if (!res.ok) throw new Error(String(res.status));
 *     …
 *     } catch {
 *       if (this.data) this.offline = true; else this.error = true;
 *     }
 *
 * The status is turned into a string and then thrown away by a bare `catch`.
 * Everything that goes wrong — no network, a 500, a 403 — arrives at the same
 * place and is reported as the same thing, and if the screen has a cached copy
 * it is shown under "অফলাইন — সর্বশেষ সংরক্ষিত".
 *
 * For a refusal that is three separate wrongs at once:
 *
 *   1. It is **not** an offline state. Nothing is wrong with the connection.
 *   2. It offers a retry, and no retry will ever succeed.
 *   3. It keeps showing the data the server has just refused — which is the
 *      only one of the three that is a privacy failure rather than a
 *      usability one. The cache was filled when the person was allowed to see
 *      it, or by a different person on a shared device; either way, once the
 *      server says no, the screen must stop saying it.
 *
 * ── One class, not four copies ─────────────────────────────────────────────
 * The Pre-P5 closure pass fixed three screens and left `class HttpStatus` in
 * each of them — three identical declarations, which is how a fourth ends up
 * subtly different. This is the one.
 *
 * The explicit field is not a style choice: Node runs this repository's
 * TypeScript in strip-only mode, where `constructor(readonly status: number)`
 * compiles under `tsc` and throws at runtime. P3 lost an afternoon to it.
 */
export class HttpStatus extends Error {
  status: number;

  constructor(status: number) {
    super(String(status));
    this.name = 'HttpStatus';
    this.status = status;
  }
}

/** The status behind a rejection, when it carried one. */
export function statusOf(err: unknown): number | undefined {
  return err instanceof HttpStatus ? err.status : undefined;
}

/**
 * `true` when the server explicitly refused — the case that must never be
 * dressed up as an outage, and must never leave cached data on screen.
 *
 * 401 is deliberately NOT included. A dead session is recoverable by signing
 * in again, `humanError` already says so, and the app's auth layer refreshes
 * before it gives up.
 */
export function isDenied(err: unknown): boolean {
  return statusOf(err) === 403;
}

/**
 * Throw an `HttpStatus` for any non-2xx, so the caller's `catch` can tell a
 * refusal from a flat tyre.
 *
 * Named for what it protects rather than what it does: every call site reads
 * `await refuseUnlessOk(res)` and the reason is in this file.
 */
export function refuseUnlessOk(res: { ok: boolean; status: number }): void {
  if (!res.ok) throw new HttpStatus(res.status);
}
