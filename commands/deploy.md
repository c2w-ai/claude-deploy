---
description: Deploy this project to the web and get a public URL
argument-hint: "[optional project name]"
allowed-tools:
  - Bash
---

# /deploy — One-command deployment

You are deploying the user's current project to the hosted claude-deploy service. The goal is a **single, frictionless command** that ends with a public URL the user can share.

## Steps

1. Run the deploy script. It packages the current working directory (respecting `.gitignore` when available), uploads the tarball to the hosted backend, and prints a JSON line containing the public URL.

   Use this exact invocation so the plugin root resolves correctly:

   ```bash
   bash "${CLAUDE_PLUGIN_ROOT}/scripts/deploy.sh" $ARGUMENTS
   ```

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

5. If the script exits non-zero or no URL is found:
   - Show the last ~20 lines of output.
   - If the exit code is **7**: the daily deploy cap was reached — tell the user to try again tomorrow or self-host the backend (link to `docs/SELFHOST.md`).
   - If the exit code is **8**: the hosted service is in maintenance — suggest retrying in a few minutes.
   - If the exit code is **9**: authentication failed or the user cancelled the browser flow — ask them to run `/deploy` again and complete the sign-in.
   - If the exit code is **2**: tarball too large — suggest adding large files to `.gitignore` or setting `CLAUDE_DEPLOY_MAX_MB`.
   - If the exit code is **3**: empty project — confirm the user is in a project directory.
   - Otherwise: show the response body and suggest checking `CLAUDE_DEPLOY_BACKEND` env var and that the project has a supported runtime (Node, Python, Go, static HTML, Dockerfile, etc.).
   - Do **not** attempt to retry automatically more than once.

## Constraints

- Do NOT ask the user to create accounts with a hosting provider or paste tokens — the plugin handles everything via the hosted service + email magic-link auth.
- Do NOT modify user files. Packaging is read-only.
- Keep the final response short: the URL is the headline.
