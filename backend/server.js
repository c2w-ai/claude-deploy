// claude-deploy backend
//
// Receives a gzipped tarball from the claude-deploy Claude Code plugin and
// deploys it to a Railway project owned by the backend operator. Returns the
// public URL of the deployed service.
//
// Uses the Railway CLI (`railway` on PATH) for all Railway operations — this
// avoids hand-maintaining GraphQL schema bindings and gets us correct build/
// upload behavior for free.
//
// Required on the host:
//   - `railway` CLI (>= 4.10) on PATH
//   - `tar` on PATH
//
// Required env:
//   CD_TARGET_TOKEN          Railway PROJECT token scoped to the user-apps
//                            project + environment. Used for both the CLI
//                            subprocess (via RAILWAY_TOKEN) and GraphQL API
//                            calls (via Project-Access-Token header).
//   CD_TARGET_PROJECT_ID     UUID of the target project (the token's scope).
//   CD_TARGET_ENVIRONMENT_ID UUID of the target environment.
//
// Optional env:
//   PORT                       default 3000
//   MAX_UPLOAD_BYTES           default 52428800 (50 MB)
//   CLIENT_TOKEN               require Authorization: Bearer <token> from clients
//   DEPLOY_TIMEOUT_MS          default 900000 (15 minutes)
//   SERVICE_NAME_PREFIX        default "cd"
//   RATE_LIMIT_PER_MIN         default 6 per IP
//
// IMPORTANT: we use a project token (not an account token) because when the
// backend runs on Railway itself, the `railway` CLI ignores `--project`
// flags and reads project info from the container runtime. A project token
// encodes its target project/environment in the token itself, bypassing
// that override.

'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');

const PORT = Number(process.env.PORT || 3000);
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 50 * 1024 * 1024);
const CLIENT_TOKEN = process.env.CLIENT_TOKEN || '';
const DEPLOY_TIMEOUT_MS = Number(process.env.DEPLOY_TIMEOUT_MS || 15 * 60 * 1000);
const SERVICE_NAME_PREFIX = process.env.SERVICE_NAME_PREFIX || 'cd';
const CD_TARGET_TOKEN = process.env.CD_TARGET_TOKEN || '';
const CD_TARGET_PROJECT_ID = process.env.CD_TARGET_PROJECT_ID || '';
const CD_TARGET_ENVIRONMENT_ID = process.env.CD_TARGET_ENVIRONMENT_ID || '';
const RAILWAY_GRAPHQL_URL = process.env.RAILWAY_GRAPHQL_URL || 'https://backboard.railway.com/graphql/v2';

// Supabase — used for end-user authentication (email magic link). The
// backend never sees user passwords; the browser auth page uses the
// Supabase JS SDK with the anon key to sign up / sign in, then posts the
// resulting access token back to the backend for session pairing.
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
// PUBLIC_BACKEND_URL is the externally-reachable URL of THIS backend — needed
// for Supabase redirect_to after email confirmation. When not set we derive
// from the incoming request Host header.
const PUBLIC_BACKEND_URL = (process.env.PUBLIC_BACKEND_URL || '').replace(/\/$/, '');

function warnMissingEnv() {
  const missing = [];
  if (!CD_TARGET_TOKEN) missing.push('CD_TARGET_TOKEN');
  if (!CD_TARGET_PROJECT_ID) missing.push('CD_TARGET_PROJECT_ID');
  if (!CD_TARGET_ENVIRONMENT_ID) missing.push('CD_TARGET_ENVIRONMENT_ID');
  if (!SUPABASE_URL) missing.push('SUPABASE_URL');
  if (!SUPABASE_ANON_KEY) missing.push('SUPABASE_ANON_KEY');
  if (missing.length) {
    console.warn(`[claude-deploy] WARNING: missing env vars: ${missing.join(', ')} — deploys will fail.`);
  }
}
warnMissingEnv();

// ---------- child_process helper ----------

function run(cmd, args, { cwd, env, input, timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...(env || {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const chunks = [];
    const errChunks = [];
    let killed = false;
    const timer = timeoutMs
      ? setTimeout(() => {
          killed = true;
          child.kill('SIGKILL');
        }, timeoutMs)
      : null;
    child.stdout.on('data', (c) => chunks.push(c));
    child.stderr.on('data', (c) => errChunks.push(c));
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      const stdout = Buffer.concat(chunks).toString('utf-8');
      const stderr = Buffer.concat(errChunks).toString('utf-8');
      if (killed) {
        reject(Object.assign(new Error(`${cmd} timed out after ${timeoutMs}ms`), { stdout, stderr }));
      } else if (code !== 0) {
        reject(Object.assign(new Error(`${cmd} ${args.join(' ')} failed (exit ${code}${signal ? `, signal ${signal}` : ''}): ${stderr.trim() || stdout.trim()}`), { stdout, stderr, code }));
      } else {
        resolve({ stdout, stderr });
      }
    });
    if (input !== undefined) {
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }
  });
}

// Build a clean env for railway CLI subprocesses. When the backend is hosted
// on Railway, the platform injects a bunch of RAILWAY_* vars describing the
// backend's own service (RAILWAY_PROJECT_ID, RAILWAY_ENVIRONMENT_*,
// RAILWAY_SERVICE_*, ...). We strip those and set our own RAILWAY_TOKEN
// (a project token scoped to the target project/environment) so the CLI
// auto-targets the right place without `railway link`.
function railwayEnv(isolatedHome) {
  const base = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('RAILWAY_')) continue;
    base[k] = v;
  }
  if (CD_TARGET_TOKEN) base.RAILWAY_TOKEN = CD_TARGET_TOKEN;
  if (isolatedHome) base.HOME = isolatedHome;
  return base;
}

// ---------- core deploy flow ----------

async function extractTarball(tarball, destDir) {
  await run('tar', ['-xzf', tarball, '-C', destDir]);
}

// Railway's backboard/GraphQL API has occasional transient failures
// ("error decoding response body", 5xx, reqwest errors). We retry
// aggressively with exponential-ish backoff because these commands are
// idempotent for our use case (linking, adding a named service, generating
// a domain — subsequent calls are safe).
const TRANSIENT_RAILWAY = /error decoding response body|Failed to fetch|reqwest error|50\d (Bad Gateway|Service Unavailable|Gateway Timeout)|operation timed out|Internal Server Error/i;

