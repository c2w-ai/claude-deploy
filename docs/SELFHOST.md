# Self-hosting the claude-deploy backend

By default, the `claude-deploy` plugin points at a shared hosted backend that the maintainers run. This document is for operators who want to run their own backend — either to control their own hosting bill, remove the shared daily cap, or customize the behavior.

The backend is a zero-dependency Node 20 server in `backend/`. It exposes `POST /deploy`, extracts a gzipped tarball, and deploys it to a Railway project you own. (Railway is the current hosting provider under the hood; a future version will abstract this further.)

---

## 1. Create two Railway projects

You want two projects (they can be in the same workspace):

1. **backend project** — where the `claude-deploy` backend itself runs (one service, `api`).
2. **user-apps project** — the target where the backend creates a new service per user deploy.

Note each project's UUID.

## 2. Create a Railway account token (temporary, just to mint a project token)

At https://railway.com/account/tokens create an account/team token with access to the user-apps project.

## 3. Create a project token for user-apps

Using the Railway GraphQL API (from a shell that has the account token):

```bash
curl -sS -X POST https://backboard.railway.com/graphql/v2 \
  -H "Authorization: Bearer $RAILWAY_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "mutation($i: ProjectTokenCreateInput!) { projectTokenCreate(input: $i) }",
    "variables": { "i": {
      "projectId": "<user-apps-project-uuid>",
      "environmentId": "<user-apps-production-env-uuid>",
      "name": "claude-deploy-backend"
    } }
  }'
```

The response contains the token string — save it, that's `CD_TARGET_TOKEN`. You can discard the account token afterwards; the backend never needs it.

## 4. Deploy the backend

```bash
cd backend
railway link -p <backend-project-id> -e production
railway add --service api
railway variables --service api \
  --set "CD_TARGET_TOKEN=<token-from-step-3>" \
  --set "CD_TARGET_PROJECT_ID=<user-apps-project-uuid>" \
  --set "CD_TARGET_ENVIRONMENT_ID=<user-apps-production-env-uuid>" \
  --set "SUPABASE_URL=<your-supabase-url>" \
  --set "SUPABASE_ANON_KEY=<your-supabase-anon-key>" \
  --skip-deploys
railway up --ci --service api
railway domain --service api
```

### Backend env vars

| Variable | Required | Description |
|---|---|---|
| `CD_TARGET_TOKEN` | ✅ | Project token scoped to the user-apps project + environment. Used for both the CLI subprocess (`RAILWAY_TOKEN` env) and GraphQL API calls (`Project-Access-Token` header). |
| `CD_TARGET_PROJECT_ID` | ✅ | UUID of the user-apps project. Required for GraphQL mutations. |
| `CD_TARGET_ENVIRONMENT_ID` | ✅ | UUID of the target environment in the user-apps project. |
| `SUPABASE_URL` | ✅ | Supabase project URL, e.g. `https://xxx.supabase.co`. Used for auth (JWT validation + magic link send). |
| `SUPABASE_ANON_KEY` | ✅ | Supabase publishable/anon key. Used by the browser auth page and by the backend to call `/auth/v1/user` for JWT validation. |
| `CD_MAINTENANCE` | no | Set to `1` to pause `POST /deploy` — returns 503 with a maintenance message. Kill switch for abuse spikes. |
| `SERVICE_TTL_HOURS` | no | Default `24`. Services whose last deployment is older than this are auto-deleted by the TTL job. |
| `CLEANUP_INTERVAL_MIN` | no | Default `30`. How often the TTL cleanup job runs. |
| `DAILY_LIMIT_PER_USER` | no | Default `20`. Max new service creations per authenticated user per 24h window. Redeploys to existing services don't count. |
| `DAILY_LIMIT_GLOBAL` | no | Default `200`. Hard ceiling on new services per day across all users. |
| `RATE_LIMIT_PER_MIN` | no | Default `6`. Per-minute burst cap per IP (sliding window). |
| `MAX_UPLOAD_BYTES` | no | Default `52428800` (50 MB). |
| `DEPLOY_TIMEOUT_MS` | no | Default `900000` (15 min). |
| `SERVICE_NAME_PREFIX` | no | Default `cd`. Only services whose name starts with `<prefix>-` are touched by the TTL cleanup job. |

> **Why a project token instead of an account token?** When the backend is itself hosted on Railway, the `railway` CLI inside the container ignores `--project` flags and silently routes every command to the backend's OWN project — even if you `railway link` to a different one. A project-scoped token encodes the target project and environment in the token itself, so the CLI has no opportunity to pick the wrong place.

