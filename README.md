# claude-deploy

Deploy any project to the web with **one Claude Code command**.

```
/deploy
```

…and you get back a public URL.

No signups. No Dockerfiles you didn't write. No Railway dashboard clicking. The plugin tarballs your current working directory, ships it to a hosted backend, and the backend creates (or updates) a Railway service, waits for the build to finish, then hands a public URL back to Claude Code.

---

## For end users

### Install (one-time)

In Claude Code:

```
/plugin marketplace add c2w-ai/claude-deploy
/plugin install claude-deploy@claude-deploy
```

> Installing from a local clone? Point marketplace add at the directory:
> `/plugin marketplace add /path/to/claude-deploy`.

### Use

From any project directory, inside Claude Code:

```
/deploy
```

You'll get back something like:

```
✅ Deployed: https://cd-a1b2c3d4-my-project-production.up.railway.app
```

Open the URL. That's it. **Run `/deploy` again from the same project to redeploy to the same URL** — no new service gets created, no new URL to share around, no daily-quota burn.

Pass an optional name hint for the project:

```
/deploy my-landing-page
```

Typical latency: **30–60 s** (most of which is Railway's Nixpacks/Railpack build).

### Limits (hosted backend)

This is a shared, free-tier hosted backend. Keep everyone honest:

| | |
|---|---|
| **Upload cap** | 50 MB (gzipped tarball) |
| **Inactivity TTL** | **24 hours** — deploys auto-expire if you haven't redeployed. Run `/deploy` again to refresh the clock. |
| **Daily new-service cap** | **20 per IP / 200 globally per day**. Redeploys to existing services DO NOT count against this. |
| **Burst rate limit** | 10 requests/min/IP |
| **Auth** | The plugin sends a shared bearer token by default. Operators running their own backend can require their own `CLAUDE_DEPLOY_TOKEN`. |

Need permanent deployments, a bigger daily budget, or to control your own Railway bill? Self-host the backend — see [`docs/SELFHOST.md`](docs/SELFHOST.md).

### How packaging works

- If your project is a git repo, the plugin respects `.gitignore` (uses `git ls-files`).
- Otherwise it tarballs the directory, excluding common build/cache dirs (`node_modules`, `.next`, `dist`, `venv`, etc.).
- Upload cap: 50 MB. Override with `CLAUDE_DEPLOY_MAX_MB=100` if your self-hosted backend allows it.
- No binary assets you don't need — put them in `.gitignore` first.

### How upsert works

On first run, the plugin writes a random UUID to `~/.claude-deploy/client-id`. This identifier + your project slug (derived from the git remote or directory name) forms the key for the Railway service name. Running `/deploy` again from the same project on the same machine routes to the same service, so you get the same URL. Clone the project to a different machine and you'll get a different URL — one per (machine, project).

### Using your own backend

By default the plugin points at the hosted backend. To point it at a self-hosted instance:

```bash
export CLAUDE_DEPLOY_BACKEND=https://my-claude-deploy.up.railway.app
export CLAUDE_DEPLOY_TOKEN=<client token, if your backend requires one>
claude        # launch Claude Code with the env in scope
```

The slash command reads those vars from the environment Claude Code was launched in.

### Status

The hosted backend exposes a JSON status page — useful for "is it up?" checks:

```
https://api-production-d9b7.up.railway.app/
```

Shows version, maintenance flag, TTL, daily cap, and your IP's current usage.

---

## For operators (hosting your own backend)

The backend is a zero-dependency Node 20 server in `backend/`. It exposes `POST /deploy`, extracts the tarball, shells out to the `railway` CLI to create a new service in your target Railway project, uploads the code, waits for the build, generates a domain, and returns the URL.

### 1. Create two Railway projects

You want two projects (they can be in the same workspace):

1. **backend project** — where the `claude-deploy` backend itself runs (one service, `api`).
2. **user-apps project** — the target where the backend creates a new service per user deploy.

Note each project's UUID.

### 2. Create a Railway token

At https://railway.com/account/tokens create an account/team token with access to the user-apps project. This is the `RAILWAY_API_TOKEN` the backend uses.

### 3. Create a project token for user-apps

Using the Railway GraphQL API (from a shell that has a valid `RAILWAY_API_TOKEN`):

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

The response contains the token string — save it, that's `CD_TARGET_TOKEN`.

### 4. Deploy the backend

```bash
cd backend
railway link -p <backend-project-id> -e production
railway add --service api
railway variables --service api \
  --set "CD_TARGET_TOKEN=<token-from-step-3>" \
  --skip-deploys
railway up --ci --service api
railway domain --service api
```

### Backend env vars

| Variable | Required | Description |
|---|---|---|
| `CD_TARGET_TOKEN` | ✅ | **Railway PROJECT token** scoped to the user-apps project + environment. Used for both the CLI subprocess (`RAILWAY_TOKEN` env) and GraphQL API calls (`Project-Access-Token` header). |
| `CD_TARGET_PROJECT_ID` | ✅ | UUID of the user-apps project. Required for GraphQL mutations. |
| `CD_TARGET_ENVIRONMENT_ID` | ✅ | UUID of the target environment in the user-apps project. |
| `CLIENT_TOKEN` | recommended | If set, clients must send `Authorization: Bearer <token>`. Set this before sharing the backend URL publicly. |
| `CD_MAINTENANCE` | no | Set to `1` to pause `POST /deploy` — returns 503 with a maintenance message. Kill switch for abuse spikes. |
| `SERVICE_TTL_HOURS` | no | Default `24`. Services whose last deployment is older than this are auto-deleted by the TTL job. |
| `CLEANUP_INTERVAL_MIN` | no | Default `30`. How often the TTL cleanup job runs. |
| `DAILY_LIMIT_PER_IP` | no | Default `20`. Max new service creations per IP per 24h window. Redeploys to existing services don't count. |
| `DAILY_LIMIT_GLOBAL` | no | Default `200`. Hard ceiling on new services per day across all IPs. |
| `RATE_LIMIT_PER_MIN` | no | Default `6`. Per-minute burst cap per IP (sliding window). |
| `MAX_UPLOAD_BYTES` | no | Default `52428800` (50 MB). |
| `DEPLOY_TIMEOUT_MS` | no | Default `900000` (15 min). How long `railway up --ci` is allowed to run before being killed. |
| `SERVICE_NAME_PREFIX` | no | Default `cd`. Only services whose name starts with `<prefix>-` are touched by the TTL cleanup job. |

> **Why a project token instead of an account token?** When the backend is itself hosted on Railway, the `railway` CLI inside the container ignores `--project` flags and silently routes every command to the backend's OWN project — even if you `railway link` to a different one. A project-scoped token encodes the target project and environment in the token itself, so the CLI has no opportunity to pick the wrong place.

### 5. Point the plugin at your backend

Either:
- Fork this repo and update `BACKEND_URL` in `scripts/deploy.sh`, or
- Instruct users to `export CLAUDE_DEPLOY_BACKEND=https://yours.up.railway.app` before launching Claude Code.

### 6. Run locally for development

```bash
bash scripts/run-backend-local.sh
# in another shell, from any project:
CLAUDE_DEPLOY_BACKEND=http://localhost:3030 bash scripts/deploy.sh
```

`run-backend-local.sh` defaults `CD_TARGET_TOKEN` to the shared project token baked into the repo (override with your own when hosting for real).

### 7. Run the backend test suite

```bash
cd backend
npm test   # 21 offline tests: routing, auth, rate limit, body validation,
           # sanitize/derive/gen helpers. Does not touch Railway.
```

The tests use Node's built-in `node:test` runner — zero dependencies.

---

## Security notes

- The backend holds a Railway project token with write access to a specific project + environment. Host it somewhere you trust.
- **Set `CLIENT_TOKEN`** before sharing your backend URL publicly. Without it, anyone who finds the URL can burn your daily cap. A shared-secret token is a rotation lever, not a security boundary — you can rotate it + redeploy when a specific abuser shows up.
- **Set a realistic `DAILY_LIMIT_GLOBAL`** tied to your Railway budget tolerance. Default is 200/day, which is defensive.
- **TTL cleanup runs automatically** (default: every 30 min, 24h TTL) — services with no recent activity get auto-deleted. This is the primary cost-bounding mechanism.
- **The `CD_MAINTENANCE=1` kill switch** lets you pause the public backend in 30 seconds without touching code.
- The backend does **not** sandbox user code. User apps are deployed as regular Railway services, billed to the backend operator's Railway account.
- User code runs with no network or filesystem isolation beyond Railway's own container boundaries. Don't use this as a trusted execution environment.

---

## Architecture

```
+---------------------+        POST /deploy (gzipped tarball + headers)
|   Claude Code user  |  ───────────────────────────────────▶  +---------------------+
|   /deploy           |                                        |  claude-deploy      |
|  (plugin)           |  ◀───────────────────────────────────  |  backend (Node)     |
+---------------------+           { "url": "https://..." }     +----------+----------+
                                                                          │
                                                          GraphQL (create/find/delete service,
                                                         create domain) + CLI (`railway up`)
                                                                          │
                                                                          ▼
                                                                  +--------------+
                                                                  |   Railway    |
                                                                  |  user-apps   |
                                                                  |   project    |
                                                                  +--------------+
```

Each `/deploy` call from a given `(client-id, project-slug)` pair upserts the same service named `cd-<clientHash8>-<slug>`. Repeat deploys of the same project update the existing service in place and return the same URL. A background TTL job deletes services whose last deployment finished more than 24h ago.

---

## Roadmap

- [x] Repeat `/deploy` updates same service / returns same URL (v0.2.0)
- [x] Hosted-backend TTL + daily cap + kill switch (v0.2.0)
- [ ] Stream Railway build logs back to the client during the deploy
- [ ] `/deploy --delete` subcommand to tear down a deployment from CLI
- [ ] `/deploy --list` to show current deploys for this client
- [ ] Static-site example with `examples/static-site/`
- [ ] E2E packaging tests for `scripts/deploy.sh`

## License

MIT
