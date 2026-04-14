// Offline tests for the claude-deploy backend.
//
// Run with: `node --test test.js`  (or `npm test`).
//
// These tests do NOT touch Railway or make outbound network calls. They
// exercise: env validation, pure helpers, HTTP routing, auth, rate limiting,
// and body validation. The /deploy happy path is covered by end-to-end
// testing via the live hosted backend (see README).

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const zlib = require('node:zlib');

// Configure env BEFORE importing server.js so the module reads these values.
process.env.PORT = '0'; // let the OS assign (but we don't call listen in tests)
process.env.CD_TARGET_TOKEN = 'test-token';
process.env.CD_TARGET_PROJECT_ID = '00000000-0000-0000-0000-000000000000';
process.env.CD_TARGET_ENVIRONMENT_ID = '00000000-0000-0000-0000-000000000001';
process.env.RATE_LIMIT_PER_MIN = '3';
process.env.CLIENT_TOKEN = ''; // explicit: no auth by default for most tests

const mod = require('./server.js');
const { server, sanitizeName, genServiceName, deriveServiceName, tail, isTransientRailwayError, isUploadPhaseError } = mod;

// ---------- in-process HTTP helper ----------

function startTestServer() {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
}

function stopTestServer() {
  return new Promise((resolve) => server.close(() => resolve()));
}

