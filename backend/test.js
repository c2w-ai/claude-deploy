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
const { server, sanitizeName, genServiceName, deriveServiceName, sanitizeForClient, tail, isTransientRailwayError, isUploadPhaseError } = mod;

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

test('sanitizeForClient: redacts provider build-log URLs entirely', () => {
  const input = '  Build Logs: https://railway.com/project/abc/service/def?id=xyz\nother stuff\n';
  const out = sanitizeForClient(input);
  assert.ok(!out.includes('railway.com'), 'should redact railway.com URLs');
  assert.ok(!out.includes('Build Logs'), 'should strip the Build Logs line entirely');
  assert.ok(out.includes('other stuff'), 'should preserve unrelated lines');
});

test('sanitizeForClient: rewrites [railpack] to [builder]', () => {
  const out = sanitizeForClient('[railpack] merge $packages:apt');
  assert.strictEqual(out, '[builder] merge $packages:apt');
});

test('sanitizeForClient: rewrites "Railway GraphQL" error messages', () => {
  const out = sanitizeForClient('Railway GraphQL error: invalid mutation');
  assert.ok(out.startsWith('Hosting API error:'), `got: ${out}`);
});

test('sanitizeForClient: strips registry auth lines', () => {
  const input = 'a\n[auth] sharing credentials for production-europe-west4-drams3a.railway-registry.com\nb\n';
  const out = sanitizeForClient(input);
  assert.ok(!out.includes('railway-registry'), 'registry hostname leaked');
  assert.ok(!out.includes('[auth] sharing'), 'auth line leaked');
  assert.ok(out.includes('a\n'));
  assert.ok(out.includes('b\n'));
});

test('sanitizeForClient: PRESERVES .up.railway.app deploy URLs', () => {
  // This is the one intentional leak — it's the actual URL we hand users.
  const input = 'Deploy complete\nhttps://cd-myapp-production.up.railway.app is your URL';
  const out = sanitizeForClient(input);
  assert.ok(out.includes('.up.railway.app'), 'intentional user-facing URL must not be rewritten');
  assert.ok(out.includes('cd-myapp-production.up.railway.app'), 'exact subdomain must survive');
});

test('sanitizeForClient: handles null/undefined', () => {
  assert.strictEqual(sanitizeForClient(null), null);
  assert.strictEqual(sanitizeForClient(undefined), undefined);
  assert.strictEqual(sanitizeForClient(''), '');
});

test('sanitizeForClient: no Railway mentions survive except the intentional URL', () => {
  const input = `  Build Logs: https://railway.com/project/foo/service/bar
CI mode enabled
[railpack] merge
[auth] sharing credentials for x.railway-registry.com
Railway GraphQL error: nope
Backoff reqwest error: https://backboard.railway.com/graphql/v2
https://cd-app.up.railway.app`;
  const out = sanitizeForClient(input);
  const allMatches = out.match(/railway/gi) || [];
  assert.strictEqual(allMatches.length, 1, `expected 1 match (the .up.railway.app URL), got ${allMatches.length}: ${out}`);
  assert.ok(out.includes('cd-app.up.railway.app'));
});

// ---------- HTTP routing ----------

