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
  /**
   * B-84. The server's own error code and Bangla sentence, when the response
   * carried them.
   *
   * Without these a 403 is just a number, and every screen that refuses
   * through this class said the same thing for four different situations: a
   * role the person does not have, a school that is suspended, a service the
   * school never bought, and a service that is temporarily off. A guardian at
   * a school with no finance module was told "you do not have permission —
   * contact the head teacher", who would tell them the school does not use
   * that part of the product. The remedy was wrong because the sentence was.
   *
   * Optional, so every existing `new HttpStatus(status)` still compiles and
   * still behaves exactly as before.
   */
  code?: string;
  reasonBn?: string;

  constructor(status: number, code?: string, reasonBn?: string) {
    super(String(status));
    this.name = 'HttpStatus';
    this.status = status;
    this.code = code;
    this.reasonBn = reasonBn;
  }
}

/**
 * The status behind a rejection **or a response**.
 *
 * P5 widened this. Half the app checks a refusal after `catch`, where it holds
 * an `HttpStatus`; the other half checks it before `await res.json()`, where
 * it holds a `Response`. `isDenied(res)` reads correctly at every one of those
 * call sites and, until this change, silently returned `false` for all of
 * them — a refusal check that never fires is worse than no check, because the
 * screen looks like it has one. Both shapes carry a numeric `status`, so this
 * reads the property rather than the class.
 */
export function statusOf(err: unknown): number | undefined {
  if (err instanceof HttpStatus) return err.status;
  if (typeof err === 'object' && err !== null) {
    const s = (err as { status?: unknown }).status;
    if (typeof s === 'number') return s;
  }
  return undefined;
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
export async function refuseUnlessOk(
  res: { ok: boolean; status: number; json?: () => Promise<unknown> },
): Promise<void> {
  if (res.ok) return;
  // The body is read only on the failure path, and only for a refusal — the
  // one case where the server wrote a sentence for a person. Anything that
  // throws while reading it (an empty body, HTML from a proxy) leaves the
  // status alone, which is the behaviour every caller had before.
  let code: string | undefined;
  let reasonBn: string | undefined;
  if (res.status === 403 && typeof res.json === 'function') {
    try {
      const body = await res.json() as { error?: unknown; message?: unknown; serviceState?: unknown };
      if (typeof body?.error === 'string') code = body.error;
      if (typeof body?.message === 'string' && /[ঀ-৿]/.test(body.message)) {
        reasonBn = body.message;
      }
      // `not_in_plan` is a commercial fact and reads differently from an
      // operational one; the server sends it alongside `tenant_blocked`.
      if (typeof body?.serviceState === 'string') code = `${code}:${body.serviceState}`;
    } catch { /* a refusal with no readable body is still a refusal */ }
  }
  throw new HttpStatus(res.status, code, reasonBn);
}
