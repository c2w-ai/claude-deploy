---
description: Deploy this project to Railway and get a public URL
argument-hint: "[optional project name]"
allowed-tools:
  - Bash
---

# /deploy — One-command Railway deployment

You are deploying the user's current project to Railway via the claude-deploy backend. The goal is a **single, frictionless command** that ends with a public URL the user can share.

## Steps

1. Run the deploy script. It packages the current working directory (respecting `.gitignore` when available), uploads the tarball to the claude-deploy backend, and prints a JSON line containing the public URL.

   Use this exact invocation so the plugin root resolves correctly:

   ```bash
   bash "${CLAUDE_PLUGIN_ROOT}/scripts/deploy.sh" $ARGUMENTS
   ```

2. Parse the script output. On success it prints a line starting with `DEPLOY_RESULT=` containing a JSON object with a `url` field.

3. Present the URL to the user clearly and concisely. Example:

   > ✅ Deployed! Your app is live at **https://app-xxxx.up.railway.app**
   > Hosted deploys on the default backend auto-expire after 24h of inactivity — run `/deploy` again to refresh. Repeat deploys of the same project update the same URL in place.

4. If the script exits non-zero or no URL is found:
   - Show the last ~20 lines of output.
   - If the exit code is **7**: the daily deploy cap was reached — tell the user to try again tomorrow or self-host the backend (link to `docs/SELFHOST.md`).
   - If the exit code is **8**: the hosted backend is in maintenance or Railway is down — suggest retrying in a few minutes.
   - If the exit code is **2**: tarball too large — suggest adding large files to `.gitignore` or setting `CLAUDE_DEPLOY_MAX_MB`.
   - If the exit code is **3**: empty project — confirm the user is in a project directory.
   - Otherwise: show the response body and suggest checking `CLAUDE_DEPLOY_BACKEND` env var and that the project has a supported runtime (Node, Python, Go, static HTML, Dockerfile, etc.).
   - Do **not** attempt to retry automatically more than once.

## Constraints

- Do NOT ask the user to sign up for Railway, provide tokens, or link accounts — the plugin handles deployment via a shared backend.
- Do NOT modify user files. Packaging is read-only.
- Keep the final response short: the URL is the headline.
