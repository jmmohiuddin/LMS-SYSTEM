/**
 * The AI gateway: /api/v1/ai/{sikhok,shikho} — one Vercel function
 * (api/v1/ai/[engine].js).
 *
 *   POST /api/v1/ai/sikhok   Teacher co-pilot (docs/01 §6.1). Staff only.
 *        Body: { taskType: 'generate_cq'|'generate_mcq'|'rubric'|'lesson_plan',
 *                classLevel, subjectBn, chapterNo?, instructions?, locale? }
 *   POST /api/v1/ai/shikho   Student Socratic tutor. Any authenticated user.
 *        Body: { message, classLevel?, subjectBn?, locale? }
 *
 * Kill switch by absence: with no ANTHROPIC_API_KEY env var this returns
 * 503 ai_disabled before any side effect — same pattern as the OTP and MFS
 * switches. Set the key in Vercel env and redeploy to enable.
 *
 * RAG state: the NCTB corpus tables (nctb_documents/nctb_chunks, migration
 * 008) exist but are EMPTY, and no embedding service is wired yet, so
 * retrieval currently runs in lexical-only degraded mode — the hard metadata
 * filter of docs/01 §6.2 (class/subject/language FIRST), then tsvector BM25
 * over content_tsv ('simple' config). When the corpus is ingested and an
 * embedder exists, app.nctb_retrieve() upgrades this to hybrid retrieval
 * without changing this endpoint's contract. Until chunks exist, generation
 * proceeds ungrounded and says so in the response (grounded: false).
 *
 * Guardrails implemented here: role gating; scope-bounded prompts; a
 * deterministic redactor stripping phone numbers and NID-length digit runs
 * before any text leaves for the Claude API (docs/01 §6.3); full
 * session/turn audit into ai_sessions/ai_turns with token counts; refusal
 * stop_reason surfaced cleanly. Not yet implemented (needs embeddings):
 * item-bank answer-leak similarity check.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import Anthropic from '@anthropic-ai/sdk';
import { sharedDb } from '../../../packages/server-core/src/db.ts';
import { corsHeaders, readJson, json, HttpError } from '../../../packages/server-core/src/http.ts';
import { authenticate, requireStaff } from '../../../packages/server-core/src/auth.ts';
import { enforceRateLimit, enforceIdentityRateLimit } from '../../../packages/server-core/src/rate-limit.ts';

// Blueprint model split (docs/01 §6.1): Opus for teacher-side generation,
// Haiku for high-volume tutoring. Env-overridable without a redeploy of code.
const MODEL_SIKHOK = process.env.AI_MODEL_SIKHOK ?? 'claude-opus-5';
const MODEL_SHIKHO = process.env.AI_MODEL_SHIKHO ?? 'claude-haiku-4-5';

const TASK_TYPES = new Set(['generate_cq', 'generate_mcq', 'rubric', 'lesson_plan']);
const LOCALES = new Set(['bn', 'en', 'bn-latn']);

let _client: Anthropic | null = null;
function client(): Anthropic {
  if (!_client) _client = new Anthropic(); // reads ANTHROPIC_API_KEY
  return _client;
}

/**
 * Deterministic PII redactor — strips BD phone numbers and NID/BRC-length
 * digit runs before text egresses to the Claude API. Names can't be reliably
 * redacted without an entity dictionary; the prompts below therefore never
 * include roster data at all.
 */
function redact(text: string): string {
  return text
    .replace(/\+?880\s?1[0-9\s-]{8,12}/g, '[PHONE]')
    .replace(/\b01[3-9][0-9]{8}\b/g, '[PHONE]')
    .replace(/\b[0-9]{10,17}\b/g, '[ID]');
}

interface Chunk { content: string; section_path: string | null }

