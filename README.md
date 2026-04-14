# claude-deploy

Deploy any project to the web with **one Claude Code command**.

```
/deploy
```

…and you get back a public URL.

No signups with a cloud provider. No Dockerfiles you didn't write. No dashboards to click. The plugin tarballs your current working directory, ships it to a hosted build+run service, and returns a public URL you can share.

---

## Install (one-time)

In Claude Code:

```
/plugin marketplace add c2w-ai/claude-deploy
/plugin install claude-deploy@claude-deploy
```

> Installing from a local clone? Point marketplace add at the directory:
> `/plugin marketplace add /path/to/claude-deploy`.

---

## Use

From any project directory, inside Claude Code:

```
/deploy
```

On first run, a browser window opens asking you to sign in with email — click the magic link in your inbox, and the CLI automatically picks up where it left off. Subsequent `/deploy` calls from the same machine use the cached session.

You'll get back something like:

```
✅ Deployed: https://cd-a1b2c3d4-my-project-production.up.railway.app
```

Open the URL. That's it. **Run `/deploy` again from the same project to redeploy to the same URL** — no new URL to share around, no daily-quota burn.

Pass an optional name hint for the project:

```
/deploy my-landing-page
```

Typical first-deploy latency: **30–60 s** (most of which is the remote build).

## Manage your deploys

### `/deploy --list`

Show every deploy on your account:

```
/deploy --list
```

```
  2 deploys for you@example.com:

  ✓ my-landing    3m ago    https://cd-ff730846-my-landing-production.up.railway.app
  ✓ api-test      1d ago    https://cd-ff730846-api-test-production.up.railway.app

  Delete with: /deploy --delete <slug>
```

The list is scoped to your Supabase account — if you sign in on a different machine, you still see the same deploys.

### `/deploy --delete <slug>`

Tear down a deploy by its slug (the trailing part of the URL):

```
/deploy --delete api-test
```

Deletes the underlying hosted service and frees up one slot in your daily cap. You can only delete deploys you own — the backend verifies ownership via your Supabase user id before touching anything.

---

## Limits (hosted service)

This is a free, shared hosting service. Keep everyone honest:

| | |
|---|---|
| **Upload cap** | 50 MB (gzipped tarball) |
| **Inactivity TTL** | **24 hours** — deploys auto-expire if you haven't redeployed. Run `/deploy` again to refresh. |
| **Daily new-project cap** | **20 new projects per user / day**, 200 globally per day. **Redeploys to existing projects DO NOT count** against this. |
| **Burst rate limit** | 10 requests/min/IP |
| **Auth** | Email magic link via Supabase on first run; cached as a local token after that. |

Need permanent deployments, a bigger daily budget, or to control your own hosting bill? Self-host the backend — see [`docs/SELFHOST.md`](docs/SELFHOST.md).

---

## How packaging works

- If your project is a git repo, the plugin respects `.gitignore` (uses `git ls-files`).
- Otherwise it tarballs the directory, excluding common build/cache dirs (`node_modules`, `.next`, `dist`, `venv`, etc.).
- Upload cap: 50 MB. Override with `CLAUDE_DEPLOY_MAX_MB=100` if your self-hosted backend allows it.
- No binary assets you don't need — put them in `.gitignore` first.

## How upsert works

On first run, the plugin authenticates you via email magic link and stores a session token at `~/.claude-deploy/auth-token`. Every `/deploy` call sends that token, so the hosted service can identify you. Your **user identity + project slug** (derived from the git remote or directory name) forms the key for the deployed project — running `/deploy` again from the same project with the same account routes to the same deployment. Clone the project to a different machine, sign in with the same email, and you get the same URL.

## Using your own backend

By default the plugin points at the hosted service. To point it at a self-hosted instance:

```bash
export CLAUDE_DEPLOY_BACKEND=https://my-claude-deploy.up.example.com
claude        # launch Claude Code with the env in scope
```

The slash command reads that var from the environment Claude Code was launched in.

## Status

The hosted service exposes a JSON status page — useful for "is it up?" checks:

```
https://api-production-d9b7.up.railway.app/
```

Shows version, maintenance flag, TTL, daily cap, and your identity's current usage.

---

## Architecture (end-user view)

```
/deploy
  │
  ▼
[package current dir, respecting .gitignore]
  │
  ▼
[authenticate via Supabase magic link — first run only]
  │
  ▼
[upload to hosted build+run service]
  │
  ▼
[receive public URL ← serve your app]
```

Operator-side details (which hosting provider is used under the hood, how services are managed, etc.) live in [`docs/SELFHOST.md`](docs/SELFHOST.md).

---

## Roadmap

- [x] Repeat `/deploy` updates same project / returns same URL (v0.2.0)
- [x] Hosted-backend TTL + daily cap + kill switch (v0.2.0)
- [x] Email auth via Supabase magic link (v0.3.0)
- [x] Per-user identity scoping (v0.3.0)
- [x] Provider-brand sanitizer on all client-visible output (v0.3.1)
- [x] `/deploy --list` + `/deploy --delete` subcommands (v0.4.0)
- [ ] Custom domain (no more `.up.railway.app`)
- [ ] Stream build logs back to the client during the deploy
- [ ] Demo GIF + landing-page style README pitch

## License

MIT — see [LICENSE](LICENSE).
