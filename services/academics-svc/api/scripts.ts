/**
 * POST /api/v1/academics/scripts
 *
 * Records one page of a handwritten answer script — the compressed JPEG is
 * held by the caller and streamed to object storage; this endpoint owns the
 * metadata row (answer_scripts, migration 005) and the idempotency contract.
 *
 * Body: { id (UUIDv7 = op id), examSubjectId, studentId, pageNo, byteSize,
 *         originalBytes?, sha256 (hex), capturedAt, objectKey?, contentType? }
 *
 * Body is intentionally small — the blob rides a presigned PUT to object
 * storage separately (client-side compression to ≤200 KB/page per docs/04
 * §6 is what makes uploads viable on 3G). Idempotent on `id`: a retried
 * upload posts the same UUIDv7 and gets its existing row back with no
 * duplicate insert. `object_key` is server-authoritative — computed from
 * the tenant/year/exam layout of the DDL comment — the client's suggestion
 * (if any) is ignored to keep bucket layout under the platform's control.
 *
 * SCRIPT_STORAGE_ENABLED is the kill switch: Vercel Hobby has no persistent
 * object storage attached, so this returns 503 script_storage_unconfigured
 * until an R2/S3 credential lands — same pattern as OTP/MFS/AI. The metadata
 * row is written either way once storage is on; nothing else needs to change.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sharedDb } from '../../../packages/server-core/src/db.ts';
import { corsHeaders, readJson, json, HttpError } from '../../../packages/server-core/src/http.ts';
import { authenticate, requireStaff } from '../../../packages/server-core/src/auth.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX64_RE = /^[0-9a-f]{64}$/i;
const SCRIPT_STORAGE_ENABLED = false;

// Bytes on the wire is what actually costs on 3G. Anything above the ceiling
// says the caller's compression didn't run; reject early so the upstream
// PUT never happens for it.
const MAX_PAGE_BYTES = 250 * 1024;
const MIN_PAGE_BYTES = 4 * 1024;

interface ScriptBody {
  id?: string;
  examSubjectId?: string;
  studentId?: string;
  pageNo?: number;
  byteSize?: number;
  originalBytes?: number;
  sha256?: string;
  capturedAt?: string;
  contentType?: string;
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cors = corsHeaders();
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  if (req.method !== 'POST') { json(res, 405, { error: 'method_not_allowed' }, cors); return; }

  try {
    const claims = await authenticate(req);
    requireStaff(claims);

    const body = await readJson<ScriptBody>(req);
    const id = body.id ?? '';
    const examSubjectId = body.examSubjectId ?? '';
    const studentId = body.studentId ?? '';
    const pageNo = Number(body.pageNo ?? 1);
    const byteSize = Number(body.byteSize ?? 0);
    const sha256 = body.sha256 ?? '';
    const capturedAt = body.capturedAt ?? '';
    const contentType = body.contentType ?? 'image/jpeg';

    if (!UUID_RE.test(id)) throw new HttpError(400, 'id must be a valid uuid', 'invalid_id');
    if (!UUID_RE.test(examSubjectId)) throw new HttpError(400, 'examSubjectId must be a valid uuid', 'invalid_exam_subject_id');
    if (!UUID_RE.test(studentId)) throw new HttpError(400, 'studentId must be a valid uuid', 'invalid_student_id');
    if (!Number.isInteger(pageNo) || pageNo < 1 || pageNo > 20) throw new HttpError(400, 'pageNo must be 1..20', 'invalid_page_no');
    if (byteSize < MIN_PAGE_BYTES || byteSize > MAX_PAGE_BYTES) {
      throw new HttpError(413, `byteSize must be ${MIN_PAGE_BYTES}..${MAX_PAGE_BYTES}`, 'page_too_large');
    }
    if (!HEX64_RE.test(sha256)) throw new HttpError(400, 'sha256 must be a 64-char hex digest', 'invalid_sha256');
    if (!Number.isFinite(Date.parse(capturedAt))) throw new HttpError(400, 'capturedAt must be ISO 8601', 'invalid_captured_at');
    if (contentType !== 'image/jpeg' && contentType !== 'image/webp') {
      throw new HttpError(415, 'contentType must be image/jpeg or image/webp', 'unsupported_content_type');
    }

    if (!SCRIPT_STORAGE_ENABLED) {
      json(res, 503, {
        error: 'script_storage_unconfigured',
        message: 'answer-script object storage is not yet enabled',
      }, cors);
      return;
    }

    const db = await sharedDb();
    const result = await db.withTenant(
      { tenantId: claims.tid, userId: claims.sub, role: claims.role },
      async (client) => {
        const yearRow = await client.query<{ y: number }>(
          `SELECT EXTRACT(year FROM COALESCE(e.starts_on, CURRENT_DATE))::int AS y
             FROM exam_subjects es JOIN exams e ON e.id = es.exam_id
            WHERE es.id = $1`,
          [examSubjectId],
        );
        const year = yearRow.rows[0]?.y ?? new Date(capturedAt).getUTCFullYear();
        const objectKey = `scripts/${claims.tid}/${year}/${examSubjectId}/${studentId}/${pageNo}.jpg`;

        const row = await client.query<{ id: string; upload_state: string }>(
          `INSERT INTO answer_scripts
             (id, tenant_id, exam_subject_id, student_id, page_no,
              object_key, content_type, byte_size, sha256, original_bytes,
              captured_at, captured_by, upload_state)
           VALUES ($1, app.current_tenant(), $2, $3, $4, $5, $6, $7,
                   decode($8, 'hex'), $9, $10, $11, 'pending')
           ON CONFLICT (tenant_id, exam_subject_id, student_id, page_no) DO UPDATE
             SET byte_size = EXCLUDED.byte_size,
                 sha256 = EXCLUDED.sha256,
                 original_bytes = EXCLUDED.original_bytes,
                 captured_at = EXCLUDED.captured_at,
                 upload_state = CASE
                   WHEN answer_scripts.upload_state = 'complete' THEN 'complete'
                   ELSE 'pending'
                 END
           RETURNING id, upload_state`,
          [id, examSubjectId, studentId, pageNo, objectKey, contentType, byteSize,
           sha256, body.originalBytes ?? null, capturedAt, claims.sub],
        );

        return { scriptId: row.rows[0].id, objectKey, uploadState: row.rows[0].upload_state };
      },
    );

    json(res, 200, { ok: true, ...result }, cors);
  } catch (err) {
    if (err instanceof HttpError) {
      json(res, err.status, { error: err.code ?? 'error', message: err.message }, cors);
      return;
    }
    console.error('[scripts] unexpected error', err);
    json(res, 500, { error: 'internal_error' }, cors);
  }
}
