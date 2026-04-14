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

function warnMissingEnv() {
  const missing = [];
  if (!CD_TARGET_TOKEN) missing.push('CD_TARGET_TOKEN');
  if (!CD_TARGET_PROJECT_ID) missing.push('CD_TARGET_PROJECT_ID');
  if (!CD_TARGET_ENVIRONMENT_ID) missing.push('CD_TARGET_ENVIRONMENT_ID');
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
      logTail: tail(up.stdout + '\n' + up.stderr, 20),
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

// ---------- HTTP server ----------

const VERSION = '0.2.0';
const MAINTENANCE_MODE = process.env.CD_MAINTENANCE === '1' || process.env.CD_MAINTENANCE === 'true';

const server = http.createServer(async (req, res) => {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
  const started = Date.now();
  const log = (msg) => console.log(`[claude-deploy] ${req.method} ${req.url} ip=${ip} ${msg}`);

  try {
    if (req.method === 'GET' && req.url === '/health') {
      return jsonResponse(res, 200, { ok: true, version: VERSION });
    }
    if (req.method === 'GET' && req.url === '/') {
      const daily = dailyCount(ip);
      return jsonResponse(res, 200, {
        service: 'claude-deploy',
        version: VERSION,
        endpoints: ['POST /deploy', 'GET /health'],
        maintenance: MAINTENANCE_MODE,
        ttl_hours: SERVICE_TTL_HOURS,
        daily_limit_per_ip: DAILY_LIMIT_PER_IP,
        daily_limit_global: DAILY_LIMIT_GLOBAL,
        daily_used_your_ip: daily.perIp,
        daily_used_global: daily.global,
      });
    }
    if (!(req.method === 'POST' && req.url === '/deploy')) {
      return jsonResponse(res, 404, { error: 'not found' });
    }

    // Kill switch — operator can pause the public backend without touching code.
    if (MAINTENANCE_MODE) {
      return jsonResponse(res, 503, {
        error: 'hosted claude-deploy backend is temporarily paused for maintenance',
        detail: 'see https://github.com/c2w-ai/claude-deploy or self-host (docs/SELFHOST.md)',
      });
    }

    if (!checkAuth(req)) {
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
    const clientIdHeader = (req.headers['x-claude-deploy-client'] || '').toString();
    const projectSlugHeader = (req.headers['x-project-slug'] || '').toString();
    const canUpsert = Boolean(clientIdHeader && projectSlugHeader);

    // If this request is going to create a NEW service, check the daily cap
    // BEFORE we accept the body. Upsert requests that reuse an existing
    // service always pass this check — their cost is already booked.
    if (!canUpsert) {
      const reason = dailyWouldExceed(ip);
      if (reason) {
        const retry = retryAfterSecondsUntilNextWindow();
        const which = reason === 'global' ? 'global daily cap' : 'your IP daily cap';
        console.warn(`[claude-deploy] daily cap hit ip=${ip} reason=${reason} count=${JSON.stringify(dailyCount(ip))}`);
        res.setHeader('Retry-After', String(retry));
        return jsonResponse(res, 429, {
          error: `${which} reached — try again in ${Math.ceil(retry / 3600)}h, or self-host the backend (see README)`,
          limit_per_ip: DAILY_LIMIT_PER_IP,
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

    log(`bytes=${body.length} project=${projectNameHeader} upsert=${canUpsert}`);

    const result = await deploy(body, {
      projectNameHint: projectNameHeader,
      clientId: clientIdHeader || null,
      projectSlug: projectSlugHeader || null,
    });

    // Only count new service creations against the daily cap. Redeploys to
    // an existing service are free.
    if (result.isNewService) {
      dailyBumpCreate(ip);
    }

    const elapsedMs = Date.now() - started;
    log(`done url=${result.url} isNew=${result.isNewService} elapsed=${elapsedMs}ms`);

    return jsonResponse(res, 200, {
      ...result,
      elapsedMs,
    });
  } catch (err) {
    console.error(`[claude-deploy] error:`, err);
    // Translate persistent Railway platform failures into a clean 503 so
    // clients show "Railway appears to be down, try again" instead of a
    // scary 500 with internals.
    if (isTransientRailwayError(err)) {
      return jsonResponse(res, 503, {
        error: 'Railway platform is temporarily unavailable. Please try /deploy again in a minute.',
        detail: (err.message || '').slice(0, 300),
      });
    }
    const status = err.status || 500;
    const payload = { error: err.message || 'internal error' };
    if (err.stderr) payload.stderr = tail(err.stderr, 20);
    if (err.stdout) payload.stdout = tail(err.stdout, 20);
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
  tail,
  // server factory for isolated tests
  _createServerForTest: () => server,
};
