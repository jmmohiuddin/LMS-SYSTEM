/**
 * The Node-http → Netlify shim.
 *
 * This sits in front of every endpoint on the Netlify deployment, so a bug
 * here is a bug in all ten at once — and it is the kind of bug that looks
 * like a broken API rather than a broken adapter. The body replay in
 * particular is timing-sensitive: server-core's readBody() attaches its
 * listeners synchronously after being called, so an implementation that
 * emitted immediately would deliver into an empty emitter and every POST
 * would hang until the platform timed it out.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { netlifyAdapter } from '../adapter.mjs';

/** Mirrors packages/server-core/src/http.ts readBody(). */
const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  req.on('error', reject);
});

describe('netlify adapter', () => {
  test('passes path and query through as Node would, not the absolute URL', async () => {
    let seen;
    const fn = netlifyAdapter(async (req, res) => {
      seen = { url: req.url, method: req.method };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    await fn(new Request('https://example.com/api/v1/academics/roster?sectionId=abc'));
    // Handlers do `new URL(req.url, 'http://internal')` — an absolute URL
    // would still parse, but the pathname would then carry the real host's
    // path and the last-segment dispatch would still work by luck. Match
    // Node exactly instead of relying on that.
    assert.equal(seen.url, '/api/v1/academics/roster?sectionId=abc');
    assert.equal(seen.method, 'GET');
  });

  test('replays a POST body to listeners attached after the call', async () => {
    let body;
    const fn = netlifyAdapter(async (req, res) => {
      body = await readBody(req);      // attaches listeners on a later tick
      res.writeHead(200, {});
      res.end('ok');
    });
    const res = await fn(new Request('https://example.com/api/v1/sync/push', {
      method: 'POST', body: JSON.stringify({ ops: [1, 2] }),
    }));
    assert.equal(body, '{"ops":[1,2]}');
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'ok');
  });

  test('an empty GET still fires end, so a handler awaiting the body proceeds', async () => {
    let body = null;
    const fn = netlifyAdapter(async (req, res) => {
      body = await readBody(req);
      res.writeHead(204, {});
      res.end();
    });
    const res = await fn(new Request('https://example.com/api/v1/ops/events'));
    assert.equal(body, '');
    assert.equal(res.status, 204);
  });

  test('status and headers survive writeHead and setHeader both', async () => {
    const fn = netlifyAdapter(async (req, res) => {
      res.setHeader('X-Custom', 'one');
      res.writeHead(418, { 'Content-Type': 'application/json' });
      res.end('{"error":"teapot"}');
    });
    const res = await fn(new Request('https://example.com/api/v1/rms/solve'));
    assert.equal(res.status, 418);
    assert.equal(res.headers.get('x-custom'), 'one');
    assert.equal(res.headers.get('content-type'), 'application/json');
  });

  test('request headers arrive lowercased, the way Node delivers them', async () => {
    let auth, tenant;
    const fn = netlifyAdapter(async (req, res) => {
      auth = req.headers.authorization;
      tenant = req.headers['x-tenant-id'];
      res.writeHead(200, {}); res.end('');
    });
    await fn(new Request('https://example.com/api/v1/academics/roster', {
      headers: { Authorization: 'Bearer t', 'X-Tenant-ID': 'tenant-1' },
    }));
    // auth.ts reads req.headers.authorization; a capitalised key would make
    // every authenticated request look anonymous.
    assert.equal(auth, 'Bearer t');
    assert.equal(tenant, 'tenant-1');
  });

  test('a throwing handler becomes a 500 that leaks nothing', async () => {
    const fn = netlifyAdapter(async () => { throw new Error('connection string postgres://u:pw@host'); });
    const res = await fn(new Request('https://example.com/api/v1/academics/roster'));
    assert.equal(res.status, 500);
    const text = await res.text();
    assert.equal(text, '{"error":"internal_error"}');
    assert.ok(!text.includes('postgres://'), 'must never echo the thrown message');
  });

  test('the client IP the rate limiter reads is carried across', async () => {
    let ip;
    const fn = netlifyAdapter(async (req, res) => { ip = req.socket.remoteAddress; res.writeHead(200,{}); res.end(''); });
    await fn(new Request('https://example.com/api/v1/auth/otp-request', {
      method: 'POST', body: '{}', headers: { 'x-nf-client-connection-ip': '203.0.113.9' },
    }));
    // F-102 buckets per source IP. An adapter that dropped this would put
    // every request in Bangladesh into one bucket.
    assert.equal(ip, '203.0.113.9');
  });

  test('chunked writes are concatenated in order', async () => {
    const fn = netlifyAdapter(async (req, res) => {
      res.writeHead(200, {}); res.write('{"a":'); res.write('1}'); res.end();
    });
    const res = await fn(new Request('https://example.com/api/v1/ans/stats'));
    assert.equal(await res.text(), '{"a":1}');
  });
});