function isTransientRailwayError(err) {
  return TRANSIENT_RAILWAY.test(`${err.message || ''}\n${err.stderr || ''}`);
}

async function railwayRun(args, opts, { attempts = 5 } = {}) {
  const delays = [2000, 4000, 7000, 11000]; // ~24s total retry budget
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await run('railway', args, opts);
    } catch (err) {
      lastErr = err;
      const transient = isTransientRailwayError(err);
      const isLast = i === attempts - 1;
      if (!transient || isLast) throw err;
      const delay = delays[Math.min(i, delays.length - 1)];
      console.warn(`[claude-deploy] railway ${args[0]} transient failure (attempt ${i + 1}/${attempts}), retrying in ${delay}ms: ${(err.message || '').slice(0, 120)}`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

// ---------- Railway GraphQL helper ----------

async function railwayGraphQL(query, variables, { attempts = 4 } = {}) {
  const delays = [1500, 3000, 5500, 8000];
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(RAILWAY_GRAPHQL_URL, {
        method: 'POST',
        headers: {
          'Project-Access-Token': CD_TARGET_TOKEN,
          'Content-Type': 'application/json',
          'User-Agent': 'claude-deploy-backend/0.2.0',
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(30_000),
      });
      const text = await res.text();
      let json;
      try { json = JSON.parse(text); } catch {
        throw new Error(`Railway GraphQL non-JSON response (${res.status}): ${text.slice(0, 300)}`);
      }
      if (json.errors) {
        const msg = json.errors.map((e) => e.message).join('; ');
        const err = new Error(`Railway GraphQL error: ${msg}`);
        err._graphqlErrors = json.errors;
        throw err;
      }
      if (!res.ok) throw new Error(`Railway GraphQL HTTP ${res.status}: ${text.slice(0, 300)}`);
      return json.data;
    } catch (err) {
      lastErr = err;
      const transient =
        isTransientRailwayError(err) ||
        /fetch failed|ETIMEDOUT|ECONNRESET|AbortError|TimeoutError/i.test(err.message || '');
      if (!transient || i === attempts - 1) throw err;
      const delay = delays[Math.min(i, delays.length - 1)];
      console.warn(`[claude-deploy] GraphQL transient failure (attempt ${i + 1}/${attempts}), retrying in ${delay}ms: ${(err.message || '').slice(0, 140)}`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

async function createServiceGQL(name) {
  const data = await railwayGraphQL(
    `mutation ServiceCreate($input: ServiceCreateInput!) {
       serviceCreate(input: $input) { id name }
     }`,
    {
      input: {
        projectId: CD_TARGET_PROJECT_ID,
        environmentId: CD_TARGET_ENVIRONMENT_ID,
        name,
      },
    },
  );
  return data.serviceCreate; // { id, name }
}

async function deleteServiceGQL(serviceId) {
  try {
    await railwayGraphQL(
      `mutation ServiceDelete($id: String!) { serviceDelete(id: $id) }`,
      { id: serviceId },
    );
    return true;
  } catch (err) {
    console.warn(`[claude-deploy] cleanup: failed to delete service ${serviceId}: ${(err.message || '').slice(0, 200)}`);
    return false;
  }
}

async function createDomainGQL(serviceId) {
  const data = await railwayGraphQL(
    `mutation ServiceDomainCreate($input: ServiceDomainCreateInput!) {
       serviceDomainCreate(input: $input) { domain }
     }`,
    {
      input: {
        serviceId,
        environmentId: CD_TARGET_ENVIRONMENT_ID,
      },
    },
  );
  const domain = data?.serviceDomainCreate?.domain;
  if (!domain) throw new Error('serviceDomainCreate returned no domain');
  return domain.startsWith('http') ? domain : `https://${domain}`;
}

// Look up an existing Railway service domain via the domains edge on the
// service instance — used by the upsert flow so we don't attempt to re-create
// a domain that already exists.
async function getServiceDomainGQL(serviceId) {
  const data = await railwayGraphQL(
    `query GetServiceDomain($projectId: String!) {
       project(id: $projectId) {
         services(first: 500) {
           edges { node {
             id
             serviceInstances {
               edges { node {
                 serviceId
                 environmentId
                 domains {
                   serviceDomains { domain }
                 }
               } }
             }
           } }
         }
       }
     }`,
    { projectId: CD_TARGET_PROJECT_ID },
  );
  const edges = data?.project?.services?.edges || [];
  for (const e of edges) {
    if (e?.node?.id !== serviceId) continue;
    const instances = e.node?.serviceInstances?.edges || [];
    for (const ie of instances) {
      const inst = ie?.node;
      if (!inst || inst.environmentId !== CD_TARGET_ENVIRONMENT_ID) continue;
      const domains = inst.domains?.serviceDomains || [];
      if (domains.length && domains[0].domain) {
        const d = domains[0].domain;
        return d.startsWith('http') ? d : `https://${d}`;
      }
    }
  }
  return null;
}

// List all services in the target project, with each service's latest
// deployment timestamp — used by the TTL cleanup job (A2).
async function listServicesWithActivityGQL() {
  const data = await railwayGraphQL(
    `query ListServicesWithActivity($projectId: String!) {
       project(id: $projectId) {
         services(first: 500) {
           edges { node {
             id
             name
             createdAt
             serviceInstances {
               edges { node {
                 environmentId
                 latestDeployment { createdAt status }
               } }
             }
           } }
         }
       }
     }`,
    { projectId: CD_TARGET_PROJECT_ID },
  );
  const edges = data?.project?.services?.edges || [];
  return edges.map((e) => {
    const n = e.node;
    const instances = n.serviceInstances?.edges || [];
    // Pick the instance in our target environment, if present.
    let latest = null;
    for (const ie of instances) {
      const inst = ie?.node;
      if (inst?.environmentId === CD_TARGET_ENVIRONMENT_ID) {
        latest = inst.latestDeployment;
        break;
      }
    }
    return {
      id: n.id,
      name: n.name,
      createdAt: n.createdAt,
      latestDeployedAt: latest?.createdAt || null,
      latestStatus: latest?.status || null,
    };
  });
}

// Find a service by exact name. Used by the upsert flow (A8) to detect
// whether a repeat deploy should reuse an existing service.
async function findServiceByNameGQL(name) {
  const services = await listServicesWithActivityGQL();
  return services.find((s) => s.name === name) || null;
}

// Build a deterministic service name from a client identifier and project
// slug. Used for upsert: two calls with the same (clientId, projectSlug)
// produce the same name, so findServiceByNameGQL can reuse the service.
function deriveServiceName(clientId, projectSlug) {
  const slug = sanitizeName(projectSlug || 'app');
  const clientHash = crypto.createHash('sha256').update(String(clientId)).digest('hex').slice(0, 8);
  // Leaves room for the prefix + two dashes + 8 hash + slug within Railway's
  // service-name length limit. sanitizeName already caps slug at 24 chars.
  return `${SERVICE_NAME_PREFIX}-${clientHash}-${slug}`;
}

// Transient failures during the `railway up` UPLOAD phase (before any build
// activity starts) — we retry these. Build-time failures (exit during
// build/deploy after upload succeeded) are NOT retried since they almost
// always mean the user's code is broken.
const UPLOAD_RETRY_PATTERNS = [
  /Failed to upload code with status code 5\d\d/,
  /reqwest error[\s\S]*operation timed out/,
  /reqwest error[\s\S]*error sending request/,
  /error decoding response body/,
  /502 Bad Gateway/,
  /503 Service Unavailable/,
  /504 Gateway Timeout/,
];

function isUploadPhaseError(err) {
  const text = `${err.message || ''}\n${err.stderr || ''}\n${err.stdout || ''}`;
  // If we see "Build Logs:" in stdout, a deployment was already created —
  // don't retry, that would create a duplicate deployment.
  if (/Build Logs:/i.test(err.stdout || '')) return false;
  // If we see any build step output, we're past upload — don't retry.
  if (/\[\d+\/\d+\]|RUN |COPY |FROM /i.test(err.stdout || '')) return false;
  return UPLOAD_RETRY_PATTERNS.some((re) => re.test(text));
}

async function railwayUp(workdir, serviceName, isolatedHome) {
  // `railway up --ci` streams build logs and exits when the build finishes.
  // We retry pre-build (upload-phase) failures 2 extra times with backoff;
  // everything else is surfaced directly to the client.
  const args = ['up', '--ci', '--service', serviceName];
  const start = Date.now();

  const attempts = 3;
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const result = await run('railway', args, {
        cwd: workdir,
        env: railwayEnv(isolatedHome),
        timeoutMs: DEPLOY_TIMEOUT_MS,
      });
      return { ...result, elapsedMs: Date.now() - start };
    } catch (err) {
      lastErr = err;
      if (i === attempts - 1 || !isUploadPhaseError(err)) throw err;
      const delay = 4000 * (i + 1);
      console.warn(`[claude-deploy] railway up upload phase failed (attempt ${i + 1}/${attempts}), retrying in ${delay}ms: ${err.message.slice(0, 120)}`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

// generateDomain / parseRailwayDomain removed — we now use
// createDomainGQL() which goes through the Railway GraphQL API directly.

async function deploy(tarballBuffer, opts) {
  const { projectNameHint, clientId, projectSlug } = opts || {};

  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-deploy-'));
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-rwhome-'));
  const tarball = path.join(workdir, 'source.tar.gz');
  const srcDir = path.join(workdir, 'src');
  fs.mkdirSync(srcDir);

  // Pick the service name + upsert strategy:
  //   - If the client sent both X-Claude-Deploy-Client and X-Project-Slug,
  //     derive a deterministic name and try to reuse an existing service.
  //   - Otherwise fall back to the anonymous random-suffix path (old
  //     plugin versions, curl tests, etc.).
  let serviceName;
  let reusable = null;       // set when upsert hits an existing service
  const canUpsert = Boolean(clientId && projectSlug);
  if (canUpsert) {
    serviceName = deriveServiceName(clientId, projectSlug);
    try {
      reusable = await findServiceByNameGQL(serviceName);
    } catch (err) {
      // Don't fail the whole deploy over a flaky listServices — fall through
      // and attempt createServiceGQL. If the name collides, Railway's API
      // will surface that distinct error.
      console.warn(`[claude-deploy] upsert lookup failed, will attempt create: ${(err.message || '').slice(0, 160)}`);
    }
  } else {
    serviceName = genServiceName(projectNameHint);
  }

  let service = null;        // { id, name }
  let isNewService = false;
  let needsCleanup = false;  // only delete services WE created on this request

  try {
    fs.writeFileSync(tarball, tarballBuffer);
    await extractTarball(tarball, srcDir);
    fs.unlinkSync(tarball);

    if (reusable) {
      service = { id: reusable.id, name: reusable.name };
      isNewService = false;
      console.log(`[claude-deploy] upsert: reusing service ${service.name} id=${service.id}`);
    } else {
      // Create an empty service via GraphQL. This gives us the id we need
      // for cleanup-on-failure, and sidesteps the `railway add` CLI quirks.
      service = await createServiceGQL(serviceName);
      isNewService = true;
      needsCleanup = true;
      console.log(`[claude-deploy] created service ${service.name} id=${service.id}`);
    }

    // Upload + build via `railway up --ci`. The project-scoped
    // RAILWAY_TOKEN routes it to the right project automatically, and
    // `railway up --service <name>` handles both new-create AND
    // update-existing cases identically.
    const up = await railwayUp(srcDir, service.name, isolatedHome);

    // Fetch or create the public domain. For a reused service, try the
    // existing-domain lookup first so we don't race Railway's "domain
    // already exists" error.
    let url = null;
    if (!isNewService) {
      try {
        url = await getServiceDomainGQL(service.id);
      } catch (err) {
        console.warn(`[claude-deploy] get existing domain failed, will attempt create: ${(err.message || '').slice(0, 160)}`);
      }
    }
    if (!url) {
      url = await createDomainGQL(service.id);
    }

    needsCleanup = false; // happy path — keep the service
    return {
      url,
      service: service.name,
      serviceId: service.id,
      isNewService,
      buildMs: up.elapsedMs,
      logTail: sanitizeForClient(tail(up.stdout + '\n' + up.stderr, 20)),
    };
  } finally {
    if (needsCleanup && service?.id) {
      console.log(`[claude-deploy] cleanup: deleting service ${service.name} (${service.id}) after failure`);
      await deleteServiceGQL(service.id);
    }
    try { fs.rmSync(workdir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(isolatedHome, { recursive: true, force: true }); } catch {}
  }
}

function tail(text, lines) {
  const all = String(text || '').split('\n');
  return all.slice(-lines).join('\n');
}

// Strip the underlying hosting provider's brand out of strings we're about
// to return to end users. Internal logs + exception messages frequently
// leak "Railway", "railpack", "backboard.railway.com", and raw build-log
// URLs — none of that should be visible in the CLI output. The upstream
// host domain (*.up.railway.app) on successful deploy URLs is explicitly
// preserved because the product still uses it for the time being.
const SANITIZE_PATTERNS = [
  // Entire "Build Logs" line pointing at provider dashboard — redact
  [/^\s*Build Logs?:\s*https?:\/\/railway\.com\/[^\n]*\n?/gim, ''],
  // "[auth] sharing credentials for <registry>" — internal infra noise
  [/^\s*\[auth\]\s+sharing credentials for [^\n]*\n?/gim, ''],
  // Any remaining provider URL → redact
  [/https?:\/\/railway\.com\/[^\s"'<>)]+/g, '(internal build log)'],
  [/https?:\/\/backboard\.railway\.com\/[^\s"'<>)]+/g, '(internal hosting API)'],
  // Container registry hostnames
  [/[a-z0-9-]+\.railway-registry\.com/gi, '(internal registry)'],
  // GraphQL / API internal names
  [/Railway GraphQL/g, 'Hosting API'],
  [/railway\.com\/graphql\/v2/g, 'hosting API'],
  // Build pipeline naming
  [/\[railpack\]/g, '[builder]'],
  [/railpack/g, 'builder'],
  // Generic "Railway" / "railway" (but NEVER touch .up.railway.app — that's
  // the actual deploy URL we return to users and is documented as such).
  [/\bRailway\b(?!\.app)/g, 'hosting platform'],
  [/(?<!\.)(?<!\w)railway(?!\.app)(?!\w)/gi, 'hosting'],
];

function sanitizeForClient(text) {
  if (text === null || text === undefined) return text;
  let s = String(text);
  for (const [re, replacement] of SANITIZE_PATTERNS) {
    s = s.replace(re, replacement);
  }
  return s;
}

// ---------- utilities ----------

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function sanitizeName(raw) {
  const cleaned = String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 24);
  return cleaned || 'app';
}

function genServiceName(projectName) {
  const suffix = crypto.randomBytes(3).toString('hex');
  return `${SERVICE_NAME_PREFIX}-${sanitizeName(projectName)}-${suffix}`;
}

function jsonResponse(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > limit) {
        req.destroy();
        reject(Object.assign(new Error('Payload too large'), { status: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function checkAuth(req) {
  if (!CLIENT_TOKEN) return true;
  const h = req.headers['authorization'] || '';
  const [scheme, token] = h.split(' ');
  return scheme === 'Bearer' && token === CLIENT_TOKEN;
}

// Extract the Bearer token from an Authorization header. Returns null if
// not present.
function extractBearerToken(req) {
  const h = req.headers['authorization'] || '';
  const [scheme, token] = h.split(' ');
  if (scheme === 'Bearer' && token) return token.trim();
  return null;
}

// ---------- Supabase auth helpers ----------
//
// The flow:
//   1. CLI calls POST /auth/start → backend issues a session_id + session_secret
//      and returns a verify_url pointing at GET /auth/page?session_id=... .
//   2. CLI opens the verify_url in the user's browser and starts polling
//      GET /auth/check?session_id=...&secret=... every ~2s.
//   3. Browser page uses Supabase JS SDK (anon key) to take email input and
//      call signInWithOtp({ email, emailRedirectTo: ".../auth/callback?session_id=..." }).
//      Supabase emails the user a magic link.
//   4. User clicks the magic link → lands on /auth/callback which serves a
//      minimal HTML that uses the Supabase JS SDK to exchange the URL-hash
//      tokens into a session, then POSTs { access_token, refresh_token,
//      session_id, secret } to /auth/complete.
//   5. /auth/complete validates the access_token by calling Supabase
//      /auth/v1/user; on success it records the user_id + access_token in
//      the in-memory session map.
//   6. CLI's next /auth/check poll returns { status: "verified", ... }
//      including the access token. CLI caches it and proceeds.
//
// All session state is in-memory. Sessions expire after 10 min of pending
// or 24h of verified (verified sessions are just a cache — the access token
// is the real credential).

const AUTH_SESSION_TTL_MS = 10 * 60 * 1000;          // pending timeout
const AUTH_VERIFIED_TTL_MS = 24 * 60 * 60 * 1000;    // cache timeout
const authSessions = new Map();
// Map<session_id, {
//   secret: string,              // returned to CLI, required on poll
//   status: 'pending'|'verified'|'expired',
//   createdAt: ms,
//   verifiedAt: ms|null,
//   email: string|null,
//   userId: string|null,
//   accessToken: string|null,
//   refreshToken: string|null,
// }>

setInterval(() => {
  const now = Date.now();
  for (const [id, sess] of authSessions) {
    if (sess.status === 'pending' && now - sess.createdAt > AUTH_SESSION_TTL_MS) {
      authSessions.delete(id);
    } else if (sess.status === 'verified' && now - sess.verifiedAt > AUTH_VERIFIED_TTL_MS) {
      authSessions.delete(id);
    }
  }
}, 60_000).unref();

function createAuthSession() {
  const id = crypto.randomBytes(16).toString('hex');
  const secret = crypto.randomBytes(24).toString('hex');
  const sess = {
    secret,
    status: 'pending',
    createdAt: Date.now(),
    verifiedAt: null,
    email: null,
    userId: null,
    accessToken: null,
    refreshToken: null,
  };
  authSessions.set(id, sess);
  return { id, secret };
}

// Cache of { accessToken -> {user, validatedAt} } with a 60s TTL so each
// /deploy doesn't roundtrip to Supabase for the same token.
const jwtValidationCache = new Map();
const JWT_CACHE_TTL_MS = 60_000;

async function validateSupabaseAccessToken(accessToken) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error('backend misconfigured: SUPABASE_URL / SUPABASE_ANON_KEY not set');
  }
  // Cache check
  const cached = jwtValidationCache.get(accessToken);
  if (cached && Date.now() - cached.validatedAt < JWT_CACHE_TTL_MS) {
    return cached.user;
  }
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'apikey': SUPABASE_ANON_KEY,
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 401) {
    const err = new Error('invalid or expired access token');
    err.status = 401;
    throw err;
  }
  if (!res.ok) {
    throw new Error(`Supabase /auth/v1/user returned ${res.status}`);
  }
  const user = await res.json();
  if (!user?.id || !user?.email) {
    throw new Error('Supabase user response missing id/email');
  }
  const minimal = { id: user.id, email: user.email, emailConfirmed: !!user.email_confirmed_at };
  jwtValidationCache.set(accessToken, { user: minimal, validatedAt: Date.now() });
  // Bound the cache
  if (jwtValidationCache.size > 500) {
    const oldest = [...jwtValidationCache.entries()].sort((a, b) => a[1].validatedAt - b[1].validatedAt)[0];
    if (oldest) jwtValidationCache.delete(oldest[0]);
  }
  return minimal;
}

// Resolve the PUBLIC_BACKEND_URL for /auth/page links — either from env or
// from the incoming request's Host header. Default protocol to https for
// public hosts; http for localhost/LAN so local dev actually works.
function publicBackendUrl(req) {
  if (PUBLIC_BACKEND_URL) return PUBLIC_BACKEND_URL;
  const host = (req.headers['host'] || '').toString();
  if (!host) return '';
  const xfp = (req.headers['x-forwarded-proto'] || '').toString().split(',')[0].trim();
  let proto = xfp;
  if (!proto) {
    // Default based on host: loopback/private → http, everything else → https.
    if (/^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?$/i.test(host)) proto = 'http';
    else proto = 'https';
  }
  return `${proto}://${host}`;
}

// ---------- rate limiter + daily deploy cap ----------
//
// Two layers:
//   1. Per-minute sliding window keyed by IP — burst protection. Every
//      authenticated POST /deploy counts, even rejected/failed ones.
//   2. Daily counters (per-IP and global) — cost containment. These only
//      count *new service creations*, recorded by dailyBumpCreate() after
//      the upsert flow in deploy() establishes isNewService=true.
//      Redeploys to existing services are free against the daily cap.

const rateBuckets = new Map();
const RATE_LIMIT = Number(process.env.RATE_LIMIT_PER_MIN || 6);

function rateLimited(ip) {
  const now = Date.now();
  const windowStart = now - 60_000;
  const hits = (rateBuckets.get(ip) || []).filter((t) => t > windowStart);
  hits.push(now);
  rateBuckets.set(ip, hits);
  return hits.length > RATE_LIMIT;
}
setInterval(() => {
  const cutoff = Date.now() - 60_000;
  for (const [ip, hits] of rateBuckets) {
    const kept = hits.filter((t) => t > cutoff);
    if (kept.length) rateBuckets.set(ip, kept);
    else rateBuckets.delete(ip);
  }
}, 60_000).unref();

const DAILY_LIMIT_PER_IP = Number(process.env.DAILY_LIMIT_PER_IP || 20);
const DAILY_LIMIT_GLOBAL = Number(process.env.DAILY_LIMIT_GLOBAL || 200);
// Daily bucket layout: { counts: Map<ip,int>, global: int, windowStart: ms }.
// Window rolls over every 24h since the server was last rolled.
let dailyBucket = { counts: new Map(), global: 0, windowStart: Date.now() };

function dailyWindowTick() {
  if (Date.now() - dailyBucket.windowStart >= 24 * 60 * 60 * 1000) {
    dailyBucket = { counts: new Map(), global: 0, windowStart: Date.now() };
  }
}
function dailyCount(ip) {
  dailyWindowTick();
  return { perIp: dailyBucket.counts.get(ip) || 0, global: dailyBucket.global };
}
// Check whether a new-service request would exceed either cap — but do NOT
// increment yet (we only bump after the deploy actually commits to creating
// a service). Returns the reason string if blocked, or null if allowed.
function dailyWouldExceed(ip) {
  const { perIp, global } = dailyCount(ip);
  if (global >= DAILY_LIMIT_GLOBAL) return 'global';
  if (perIp >= DAILY_LIMIT_PER_IP) return 'ip';
  return null;
}
function dailyBumpCreate(ip) {
  dailyWindowTick();
  dailyBucket.counts.set(ip, (dailyBucket.counts.get(ip) || 0) + 1);
  dailyBucket.global += 1;
}
function retryAfterSecondsUntilNextWindow() {
  const resetAt = dailyBucket.windowStart + 24 * 60 * 60 * 1000;
  return Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
}

// ---------- TTL cleanup of stale services ----------
//
// Every CLEANUP_INTERVAL_MIN minutes, list every service in the target
// project and delete those whose most recent deployment finished more than
// SERVICE_TTL_HOURS hours ago. A service with no latestDeployment at all
// (empty shell from a failed createService) gets its createdAt used instead.
//
// Safety: only touches services whose name starts with SERVICE_NAME_PREFIX
// (default "cd-"). Services created by other means — manual testing, other
// projects co-located, the backend's own `api` service if ever colocated —
// are left alone.

const SERVICE_TTL_HOURS = Number(process.env.SERVICE_TTL_HOURS || 24);
const CLEANUP_INTERVAL_MIN = Number(process.env.CLEANUP_INTERVAL_MIN || 30);

async function runCleanupTick() {
  if (!CD_TARGET_TOKEN || !CD_TARGET_PROJECT_ID || !CD_TARGET_ENVIRONMENT_ID) {
    return;
  }
  const cutoff = Date.now() - SERVICE_TTL_HOURS * 60 * 60 * 1000;
  let listed, deleted = 0, kept = 0, skipped = 0;
  try {
    listed = await listServicesWithActivityGQL();
  } catch (err) {
    console.warn(`[claude-deploy] cleanup tick: list failed: ${(err.message || '').slice(0, 200)}`);
    return;
  }
  for (const svc of listed) {
    if (!svc.name || !svc.name.startsWith(`${SERVICE_NAME_PREFIX}-`)) {
      skipped += 1;
      continue;
    }
    const activityIso = svc.latestDeployedAt || svc.createdAt;
    const activityMs = activityIso ? Date.parse(activityIso) : 0;
    if (!activityMs || activityMs > cutoff) {
      kept += 1;
      continue;
    }
    const ok = await deleteServiceGQL(svc.id);
    if (ok) {
      deleted += 1;
      console.log(`[claude-deploy] cleanup tick: deleted ${svc.name} (last activity ${activityIso})`);
    }
  }
  console.log(`[claude-deploy] cleanup tick: deleted=${deleted} kept=${kept} skipped=${skipped} ttl=${SERVICE_TTL_HOURS}h`);
}

// Kick off the cleanup loop. First run happens after a short delay so the
// server fully boots before we start hammering GraphQL.
setTimeout(() => {
  runCleanupTick().catch((err) => console.warn(`[claude-deploy] cleanup initial tick failed: ${err.message}`));
  setInterval(() => {
    runCleanupTick().catch((err) => console.warn(`[claude-deploy] cleanup tick failed: ${err.message}`));
  }, CLEANUP_INTERVAL_MIN * 60 * 1000).unref();
}, 15_000).unref();

// ---------- /auth/* routes ----------

function htmlResponse(res, status, html) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    'Cache-Control': 'no-store',
  });
  res.end(html);
}

// Minimal auth page — renders in the user's browser. Uses Supabase JS SDK
// from the CDN. Shows an email input, sends a magic link, then after the
// redirect back, hands the access token to the backend.
function renderAuthPage({ sessionId, secret, backendUrl }) {
  const safeSession = String(sessionId).replace(/[^a-f0-9]/gi, '');
  const safeSecret = String(secret).replace(/[^a-f0-9]/gi, '');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>claude-deploy · sign in</title>
<style>
  :root { color-scheme: light; }
  body { font-family: -apple-system, ui-sans-serif, system-ui, sans-serif; max-width: 460px; margin: 4rem auto; padding: 0 1rem; color: #0f172a; line-height: 1.5; }
  h1 { font-size: 1.75rem; margin: 0 0 .5rem; }
  p { color: #475569; margin: .4rem 0 1rem; }
  form { display: flex; gap: .5rem; margin-top: 1.25rem; }
  input[type=email] { flex: 1; padding: .7rem .9rem; border: 1px solid #cbd5e1; border-radius: 8px; font-size: 1rem; }
  button { padding: .7rem 1.1rem; background: #0f172a; color: #fff; border: 0; border-radius: 8px; font-size: 1rem; cursor: pointer; }
  button:disabled { opacity: .6; cursor: default; }
  .hint { font-size: .85rem; color: #64748b; margin-top: .5rem; }
  .status { margin-top: 1.25rem; padding: .9rem 1rem; border-radius: 10px; font-size: .95rem; display: none; }
  .status.info { display: block; background: #eff6ff; color: #1e3a8a; border: 1px solid #bfdbfe; }
  .status.ok   { display: block; background: #ecfdf5; color: #065f46; border: 1px solid #a7f3d0; }
  .status.err  { display: block; background: #fef2f2; color: #7f1d1d; border: 1px solid #fecaca; }
  code { background: #f1f5f9; padding: .1rem .35rem; border-radius: 4px; font-size: .9em; }
  .foot { margin-top: 2rem; font-size: .8rem; color: #94a3b8; }
</style>
</head>
<body>
  <h1>claude-deploy</h1>
  <p>Sign in with your email to deploy. You'll get a magic link — click it and you're back in the terminal.</p>

  <form id="f">
    <input id="email" type="email" required autocomplete="email" placeholder="you@example.com" />
    <button id="go" type="submit">Send link</button>
  </form>
  <div class="hint">Session: <code id="sessionId"></code></div>
  <div id="status" class="status"></div>

  <div class="foot">No password needed. We only store the access token your <code>/deploy</code> command needs.</div>

<script type="module">
  import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

  const sessionId  = ${JSON.stringify(safeSession)};
  const sessionSecret = ${JSON.stringify(safeSecret)};
  const backendUrl = ${JSON.stringify(backendUrl)};
  const supabaseUrl = ${JSON.stringify(SUPABASE_URL)};
  const supabaseAnon = ${JSON.stringify(SUPABASE_ANON_KEY)};

  document.getElementById('sessionId').textContent = sessionId.slice(0, 8) + '…';

  const sb = createClient(supabaseUrl, supabaseAnon, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, flowType: 'pkce' },
  });

  const statusEl = document.getElementById('status');
  function setStatus(kind, msg) { statusEl.className = 'status ' + kind; statusEl.textContent = msg; }

  async function completeWithSession(sess) {
    if (!sess || !sess.access_token) { setStatus('err', 'No access token returned.'); return; }
    setStatus('info', 'Verifying with claude-deploy backend…');
    const r = await fetch(backendUrl + '/auth/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: sessionId,
        secret: sessionSecret,
        access_token: sess.access_token,
        refresh_token: sess.refresh_token || null,
      }),
    });
    if (!r.ok) {
      const body = await r.text();
      setStatus('err', 'Backend rejected session: ' + body.slice(0, 200));
      return;
    }
    setStatus('ok', '✅ Signed in! You can close this tab and return to your terminal.');
  }

  // Case 1: we're redirected back from the magic link. Supabase puts the
  // tokens in the URL hash. Exchange the hash and push back to backend.
  if (location.hash.includes('access_token=')) {
    const params = new URLSearchParams(location.hash.slice(1));
    const sess = {
      access_token: params.get('access_token'),
      refresh_token: params.get('refresh_token'),
    };
    completeWithSession(sess).catch(e => setStatus('err', 'Error: ' + e.message));
  }

  // Case 2: fresh page load — show the form.
  document.getElementById('f').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const email = document.getElementById('email').value.trim();
    if (!email) return;
    const btn = document.getElementById('go');
    btn.disabled = true;
    setStatus('info', 'Sending magic link to ' + email + '…');
    try {
      const redirectTo = backendUrl + '/auth/page?session_id=' + encodeURIComponent(sessionId) + '&secret=' + encodeURIComponent(sessionSecret);
      const { error } = await sb.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: redirectTo, shouldCreateUser: true },
      });
      if (error) throw error;
      setStatus('ok', '📬 Check your inbox at ' + email + ' and click the link. This tab will update automatically.');
    } catch (e) {
      setStatus('err', 'Failed to send link: ' + (e.message || e));
      btn.disabled = false;
    }
  });
</script>
</body>
</html>`;
}

async function handleAuthRoute(req, res, pathname, url, qs) {
  const backendUrl = publicBackendUrl(req);

  // POST /auth/start — create a session, return session_id + verify_url
  if (req.method === 'POST' && pathname === '/auth/start') {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      return jsonResponse(res, 500, { error: 'auth not configured on this backend' });
    }
    const { id, secret } = createAuthSession();
    const verify_url = `${backendUrl}/auth/page?session_id=${id}&secret=${secret}`;
    return jsonResponse(res, 200, {
      session_id: id,
      secret,
      verify_url,
      poll_url: `${backendUrl}/auth/check?session_id=${id}&secret=${secret}`,
      expires_in: Math.floor(AUTH_SESSION_TTL_MS / 1000),
    });
  }

  // GET /auth/check — CLI polls this. Returns pending or verified + access_token.
  if (req.method === 'GET' && pathname === '/auth/check') {
    const sid = qs.get('session_id') || '';
    const secret = qs.get('secret') || '';
    const sess = authSessions.get(sid);
    if (!sess) {
      return jsonResponse(res, 404, { status: 'unknown', error: 'session not found or expired' });
    }
    if (sess.secret !== secret) {
      return jsonResponse(res, 403, { status: 'forbidden', error: 'session secret mismatch' });
    }
    if (sess.status === 'pending') {
      return jsonResponse(res, 200, { status: 'pending', expires_in: Math.max(0, Math.floor((sess.createdAt + AUTH_SESSION_TTL_MS - Date.now()) / 1000)) });
    }
    if (sess.status === 'verified') {
      return jsonResponse(res, 200, {
        status: 'verified',
        access_token: sess.accessToken,
        refresh_token: sess.refreshToken,
        email: sess.email,
        user_id: sess.userId,
      });
    }
    return jsonResponse(res, 410, { status: sess.status });
  }

  // GET /auth/page?session_id=...&secret=... — render the sign-in UI.
  // Also handles the magic-link redirect (tokens in URL hash, client-side JS
  // picks them up and POSTs to /auth/complete).
  if (req.method === 'GET' && pathname === '/auth/page') {
    const sid = qs.get('session_id') || '';
    const secret = qs.get('secret') || '';
    const sess = authSessions.get(sid);
    if (!sess || sess.secret !== secret) {
      return htmlResponse(res, 404, `<!doctype html><html><body style="font-family:system-ui;max-width:460px;margin:4rem auto;padding:0 1rem"><h1>Session expired</h1><p>Please run <code>/deploy</code> again to start a new sign-in session.</p></body></html>`);
    }
    return htmlResponse(res, 200, renderAuthPage({ sessionId: sid, secret, backendUrl }));
  }

  // POST /auth/complete — receives the access_token from the browser page.
  // Validates it against Supabase, then marks the session verified.
  if (req.method === 'POST' && pathname === '/auth/complete') {
    let body;
    try {
      const raw = await readBody(req, 16 * 1024);
      body = JSON.parse(raw.toString('utf-8'));
    } catch {
      return jsonResponse(res, 400, { error: 'invalid JSON body' });
    }
    const { session_id, secret, access_token, refresh_token } = body || {};
    if (!session_id || !secret || !access_token) {
      return jsonResponse(res, 400, { error: 'missing session_id, secret, or access_token' });
    }
    const sess = authSessions.get(session_id);
    if (!sess || sess.secret !== secret) {
      return jsonResponse(res, 403, { error: 'session not found or secret mismatch' });
    }
    let user;
    try {
      user = await validateSupabaseAccessToken(access_token);
    } catch (err) {
      return jsonResponse(res, 401, { error: 'access token rejected by Supabase', detail: (err.message || '').slice(0, 200) });
    }
    if (!user.emailConfirmed) {
      return jsonResponse(res, 403, {
        error: 'email not verified',
        detail: 'Click the confirmation link in your inbox, then retry.',
      });
    }
    sess.status = 'verified';
    sess.verifiedAt = Date.now();
    sess.email = user.email;
    sess.userId = user.id;
    sess.accessToken = access_token;
    sess.refreshToken = refresh_token || null;
    console.log(`[claude-deploy] auth verified session=${session_id.slice(0, 8)}… user=${user.email}`);
    return jsonResponse(res, 200, { ok: true, user: { id: user.id, email: user.email } });
  }

  return jsonResponse(res, 404, { error: 'not found' });
}

// ---------- HTTP server ----------

const VERSION = '0.3.1';
const MAINTENANCE_MODE = process.env.CD_MAINTENANCE === '1' || process.env.CD_MAINTENANCE === 'true';

const server = http.createServer(async (req, res) => {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
  const started = Date.now();
  const log = (msg) => console.log(`[claude-deploy] ${req.method} ${req.url} ip=${ip} ${msg}`);

  // Parse URL + search params once
  let url;
  try {
    url = new URL(req.url || '/', publicBackendUrl(req) || `http://${req.headers.host || 'localhost'}`);
  } catch {
    return jsonResponse(res, 400, { error: 'bad request url' });
  }
  const pathname = url.pathname;
  const qs = url.searchParams;

  try {
    // ----- basic/status -----
    if (req.method === 'GET' && pathname === '/health') {
      return jsonResponse(res, 200, { ok: true, version: VERSION });
    }
    if (req.method === 'GET' && pathname === '/') {
      const daily = dailyCount(ip);
      return jsonResponse(res, 200, {
        service: 'claude-deploy',
        version: VERSION,
        endpoints: ['POST /deploy', 'POST /auth/start', 'GET /auth/check', 'GET /auth/page', 'GET /auth/callback', 'POST /auth/complete', 'GET /health'],
        maintenance: MAINTENANCE_MODE,
        ttl_hours: SERVICE_TTL_HOURS,
        daily_limit_per_user: DAILY_LIMIT_PER_IP, // label change for clarity; env var stays
        daily_limit_global: DAILY_LIMIT_GLOBAL,
        daily_used_your_ip: daily.perIp,
        daily_used_global: daily.global,
        auth: SUPABASE_URL ? 'supabase' : 'unconfigured',
      });
    }

    // ----- auth flow -----
    if (pathname.startsWith('/auth/')) {
      return await handleAuthRoute(req, res, pathname, url, qs);
    }

    if (!(req.method === 'POST' && pathname === '/deploy')) {
      return jsonResponse(res, 404, { error: 'not found' });
    }

    // Kill switch — operator can pause the public backend without touching code.
    if (MAINTENANCE_MODE) {
      return jsonResponse(res, 503, {
        error: 'hosted claude-deploy backend is temporarily paused for maintenance',
        detail: 'see https://github.com/c2w-ai/claude-deploy or self-host (docs/SELFHOST.md)',
      });
    }

    // Authenticate the caller. With Supabase configured we REQUIRE a valid
    // access token in Authorization: Bearer <token>. Without Supabase
    // configured, fall back to the shared CLIENT_TOKEN gate (backwards
    // compat for local development).
    let authUser = null;
    if (SUPABASE_URL && SUPABASE_ANON_KEY) {
      const accessToken = extractBearerToken(req);
      if (!accessToken) {
        return jsonResponse(res, 401, {
          error: 'authentication required',
          detail: 'Run /deploy and complete the email sign-in flow. Your session token will be cached locally.',
        });
      }
      try {
        authUser = await validateSupabaseAccessToken(accessToken);
      } catch (err) {
        return jsonResponse(res, 401, {
          error: 'invalid or expired session',
          detail: 'Your session token was rejected. Run /deploy again to sign in.',
        });
      }
      if (!authUser.emailConfirmed) {
        return jsonResponse(res, 403, {
          error: 'email not verified',
          detail: 'Check your inbox for the verification link we sent and click it, then run /deploy again.',
        });
      }
    } else if (!checkAuth(req)) {
      return jsonResponse(res, 401, { error: 'unauthorized' });
    }

    if (rateLimited(ip)) {
      return jsonResponse(res, 429, { error: 'rate limit exceeded (per-minute burst limit)' });
    }
    if (!CD_TARGET_TOKEN || !CD_TARGET_PROJECT_ID || !CD_TARGET_ENVIRONMENT_ID) {
      return jsonResponse(res, 500, {
        error: 'backend misconfigured: CD_TARGET_TOKEN, CD_TARGET_PROJECT_ID, and CD_TARGET_ENVIRONMENT_ID must all be set',
      });
    }

    const projectNameHeader = (req.headers['x-project-name'] || 'app').toString();
    const projectSlugHeader = (req.headers['x-project-slug'] || '').toString();
    // Authenticated user_id takes precedence over X-Claude-Deploy-Client for
    // the upsert key. This makes deploys portable across machines (same
    // account = same URL) and makes per-user quotas meaningful.
    const clientIdHeader = (req.headers['x-claude-deploy-client'] || '').toString();
    const upsertIdentity = authUser ? `u:${authUser.id}` : (clientIdHeader ? `c:${clientIdHeader}` : '');
    const canUpsert = Boolean(upsertIdentity && projectSlugHeader);

    // Daily cap bucket key: per-user when authenticated, per-IP otherwise.
    const bucketKey = authUser ? `u:${authUser.id}` : ip;

    // If this request is going to create a NEW service, check the daily cap
    // BEFORE we accept the body. Upsert requests always pass.
    if (!canUpsert) {
      const reason = dailyWouldExceed(bucketKey);
      if (reason) {
        const retry = retryAfterSecondsUntilNextWindow();
        const which = reason === 'global' ? 'global daily cap' : (authUser ? 'your account daily cap' : 'your IP daily cap');
        console.warn(`[claude-deploy] daily cap hit key=${bucketKey} reason=${reason}`);
        res.setHeader('Retry-After', String(retry));
        return jsonResponse(res, 429, {
          error: `${which} reached — try again in ${Math.ceil(retry / 3600)}h, or self-host the backend (see README)`,
          limit_per_user: DAILY_LIMIT_PER_IP,
          limit_global: DAILY_LIMIT_GLOBAL,
          retry_after_s: retry,
        });
      }
    }

    const body = await readBody(req, MAX_UPLOAD_BYTES);

    if (body.length < 64) {
      return jsonResponse(res, 400, { error: 'tarball is empty or truncated' });
    }
    if (!(body[0] === 0x1f && body[1] === 0x8b)) {
      return jsonResponse(res, 400, { error: 'body is not a gzip stream' });
    }

    log(`bytes=${body.length} project=${projectNameHeader} user=${authUser?.email || '(anon)'} upsert=${canUpsert}`);

    const result = await deploy(body, {
      projectNameHint: projectNameHeader,
      clientId: upsertIdentity || null,
      projectSlug: projectSlugHeader || null,
    });

    // Only count new service creations against the daily cap. Redeploys to
    // an existing service are free.
    if (result.isNewService) {
      dailyBumpCreate(bucketKey);
    }

    const elapsedMs = Date.now() - started;
    log(`done url=${result.url} isNew=${result.isNewService} elapsed=${elapsedMs}ms`);

    return jsonResponse(res, 200, {
      ...result,
      elapsedMs,
    });
  } catch (err) {
    console.error(`[claude-deploy] error:`, err);
    // Translate persistent upstream platform failures into a clean 503 so
    // clients show "hosting is temporarily down, try again" instead of a
    // scary 500 with internals.
    if (isTransientRailwayError(err)) {
      return jsonResponse(res, 503, {
        error: 'Hosting platform is temporarily unavailable. Please try /deploy again in a minute.',
        detail: sanitizeForClient((err.message || '').slice(0, 300)),
      });
    }
    const status = err.status || 500;
    const payload = { error: sanitizeForClient(err.message || 'internal error') };
    if (err.stderr) payload.stderr = sanitizeForClient(tail(err.stderr, 20));
    if (err.stdout) payload.stdout = sanitizeForClient(tail(err.stdout, 20));
    return jsonResponse(res, status, payload);
  }
});

server.requestTimeout = 20 * 60 * 1000;
server.headersTimeout = 21 * 60 * 1000;

// Only start listening when run as the entry point (not when imported by tests).
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`[claude-deploy] backend listening on :${PORT}`);
  });
}

// ---------- exports for tests ----------

module.exports = {
  server,
  // pure helpers
  sanitizeName,
  genServiceName,
  deriveServiceName,
  checkAuth,
  rateLimited,
  isTransientRailwayError,
  isUploadPhaseError,
  sanitizeForClient,
  tail,
  // server factory for isolated tests
  _createServerForTest: () => server,
};