function request(baseUrl, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const req = http.request(
      {
        method,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          let json = null;
          try { json = JSON.parse(text); } catch {}
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ---------- pure helpers ----------

test('sanitizeName: lowercases and strips invalid chars', () => {
  assert.strictEqual(sanitizeName('My Cool App!'), 'my-cool-app');
  assert.strictEqual(sanitizeName('UPPER_case_99'), 'upper-case-99');
  assert.strictEqual(sanitizeName('  spaces  '), 'spaces');
  assert.strictEqual(sanitizeName('---leading-and-trailing---'), 'leading-and-trailing');
});

test('sanitizeName: caps at 24 chars', () => {
  const out = sanitizeName('x'.repeat(100));
  assert.ok(out.length <= 24, `got length ${out.length}`);
});

test('sanitizeName: returns "app" for empty input', () => {
  assert.strictEqual(sanitizeName(''), 'app');
  assert.strictEqual(sanitizeName(null), 'app');
  assert.strictEqual(sanitizeName(undefined), 'app');
  assert.strictEqual(sanitizeName('!!!'), 'app');
});

test('genServiceName: cd-<slug>-<6hex>', () => {
  const name = genServiceName('hello world');
  assert.match(name, /^cd-hello-world-[a-f0-9]{6}$/);
});

test('genServiceName: different calls produce different suffixes', () => {
  const a = genServiceName('same');
  const b = genServiceName('same');
  assert.notStrictEqual(a, b);
  assert.match(a, /^cd-same-[a-f0-9]{6}$/);
});

test('deriveServiceName: deterministic from (clientId, projectSlug)', () => {
  const a = deriveServiceName('client-abc', 'my-app');
  const b = deriveServiceName('client-abc', 'my-app');
  assert.strictEqual(a, b, 'same inputs must produce the same name');
  assert.match(a, /^cd-[a-f0-9]{8}-my-app$/);
});

test('deriveServiceName: different clients produce different names for same slug', () => {
  const alice = deriveServiceName('alice', 'my-app');
  const bob = deriveServiceName('bob', 'my-app');
  assert.notStrictEqual(alice, bob);
  // Both should still have the slug visible
  assert.match(alice, /-my-app$/);
  assert.match(bob, /-my-app$/);
});

test('deriveServiceName: sanitizes garbage project slug', () => {
  const name = deriveServiceName('x', 'My Cool App!!!');
  assert.match(name, /^cd-[a-f0-9]{8}-my-cool-app$/);
});

test('deriveServiceName: falls back to "app" for empty slug', () => {
  const name = deriveServiceName('x', '');
  assert.match(name, /^cd-[a-f0-9]{8}-app$/);
});

test('tail: returns last N lines', () => {
  const input = 'a\nb\nc\nd\ne\n';
  assert.strictEqual(tail(input, 2), 'e\n'); // last 2 includes trailing empty line
  assert.strictEqual(tail('hi', 5), 'hi');
});

test('isTransientRailwayError: matches backboard failures', () => {
  assert.strictEqual(isTransientRailwayError({ message: 'error decoding response body' }), true);
  assert.strictEqual(isTransientRailwayError({ message: '503 Service Unavailable' }), true);
  assert.strictEqual(isTransientRailwayError({ message: 'reqwest error', stderr: 'operation timed out' }), true);
  assert.strictEqual(isTransientRailwayError({ message: 'build failed' }), false);
});

test('isUploadPhaseError: no-retry once build started', () => {
  assert.strictEqual(isUploadPhaseError({ message: '503 Service Unavailable', stdout: 'Indexing...\nUploading...\n' }), true);
  assert.strictEqual(isUploadPhaseError({ message: '503 Service Unavailable', stdout: 'Build Logs: https://...' }), false);
  assert.strictEqual(isUploadPhaseError({ message: 'build failed', stdout: '' }), false);
});

// ---------- HTTP routing ----------

test('GET /health returns 200 ok', async (t) => {
  const base = await startTestServer();
  t.after(() => stopTestServer());

  const res = await request(base, { path: '/health' });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.json, { ok: true, version: '0.2.0' });
});

test('GET / returns service descriptor', async (t) => {
  const base = await startTestServer();
  t.after(() => stopTestServer());

  const res = await request(base, { path: '/' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.json.service, 'claude-deploy');
  assert.ok(Array.isArray(res.json.endpoints));
});

test('GET /unknown returns 404', async (t) => {
  const base = await startTestServer();
  t.after(() => stopTestServer());

  const res = await request(base, { path: '/does-not-exist' });
  assert.strictEqual(res.status, 404);
});

test('GET /deploy returns 404 (only POST is allowed)', async (t) => {
  const base = await startTestServer();
  t.after(() => stopTestServer());

  const res = await request(base, { path: '/deploy' });
  assert.strictEqual(res.status, 404);
});

test('POST /deploy rejects empty body with 400', async (t) => {
  const base = await startTestServer();
  t.after(() => stopTestServer());

  const res = await request(base, { method: 'POST', path: '/deploy', body: 'hi' });
  assert.strictEqual(res.status, 400);
  assert.match(res.json.error, /empty or truncated/);
});

test('POST /deploy rejects non-gzip body with 400', async (t) => {
  const base = await startTestServer();
  t.after(() => stopTestServer());

  // >64 bytes so we pass the length check, but not gzip.
  const body = Buffer.from('x'.repeat(200));
  const res = await request(base, {
    method: 'POST',
    path: '/deploy',
    headers: { 'content-type': 'application/octet-stream', 'content-length': body.length },
    body,
  });
  assert.strictEqual(res.status, 400);
  assert.match(res.json.error, /not a gzip stream/);
});

test('POST /deploy gzipped body is accepted past validation (would hit Railway)', async (t) => {
  const base = await startTestServer();
  t.after(() => stopTestServer());

  // A valid gzip stream. We can't let it actually talk to Railway, so we
  // assert we get something OTHER than 400/404/401/429 — specifically it
  // should try to deploy and surface a 500 / 503 (from the fake Railway
  // token we configured). Any non-validation status confirms the request
  // passed early checks.
  // Must exceed the 64-byte minimum length after gzipping. Random bytes
  // don't compress, so a small seed gives us a bigger gzip output.
  const random = require('node:crypto').randomBytes(256);
  const tarball = zlib.gzipSync(random);
  const res = await request(base, {
    method: 'POST',
    path: '/deploy',
    headers: { 'content-type': 'application/gzip', 'x-project-name': 'test' },
    body: tarball,
  });
  assert.ok(
    res.status === 500 || res.status === 503,
    `expected 5xx from Railway error, got ${res.status}: ${res.text.slice(0, 200)}`,
  );
});

// ---------- auth ----------

test('CLIENT_TOKEN gate: missing header → 401', async (t) => {
  // Restart with CLIENT_TOKEN set — need a fresh require.cache entry.
  delete require.cache[require.resolve('./server.js')];
  process.env.CLIENT_TOKEN = 'secret-abc';
  const freshMod = require('./server.js');

  await new Promise((r) => freshMod.server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => freshMod.server.close(() => r())));
  const addr = freshMod.server.address();
  const base = `http://127.0.0.1:${addr.port}`;

  const body = zlib.gzipSync(Buffer.from('placeholder content for body validation path'));
  const res = await request(base, {
    method: 'POST',
    path: '/deploy',
    headers: { 'content-type': 'application/gzip' },
    body,
  });
  assert.strictEqual(res.status, 401);

  // Correct token → passes auth check (exact downstream status depends on
  // Railway, so just assert it's NOT 401 anymore).
  const ok = await request(base, {
    method: 'POST',
    path: '/deploy',
    headers: {
      'content-type': 'application/gzip',
      authorization: 'Bearer secret-abc',
      'x-project-name': 'auth-test',
    },
    body,
  });
  assert.notStrictEqual(ok.status, 401);

  // Reset for subsequent tests
  process.env.CLIENT_TOKEN = '';
  delete require.cache[require.resolve('./server.js')];
});

// Note: the rate-limit test is order-sensitive (it depends on the in-memory
// bucket state) so we put it last and restart the server before running it.
test('rate limit: bucket trips after N requests from same ip', async (t) => {
  delete require.cache[require.resolve('./server.js')];
  process.env.RATE_LIMIT_PER_MIN = '2';
  process.env.CLIENT_TOKEN = '';
  const freshMod = require('./server.js');

  await new Promise((r) => freshMod.server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => freshMod.server.close(() => r())));
  const addr = freshMod.server.address();
  const base = `http://127.0.0.1:${addr.port}`;

  const body = Buffer.from('tiny'); // fails body validation (400) but still counts against the bucket
  // First 2 allowed
  const a = await request(base, { method: 'POST', path: '/deploy', body });
  const b = await request(base, { method: 'POST', path: '/deploy', body });
  assert.ok(a.status !== 429, `first request should pass rate limit, got ${a.status}`);
  assert.ok(b.status !== 429, `second request should pass rate limit, got ${b.status}`);

  // Third should be rate-limited
  const c = await request(base, { method: 'POST', path: '/deploy', body });
  assert.strictEqual(c.status, 429, `expected 429 on third request, got ${c.status}: ${c.text.slice(0, 100)}`);
});
