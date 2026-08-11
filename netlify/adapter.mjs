/**
 * Node http (req, res) → Netlify Functions v2 (Request → Response).
 *
 * Every service handler in this repo is written against Node's
 * IncomingMessage/ServerResponse because that is what Vercel's Node builder
 * hands them. Netlify v2 hands a Web Request and wants a Web Response back.
 * Rather than fork ten handlers — and then maintain two copies of the
 * tenant guard, the rate limiter and the auth checks, which is exactly the
 * kind of duplication that ends with a security fix landing in one of them —
 * this shims the two shapes at the edge and the handlers stay untouched.
 *
 * What the handlers actually use, and therefore all this has to support:
 *   req: .url .method .headers, and .on('data'|'end'|'error') for the body
 *   res: .writeHead(status, headers) .setHeader() .end(body) .write(chunk)
 *
 * The body is read once, up front, and replayed to the listeners
 * synchronously on the next tick. readBody() in server-core attaches its
 * listeners immediately after being called, so emitting on a later tick is
 * what makes the replay land rather than fire into an empty emitter.
 */

/** Minimal EventEmitter — the real one is not worth pulling in for three events. */
function makeRequest(webReq, bodyText) {
  const url = new URL(webReq.url);
  const listeners = new Map();
  const headers = {};
  for (const [k, v] of webReq.headers) headers[k.toLowerCase()] = v;

  const req = {
    // Path + query only. Handlers build their own URL against a dummy origin
    // and read searchParams; giving them the absolute URL would still work,
    // but this matches exactly what Node hands them on Vercel.
    url: url.pathname + url.search,
    method: webReq.method,
    headers,
    // Some handlers read the client address for rate limiting; Netlify puts
    // it on a header, and the shape below is what Node's socket looks like.
    socket: { remoteAddress: headers['x-nf-client-connection-ip'] ?? headers['x-forwarded-for'] ?? '' },
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(fn);
      return req;
    },
  };

  // Replay after the current tick so listeners attached synchronously by the
  // caller are already registered.
  queueMicrotask(() => {
    const data = listeners.get('data') ?? [];
    const end = listeners.get('end') ?? [];
    if (bodyText) for (const fn of data) fn(Buffer.from(bodyText, 'utf8'));
    for (const fn of end) fn();
  });

  return req;
}

function makeResponse(resolve) {
  let status = 200;
  const headers = {};
  const chunks = [];
  let done = false;

  const finish = () => {
    if (done) return;
    done = true;
    resolve(new Response(chunks.length ? chunks.join('') : null, { status, headers }));
  };

  return {
    get statusCode() { return status; },
    set statusCode(v) { status = v; },
    setHeader(k, v) { headers[k] = String(v); },
    getHeader(k) { return headers[k]; },
    removeHeader(k) { delete headers[k]; },
    writeHead(code, maybeHeaders) {
      status = code;
      if (maybeHeaders) for (const [k, v] of Object.entries(maybeHeaders)) headers[k] = String(v);
      return this;
    },
    write(chunk) { if (chunk != null) chunks.push(String(chunk)); return true; },
    end(chunk) { if (chunk != null) chunks.push(String(chunk)); finish(); },
  };
}

export function netlifyAdapter(handler) {
  return async function netlifyHandler(webReq) {
    // Read the body before invoking, because the shim replays rather than
    // streams. These are JSON APIs with small payloads (see scripts.ts —
    // image bytes ride a presigned PUT, never this path), so buffering is
    // not a memory concern.
    const bodyText = webReq.method === 'GET' || webReq.method === 'HEAD'
      ? '' : await webReq.text();

    return new Promise((resolve) => {
      const res = makeResponse(resolve);
      const req = makeRequest(webReq, bodyText);
      Promise.resolve(handler(req, res)).catch((err) => {
        console.error('unhandled handler error', err);
        // Never leak an internal message to the client; the log has it.
        resolve(new Response(JSON.stringify({ error: 'internal_error' }), {
          status: 500, headers: { 'Content-Type': 'application/json' },
        }));
      });
    });
  };
}