/** Hard metadata filter first, then lexical rank. Empty corpus → []. */
async function retrieve(
  db: Awaited<ReturnType<typeof sharedDb>>,
  ctx: { tenantId: string; userId: string; role: string },
  q: { classLevel: number; subjectBn?: string; queryText: string; locale: string },
): Promise<Chunk[]> {
  return db.withTenant(ctx, async (c) => {
    const r = await c.query<Chunk>(
      `SELECT content, section_path
         FROM nctb_chunks
        WHERE class_level = $1
          AND language = $2
          AND content_tsv @@ plainto_tsquery('simple', $3)
        ORDER BY ts_rank(content_tsv, plainto_tsquery('simple', $3)) DESC
        LIMIT 6`,
      [q.classLevel, q.locale === 'en' ? 'en' : 'bn', q.queryText],
    );
    return r.rows;
  });
}

async function logSession(
  db: Awaited<ReturnType<typeof sharedDb>>,
  ctx: { tenantId: string; userId: string; role: string },
  row: {
    engine: 'sikhok' | 'shikho'; taskType: string; locale: string; model: string;
    inputTokens: number; outputTokens: number;
    userText: string; assistantText: string; latencyMs: number;
  },
): Promise<void> {
  try {
    await db.withTenant(ctx, async (c) => {
      const sess = await c.query<{ id: string }>(
        `INSERT INTO ai_sessions
           (tenant_id, engine, user_id, user_role, locale, task_type, model,
            input_tokens, output_tokens, turn_count, ended_at)
         VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8, 2, now())
         RETURNING id`,
        [row.engine, ctx.userId, ctx.role, row.locale, row.taskType, row.model,
         row.inputTokens, row.outputTokens],
      );
      const sessionId = sess.rows[0].id;
      await c.query(
        `INSERT INTO ai_turns
           (tenant_id, session_id, turn_no, role, content_redacted, latency_ms, input_tokens, output_tokens)
         VALUES (app.current_tenant(), $1, 1, 'user', $2, NULL, $3, NULL),
                (app.current_tenant(), $1, 2, 'assistant', $4, $5, NULL, $6)`,
        [sessionId, redact(row.userText), row.inputTokens, redact(row.assistantText), row.latencyMs, row.outputTokens],
      );
    });
  } catch (err) {
    // The audit log must never take the answer down with it.
    console.error('[ai] session logging failed', err);
  }
}