test('GET /health returns 200 ok', async (t) => {
  const base = await startTestServer();
  t.after(() => stopTestServer());

  const res = await request(base, { path: '/health' });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.json, { ok: true, version: '0.4.1' });
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

// ---------- /deploys management endpoints (list + delete) ----------
//
// These routes require a valid Supabase JWT + call Railway GraphQL. We
// stub global.fetch so the routes get deterministic responses without any
// network access, then spin up a fresh server instance with SUPABASE_URL
// set so the routes actually enter the auth path (rather than the 500
// "auth not configured" branch).

function makeFetchStub({ validUser = null, userServices = [], onDelete = () => true } = {}) {
  const originalFetch = global.fetch;
  global.fetch = async (url, opts = {}) => {
    const u = typeof url === 'string' ? url : url.toString();
    const method = (opts.method || 'GET').toUpperCase();
    // Supabase /auth/v1/user → validate JWT
    if (u.includes('/auth/v1/user')) {
      const auth = (opts.headers && (opts.headers.Authorization || opts.headers.authorization)) || '';
      const token = auth.replace(/^Bearer\s+/i, '');
      if (validUser && token === validUser.token) {
        return new Response(JSON.stringify({
          id: validUser.id,
          email: validUser.email,
          email_confirmed_at: '2026-01-01T00:00:00Z',
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ error: 'invalid' }), { status: 401 });
    }
    // Railway GraphQL
    if (u.includes('railway') && u.includes('/graphql')) {
      let body = {};
      try { body = JSON.parse(opts.body || '{}'); } catch {}
      const q = body.query || '';
      // ListServicesWithActivity OR ListDomains — return the user's services
      if (q.includes('services(first: 500)') && q.includes('serviceInstances')) {
        const edges = userServices.map((s) => ({
          node: {
            id: s.id,
            name: s.name,
            createdAt: s.createdAt || '2026-04-14T00:00:00Z',
            serviceInstances: {
              edges: [{
                node: {
                  environmentId: body.variables?.envId || '00000000-0000-0000-0000-000000000001',
                  serviceId: s.id,
                  latestDeployment: { createdAt: s.latestDeployedAt || '2026-04-14T00:00:00Z', status: s.status || 'SUCCESS' },
                  domains: { serviceDomains: s.domain ? [{ domain: s.domain }] : [] },
                },
              }],
            },
          },
        }));
        return new Response(JSON.stringify({ data: { project: { services: { edges } } } }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      // serviceDelete mutation
      if (q.includes('serviceDelete')) {
        const id = body.variables?.id || '';
        const ok = onDelete(id);
        return new Response(JSON.stringify({ data: { serviceDelete: ok } }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      // Default: empty data
      return new Response(JSON.stringify({ data: {} }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    // Anything else: 500
    return new Response(JSON.stringify({ error: 'unexpected fetch in test', url: u }), { status: 500 });
  };
  return () => { global.fetch = originalFetch; };
}

function spinFreshServer(extraEnv = {}) {
  delete require.cache[require.resolve('./server.js')];
  // Defaults for the deploys tests
  process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://fake.supabase.co';
  process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'fake-anon';
  process.env.CD_TARGET_TOKEN = process.env.CD_TARGET_TOKEN || 'test-target';
  process.env.CD_TARGET_PROJECT_ID = process.env.CD_TARGET_PROJECT_ID || '00000000-0000-0000-0000-000000000000';
  process.env.CD_TARGET_ENVIRONMENT_ID = process.env.CD_TARGET_ENVIRONMENT_ID || '00000000-0000-0000-0000-000000000001';
  process.env.CLIENT_TOKEN = '';
  Object.assign(process.env, extraEnv);
  return require('./server.js');
}

async function listenOnEphemeral(freshMod) {
  await new Promise((r) => freshMod.server.listen(0, '127.0.0.1', r));
  const addr = freshMod.server.address();
  return `http://127.0.0.1:${addr.port}`;
}

// Helper: compute the expected upsert hash for a given user id so tests can
// construct ownership-correct service names.
const nodeCrypto = require('node:crypto');
function identityHashForTest(userId) {
  return nodeCrypto.createHash('sha256').update(`u:${userId}`).digest('hex').slice(0, 8);
}

test('GET /deploys: 401 without Authorization', async (t) => {
  const fresh = spinFreshServer();
  const base = await listenOnEphemeral(fresh);
  const restore = makeFetchStub();
  t.after(() => { restore(); return new Promise((r) => fresh.server.close(() => r())); });

  const res = await request(base, { path: '/deploys' });
  assert.strictEqual(res.status, 401);
  assert.match(res.json.error, /auth/i);
});

test('GET /deploys: 401 with bogus Bearer token', async (t) => {
  const fresh = spinFreshServer();
  const base = await listenOnEphemeral(fresh);
  const restore = makeFetchStub({
    validUser: { id: 'real-user', token: 'real-token', email: 'real@example.com' },
  });
  t.after(() => { restore(); return new Promise((r) => fresh.server.close(() => r())); });

  const res = await request(base, {
    path: '/deploys',
    headers: { authorization: 'Bearer not-the-right-token' },
  });
  assert.strictEqual(res.status, 401);
});

test('GET /deploys: 200 with empty list for a fresh user', async (t) => {
  const fresh = spinFreshServer();
  const base = await listenOnEphemeral(fresh);
  const userId = '11111111-1111-4111-8111-111111111111';
  const restore = makeFetchStub({
    validUser: { id: userId, token: 'good-token', email: 'fresh@example.com' },
    userServices: [], // no services yet
  });
  t.after(() => { restore(); return new Promise((r) => fresh.server.close(() => r())); });

  const res = await request(base, {
    path: '/deploys',
    headers: { authorization: 'Bearer good-token' },
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.json.user_email, 'fresh@example.com');
  assert.strictEqual(res.json.count, 0);
  assert.deepStrictEqual(res.json.deploys, []);
});

test('GET /deploys: returns only services owned by the caller', async (t) => {
  const fresh = spinFreshServer();
  const base = await listenOnEphemeral(fresh);
  const ownerId = '22222222-2222-4222-8222-222222222222';
  const ownerHash = identityHashForTest(ownerId);
  const strangerHash = identityHashForTest('99999999-9999-4999-8999-999999999999');
  const restore = makeFetchStub({
    validUser: { id: ownerId, token: 'owner-token', email: 'owner@example.com' },
    userServices: [
      { id: 'svc-a', name: `cd-${ownerHash}-alpha`, domain: 'cd-alpha.up.railway.app', status: 'SUCCESS' },
      { id: 'svc-b', name: `cd-${ownerHash}-beta`,  domain: 'cd-beta.up.railway.app',  status: 'SUCCESS' },
      { id: 'svc-c', name: `cd-${strangerHash}-gamma`, domain: 'cd-gamma.up.railway.app', status: 'SUCCESS' },
      { id: 'svc-d', name: 'unrelated-service', status: 'SUCCESS' }, // doesn't match prefix at all
    ],
  });
  t.after(() => { restore(); return new Promise((r) => fresh.server.close(() => r())); });

  const res = await request(base, {
    path: '/deploys',
    headers: { authorization: 'Bearer owner-token' },
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.json.count, 2);
  const slugs = res.json.deploys.map((d) => d.slug).sort();
  assert.deepStrictEqual(slugs, ['alpha', 'beta']);
  assert.ok(res.json.deploys.every((d) => d.service.startsWith(`cd-${ownerHash}-`)));
});

test('DELETE /deploys/:slug: 404 when no match', async (t) => {
  const fresh = spinFreshServer();
  const base = await listenOnEphemeral(fresh);
  const userId = '33333333-3333-4333-8333-333333333333';
  const restore = makeFetchStub({
    validUser: { id: userId, token: 'good', email: 'nothing@example.com' },
    userServices: [], // nothing to delete
  });
  t.after(() => { restore(); return new Promise((r) => fresh.server.close(() => r())); });

  const res = await request(base, {
    method: 'DELETE',
    path: '/deploys/ghost',
    headers: { authorization: 'Bearer good' },
  });
  assert.strictEqual(res.status, 404);
  assert.match(res.json.error, /no deploy/i);
});

test('DELETE /deploys/:slug: 403 when the slug belongs to another user', async (t) => {
  const fresh = spinFreshServer();
  const base = await listenOnEphemeral(fresh);
  const callerId = '44444444-4444-4444-8444-444444444444';
  const otherId  = '55555555-5555-4555-8555-555555555555';
  const otherHash = identityHashForTest(otherId);
  let deleted = false;
  const restore = makeFetchStub({
    validUser: { id: callerId, token: 'caller-token', email: 'caller@example.com' },
    userServices: [
      { id: 'svc-x', name: `cd-${otherHash}-secret`, domain: 'cd-secret.up.railway.app' },
    ],
    onDelete: () => { deleted = true; return true; },
  });
  t.after(() => { restore(); return new Promise((r) => fresh.server.close(() => r())); });

  // The attacker tries to delete someone else's deploy by passing the
  // full service name (since they can't derive the hash from the slug
  // without knowing the owner's user_id).
  const res = await request(base, {
    method: 'DELETE',
    path: `/deploys/cd-${otherHash}-secret`,
    headers: { authorization: 'Bearer caller-token' },
  });
  assert.strictEqual(res.status, 403);
  assert.strictEqual(deleted, false, 'must NOT call serviceDelete on a service the user does not own');
});

test('DELETE /deploys/:slug: 200 on happy path', async (t) => {
  const fresh = spinFreshServer();
  const base = await listenOnEphemeral(fresh);
  const userId = '66666666-6666-4666-8666-666666666666';
  const userHash = identityHashForTest(userId);
  const deletedIds = [];
  const restore = makeFetchStub({
    validUser: { id: userId, token: 'owner-token', email: 'owner@example.com' },
    userServices: [
      { id: 'svc-happy', name: `cd-${userHash}-myapp`, domain: 'cd-myapp.up.railway.app' },
    ],
    onDelete: (id) => { deletedIds.push(id); return true; },
  });
  t.after(() => { restore(); return new Promise((r) => fresh.server.close(() => r())); });

  const res = await request(base, {
    method: 'DELETE',
    path: '/deploys/myapp',
    headers: { authorization: 'Bearer owner-token' },
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.json.ok, true);
  assert.strictEqual(res.json.deleted.slug, 'myapp');
  assert.deepStrictEqual(deletedIds, ['svc-happy'], 'must call serviceDelete exactly once with the matched service id');
});

test('DELETE /deploys/: 400 when target is missing', async (t) => {
  const fresh = spinFreshServer();
  const base = await listenOnEphemeral(fresh);
  const userId = '77777777-7777-4777-8777-777777777777';
  const restore = makeFetchStub({
    validUser: { id: userId, token: 'good', email: 'empty@example.com' },
  });
  t.after(() => { restore(); return new Promise((r) => fresh.server.close(() => r())); });

  const res = await request(base, {
    method: 'DELETE',
    path: '/deploys/',
    headers: { authorization: 'Bearer good' },
  });
  assert.strictEqual(res.status, 400);
});

// Note: the rate-limit test is order-sensitive (it depends on the in-memory
// bucket state) so we put it last and restart the server before running it.
test('rate limit: bucket trips after N requests from same ip', async (t) => {
  delete require.cache[require.resolve('./server.js')];
  process.env.RATE_LIMIT_PER_MIN = '2';
  process.env.CLIENT_TOKEN = '';
  // The /deploys tests above set SUPABASE_URL/SUPABASE_ANON_KEY on process.env
  // to spin a Supabase-aware server. Unset them so this test goes through the
  // old CLIENT_TOKEN fallback path and the rate limiter actually fires (rather
  // than every request being rejected at the auth check with 401).
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_ANON_KEY;
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
