---
description: Deploy this project to the web, list your deploys, or delete one
argument-hint: "[name | --list | --delete <slug>]"
allowed-tools:
  - Bash
---

# /deploy — One-command deployment + management

You are deploying the user's current project to the hosted claude-deploy service, OR listing their existing deploys, OR deleting one, depending on the arguments.

## Dispatch based on `$ARGUMENTS`

- `/deploy` or `/deploy <name>` → **deploy mode** (default). Package + upload the current directory.
- `/deploy --list` → **list mode**. Fetch the user's current deploys and present them.
- `/deploy --delete <slug>` → **delete mode**. Tear down the named deploy.

In all three modes, run the script with the exact invocation:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/deploy.sh" $ARGUMENTS
```

## Steps for deploy mode

1. Run the script. It packages the current working directory (respecting `.gitignore` when available), uploads the tarball to the hosted backend, and prints a JSON line containing the public URL.

2. **If this is the user's first `/deploy` on this machine**, the script will pause to authenticate them:
   - It prints instructions and a URL, then opens the URL in the user's default browser.
   - The user signs in or signs up with their email — a magic link is emailed to them.
   - Clicking the link brings them back to a success page; the script detects this and resumes automatically.
   - A session token is cached at `~/.claude-deploy/auth-token` so subsequent runs skip this step.
   - **Do not intercept or re-prompt** — the script handles the whole auth flow.

3. Parse the script output. On success it prints a line starting with `DEPLOY_RESULT=` containing a JSON object with a `url` field.

4. Present the URL to the user clearly and concisely. Example:

   > ✅ Deployed! Your app is live at **https://cd-a1b2c3d4-my-project-production.up.railway.app**
   > Hosted deploys auto-expire after 24h of inactivity — run `/deploy` again to refresh. Repeat deploys of the same project update the same URL in place.

## Steps for list mode (`/deploy --list`)

1. The script will print a JSON body on stdout followed by a human-readable table on stderr. Parse stdout to get the authoritative data: `{ "user_email": "...", "count": N, "deploys": [{ "slug", "service", "url", "status", "created_at", "last_deployed_at" }] }`.
2. Present a concise list to the user. Example:

   > You have **3 deploys** (signed in as `you@example.com`):
   > - ✅ `my-landing` — https://cd-…-my-landing.up.railway.app (deployed 2h ago)
   > - ✅ `blog` — https://cd-…-blog.up.railway.app (deployed 1d ago)
   > - ⚠ `api-test` — build failed (try `/deploy` again or `/deploy --delete api-test`)

3. If the list is empty, say so and suggest running `/deploy` from a project directory to create one.

## Steps for delete mode (`/deploy --delete <slug>`)

1. The script prints the JSON response and a confirmation line.
2. Tell the user plainly: "Deleted `<slug>`." If the exit code is **11**, no match was found — suggest `/deploy --list` to see actual slugs.

## Error handling (all modes)

If the script exits non-zero:
- Show the last ~20 lines of output.
- Exit code **7** → daily deploy cap reached — try again tomorrow or self-host (see `docs/SELFHOST.md`).
- Exit code **8** → hosted service is in maintenance — retry in a few minutes.
- Exit code **9** → authentication failed or the user cancelled the browser flow — ask them to run `/deploy` again.
- Exit code **11** → (delete mode) no deploy found with that slug. Run `/deploy --list` first.
- Exit code **12** → (delete mode) that slug exists but doesn't belong to this account.
- Exit code **2** → tarball too large — add large files to `.gitignore` or set `CLAUDE_DEPLOY_MAX_MB`.
- Exit code **3** → empty project — confirm the user is in a project directory.
- Otherwise: show the response body and suggest checking `CLAUDE_DEPLOY_BACKEND` env var and supported runtimes.
- Do **not** retry automatically more than once.

## Constraints

- Do NOT ask the user to create accounts with a hosting provider or paste tokens — the plugin handles everything via the hosted service + email magic-link auth.
- Do NOT modify user files. Packaging is read-only.
- Keep the final response short: the URL is the headline for deploy mode; the table is the headline for list mode; the confirmation is the headline for delete mode.