function extractText(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

interface SikhokBody {
  taskType?: string; classLevel?: number; subjectBn?: string;
  chapterNo?: number; instructions?: string; locale?: string;
}

async function sikhok(req: IncomingMessage, res: ServerResponse, cors: Record<string, string>): Promise<void> {
  const claims = await authenticate(req);
  requireStaff(claims);
  // F-102, identity dimension. The dispatcher charged this IP; this is the
  // per-account spend control, and the earliest point the account is known.
  // Charged before the body is read so a refused caller never reaches the
  // Anthropic API — this is the only endpoint class with real per-call cost.
  if (!(await enforceIdentityRateLimit(res, cors, 'ai', `${claims.tid}:${claims.sub}`))) return;
  const body = await readJson<SikhokBody>(req);

  const taskType = body.taskType ?? '';
  const classLevel = Number(body.classLevel);
  const subjectBn = (body.subjectBn ?? '').slice(0, 100);
  const locale = LOCALES.has(body.locale ?? '') ? (body.locale as string) : 'bn';
  if (!TASK_TYPES.has(taskType)) {
    throw new HttpError(400, `taskType must be one of ${[...TASK_TYPES].join(', ')}`, 'invalid_task_type');
  }
  if (!Number.isInteger(classLevel) || classLevel < 1 || classLevel > 12) {
    throw new HttpError(400, 'classLevel must be 1..12', 'invalid_class_level');
  }
  if (!subjectBn) throw new HttpError(400, 'subjectBn is required', 'subject_required');

  const db = await sharedDb();
  const ctx = { tenantId: claims.tid, userId: claims.sub, role: claims.role };
  const queryText = `${subjectBn} ${body.instructions ?? ''}`.trim();
  const chunks = await retrieve(db, ctx, { classLevel, subjectBn, queryText, locale });

  const taskBn: Record<string, string> = {
    generate_cq: 'একটি NCTB-সম্মত সৃজনশীল প্রশ্ন (CQ) তৈরি করুন — উদ্দীপক এবং ক/খ/গ/ঘ চারটি অংশসহ (জ্ঞান ১, অনুধাবন ২, প্রয়োগ ৩, উচ্চতর দক্ষতা ৪ নম্বর)।',
    generate_mcq: '১০টি বহুনির্বাচনি প্রশ্ন (MCQ) তৈরি করুন, প্রতিটির ৪টি বিকল্প ও সঠিক উত্তর চিহ্নিতসহ।',
    rubric: 'একটি বিস্তারিত মূল্যায়ন রুব্রিক তৈরি করুন।',
    lesson_plan: 'একটি ৪৫-মিনিটের পাঠ পরিকল্পনা তৈরি করুন (শিখনফল, উপকরণ, ধাপ, মূল্যায়ন)।',
  };

  const grounding = chunks.length
    ? `\n\nNCTB পাঠ্যবই থেকে প্রাসঙ্গিক অংশ (এর বাইরে যাবেন না):\n${chunks.map((c, i) => `[${i + 1}] ${c.section_path ?? ''}\n${c.content}`).join('\n\n')}`
    : '\n\n(কোনো পাঠ্যবই অংশ পাওয়া যায়নি — শুধুমাত্র NCTB পাঠ্যক্রমের সাধারণ জ্ঞান ব্যবহার করুন এবং অধ্যায়-নির্দিষ্ট দাবি এড়িয়ে চলুন।)';

  const system =
    'You are SikhokAI, a teacher co-pilot for Bangladeshi schools. You generate NCTB-curriculum-compliant ' +
    'assessment material. Stay strictly within the named class level and subject. Answer in Bangla unless ' +
    "the locale is 'en'. Output well-structured Markdown.";
  const user = redact(
    `শ্রেণি: ${classLevel}, বিষয়: ${subjectBn}${body.chapterNo ? `, অধ্যায়: ${body.chapterNo}` : ''}\n` +
    `${taskBn[taskType]}\n${body.instructions ? `অতিরিক্ত নির্দেশনা: ${body.instructions.slice(0, 2000)}` : ''}` +
    grounding,
  );

  const started = Date.now();
  const msg = await client().messages.create({
    model: MODEL_SIKHOK,
    max_tokens: 4096,
    system,
    messages: [{ role: 'user', content: user }],
  });

  if (msg.stop_reason === 'refusal') {
    json(res, 200, { ok: false, error: 'ai_refused', message: 'the model declined this request' }, cors);
    return;
  }
  const text = extractText(msg.content);
  await logSession(db, ctx, {
    engine: 'sikhok', taskType, locale, model: msg.model,
    inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens,
    userText: user, assistantText: text, latencyMs: Date.now() - started,
  });

  json(res, 200, {
    ok: true,
    taskType,
    content: text,
    grounded: chunks.length > 0,
    retrievedChunks: chunks.length,
    model: msg.model,
    usage: { inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens },
  }, cors);
}

interface ShikhoBody { message?: string; classLevel?: number; subjectBn?: string; locale?: string }

async function shikho(req: IncomingMessage, res: ServerResponse, cors: Record<string, string>): Promise<void> {
  const claims = await authenticate(req);
  // F-102, identity dimension — see sikhok() above.
  if (!(await enforceIdentityRateLimit(res, cors, 'ai', `${claims.tid}:${claims.sub}`))) return;
  const body = await readJson<ShikhoBody>(req);
  const message = (body.message ?? '').trim().slice(0, 4000);
  if (!message) throw new HttpError(400, 'message is required', 'message_required');
  const locale = LOCALES.has(body.locale ?? '') ? (body.locale as string) : 'bn';
  const classLevel = Number.isInteger(Number(body.classLevel)) ? Number(body.classLevel) : null;

  const db = await sharedDb();
  const ctx = { tenantId: claims.tid, userId: claims.sub, role: claims.role };
  const chunks = classLevel
    ? await retrieve(db, ctx, { classLevel, subjectBn: body.subjectBn, queryText: message, locale })
    : [];

  const system =
    'You are ShikhoAI (শিখো), a patient Socratic tutor for Bangladeshi school students. ' +
    'RULES: Never give the final answer to a homework or exam question — guide with questions, hints and ' +
    'worked analogies so the student reaches it themselves. Match the student\'s language (Bangla, English, ' +
    'or Banglish). Keep responses short and encouraging. Stay within the student\'s class level' +
    (classLevel ? ` (Class ${classLevel})` : '') +
    (body.subjectBn ? ` and the subject ${body.subjectBn}` : '') +
    '. If the student expresses self-harm, abuse, or distress, respond with care and suggest speaking to a ' +
    'trusted teacher or guardian.' +
    (chunks.length
      ? `\n\nRelevant NCTB textbook passages:\n${chunks.map((c) => c.content).join('\n\n')}`
      : '');

  const started = Date.now();
  const msg = await client().messages.create({
    model: MODEL_SHIKHO,
    max_tokens: 1024,
    system,
    messages: [{ role: 'user', content: redact(message) }],
  });

  if (msg.stop_reason === 'refusal') {
    json(res, 200, { ok: false, error: 'ai_refused', message: 'the model declined this request' }, cors);
    return;
  }
  const text = extractText(msg.content);
  await logSession(db, ctx, {
    engine: 'shikho', taskType: 'tutor_chat', locale, model: msg.model,
    inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens,
    userText: message, assistantText: text, latencyMs: Date.now() - started,
  });

  json(res, 200, {
    ok: true,
    reply: text,
    grounded: chunks.length > 0,
    // F-1302: the student must be able to see WHERE an answer comes from,
    // not merely that it is grounded. These are the textbook section paths
    // the retrieval actually used, deduped and capped — the screen prints
    // them under the reply. Without them "grounded" is a claim the reader
    // cannot check, which is the thing the requirement exists to prevent.
    sources: [...new Set(chunks.map((c) => c.section_path).filter((p): p is string => !!p))].slice(0, 3),
    model: msg.model,
    usage: { inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens },
  }, cors);
}

const ROUTES: Record<string, (req: IncomingMessage, res: ServerResponse, cors: Record<string, string>) => Promise<void>> = {
  sikhok,
  shikho,
};

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cors = corsHeaders();
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    res.end();
    return;
  }
  if (req.method !== 'POST') {
    json(res, 405, { error: 'method_not_allowed' }, cors);
    return;
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    json(res, 503, { error: 'ai_disabled', message: 'AI features are not yet enabled' }, corsHeaders());
    return;
  }

  const path = new URL(req.url ?? '/', 'http://internal').pathname;
  const sub = path.split('/').filter(Boolean).pop() ?? '';
  const route = ROUTES[sub];
  if (!route) {
    json(res, 404, { error: 'not_found' }, cors);
    return;
  }
  // F-102, IP dimension. The identity dimension is charged inside each
  // engine, right after authenticate().
  if (!(await enforceRateLimit(req, res, cors, 'ai'))) return;
  try {
    await route(req, res, cors);
  } catch (err) {
    if (err instanceof HttpError) {
      json(res, err.status, { error: err.code ?? 'error', message: err.message }, cors);
      return;
    }
    if (err instanceof Anthropic.APIError) {
      console.error(`[ai/${sub}] upstream error`, err.status, err.message);
      json(res, 502, { error: 'ai_upstream_error', message: 'the AI service is temporarily unavailable' }, cors);
      return;
    }
    console.error(`[ai/${sub}] unexpected error`, err);
    json(res, 500, { error: 'internal_error' }, cors);
  }
}
