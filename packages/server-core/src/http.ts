/**
 * Minimal request/response helpers for Vercel Node serverless functions.
 * There is no framework here on purpose — see services/sync-svc/api/push.ts,
 * whose CORS/header/readBody/json shape this generalises.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

export function corsHeaders(extraHeaders: string[] = [], methods = 'GET, POST, OPTIONS'): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': methods,
    'Access-Control-Allow-Headers': [
      'Content-Type',
      'Authorization',
      'X-Tenant-ID',
      'X-User-ID',
      'X-Role',
      ...extraHeaders,
    ].join(', '),
  };
}

export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function header(req: IncomingMessage, name: string): string {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] ?? '' : v ?? '';
}

export function query(req: IncomingMessage): URLSearchParams {
  const url = new URL(req.url ?? '/', 'http://internal');
  return url.searchParams;
}

export async function readJson<T>(req: IncomingMessage): Promise<T> {
  const raw = await readBody(req);
  return JSON.parse(raw) as T;
}

export function json(res: ServerResponse, code: number, body: unknown, cors: Record<string, string>): void {
  const payload = JSON.stringify(body);
  res.writeHead(code, { ...cors, 'Content-Type': 'application/json' });
  res.end(payload);
}

export class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}