## 5. Configure Supabase

1. Create a Supabase project at https://supabase.com (or reuse an existing one).
2. **Enable Email auth**: Authentication → Providers → Email → enabled. Leave "Confirm email" ON (default).
3. **Site URL + Redirect allowlist** — this is the most failure-prone step. The magic-link emails that Supabase sends need to redirect back to your backend's `/auth/page`, so the backend URL must be in the allowlist. Two ways to set it:

   **Option A — via the Dashboard**: Authentication → URL Configuration
   - Site URL: `https://<your-backend>.up.railway.app` (or your custom domain)
   - Redirect URLs: add `https://<your-backend>.up.railway.app/**`

   **Option B — via the Management API** (scriptable):
   ```bash
   SBP_TOKEN=<your Supabase personal access token, sbp_...>
   REF=<your project ref>
   curl -sS -X PATCH "https://api.supabase.com/v1/projects/$REF/config/auth" \
     -H "Authorization: Bearer $SBP_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{
       "site_url": "https://<your-backend>.up.railway.app",
       "uri_allow_list": "https://<your-backend>.up.railway.app/**,http://localhost:*/**,http://127.0.0.1:*/**"
     }'
   ```

   If the allowlist is empty, clicking the magic link lands on Supabase's default site (localhost:3000) and the CLI will hang waiting forever. If you see users complaining that `/deploy` "never returns" after sign-in, **check this first**.

4. Get the project URL + publishable (anon) key: Project Settings → API. Set those as `SUPABASE_URL` and `SUPABASE_ANON_KEY` on your backend. You do NOT need the service role key for the default flow — the backend's JWT validation uses the public `/auth/v1/user` endpoint which accepts the user's own access token as auth.

## 6. Point the plugin at your backend

Either:
- Fork this repo and update `BACKEND_URL` in `scripts/deploy.sh`, or
- Instruct users to `export CLAUDE_DEPLOY_BACKEND=https://yours.up.railway.app` before launching Claude Code.

## 7. Run locally for development

```bash
export CD_TARGET_TOKEN=<your project token>
export CD_TARGET_PROJECT_ID=<uuid>
export CD_TARGET_ENVIRONMENT_ID=<uuid>
export SUPABASE_URL=https://xxx.supabase.co
export SUPABASE_ANON_KEY=eyJ...
bash scripts/run-backend-local.sh
# in another shell, from any project:
CLAUDE_DEPLOY_BACKEND=http://localhost:3030 bash scripts/deploy.sh
```

## 8. Run the backend test suite

```bash
cd backend
npm test
```

Offline tests: routing, auth, rate limit, body validation, helper functions. Does not touch the hosting provider or Supabase.

---

## Security notes

- The backend holds a project token with write access to one hosting project + environment. Host the backend somewhere you trust.
- Authenticated users are identified by a Supabase JWT; the daily cap and upsert key are both scoped per-user (not per-IP), so a user changing IPs doesn't reset their state.
- `CD_MAINTENANCE=1` kill switch lets you pause the backend in 30 seconds without touching code.
- TTL cleanup runs automatically (default: every 30 min, 24h TTL) — services with no recent activity get auto-deleted. This is the primary cost-bounding mechanism.
- The backend does **not** sandbox user code. User apps are deployed as regular containerized services, billed to the backend operator's hosting account.
- User code runs with no network or filesystem isolation beyond the provider's own container boundaries. Don't use this as a trusted execution environment.

---

## Architecture

```
+---------------------+        POST /deploy (gzipped tarball + JWT)
|   Claude Code user  |  ───────────────────────────────────▶  +---------------------+
|   /deploy           |                                        |  claude-deploy      |
|  (plugin)           |  ◀───────────────────────────────────  |  backend (Node)     |
+---------------------+           { "url": "https://..." }     +----------+----------+
                                                                          │
                                                          ┌───────────────┼────────────────┐
                                                          ▼               │                ▼
                                                  +--------------+        │       +---------------+
                                                  |   Supabase   |        │       |  hosting      |
                                                  |   Auth       |        │       |  provider     |
                                                  | (JWT valid,  |        │       | (Railway      |
                                                  |  magic link) |        │       |  under hood)  |
                                                  +--------------+        │       +---------------+
                                                                          │
                                                              ├─ createServiceGQL (via project token)
                                                              ├─ railway up --ci --service <name>
                                                              └─ createDomainGQL
```
